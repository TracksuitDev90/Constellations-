import type { World } from '../sim/World.js';

export class Selection {
  private world: World;
  private playerId: number;
  private selected = new Set<number>();

  constructor(world: World, playerId: number) {
    this.world = world;
    this.playerId = playerId;
  }

  get ids(): ReadonlySet<number> {
    return this.selected;
  }

  toggle(planetId: number): void {
    const p = this.world.planets[planetId];
    if (p.owner !== this.playerId) return;
    if (this.selected.has(planetId)) {
      this.selected.delete(planetId);
      this.deselectUnitsOf(planetId);
    } else {
      this.selected.add(planetId);
      this.selectUnitsOf(planetId);
    }
  }

  set(planetId: number): void {
    const p = this.world.planets[planetId];
    if (p.owner !== this.playerId) return;
    this.clear();
    this.selected.add(planetId);
    this.selectUnitsOf(planetId);
  }

  clear(): void {
    this.selected.clear();
    this.clearUnitSelection();
  }

  selectAllOwned(): void {
    this.clear();
    for (const p of this.world.planets) {
      if (p.owner === this.playerId) {
        this.selected.add(p.id);
        this.selectUnitsOf(p.id);
      }
    }
  }

  /** Replace selection with every owned planet whose center lies inside the rect. */
  selectInRect(x0: number, y0: number, x1: number, y1: number): void {
    const lx = Math.min(x0, x1);
    const rx = Math.max(x0, x1);
    const ty = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    this.clear();
    for (const p of this.world.planets) {
      if (p.owner !== this.playerId) continue;
      if (p.pos.x >= lx && p.pos.x <= rx && p.pos.y >= ty && p.pos.y <= by) {
        this.selected.add(p.id);
        this.selectUnitsOf(p.id);
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
      if (this.world.planets[pid].owner === this.playerId) this.selected.add(pid);
    }
    // Also fold in any owned planet whose center falls in the disc, for parity
    // with the previous planet-lasso behavior.
    for (const p of this.world.planets) {
      if (p.owner !== this.playerId) continue;
      const dx = p.pos.x - cx;
      const dy = p.pos.y - cy;
      if (dx * dx + dy * dy <= r2) {
        this.selected.add(p.id);
        this.selectUnitsOf(p.id);
      }
    }
  }

  /**
   * Route selected sources/units to a target planet. Every tap is a fresh
   * discrete wave — orbiters of selected planets break orbit and transit
   * directly via boids flocking. Called for both enemy attacks and friendly
   * reinforcement.
   */
  routeTo(targetId: number): void {
    const commanded = this.world.commandSelectedTo(this.playerId, { planetId: targetId });
    if (commanded > 0) {
      this.clearUnitSelection();
      return;
    }
    // Nothing selected at the unit level (or they all already left) — fall
    // back to a classic stream-over-edges wave from every selected planet.
    for (const src of this.selected) {
      if (src === targetId) continue;
      this.world.openStream(this.playerId, src, targetId);
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
      if (this.world.planets[id].owner !== this.playerId) this.selected.delete(id);
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

  private selectUnitsOf(planetId: number): void {
    const ships = this.world.ships.all;
    for (const s of ships) {
      if (!s.active) continue;
      if (s.owner !== this.playerId) continue;
      if (s.state !== 'orbiting' || s.parentPlanet !== planetId) continue;
      s.isSelected = true;
    }
  }

  private deselectUnitsOf(planetId: number): void {
    const ships = this.world.ships.all;
    for (const s of ships) {
      if (s.parentPlanet === planetId) s.isSelected = false;
    }
  }

  private clearUnitSelection(): void {
    const ships = this.world.ships.all;
    for (const s of ships) s.isSelected = false;
  }
}
