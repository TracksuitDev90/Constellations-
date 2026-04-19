import type { Vec2 } from '../../util/math.js';

export interface Ship {
  active: boolean;
  owner: number;
  x: number;
  y: number;
  /** Current velocity. Ships keep momentum and steer toward their target. */
  vx: number;
  vy: number;
  targetPlanet: number;
  speed: number;
  /** Max turn rate (radians/sec) — varies per ship for organic arcs. */
  turnRate: number;
  /** Lateral wobble amplitude and phase — keeps the swarm flowing. */
  wobbleAmp: number;
  wobblePhase: number;
  /** Seconds since launch; used for wobble and to scale early curvature. */
  age: number;
}

export interface SpawnOptions {
  vx: number;
  vy: number;
  turnRate: number;
  wobbleAmp: number;
  wobblePhase: number;
}

export class ShipPool {
  private ships: Ship[] = [];
  private freeList: number[] = [];

  spawn(
    owner: number,
    pos: Vec2,
    targetPlanet: number,
    speed: number,
    opts: SpawnOptions,
  ): number {
    const idx = this.freeList.pop();
    if (idx !== undefined) {
      const s = this.ships[idx];
      s.active = true;
      s.owner = owner;
      s.x = pos.x;
      s.y = pos.y;
      s.vx = opts.vx;
      s.vy = opts.vy;
      s.targetPlanet = targetPlanet;
      s.speed = speed;
      s.turnRate = opts.turnRate;
      s.wobbleAmp = opts.wobbleAmp;
      s.wobblePhase = opts.wobblePhase;
      s.age = 0;
      return idx;
    }
    const ship: Ship = {
      active: true,
      owner,
      x: pos.x,
      y: pos.y,
      vx: opts.vx,
      vy: opts.vy,
      targetPlanet,
      speed,
      turnRate: opts.turnRate,
      wobbleAmp: opts.wobbleAmp,
      wobblePhase: opts.wobblePhase,
      age: 0,
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
