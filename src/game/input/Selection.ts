import type { World } from '../sim/World.js';

/** How far a planet's swarm is committed by the current selection. */
export type SelectionStage = 1 | 2; // 1 = half the swarm, 2 = the whole swarm

/**
 * Swarm selection, Auralux-style: tapping an owned planet gathers HALF its
 * orbiting units; tapping it again gathers them all. `stage` tracks which of
 * the two levels each selected planet is at so the UI can escalate on
 * repeat taps and the renderer can show partial commitment.
 */
export class Selection {
  private world: World;
  private playerId: number;
  private selected = new Set<number>();
  private stages = new Map<number, SelectionStage>();

  constructor(world: World, playerId: number) {
    this.world = world;
    this.playerId = playerId;
  }

  get ids(): ReadonlySet<number> {
    return this.selected;
  }

  /** Current stage of a selected planet (undefined when not selected). */
  stageOf(planetId: number): SelectionStage | undefined {
    return this.stages.get(planetId);
  }

  /** True when any unit (orbiting, transiting, or hovering) is selected. */
  hasSelectedUnits(): boolean {
    for (const s of this.world.ships.all) {
      if (s.active && s.isSelected && s.owner === this.playerId) return true;
    }
    return false;
  }

  /** Replace the selection with HALF of this planet's swarm (Auralux tap 1). */
  set(planetId: number): void {
    const p = this.world.planets[planetId];
    if (p.owner !== this.playerId) return;
    this.clear();
    this.selected.add(planetId);
    this.stages.set(planetId, 1);
    this.selectUnitsOf(planetId, 0.5);
  }

  /**
   * Escalate an already-selected planet to its full swarm (Auralux tap 2).
   * Returns true if the escalation happened (i.e. it wasn't already full).
   */
  escalate(planetId: number): boolean {
    if (!this.selected.has(planetId)) return false;
    if (this.stages.get(planetId) === 2) return false;
    this.stages.set(planetId, 2);
    this.selectUnitsOf(planetId, 1);
    return true;
  }

  clear(): void {
    this.selected.clear();
    this.stages.clear();
    this.clearUnitSelection();
  }

  selectAllOwned(): void {
    this.clear();
    for (const p of this.world.planets) {
      if (p.owner === this.playerId) {
        this.selected.add(p.id);
        this.stages.set(p.id, 2);
        this.selectUnitsOf(p.id, 1);
      }
    }
  }

  /**
   * Replace selection with every owned unit whose position falls inside the
   * drag disc. Matches the Auralux-style free-space lasso selection.
   */
  selectInCircle(cx: number, cy: number, radius: number): void {
    const r2 = radius * radius;
    this.clear();
    const ships = this.world.ships.all;
    const touchedPlanets = new Set<number>();
    for (const s of ships) {
      if (!s.active || s.owner !== this.playerId) continue;
      if (
        s.state !== 'orbiting' &&
        s.state !== 'transit' &&
        s.state !== 'hovering'
      )
        continue;
      const dx = s.x - cx;
      const dy = s.y - cy;
      if (dx * dx + dy * dy <= r2) {
        s.isSelected = true;
        if (s.parentPlanet >= 0) touchedPlanets.add(s.parentPlanet);
      }
    }
    // Light up any planet whose orbiters the lasso grabbed so the HUD / renderer
    // still has a concept of "source planet".
    for (const pid of touchedPlanets) {
      if (this.world.planets[pid].owner === this.playerId) {
        this.selected.add(pid);
        this.stages.set(pid, 2);
      }
    }
    // Also fold in any owned planet whose center falls in the disc, for parity
    // with the previous planet-lasso behavior. A lassoed planet commits its
    // whole swarm.
    for (const p of this.world.planets) {
      if (p.owner !== this.playerId) continue;
      const dx = p.pos.x - cx;
      const dy = p.pos.y - cy;
      if (dx * dx + dy * dy <= r2) {
        this.selected.add(p.id);
        this.stages.set(p.id, 2);
        this.selectUnitsOf(p.id, 1);
      }
    }
  }

  /**
   * Route selected units to a target planet. Every tap is a fresh discrete
   * wave — selected orbiters break orbit and transit directly via boids
   * flocking. Called for enemy attacks, friendly reinforcement, and
   * self-feeding a ringed planet (target may be a selected source).
   *
   * `absorbOnArrive` tags the commanded ships so they auto-absorb into the
   * destination planet (feeding its rings) instead of joining orbit.
   */
  routeTo(targetId: number, absorbOnArrive = false): void {
    const commanded = this.world.commandSelectedTo(
      this.playerId,
      { planetId: targetId },
      { absorbOnArrive },
    );
    if (commanded > 0) {
      this.clearUnitSelection();
      return;
    }
    // Nothing selected at the unit level (or they all already left) — fall
    // back to a direct garrison wave from every selected planet, honoring
    // the half/full stage so a half-selection never empties the planet.
    for (const src of this.selected) {
      if (src === targetId) continue;
      const p = this.world.planets[src];
      if (!p || p.owner !== this.playerId) continue;
      const count =
        this.stages.get(src) === 1 ? Math.ceil(p.garrison / 2) : undefined;
      this.world.openStream(this.playerId, src, targetId, count, { absorbOnArrive });
    }
  }

  /**
   * Command selected units to fly to a free-space point and hold there.
   * Used when the player taps empty space with units selected.
   */
  routeToPoint(x: number, y: number): number {
    const n = this.world.commandSelectedTo(this.playerId, { x, y });
    if (n > 0) this.clearUnitSelection();
    return n;
  }

  /** Remove lost planets from selection. Also drops unit flags on lost ships. */
  sync(): void {
    for (const id of [...this.selected]) {
      if (this.world.planets[id].owner !== this.playerId) {
        this.selected.delete(id);
        this.stages.delete(id);
      }
    }
    // Keep unit-selection flags hygienic.
    const ships = this.world.ships.all;
    for (const s of ships) {
      if (!s.active) {
        s.isSelected = false;
        continue;
      }
      if (s.owner !== this.playerId) s.isSelected = false;
    }
  }

  /**
   * Flag `fraction` of the planet's (not yet selected) orbiters as selected.
   * fraction 1 selects everything; 0.5 selects every other unit so a half
   * send visually peels a striped subset out of the orbit.
   */
  private selectUnitsOf(planetId: number, fraction: number): void {
    const ships = this.world.ships.all;
    let i = 0;
    for (const s of ships) {
      if (!s.active) continue;
      if (s.owner !== this.playerId) continue;
      if (s.state !== 'orbiting' || s.parentPlanet !== planetId) continue;
      if (fraction >= 1 || i % 2 === 0) s.isSelected = true;
      i++;
    }
  }

  private clearUnitSelection(): void {
    const ships = this.world.ships.all;
    for (const s of ships) s.isSelected = false;
  }
}
