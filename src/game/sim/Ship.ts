import type { Vec2 } from '../../util/math.js';

export interface Ship {
  active: boolean;
  owner: number;
  x: number;
  y: number;
  targetPlanet: number;
  speed: number;
}

export class ShipPool {
  private ships: Ship[] = [];
  private freeList: number[] = [];

  spawn(owner: number, pos: Vec2, targetPlanet: number, speed: number): number {
    const idx = this.freeList.pop();
    if (idx !== undefined) {
      const s = this.ships[idx];
      s.active = true;
      s.owner = owner;
      s.x = pos.x;
      s.y = pos.y;
      s.targetPlanet = targetPlanet;
      s.speed = speed;
      return idx;
    }
    const ship: Ship = {
      active: true,
      owner,
      x: pos.x,
      y: pos.y,
      targetPlanet,
      speed,
    };
    this.ships.push(ship);
    return this.ships.length - 1;
  }

  kill(idx: number): void {
    if (!this.ships[idx].active) return;
    this.ships[idx].active = false;
    this.freeList.push(idx);
  }

  get(idx: number): Ship {
    return this.ships[idx];
  }

  get all(): readonly Ship[] {
    return this.ships;
  }

  activeCount(): number {
    let n = 0;
    for (const s of this.ships) if (s.active) n++;
    return n;
  }
}
