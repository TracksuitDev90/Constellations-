import { dist, vec, type Vec2 } from '../../util/math.js';
import {
  BASE_MAX_HEALTH,
  BASE_PRODUCTION,
  BASE_UNIT_CAPACITY,
  RING_CAPACITY_FOR_SIZE,
  SIZE_RADIUS,
  clampRingCount,
  ringsComplete,
  type Planet,
  type PlanetType,
  type RingCount,
} from './Planet.js';
import type { Player } from './Player.js';
import { ShipPool, type Ship } from './Ship.js';
import { createStream, type ShipStream } from './Stream.js';

export interface MapSpec {
  width: number;
  height: number;
  planets: Array<{
    pos: Vec2;
    /**
     * Optional override; if omitted, the planet's radius is derived from
     * `type` via `SIZE_RADIUS`, so map authors can just pick a size.
     */
    radius?: number;
    owner: number | null;
    garrison: number;
    type?: PlanetType;
    /**
     * Authored unfilled ring count. Clamped to `MAX_RING_COUNT[type]`. Rings
     * fill from absorbed units; filling the last one evolves the planet.
     */
    ringCount?: number;
  }>;
  edges: Array<[number, number]>;
}

export interface WorldEvents {
  onShipLaunch?: (owner: number) => void;
  onPlanetCapture?: (planetId: number, newOwner: number) => void;
  /**
   * Fired when a planet's residual health falls to zero under attack. The
   * planet loses its owner but does NOT flip to the attacker — it becomes
   * neutral and still needs to be captured by the normal garrison-drain.
   */
  onPlanetNeutralized?: (planetId: number, lostOwner: number) => void;
  /** Fired when a ship lands. `friendly` = arrived at an owned planet. */
  onShipArrive?: (planetId: number, owner: number, friendly: boolean) => void;
  /** Fired when a ship is consumed by absorb at its parent planet's center. */
  onShipAbsorbed?: (planetId: number, owner: number) => void;
  /**
   * Fired every time an absorbed unit ticks up a ring's fill counter. Distinct
   * from `onRingFilled` which only fires on the final unit that completes the ring.
   */
  onRingProgress?: (planetId: number, ringIndex: number, owner: number) => void;
  /** Fired when a ring finishes filling with absorbed units. */
  onRingFilled?: (planetId: number, ringIndex: number, owner: number) => void;
  /** Fired when a planet evolves to the next size (ring-fill complete). */
  onPlanetEvolve?: (planetId: number, owner: number, newType: PlanetType) => void;
  /**
   * Fired when a ship dies in mid-flight combat with an enemy ship. One call
   * per ship killed; both sides of a 1:1 trade fire this event.
   */
  onShipDeath?: (owner: number, x: number, y: number) => void;
  onGameOver?: (winner: number | null) => void;
}

export const SHIP_SPEED = 48;
/**
 * Interval between successive ships in a wave. Kept short on purpose —
 * Auralux releases the selected ships as a quick burst rather than a
 * continuous trickle, so a batch of ~20 drains in well under a second.
 */
export const DEFAULT_EMIT_INTERVAL = 0.035;
/**
 * Max random exit-cone angle, in radians, around the direct line to target.
 * Kept narrow so streams look like organized flows, not a shotgun blast —
 * matches the single-file feel of Auralux: Constellations.
 */
const EXIT_CONE = Math.PI / 7; // ±~25°
/** Distance (world units) at which two enemy ships mutually destroy each other. */
const SHIP_COLLIDE_RADIUS = 5;

/** Target orbit radius around a planet, expressed as a multiple of planet radius. */
const ORBIT_RADIUS_MULT = 1.75;
/** How far (px) inside the orbit band counts as "settled into orbit". */
const ORBIT_SETTLE_TOLERANCE = 3;
/** How far (px) from planet center before an absorbing unit is consumed. */
const ABSORB_CONSUME_DIST = 3;

/** Boids tuning for transit swarms. Kept gentle — ships must still arrive. */
const SEPARATION_RADIUS = 9;
const SEPARATION_WEIGHT = 22;
const COHESION_RADIUS = 38;
const COHESION_WEIGHT = 4;
const SEEK_WEIGHT = 60;

export class World {
  players: Player[];
  planets: Planet[];
  edges: Set<string>;
  neighbors: Map<number, number[]>;
  streams: ShipStream[] = [];
  ships: ShipPool = new ShipPool();
  time = 0;
  width: number;
  height: number;
  gameOver = false;
  winner: number | null = null;
  private events: WorldEvents;
  private playersSeen = new Set<number>();

  constructor(map: MapSpec, players: Player[], events: WorldEvents = {}) {
    this.players = players;
    this.width = map.width;
    this.height = map.height;
    this.events = events;
    this.planets = map.planets.map((p, i) => {
      // XXL is terminal: only reachable by evolving via ring-fill. Silently
      // downgrade any authored XXL so the growth path is preserved.
      const authoredType: PlanetType = p.type ?? 0;
      const type: PlanetType = authoredType >= 3 ? 2 : authoredType;
      const ringCount: RingCount = clampRingCount(type, p.ringCount ?? 0);
      const maxHealth = BASE_MAX_HEALTH[type];
      return {
        id: i,
        pos: { ...p.pos },
        radius: p.radius ?? SIZE_RADIUS[type],
        owner: p.owner,
        garrison: p.garrison,
        type,
        productionRate: BASE_PRODUCTION[type],
        productionAcc: 0,
        capturePulse: 0,
        evolvePulse: 0,
        ringCount,
        ringFillProgress: new Array(ringCount).fill(0),
        maxUnitCapacity: BASE_UNIT_CAPACITY[type],
        absorbing: false,
        health: maxHealth,
        maxHealth,
      };
    });
    this.edges = new Set();
    this.neighbors = new Map();
    for (let i = 0; i < this.planets.length; i++) this.neighbors.set(i, []);
    for (const [a, b] of map.edges) {
      this.edges.add(edgeKey(a, b));
      this.neighbors.get(a)!.push(b);
      this.neighbors.get(b)!.push(a);
    }
  }

  hasEdge(a: number, b: number): boolean {
    return this.edges.has(edgeKey(a, b));
  }

  /**
   * Send a one-shot wave of ships from source -> target along constellation edges.
   * If `count` is omitted, the entire current garrison of the source is launched.
   * Streams are discrete — the player taps again for another wave.
   */
  openStream(
    owner: number,
    source: number,
    target: number,
    count?: number,
    opts: { absorbOnArrive?: boolean } = {},
  ): void {
    if (source === target) return;
    const src = this.planets[source];
    if (src.owner !== owner) return;
    const path = this.findPath(source, target);
    if (path.length < 2) return;
    const nextHop = path[1];
    const remaining = count === undefined ? src.garrison : Math.min(count, src.garrison);
    if (remaining <= 0) return;
    const absorbOnArrive = opts.absorbOnArrive ?? false;
    this.cancelStreamsFrom(source, owner);
    // Only the final-hop stream (nextHop === target) should carry the absorb
    // flag — mid-hop waypoints are friendly planets we just pass through.
    this.streams.push(
      createStream(
        owner,
        source,
        nextHop,
        DEFAULT_EMIT_INTERVAL,
        remaining,
        absorbOnArrive && nextHop === target,
      ),
    );
    if (nextHop !== target) {
      this.queueDownstream(owner, path, remaining, absorbOnArrive);
    }
  }

  private queueDownstream(
    owner: number,
    path: number[],
    remaining: number,
    absorbOnArrive: boolean,
  ): void {
    for (let i = 1; i < path.length - 1; i++) {
      const s = path[i];
      const t = path[i + 1];
      if (this.planets[s].owner === owner) {
        this.cancelStreamsFrom(s, owner);
        this.streams.push(
          createStream(
            owner,
            s,
            t,
            DEFAULT_EMIT_INTERVAL,
            remaining,
            absorbOnArrive && t === path[path.length - 1],
          ),
        );
      }
    }
  }

  cancelStreamsFrom(source: number, owner: number): void {
    this.streams = this.streams.filter((s) => !(s.source === source && s.owner === owner));
  }

  cancelAllStreamsOf(owner: number): void {
    this.streams = this.streams.filter((s) => s.owner !== owner);
  }

  /** BFS shortest path along constellation edges. */
  findPath(from: number, to: number): number[] {
    if (from === to) return [from];
    const prev = new Map<number, number>();
    const queue: number[] = [from];
    const visited = new Set<number>([from]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === to) break;
      for (const n of this.neighbors.get(cur) ?? []) {
        if (visited.has(n)) continue;
        visited.add(n);
        prev.set(n, cur);
        queue.push(n);
      }
    }
    if (!prev.has(to) && from !== to) return [];
    const path: number[] = [to];
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur);
      if (p === undefined) return [];
      path.unshift(p);
      cur = p;
    }
    return path;
  }

  /**
   * Toggle absorption mode on a friendly planet. While absorbing, orbit units
   * are pulled into the center and consumed — feeding either health (if damaged)
   * or the upgrade meter (which converts into permanent production gains).
   */
  triggerAbsorb(planetId: number, owner: number, enabled = true): void {
    const p = this.planets[planetId];
    if (!p || p.owner !== owner) return;
    p.absorbing = enabled;
  }

  /**
   * Command every selected unit to break orbit and transit toward a target.
   * `target` may be a planet id (non-negative) or a free-space point.
   * Returns the number of units that received the order.
   */
  commandSelectedTo(
    owner: number,
    target: { planetId: number } | { x: number; y: number },
    opts: { absorbOnArrive?: boolean } = {},
  ): number {
    const ships = this.ships.all;
    const planetTarget = 'planetId' in target;
    if (planetTarget && !this.planets[target.planetId]) return 0;
    const absorbOnArrive = (opts.absorbOnArrive ?? false) && planetTarget;
    let n = 0;
    // Planets that had an orbiter commanded away — we'll also drain any
    // production overflow (garrison beyond live-orbiter cap) from these so
    // the count under the planet visibly drops to zero instead of leaving a
    // phantom reserve behind.
    const drained = new Set<number>();
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s.active || !s.isSelected || s.owner !== owner) continue;
      if (
        s.state !== 'orbiting' &&
        s.state !== 'transit' &&
        s.state !== 'hovering'
      )
        continue;
      if (s.state === 'orbiting' && s.parentPlanet >= 0) {
        const parent = this.planets[s.parentPlanet];
        if (parent && parent.owner === owner && parent.garrison > 0) {
          parent.garrison -= 1;
        }
        drained.add(s.parentPlanet);
        s.sourcePlanet = s.parentPlanet;
      }
      s.state = 'transit';
      s.parentPlanet = -1;
      if (planetTarget) {
        s.targetPlanet = target.planetId;
      } else {
        s.targetPlanet = -1;
        s.targetX = target.x;
        s.targetY = target.y;
      }
      s.age = 0;
      s.absorbOnArrive = absorbOnArrive;
      this.events.onShipLaunch?.(owner);
      n++;
    }
    // Drain residual garrison on source planets by spawning fresh transit
    // ships straight from the planet edge. Covers the production-overflow
    // case (garrison > live-orbiter cap) so commanding a planet's units
    // always leaves the planet at zero.
    for (const pid of drained) {
      if (planetTarget && pid === target.planetId) continue;
      const src = this.planets[pid];
      if (!src || src.owner !== owner) continue;
      while (src.garrison > 0) {
        src.garrison -= 1;
        this.spawnTransitFromPlanet(src, target, absorbOnArrive);
        this.events.onShipLaunch?.(owner);
        n++;
      }
    }
    return n;
  }

  /**
   * Spawn a transit-state ship emerging from `src`'s edge, headed at the
   * given target. Used to drain residual garrison on a command that the
   * orbit-unit pass couldn't account for.
   */
  private spawnTransitFromPlanet(
    src: Planet,
    target: { planetId: number } | { x: number; y: number },
    absorbOnArrive: boolean,
  ): void {
    if (src.owner === null) return;
    const planetTarget = 'planetId' in target;
    const tx = planetTarget ? this.planets[target.planetId].pos.x : target.x;
    const ty = planetTarget ? this.planets[target.planetId].pos.y : target.y;
    const baseAngle = Math.atan2(ty - src.pos.y, tx - src.pos.x);
    const exitAngle = baseAngle + (Math.random() - 0.5) * EXIT_CONE;
    const exitR = src.radius + 2 + Math.random() * (src.radius * 0.25);
    const spawnPos = vec(
      src.pos.x + Math.cos(exitAngle) * exitR,
      src.pos.y + Math.sin(exitAngle) * exitR,
    );
    const headingAngle = baseAngle + (exitAngle - baseAngle) * 0.55;
    const idx = this.ships.spawn(src.owner, spawnPos, planetTarget ? target.planetId : -1, SHIP_SPEED, {
      vx: Math.cos(headingAngle) * SHIP_SPEED,
      vy: Math.sin(headingAngle) * SHIP_SPEED,
      turnRate: 1.4 + Math.random() * 1.6,
      wobbleAmp: (Math.random() - 0.5) * 0.3,
      wobblePhase: Math.random() * Math.PI * 2,
      state: 'transit',
      sourcePlanet: src.id,
      absorbOnArrive: absorbOnArrive && planetTarget,
    });
    if (!planetTarget) {
      const s = this.ships.get(idx);
      s.targetX = tx;
      s.targetY = ty;
    }
  }

  step(dt: number): void {
    if (this.gameOver) return;
    this.time += dt;

    // Production. Bigger planets produce meaningfully faster; growth comes
    // from evolving the planet via ring fill (Auralux: Constellations' "explode
    // into a bigger size" mechanic), not from a ring-count multiplier.
    for (const p of this.planets) {
      if (p.capturePulse > 0) p.capturePulse = Math.max(0, p.capturePulse - dt);
      if (p.evolvePulse > 0) p.evolvePulse = Math.max(0, p.evolvePulse - dt * 0.9);
      if (p.owner === null) continue;
      // Absorbing planets stall production so all focus is on consuming orbiters.
      if (p.absorbing) continue;
      p.productionAcc += p.productionRate * dt;
      while (p.productionAcc >= 1) {
        p.productionAcc -= 1;
        p.garrison += 1;
        // Spawn a physical orbit unit if we have capacity headroom.
        this.spawnOrbiter(p);
      }
    }

    // Stream emission (one-shot: drains `remaining` and then removes itself)
    for (const s of this.streams) {
      const src = this.planets[s.source];
      if (src.owner !== s.owner || src.garrison <= 0 || s.remaining <= 0) {
        s.emitAcc = 0;
        continue;
      }
      s.emitAcc += dt;
      while (s.emitAcc >= s.emitInterval && src.garrison > 0 && s.remaining > 0) {
        s.emitAcc -= s.emitInterval;
        src.garrison -= 1;
        s.remaining -= 1;
        this.emitStreamShip(s, src);
      }
    }

    // Drop finished streams and any whose source is no longer owned by the streamer.
    this.streams = this.streams.filter(
      (s) => s.remaining > 0 && this.planets[s.source].owner === s.owner,
    );

    // Ship simulation. Each state runs its own steering pass.
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      if (!ship.active) continue;
      ship.age += dt;
      if (ship.state === 'orbiting') this.stepOrbiting(i, ship, dt);
      else if (ship.state === 'absorbing') this.stepAbsorbing(i, ship, dt);
      else if (ship.state === 'hovering') this.stepHovering(ship, dt, ships);
      else this.stepTransit(i, ship, dt, ships);
    }

    // Mid-flight combat: enemy streams that cross destroy each other 1:1.
    this.stepShipCombat();

    this.checkGameOver();
  }

  /**
   * Check every pair of in-flight ships of different owners for proximity; any
   * pair inside `SHIP_COLLIDE_RADIUS` mutually destroys. Grid bucketing keeps
   * this cheap even with hundreds of ships in the air.
   */
  private stepShipCombat(): void {
    const ships = this.ships.all;
    const cell = Math.max(SHIP_COLLIDE_RADIUS * 2, 10);
    const buckets = new Map<number, number[]>();
    const keyOf = (cx: number, cy: number): number => cx * 100000 + cy;
    const combatant = (s: Ship): boolean =>
      s.active && (s.state === 'transit' || s.state === 'hovering');
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!combatant(s)) continue;
      const cx = Math.floor(s.x / cell);
      const cy = Math.floor(s.y / cell);
      const key = keyOf(cx, cy);
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(i);
    }

    const r2 = SHIP_COLLIDE_RADIUS * SHIP_COLLIDE_RADIUS;
    const dead = new Set<number>();
    for (const [key, arr] of buckets) {
      const cx = Math.floor(key / 100000);
      const cy = key - cx * 100000;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const other = buckets.get(keyOf(cx + dx, cy + dy));
          if (!other) continue;
          for (const i of arr) {
            if (dead.has(i)) continue;
            const si = ships[i];
            for (const j of other) {
              if (j <= i) continue; // dedupe (only compare each pair once)
              if (dead.has(j)) continue;
              const sj = ships[j];
              if (si.owner === sj.owner) continue;
              const ddx = si.x - sj.x;
              const ddy = si.y - sj.y;
              if (ddx * ddx + ddy * ddy > r2) continue;
              dead.add(i);
              dead.add(j);
              break;
            }
          }
        }
      }
    }

    for (const idx of dead) {
      const s = ships[idx];
      this.events.onShipDeath?.(s.owner, s.x, s.y);
      this.ships.kill(idx);
    }
  }

  /** Spawn a new orbit unit emerging from the planet center. */
  private spawnOrbiter(planet: Planet): void {
    if (planet.owner === null) return;
    const liveOrbiters = this.countOrbitersOf(planet.id);
    if (liveOrbiters >= planet.maxUnitCapacity) return;
    const angle = Math.random() * Math.PI * 2;
    const outward = SHIP_SPEED * 0.8;
    const orbitRadius = planet.radius * ORBIT_RADIUS_MULT + (Math.random() - 0.5) * 6;
    this.ships.spawn(planet.owner, planet.pos, -1, SHIP_SPEED, {
      vx: Math.cos(angle) * outward,
      vy: Math.sin(angle) * outward,
      turnRate: 2.2 + Math.random() * 1.6,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'orbiting',
      parentPlanet: planet.id,
      orbitRadius,
      orbitDir: Math.random() < 0.5 ? 1 : -1,
      wanderPhase: Math.random() * Math.PI * 2,
    });
  }

  private countOrbitersOf(planetId: number): number {
    const all = this.ships.all;
    let n = 0;
    for (const s of all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === planetId) n++;
    }
    return n;
  }

  /**
   * Emit a single stream ship. Prefers repurposing an existing orbiter (so it
   * visibly breaks orbit) over spawning a fresh one from the planet edge.
   */
  private emitStreamShip(stream: ShipStream, src: Planet): void {
    const tgt = this.planets[stream.target];
    const orbiterIdx = this.ships.findOrbiterOf(src.id, stream.owner);

    if (orbiterIdx >= 0) {
      const ship = this.ships.get(orbiterIdx);
      ship.state = 'transit';
      ship.sourcePlanet = src.id;
      ship.parentPlanet = -1;
      ship.targetPlanet = stream.target;
      ship.age = 0;
      ship.absorbOnArrive = stream.absorbOnArrive;
      // Point velocity roughly at the next-hop planet so the break looks intentional.
      const dirX = tgt.pos.x - ship.x;
      const dirY = tgt.pos.y - ship.y;
      const m = Math.hypot(dirX, dirY) || 1;
      ship.vx = (dirX / m) * SHIP_SPEED;
      ship.vy = (dirY / m) * SHIP_SPEED;
      ship.speed = SHIP_SPEED;
      ship.turnRate = 1.4 + Math.random() * 1.6;
      ship.wobbleAmp = (Math.random() - 0.5) * 0.3;
      ship.wobblePhase = Math.random() * Math.PI * 2;
      this.events.onShipLaunch?.(stream.owner);
      return;
    }

    // Fallback: spawn a fresh transit ship from the planet edge (same as before).
    const dirX = tgt.pos.x - src.pos.x;
    const dirY = tgt.pos.y - src.pos.y;
    const baseAngle = Math.atan2(dirY, dirX);
    const exitAngle = baseAngle + (Math.random() - 0.5) * EXIT_CONE;
    const exitR = src.radius + 2 + Math.random() * (src.radius * 0.25);
    const spawnPos = vec(
      src.pos.x + Math.cos(exitAngle) * exitR,
      src.pos.y + Math.sin(exitAngle) * exitR,
    );
    const headingAngle = baseAngle + (exitAngle - baseAngle) * 0.55;
    this.ships.spawn(stream.owner, spawnPos, stream.target, SHIP_SPEED, {
      vx: Math.cos(headingAngle) * SHIP_SPEED,
      vy: Math.sin(headingAngle) * SHIP_SPEED,
      turnRate: 1.4 + Math.random() * 1.6,
      wobbleAmp: (Math.random() - 0.5) * 0.3,
      wobblePhase: Math.random() * Math.PI * 2,
      state: 'transit',
      sourcePlanet: src.id,
      absorbOnArrive: stream.absorbOnArrive,
    });
    this.events.onShipLaunch?.(stream.owner);
  }

  private stepOrbiting(idx: number, ship: Ship, dt: number): void {
    const planet = this.planets[ship.parentPlanet];
    if (!planet || planet.owner !== ship.owner) {
      // Parent lost or stale — release into transit to the nearest friendly
      // alternative, or just kill it to return to the pool.
      this.ships.kill(idx);
      return;
    }
    // If the planet is in absorb mode, switch the unit to absorbing state.
    if (planet.absorbing) {
      ship.state = 'absorbing';
      return;
    }

    const dx = ship.x - planet.pos.x;
    const dy = ship.y - planet.pos.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const radial = d - ship.orbitRadius;

    // Radial component: gently pull/push toward the orbit band.
    const radialForce = -radial * 4; // stiffness
    // Tangential component: perpendicular unit vector scaled by desired speed.
    const tx = -dy / d;
    const ty = dx / d;
    const tangentSpeed = SHIP_SPEED * 0.75 * ship.orbitDir;

    // Small wander so the swarm vibrates rather than locking to perfect circles.
    const wander = Math.sin(this.time * 2.3 + ship.wanderPhase) * 6;
    const rx = dx / d;
    const ry = dy / d;
    // Separation from nearby orbiters of the same planet — prevents stacking.
    const sep = this.orbitSeparation(ship);

    let targetVx = tx * tangentSpeed + rx * radialForce + rx * wander + sep.x;
    let targetVy = ty * tangentSpeed + ry * radialForce + ry * wander + sep.y;

    // Smooth velocity toward target (lightweight steering).
    const blend = Math.min(1, dt * 6);
    ship.vx += (targetVx - ship.vx) * blend;
    ship.vy += (targetVy - ship.vy) * blend;

    // Cap speed.
    const sp = Math.hypot(ship.vx, ship.vy);
    const maxSp = SHIP_SPEED * 1.1;
    if (sp > maxSp) {
      ship.vx = (ship.vx / sp) * maxSp;
      ship.vy = (ship.vy / sp) * maxSp;
    }

    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;

    if (Math.abs(radial) < ORBIT_SETTLE_TOLERANCE) {
      // Nudge speed to match the orbit tangent exactly once settled.
      ship.vx = tx * tangentSpeed;
      ship.vy = ty * tangentSpeed;
    }
  }

  private orbitSeparation(self: Ship): { x: number; y: number } {
    const ships = this.ships.all;
    let fx = 0;
    let fy = 0;
    for (const other of ships) {
      if (other === self || !other.active) continue;
      if (other.state !== 'orbiting' || other.parentPlanet !== self.parentPlanet) continue;
      const dx = self.x - other.x;
      const dy = self.y - other.y;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
      const d = Math.sqrt(d2);
      const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
      fx += (dx / d) * push * SEPARATION_WEIGHT;
      fy += (dy / d) * push * SEPARATION_WEIGHT;
    }
    return { x: fx, y: fy };
  }

  private stepAbsorbing(idx: number, ship: Ship, dt: number): void {
    const planet = this.planets[ship.parentPlanet];
    if (!planet || planet.owner !== ship.owner) {
      this.ships.kill(idx);
      return;
    }
    // If the planet has turned absorb off, fall back to orbit — unless this
    // unit was sent as a reinforcement specifically to be absorbed, in which
    // case it stays committed and finishes its pull to the center.
    if (!planet.absorbing && !ship.absorbOnArrive) {
      ship.state = 'orbiting';
      return;
    }
    const dx = planet.pos.x - ship.x;
    const dy = planet.pos.y - ship.y;
    const d = Math.hypot(dx, dy);
    if (d <= ABSORB_CONSUME_DIST) {
      this.consumeAbsorbed(planet);
      this.ships.kill(idx);
      return;
    }
    // Reverse-seek: high-speed straight pull toward the center.
    const pullSpeed = SHIP_SPEED * 1.6;
    ship.vx = (dx / d) * pullSpeed;
    ship.vy = (dy / d) * pullSpeed;
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
  }

  private consumeAbsorbed(planet: Planet): void {
    if (planet.garrison > 0) planet.garrison -= 1;
    if (planet.owner !== null) this.events.onShipAbsorbed?.(planet.id, planet.owner);
    // Absorb has two jobs: heal first if the planet is damaged, then fill rings.
    if (planet.health < planet.maxHealth) {
      planet.health = Math.min(planet.maxHealth, planet.health + 1);
      return;
    }
    if (planet.ringCount === 0) return; // nothing to grow into; orbiter is still spent.
    const cap = RING_CAPACITY_FOR_SIZE[planet.type];
    for (let i = 0; i < planet.ringCount; i++) {
      const before = planet.ringFillProgress[i] ?? 0;
      if (before >= cap) continue;
      const after = before + 1;
      planet.ringFillProgress[i] = after;
      if (planet.owner !== null) {
        this.events.onRingProgress?.(planet.id, i, planet.owner);
        if (after >= cap) this.events.onRingFilled?.(planet.id, i, planet.owner);
      }
      break;
    }
    if (ringsComplete(planet)) this.evolvePlanet(planet);
  }

  /**
   * Grow a planet one tier. Called only when every ring has been filled by
   * absorbed units; clears rings, scales radius/production/capacity up, and
   * signals listeners so the renderer and audio can react.
   */
  private evolvePlanet(planet: Planet): void {
    if (planet.type >= 3) return;
    const newType: PlanetType = (planet.type + 1) as PlanetType;
    planet.type = newType;
    planet.radius = SIZE_RADIUS[newType];
    planet.productionRate = BASE_PRODUCTION[newType];
    planet.maxUnitCapacity = BASE_UNIT_CAPACITY[newType];
    planet.maxHealth = BASE_MAX_HEALTH[newType];
    planet.health = planet.maxHealth;
    planet.ringCount = 0;
    planet.ringFillProgress = [];
    planet.evolvePulse = 1;
    // Auto-stop absorb: there's nothing left to fill, and the player should
    // re-opt-in if they want to heal a newly damaged XXL later.
    planet.absorbing = false;
    if (planet.owner !== null) {
      this.events.onPlanetEvolve?.(planet.id, planet.owner, newType);
    }
  }

  private stepTransit(idx: number, ship: Ship, dt: number, allShips: readonly Ship[]): void {
    // Transit can target a planet (targetPlanet >= 0) or a free-space point
    // (targetPlanet === -1, using targetX/targetY). Planet-arrival hands off to
    // arrive(); point-arrival hands off to hovering around the point.
    const pointTarget = ship.targetPlanet < 0;
    const tgt = pointTarget ? null : this.planets[ship.targetPlanet];
    if (!pointTarget && !tgt) {
      this.ships.kill(idx);
      return;
    }
    const targetX = tgt ? tgt.pos.x : ship.targetX;
    const targetY = tgt ? tgt.pos.y : ship.targetY;
    const arriveDist = tgt ? tgt.radius + 1 : 6;
    const dx = targetX - ship.x;
    const dy = targetY - ship.y;
    const d = Math.hypot(dx, dy);
    if (d <= arriveDist) {
      if (tgt) this.arrive(idx, tgt);
      else this.beginHover(ship);
      return;
    }

    // Seek (Arrive): force toward the target, slowing near arrival.
    const seekStrength = Math.min(1, d / 40);
    const invD = 1 / (d || 1);
    let fx = dx * invD * SEEK_WEIGHT * seekStrength;
    let fy = dy * invD * SEEK_WEIGHT * seekStrength;

    // Boids: separation (hard) + weak cohesion with nearby friendly transits.
    let sepX = 0;
    let sepY = 0;
    let cohX = 0;
    let cohY = 0;
    let cohN = 0;
    for (const other of allShips) {
      if (other === ship || !other.active) continue;
      if (other.state !== 'transit' || other.owner !== ship.owner) continue;
      const ox = ship.x - other.x;
      const oy = ship.y - other.y;
      const d2 = ox * ox + oy * oy;
      if (d2 === 0) continue;
      if (d2 < SEPARATION_RADIUS * SEPARATION_RADIUS) {
        const od = Math.sqrt(d2);
        const push = (SEPARATION_RADIUS - od) / SEPARATION_RADIUS;
        sepX += (ox / od) * push;
        sepY += (oy / od) * push;
      }
      if (d2 < COHESION_RADIUS * COHESION_RADIUS && other.targetPlanet === ship.targetPlanet) {
        cohX += other.x;
        cohY += other.y;
        cohN++;
      }
    }
    fx += sepX * SEPARATION_WEIGHT;
    fy += sepY * SEPARATION_WEIGHT;
    if (cohN > 0) {
      const avgX = cohX / cohN;
      const avgY = cohY / cohN;
      const cdx = avgX - ship.x;
      const cdy = avgY - ship.y;
      const cd = Math.hypot(cdx, cdy) || 1;
      fx += (cdx / cd) * COHESION_WEIGHT;
      fy += (cdy / cd) * COHESION_WEIGHT;
    }

    // Lateral wobble — keeps single-file flights looking organic. Fades on arrival.
    const approachFalloff = Math.min(1, d / 80);
    const wobble =
      Math.sin(this.time * 3.2 + ship.wobblePhase) * ship.wobbleAmp * approachFalloff;
    // Apply wobble as a perpendicular nudge to the current velocity direction.
    const vMag = Math.hypot(ship.vx, ship.vy) || 1;
    const perpX = -ship.vy / vMag;
    const perpY = ship.vx / vMag;
    fx += perpX * wobble * 12;
    fy += perpY * wobble * 12;

    // Steer velocity toward desired force.
    const blend = Math.min(1, dt * 3);
    ship.vx += (fx - ship.vx) * blend;
    ship.vy += (fy - ship.vy) * blend;

    // Cap speed to the ship's nominal speed.
    const sp = Math.hypot(ship.vx, ship.vy);
    if (sp > ship.speed) {
      ship.vx = (ship.vx / sp) * ship.speed;
      ship.vy = (ship.vy / sp) * ship.speed;
    }

    const step = Math.hypot(ship.vx, ship.vy) * dt;
    if (step >= d) {
      if (tgt) this.arrive(idx, tgt);
      else this.beginHover(ship);
    } else {
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
    }
  }

  private beginHover(ship: Ship): void {
    ship.state = 'hovering';
    ship.age = 0;
    // Small orbit radius around the hover point so the units bob in a
    // visible cluster rather than stacking on one pixel.
    ship.orbitRadius = 10 + Math.random() * 6;
    ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
    ship.wanderPhase = Math.random() * Math.PI * 2;
  }

  private stepHovering(ship: Ship, dt: number, allShips: readonly Ship[]): void {
    const dx = ship.x - ship.targetX;
    const dy = ship.y - ship.targetY;
    const d = Math.hypot(dx, dy) || 0.0001;
    const radial = d - ship.orbitRadius;
    // Radial pull toward the hover band.
    const radialForce = -radial * 3;
    // Tangential drift around the hover point.
    const tx = -dy / d;
    const ty = dx / d;
    const tangentSpeed = SHIP_SPEED * 0.35 * ship.orbitDir;
    const wander = Math.sin(this.time * 1.8 + ship.wanderPhase) * 4;
    const rx = dx / d;
    const ry = dy / d;
    // Simple separation pass so hovering units don't collide.
    let sepX = 0;
    let sepY = 0;
    for (const other of allShips) {
      if (other === ship || !other.active) continue;
      if (other.state !== 'hovering' && other.state !== 'orbiting') continue;
      if (other.owner !== ship.owner) continue;
      const ox = ship.x - other.x;
      const oy = ship.y - other.y;
      const d2 = ox * ox + oy * oy;
      if (d2 === 0 || d2 > SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
      const od = Math.sqrt(d2);
      const push = (SEPARATION_RADIUS - od) / SEPARATION_RADIUS;
      sepX += (ox / od) * push;
      sepY += (oy / od) * push;
    }
    const targetVx = tx * tangentSpeed + rx * radialForce + rx * wander + sepX * SEPARATION_WEIGHT;
    const targetVy = ty * tangentSpeed + ry * radialForce + ry * wander + sepY * SEPARATION_WEIGHT;
    const blend = Math.min(1, dt * 4);
    ship.vx += (targetVx - ship.vx) * blend;
    ship.vy += (targetVy - ship.vy) * blend;
    const sp = Math.hypot(ship.vx, ship.vy);
    const maxSp = SHIP_SPEED * 0.6;
    if (sp > maxSp) {
      ship.vx = (ship.vx / sp) * maxSp;
      ship.vy = (ship.vy / sp) * maxSp;
    }
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
  }

  private arrive(shipIdx: number, planet: Planet): void {
    const ship = this.ships.get(shipIdx);
    const friendly = planet.owner === ship.owner;
    if (friendly) {
      planet.garrison += 1;
      // Reinforcement tagged for auto-absorb: route straight into the absorb
      // pull instead of orbit, so rings visibly fill and the planet grows.
      // Only meaningful if the planet actually has something to absorb into
      // (rings to fill or damage to heal).
      const canAbsorb = planet.ringCount > 0 || planet.health < planet.maxHealth;
      if (ship.absorbOnArrive && canAbsorb) {
        ship.state = 'absorbing';
        ship.parentPlanet = planet.id;
        ship.sourcePlanet = -1;
        ship.targetPlanet = -1;
        ship.isSelected = false;
        // Keep absorbOnArrive true so stepAbsorbing treats this unit as a
        // committed reinforcement — it won't pop back to orbit if the player
        // toggles off the planet's absorb mode mid-flight.
        this.events.onShipArrive?.(planet.id, ship.owner, friendly);
        return;
      }
      // Turn the arriving ship into an orbiter of its new home rather than
      // returning it to the pool — matches the spec: "unit's state resets to
      // Orbiting and it joins the target planet's list".
      if (this.countOrbitersOf(planet.id) < planet.maxUnitCapacity) {
        ship.state = 'orbiting';
        ship.parentPlanet = planet.id;
        ship.sourcePlanet = -1;
        ship.targetPlanet = -1;
        ship.orbitRadius = planet.radius * ORBIT_RADIUS_MULT + (Math.random() - 0.5) * 6;
        ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
        ship.wanderPhase = Math.random() * Math.PI * 2;
        ship.isSelected = false;
        // Seed velocity roughly tangential for a clean orbit entry.
        const dx = ship.x - planet.pos.x;
        const dy = ship.y - planet.pos.y;
        const d = Math.hypot(dx, dy) || 1;
        const tangentSpeed = SHIP_SPEED * 0.75 * ship.orbitDir;
        ship.vx = (-dy / d) * tangentSpeed;
        ship.vy = (dx / d) * tangentSpeed;
        this.events.onShipArrive?.(planet.id, ship.owner, friendly);
        return;
      }
    } else {
      // Enemy arrival. Order of operations matters:
      //   1. Burn through active defenders (garrison) first.
      //   2. Once defenders are gone on an owned planet, chip at residual
      //      planetary health — the structure that keeps it flagged as the
      //      current owner's. When health hits zero the planet goes NEUTRAL,
      //      not captured, so the attacker must still land a fresh wave to
      //      take it. Strategically this means stripping a world of all its
      //      units no longer gives the enemy a free capture — they have to
      //      actually fight through the hull.
      //   3. On a neutral planet, arrivals work the old way: drain the
      //      neutral garrison then flip ownership.
      if (planet.owner !== null && planet.garrison <= 0) {
        planet.garrison = 0;
        planet.health = Math.max(0, planet.health - 1);
        planet.capturePulse = 0.35;
        if (planet.health <= 0) {
          const lostOwner = planet.owner;
          planet.owner = null;
          planet.absorbing = false;
          planet.ringFillProgress = new Array(planet.ringCount).fill(0);
          planet.capturePulse = 0.55;
          // The old owner's leftover orbiters are displaced — the world is
          // briefly no-one's, ready to be claimed by the next arriving wave.
          this.evictOrbitersOf(planet.id, -1);
          this.events.onPlanetNeutralized?.(planet.id, lostOwner);
        }
      } else {
        planet.garrison -= 1;
        if (planet.garrison < 0) {
          planet.owner = ship.owner;
          planet.garrison = 1;
          planet.capturePulse = 0.6;
          // Reset ring fill — captured planets start with empty rings so the
          // new owner must invest absorb to keep the growth path.
          planet.ringFillProgress = new Array(planet.ringCount).fill(0);
          planet.absorbing = false;
          planet.health = planet.maxHealth;
          // On capture, evict any leftover orbiters of the prior owner.
          this.evictOrbitersOf(planet.id, ship.owner);
          this.events.onPlanetCapture?.(planet.id, ship.owner);
        }
      }
    }
    this.events.onShipArrive?.(planet.id, ship.owner, friendly);
    this.ships.kill(shipIdx);
  }

  /** Kill every orbiter of `planetId` whose owner differs from `keepOwner`. */
  private evictOrbitersOf(planetId: number, keepOwner: number): void {
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s.active) continue;
      if (s.state !== 'orbiting' || s.parentPlanet !== planetId) continue;
      if (s.owner !== keepOwner) this.ships.kill(i);
    }
  }

  private checkGameOver(): void {
    const alive = new Set<number>();
    for (const p of this.planets) if (p.owner !== null) alive.add(p.owner);
    for (const s of this.ships.all) if (s.active) alive.add(s.owner);
    for (const a of alive) this.playersSeen.add(a);
    // Don't end the match until at least two players have actually entered.
    if (this.playersSeen.size < 2) return;
    if (alive.size <= 1) {
      this.gameOver = true;
      this.winner = alive.size === 1 ? [...alive][0] : null;
      this.events.onGameOver?.(this.winner);
    }
  }

  planetAt(worldX: number, worldY: number, slop = 6): Planet | null {
    for (const p of this.planets) {
      const d = dist({ x: worldX, y: worldY }, p.pos);
      if (d <= p.radius + slop) return p;
    }
    return null;
  }

  totalGarrison(owner: number): number {
    let t = 0;
    for (const p of this.planets) if (p.owner === owner) t += p.garrison;
    for (const s of this.ships.all) {
      if (s.active && s.owner === owner && s.state === 'transit') t += 1;
    }
    return t;
  }
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
