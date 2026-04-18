import { dist, norm, sub, vec, type Vec2 } from '../../util/math.js';
import { BASE_PRODUCTION, type Planet, type PlanetType } from './Planet.js';
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
  onGameOver?: (winner: number | null) => void;
}

export const SHIP_SPEED = 48;
export const DEFAULT_EMIT_INTERVAL = 0.12;

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
      return {
        id: i,
        pos: { ...p.pos },
        radius: p.radius,
        owner: p.owner,
        garrison: p.garrison,
        type,
        productionRate: BASE_PRODUCTION[type],
        productionAcc: 0,
        capturePulse: 0,
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

    // Production
    for (const p of this.planets) {
      if (p.capturePulse > 0) p.capturePulse = Math.max(0, p.capturePulse - dt);
      if (p.owner === null) continue;
      p.productionAcc += p.productionRate * dt;
      while (p.productionAcc >= 1) {
        p.productionAcc -= 1;
        p.garrison += 1;
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
        const dir = norm(sub(tgt.pos, src.pos));
        const spawnPos = vec(
          src.pos.x + dir.x * (src.radius + 2),
          src.pos.y + dir.y * (src.radius + 2),
        );
        this.ships.spawn(s.owner, spawnPos, s.target, SHIP_SPEED);
        this.events.onShipLaunch?.(s.owner);
      }
    }

    // Drop finished streams and any whose source is no longer owned by the streamer.
    this.streams = this.streams.filter(
      (s) => s.remaining > 0 && this.planets[s.source].owner === s.owner,
    );

    // Ship movement + arrival
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      if (!ship.active) continue;
      const tgt = this.planets[ship.targetPlanet];
      const dx = tgt.pos.x - ship.x;
      const dy = tgt.pos.y - ship.y;
      const d = Math.hypot(dx, dy);
      const step = ship.speed * dt;
      if (d <= tgt.radius + 1 || step >= d) {
        this.arrive(i, tgt);
      } else {
        ship.x += (dx / d) * step;
        ship.y += (dy / d) * step;
      }
    }

    this.checkGameOver();
  }

  private arrive(shipIdx: number, planet: Planet): void {
    const ship = this.ships.get(shipIdx);
    if (planet.owner === ship.owner) {
      planet.garrison += 1;
    } else {
      planet.garrison -= 1;
      if (planet.garrison < 0) {
        planet.owner = ship.owner;
        planet.garrison = 1;
        planet.capturePulse = 0.6;
        this.events.onPlanetCapture?.(planet.id, ship.owner);
      }
    }
    this.ships.kill(shipIdx);
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
