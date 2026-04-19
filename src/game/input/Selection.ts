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
    if (this.selected.has(planetId)) this.selected.delete(planetId);
    else this.selected.add(planetId);
  }

  set(planetId: number): void {
    const p = this.world.planets[planetId];
    if (p.owner !== this.playerId) return;
    this.selected.clear();
    this.selected.add(planetId);
  }

  clear(): void {
    this.selected.clear();
  }

  selectAllOwned(): void {
    this.selected.clear();
    for (const p of this.world.planets) {
      if (p.owner === this.playerId) this.selected.add(p.id);
    }
  }

  /** Replace selection with every owned planet whose center lies inside the rect. */
  selectInRect(x0: number, y0: number, x1: number, y1: number): void {
    const lx = Math.min(x0, x1);
    const rx = Math.max(x0, x1);
    const ty = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    this.selected.clear();
    for (const p of this.world.planets) {
      if (p.owner !== this.playerId) continue;
      if (p.pos.x >= lx && p.pos.x <= rx && p.pos.y >= ty && p.pos.y <= by) {
        this.selected.add(p.id);
      }
    }
  }

  /** Replace selection with every owned planet whose center lies in the disc. */
  selectInCircle(cx: number, cy: number, radius: number): void {
    const r2 = radius * radius;
    this.selected.clear();
    for (const p of this.world.planets) {
      if (p.owner !== this.playerId) continue;
      const dx = p.pos.x - cx;
      const dy = p.pos.y - cy;
      if (dx * dx + dy * dy <= r2) this.selected.add(p.id);
    }
  }

  routeTo(targetId: number): void {
    // Sources stream to the target, except the target itself if it was selected.
    for (const src of this.selected) {
      if (src === targetId) continue;
      this.world.openStream(this.playerId, src, targetId);
    }
    // Selection persists so the player can immediately re-target without
    // re-tapping each source — matches the Auralux Constellations feel where
    // you can quickly redirect ongoing waves.
  }

  /** Remove lost planets from selection. */
  sync(): void {
    for (const id of [...this.selected]) {
      if (this.world.planets[id].owner !== this.playerId) this.selected.delete(id);
    }
  }
}
