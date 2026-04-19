import { dist, vec, type Vec2 } from '../../util/math.js';
import {
  BASE_PRODUCTION,
  filledRingCount,
  productionMultiplier,
  type Planet,
  type PlanetType,
} from './Planet.js';
import type { Player } from './Player.js';
import { ShipPool } from './Ship.js';
import { createStream, type ShipStream } from './Stream.js';

export interface MapSpec {
  width: number;
  height: number;
  planets: Array<{
    pos: Vec2;
    radius: number;
    owner: number | null;
    garrison: number;
    type?: PlanetType;
  }>;
  edges: Array<[number, number]>;
}

export interface WorldEvents {
  onShipLaunch?: (owner: number) => void;
  onPlanetCapture?: (planetId: number, newOwner: number) => void;
  /** Fired when a ship lands. `friendly` = arrived at an owned planet. */
  onShipArrive?: (planetId: number, owner: number, friendly: boolean) => void;
  /** Fired when garrison crosses a new ring threshold (or a ring opens up). */
  onRingFilled?: (planetId: number, ringIndex: number, owner: number) => void;
  onGameOver?: (winner: number | null) => void;
}

export const SHIP_SPEED = 48;
/**
 * Interval between successive ships in a wave. Kept short on purpose —
 * Auralux releases the selected ships as a quick burst rather than a
 * continuous trickle, so a batch of ~20 drains in well under a second.
 */
export const DEFAULT_EMIT_INTERVAL = 0.035;
/** Max random exit-cone angle, in radians, around the direct line to target. */
const EXIT_CONE = Math.PI / 3; // ±60°

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
      const type: PlanetType = p.type ?? 0;
      const planet: Planet = {
        id: i,
        pos: { ...p.pos },
        radius: p.radius,
        owner: p.owner,
        garrison: p.garrison,
        type,
        productionRate: BASE_PRODUCTION[type],
        productionAcc: 0,
        capturePulse: 0,
        ringsFilled: 0,
      };
      planet.ringsFilled = filledRingCount(planet);
      return planet;
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
   * Streams no longer auto-refill from production — callers must tap/drag again.
   */
  openStream(owner: number, source: number, target: number, count?: number): void {
    if (source === target) return;
    const src = this.planets[source];
    if (src.owner !== owner) return;
    const path = this.findPath(source, target);
    if (path.length < 2) return;
    const nextHop = path[1];
    const remaining = count === undefined ? src.garrison : Math.min(count, src.garrison);
    if (remaining <= 0) return;
    this.cancelStreamsFrom(source, owner);
    this.streams.push(createStream(owner, source, nextHop, DEFAULT_EMIT_INTERVAL, remaining));
    if (nextHop !== target) {
      this.queueDownstream(owner, path, remaining);
    }
  }

  private queueDownstream(owner: number, path: number[], remaining: number): void {
    for (let i = 1; i < path.length - 1; i++) {
      const s = path[i];
      const t = path[i + 1];
      if (this.planets[s].owner === owner) {
        this.cancelStreamsFrom(s, owner);
        this.streams.push(createStream(owner, s, t, DEFAULT_EMIT_INTERVAL, remaining));
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

  step(dt: number): void {
    if (this.gameOver) return;
    this.time += dt;

    // Production. Output scales by how many of the planet's capacity rings are
    // currently filled — this is the Auralux Constellations growth loop, where
    // investing garrison in a ringed planet upgrades it into a faster source.
    for (const p of this.planets) {
      if (p.capturePulse > 0) p.capturePulse = Math.max(0, p.capturePulse - dt);
      if (p.owner === null) continue;
      const mult = productionMultiplier(p);
      p.productionAcc += p.productionRate * mult * dt;
      while (p.productionAcc >= 1) {
        p.productionAcc -= 1;
        p.garrison += 1;
        this.notifyRingChange(p);
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
        const tgt = this.planets[s.target];
        const dirX = tgt.pos.x - src.pos.x;
        const dirY = tgt.pos.y - src.pos.y;
        const baseAngle = Math.atan2(dirY, dirX);

        // Random exit angle inside a wide cone facing the target — keeps
        // departures organic instead of all single-file.
        const exitAngle = baseAngle + (Math.random() - 0.5) * EXIT_CONE;
        const exitR = src.radius + 2 + Math.random() * (src.radius * 0.25);
        const spawnPos = vec(
          src.pos.x + Math.cos(exitAngle) * exitR,
          src.pos.y + Math.sin(exitAngle) * exitR,
        );

        // Initial heading: blends the exit angle with the direct line so
        // ships immediately curve back toward the target rather than
        // launching straight outward.
        const headingAngle = baseAngle + (exitAngle - baseAngle) * 0.55;
        const turnRate = 1.4 + Math.random() * 1.6; // rad/sec
        const wobbleAmp = (Math.random() - 0.5) * 0.6; // signed lateral push
        const wobblePhase = Math.random() * Math.PI * 2;

        this.ships.spawn(s.owner, spawnPos, s.target, SHIP_SPEED, {
          vx: Math.cos(headingAngle) * SHIP_SPEED,
          vy: Math.sin(headingAngle) * SHIP_SPEED,
          turnRate,
          wobbleAmp,
          wobblePhase,
        });
        this.events.onShipLaunch?.(s.owner);
      }
    }

    // Drop finished streams and any whose source is no longer owned by the streamer.
    this.streams = this.streams.filter(
      (s) => s.remaining > 0 && this.planets[s.source].owner === s.owner,
    );

    // Ship movement + arrival.
    // Each ship steers its velocity toward the target with a per-ship turn
    // rate, plus a sinusoidal lateral wobble that fades as it nears the
    // planet — together these give the swarm a flowing, non-linear look
    // without any ship missing the target.
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      if (!ship.active) continue;
      ship.age += dt;
      const tgt = this.planets[ship.targetPlanet];
      const dx = tgt.pos.x - ship.x;
      const dy = tgt.pos.y - ship.y;
      const d = Math.hypot(dx, dy);
      if (d <= tgt.radius + 1) {
        this.arrive(i, tgt);
        continue;
      }

      // Steer current heading toward desired heading.
      const desired = Math.atan2(dy, dx);
      const current = Math.atan2(ship.vy, ship.vx);
      let delta = desired - current;
      // Wrap to [-PI, PI].
      if (delta > Math.PI) delta -= Math.PI * 2;
      else if (delta < -Math.PI) delta += Math.PI * 2;
      const maxTurn = ship.turnRate * dt;
      const turn = Math.max(-maxTurn, Math.min(maxTurn, delta));
      let newAng = current + turn;

      // Lateral wobble — a perpendicular nudge that decays near the target,
      // so ships meander mid-flight but settle on a clean approach.
      const approachFalloff = Math.min(1, d / 80);
      const wobble =
        Math.sin(this.time * 3.2 + ship.wobblePhase) * ship.wobbleAmp * approachFalloff;
      newAng += wobble * dt * 4;

      ship.vx = Math.cos(newAng) * ship.speed;
      ship.vy = Math.sin(newAng) * ship.speed;

      const step = ship.speed * dt;
      if (step >= d) {
        this.arrive(i, tgt);
      } else {
        ship.x += ship.vx * dt;
        ship.y += ship.vy * dt;
      }
    }

    this.checkGameOver();
  }

  private arrive(shipIdx: number, planet: Planet): void {
    const ship = this.ships.get(shipIdx);
    const friendly = planet.owner === ship.owner;
    if (friendly) {
      planet.garrison += 1;
    } else {
      planet.garrison -= 1;
      if (planet.garrison < 0) {
        planet.owner = ship.owner;
        planet.garrison = 1;
        planet.capturePulse = 0.6;
        planet.ringsFilled = 0;
        this.events.onPlanetCapture?.(planet.id, ship.owner);
      }
    }
    this.events.onShipArrive?.(planet.id, ship.owner, friendly);
    this.notifyRingChange(planet);
    this.ships.kill(shipIdx);
  }

  /**
   * Detect ring threshold crossings (in either direction) and notify listeners.
   * Crossing a threshold upward is an "upgrade" moment — the visible ring fills
   * and production multiplies.
   */
  private notifyRingChange(planet: Planet): void {
    if (planet.owner === null) {
      planet.ringsFilled = 0;
      return;
    }
    const filled = filledRingCount(planet);
    if (filled > planet.ringsFilled) {
      for (let k = planet.ringsFilled; k < filled; k++) {
        this.events.onRingFilled?.(planet.id, k, planet.owner);
      }
    }
    planet.ringsFilled = filled;
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
    for (const s of this.ships.all) if (s.active && s.owner === owner) t += 1;
    return t;
  }
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
