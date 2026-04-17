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

  clear(): void {
    this.selected.clear();
  }

  selectAllOwned(): void {
    this.selected.clear();
    for (const p of this.world.planets) {
      if (p.owner === this.playerId) this.selected.add(p.id);
    }
  }

  routeTo(targetId: number): void {
    if (this.selected.has(targetId)) {
      // Target is one of the selected sources — drop it so we don't stream to self.
      this.selected.delete(targetId);
    }
    for (const src of this.selected) {
      this.world.openStream(this.playerId, src, targetId);
    }
  }

  /** Remove lost planets from selection. */
  sync(): void {
    for (const id of [...this.selected]) {
      if (this.world.planets[id].owner !== this.playerId) this.selected.delete(id);
    }
  }
}
