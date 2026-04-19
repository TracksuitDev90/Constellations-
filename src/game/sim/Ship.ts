import type { Vec2 } from '../../util/math.js';

/**
 * Ship states drive the per-tick steering:
 *   'orbiting'  — unit circles its parent planet using tangential steering
 *                 plus a small wander/separation jitter so the swarm vibrates.
 *   'transit'   — unit is flying toward a target planet OR a point in space;
 *                 uses boids-style seek + separation + cohesion.
 *   'hovering'  — unit is loitering around a free-space point it was ordered
 *                 to hold at (no parent planet).
 *   'absorbing' — unit is being pulled into its parent planet's center to be
 *                 consumed for heal / upgrade energy.
 */
export type ShipState = 'orbiting' | 'transit' | 'hovering' | 'absorbing';

export interface Ship {
  active: boolean;
  state: ShipState;
  owner: number;
  x: number;
  y: number;
  /** Current velocity. Ships keep momentum and steer toward their target. */
  vx: number;
  vy: number;
  /** For 'transit' toward a planet: destination planet id. Otherwise -1. */
  targetPlanet: number;
  /**
   * For 'transit'/'hovering' toward a free-space point: world coordinates
   * of the destination. Ignored when targetPlanet >= 0.
   */
  targetX: number;
  targetY: number;
  /**
   * Planet the unit originally departed from in its current transit leg.
   * Preserved as metadata; not currently used for redirect logic.
   */
  sourcePlanet: number;
  /** Planet the unit calls home (for orbit/absorb). -1 if none. */
  parentPlanet: number;
  speed: number;
  /** Max turn rate (radians/sec) — varies per ship for organic arcs. */
  turnRate: number;
  /** Lateral wobble amplitude and phase — keeps the swarm flowing. */
  wobbleAmp: number;
  wobblePhase: number;
  /** Seconds since launch; used for wobble and to scale early curvature. */
  age: number;
  /** Desired orbit radius around the parent planet (world units). */
  orbitRadius: number;
  /** +1 = CCW, -1 = CW. Mixed signs make the swarm feel busy rather than rigid. */
  orbitDir: number;
  /** Phase offset used for small wander/jitter forces in orbit. */
  wanderPhase: number;
  /** Set by Selection; renderers may highlight selected units. */
  isSelected: boolean;
}

export interface SpawnOptions {
  vx: number;
  vy: number;
  turnRate: number;
  wobbleAmp: number;
  wobblePhase: number;
  /** Optional — defaults to 'transit' for backwards compatibility. */
  state?: ShipState;
  parentPlanet?: number;
  sourcePlanet?: number;
  targetX?: number;
  targetY?: number;
  orbitRadius?: number;
  orbitDir?: number;
  wanderPhase?: number;
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
    const state = opts.state ?? 'transit';
    const parentPlanet = opts.parentPlanet ?? -1;
    const sourcePlanet = opts.sourcePlanet ?? -1;
    const targetX = opts.targetX ?? 0;
    const targetY = opts.targetY ?? 0;
    const orbitRadius = opts.orbitRadius ?? 0;
    const orbitDir = opts.orbitDir ?? 1;
    const wanderPhase = opts.wanderPhase ?? Math.random() * Math.PI * 2;
    const idx = this.freeList.pop();
    if (idx !== undefined) {
      const s = this.ships[idx];
      s.active = true;
      s.state = state;
      s.owner = owner;
      s.x = pos.x;
      s.y = pos.y;
      s.vx = opts.vx;
      s.vy = opts.vy;
      s.targetPlanet = targetPlanet;
      s.targetX = targetX;
      s.targetY = targetY;
      s.sourcePlanet = sourcePlanet;
      s.parentPlanet = parentPlanet;
      s.speed = speed;
      s.turnRate = opts.turnRate;
      s.wobbleAmp = opts.wobbleAmp;
      s.wobblePhase = opts.wobblePhase;
      s.age = 0;
      s.orbitRadius = orbitRadius;
      s.orbitDir = orbitDir;
      s.wanderPhase = wanderPhase;
      s.isSelected = false;
      return idx;
    }
    const ship: Ship = {
      active: true,
      state,
      owner,
      x: pos.x,
      y: pos.y,
      vx: opts.vx,
      vy: opts.vy,
      targetPlanet,
      targetX,
      targetY,
      sourcePlanet,
      parentPlanet,
      speed,
      turnRate: opts.turnRate,
      wobbleAmp: opts.wobbleAmp,
      wobblePhase: opts.wobblePhase,
      age: 0,
      orbitRadius,
      orbitDir,
      wanderPhase,
      isSelected: false,
    };
    this.ships.push(ship);
    return this.ships.length - 1;
  }

  kill(idx: number): void {
    const s = this.ships[idx];
    if (!s || !s.active) return;
    s.active = false;
    s.isSelected = false;
    s.state = 'transit';
    s.parentPlanet = -1;
    s.sourcePlanet = -1;
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

  /**
   * Find and return the index of any active orbiting ship belonging to
   * `planetId` owned by `owner`. Returns -1 if none.
   */
  findOrbiterOf(planetId: number, owner: number): number {
    for (let i = 0; i < this.ships.length; i++) {
      const s = this.ships[i];
      if (!s.active) continue;
      if (s.state === 'orbiting' && s.parentPlanet === planetId && s.owner === owner) {
        return i;
      }
    }
    return -1;
  }
}
