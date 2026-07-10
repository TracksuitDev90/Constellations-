import { dist, vec, type Vec2 } from '../../util/math.js';
import { NeutralPool } from './Neutral.js';
import {
  BASE_MAX_HEALTH,
  BASE_PRODUCTION,
  BASE_UNIT_CAPACITY,
  SIZE_RADIUS,
  clampRingCount,
  ringCapacity,
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
  /**
   * Up to two entries of distinct kinds. Each hazardous match rolls one
   * hazard (drifting planet, asteroid belt, or neutral green swarm), with
   * a chance of a second — enough variety that every level feels different
   * without overwhelming the strategic read.
   */
  hazards?: HazardSpec[];
}

/**
 * One per-level "world hazard" — picked at map generation time. Discriminated
 * union so each variant carries only the data it needs.
 *
 *   - driftingPlanet: a single planet drifts in a straight line at vx/vy and
 *     bounces off the map bounds. Edges and pathfinding still reference its
 *     id, so streams keep flowing — the world just won't sit still.
 *   - asteroidField: a circular zone that multiplies transit-ship speed by
 *     `slowdown` (e.g. 0.35). Doesn't kill ships, just delays them — useful
 *     for forcing detours or surviving longer through a chokepoint.
 *   - neutralSwarm: a pack of green hostiles spawned around `pos`. They
 *     wander a `patrolRadius` and shoot down the nearest in-range ship of
 *     ANY owner, but never capture planets. Their own units die when killed
 *     in a 1:1 exchange; they respawn slowly so the swarm thins under
 *     sustained attack. When `guardPlanetId` is set the swarm is a guardian:
 *     its anchor follows that planet (even if it drifts) and respawning stops
 *     for good once the planet is captured — clear the prize, break the pack.
 *   - blackHole: a gravity well at `pos`. Free-flying ships inside
 *     `gravityRadius` are pulled toward the center; anything that crosses the
 *     capture threshold is locked into a slow terminal spiral and consumed at
 *     the event horizon. The outer band doubles as a slingshot lane — ships
 *     riding it fly meaningfully faster — so the hardest hazard is also the
 *     boldest shortcut.
 *   - flareStar: a volatile star that detonates every `period` seconds,
 *     sending a shockwave from its core out to `maxRadius` at `waveSpeed`.
 *     The wavefront destroys every free-flying ship it sweeps (orbiting
 *     garrisons are sheltered by their planet). The blast is telegraphed —
 *     the star visibly overcharges before it pops — so crossing the zone is
 *     a timing game: dart through between pulses or pay in ships.
 *   - wormhole: a linked pair of gates at `a` and `b`. A transit ship that
 *     flies into either mouth is thrown out of the other, keeping its
 *     heading. Ships automatically route through a gate whenever the gate
 *     path is meaningfully shorter than the direct line — for every player,
 *     so a wormhole is both your shortcut and the enemy's flank route.
 */
export type HazardSpec =
  | { type: 'driftingPlanet'; planetId: number; vx: number; vy: number }
  | { type: 'asteroidField'; pos: Vec2; radius: number; slowdown: number; seed: number }
  | {
      type: 'neutralSwarm';
      pos: Vec2;
      count: number;
      patrolRadius: number;
      seed: number;
      guardPlanetId?: number;
    }
  | { type: 'blackHole'; pos: Vec2; horizonRadius: number; gravityRadius: number; seed: number }
  | {
      type: 'flareStar';
      pos: Vec2;
      period: number;
      waveSpeed: number;
      maxRadius: number;
      seed: number;
    }
  | { type: 'wormhole'; a: Vec2; b: Vec2; radius: number; seed: number };

export interface AsteroidField {
  pos: Vec2;
  radius: number;
  slowdown: number;
  seed: number;
}

export interface BlackHole {
  pos: Vec2;
  /** Radius of the event horizon — ships are consumed here. */
  horizonRadius: number;
  /** Outer reach of the gravity pull. Beyond this, ships fly unaffected. */
  gravityRadius: number;
  /**
   * Point of no return: crossing this switches a ship into the 'doomed'
   * scripted spiral. Derived from horizonRadius at world construction.
   */
  captureRadius: number;
  seed: number;
}

export interface FlareStar {
  pos: Vec2;
  /** Seconds of charge-up between detonations. */
  period: number;
  /** Shockwave expansion speed (px/s). */
  waveSpeed: number;
  /** Blast reach — the wave dies here and the star begins recharging. */
  maxRadius: number;
  seed: number;
  /** Charge accumulated toward the next detonation (renderer reads this). */
  charge: number;
  /** Current shockwave radius, or -1 while the star is recharging. */
  waveRadius: number;
}

export interface Wormhole {
  a: Vec2;
  b: Vec2;
  /** Mouth radius — a transit ship inside either mouth is warped. */
  radius: number;
  seed: number;
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
  /** Fired when a neutral hostile is destroyed. Carries world-space death point. */
  onNeutralDeath?: (x: number, y: number) => void;
  /** Fired when a ship finishes its doomed spiral and crosses a black hole's horizon. */
  onShipConsumed?: (owner: number, x: number, y: number) => void;
  /** Fired when a flare star detonates (start of a shockwave). */
  onFlareDetonate?: (x: number, y: number) => void;
  /** Fired when a ship rides a wormhole. Carries entry and exit points. */
  onShipWarp?: (owner: number, fromX: number, fromY: number, toX: number, toY: number) => void;
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

/** Target orbit radius around a planet, expressed as a multiple of planet
 * radius. Exported so input handling can treat a tap on the visible swarm
 * band as a tap on the planet it belongs to. */
export const ORBIT_RADIUS_MULT = 1.75;
/** How far (px) inside the orbit band counts as "settled into orbit". */
const ORBIT_SETTLE_TOLERANCE = 3;
/** How far (px) from planet center before an absorbing unit is consumed. */
const ABSORB_CONSUME_DIST = 3;
/**
 * Max rate (ghosts/sec) at which phantom garrison is converted into visible
 * absorbing ships. Tuned so even an XXL with a full overflow staggers its
 * flush over a readable second or two instead of popping in a single frame.
 */
const ABSORB_FLUSH_RATE = 14;
/**
 * Hard ceiling on live orbiters a friendly planet can accept from arriving
 * reinforcements — higher than the per-size `maxUnitCapacity` that gates
 * native production, so a player stacking extra waves on a captured world
 * sees the swarm visibly thicken instead of silently topping out at the
 * base size cap. Safety net to keep the O(n²) orbit separation cheap.
 */
const REINFORCEMENT_ORBIT_CAP = 300;

/**
 * Black hole tuning. The capture threshold sits well outside the horizon so a
 * ship is visibly committed (~1s of flight) before it starts the spiral, and
 * peak gravity is strong enough that a straight line through the inner half
 * of the well is fatal while a pass along the rim only bends the flight path.
 */
const BLACK_HOLE_CAPTURE_MULT = 2.6;
/** Peak gravitational acceleration (px/s²) at the capture threshold. */
const BLACK_HOLE_G_PEAK = 110;
/**
 * Slingshot band: the safe part of a gravity well, from just outside the
 * capture threshold out to the gravity radius. Ships riding the band get a
 * speed-cap lift that peaks mid-band — the well bends their path AND speeds
 * them up, so shaving close to a black hole is a genuine fast lane with a
 * fatal inner edge. Exported so the AI can price the same tradeoff.
 */
export const SLINGSHOT_INNER_MULT = 1.15;
/** Peak speed multiplier at the middle of the slingshot band. */
export const SLINGSHOT_PEAK_BOOST = 1.35;
/** Radial infall speed (px/s) at the capture rim... */
const DOOM_INFALL_BASE = 8;
/** ...climbing by this much as the spiral closes on the horizon. */
const DOOM_INFALL_ACCEL = 30;
/** Angular speed (rad/s) of the doomed spiral at the rim / added near center. */
const DOOM_SPIN_BASE = 1.4;
const DOOM_SPIN_ACCEL = 3.4;

/**
 * Wormhole tuning. The cooldown keeps a freshly-warped ship from being
 * re-swallowed while it clears the exit mouth; the detour margin is how many
 * pixels of path a gate must actually save before a transit ship bothers
 * steering into it — without it, near-tie routes make waves split and dither.
 */
export const WARP_COOLDOWN = 1.5;
const WORMHOLE_EXIT_PAD = 8;
const WORMHOLE_DETOUR_MARGIN = 60;
/** Extra sweep slack (px) behind the flare wavefront so no ship slips between frames. */
const FLARE_WAVE_PAD = 2;

/** True when the planet still has something absorb can usefully fill. */
const canAbsorb = (p: Planet): boolean =>
  p.ringCount > 0 || p.health < p.maxHealth;

/** Boids tuning for transit swarms. Kept gentle — ships must still arrive. */
const SEPARATION_RADIUS = 9;
const SEPARATION_WEIGHT = 22;
const COHESION_RADIUS = 38;
const COHESION_WEIGHT = 4;
const SEEK_WEIGHT = 60;

/**
 * Cell size of the shared per-tick spatial grid. Sized to the largest
 * neighbor-query radius (cohesion) so a 3×3 cell sweep always covers it;
 * separation and combat use the same grid with tighter distance checks.
 */
const GRID_CELL = COHESION_RADIUS;
/**
 * Collision-free packing of a (cellX, cellY) pair into one integer key.
 * The +0x8000 bias keeps the packing valid for negative cells — ships can
 * drift slightly past the map bounds (boids push, free-space hover points),
 * and the previous `cx * 100000 + cy` scheme silently corrupted keys there.
 */
const gridKey = (cx: number, cy: number): number =>
  (cx + 0x8000) * 0x10000 + (cy + 0x8000);

export class World {
  players: Player[];
  planets: Planet[];
  edges: Set<string>;
  neighbors: Map<number, number[]>;
  streams: ShipStream[] = [];
  ships: ShipPool = new ShipPool();
  /**
   * Static hazard zones (asteroid belts), any number per match;
   * `stepTransit` consults this list to apply a per-zone speed multiplier.
   */
  asteroidFields: AsteroidField[] = [];
  /** Gravity wells from the `blackHole` hazard; consulted by every flight pass. */
  blackHoles: BlackHole[] = [];
  /** Periodic shockwave stars from the `flareStar` hazard. */
  flareStars: FlareStar[] = [];
  /** Linked gate pairs from the `wormhole` hazard. */
  wormholes: Wormhole[] = [];
  /** Pool of green hostile units spawned by the `neutralSwarm` hazard. */
  neutrals: NeutralPool = new NeutralPool();
  time = 0;
  width: number;
  height: number;
  gameOver = false;
  winner: number | null = null;
  private events: WorldEvents;
  private playersSeen = new Set<number>();
  /**
   * Per-tick spatial hash of all active ships, rebuilt once at the top of
   * `step()` and shared by every neighbor query (boids separation/cohesion,
   * orbit separation, hover separation, mid-flight combat). Bucket arrays are
   * pooled across frames so the rebuild allocates nothing in steady state.
   */
  private grid = new Map<number, number[]>();
  private gridBucketPool: number[][] = [];
  /** Reusable scratch buffer returned by `gatherNeighbors`. */
  private neighborScratch: number[] = [];
  /** Reusable output vector for `orbitSeparation` (avoids per-ship allocs). */
  private sepScratch = { x: 0, y: 0 };
  /** Per-tick pursuit claims (ship idx → pursuer count) for pack-splitting. */
  private pursuerCounts = new Map<number, number>();
  /**
   * Anchor points for any spawned neutral swarms. Neutrals patrol around
   * these anchors and respawn slowly if killed below the swarm's nominal
   * size, keeping the hazard a persistent threat rather than a one-shot.
   */
  private neutralAnchors: Array<{
    pos: Vec2;
    patrolRadius: number;
    targetCount: number;
    respawnAcc: number;
    /**
     * Planet this swarm guards, or -1 for a free-floating swarm. A guardian
     * anchor tracks its planet's position every tick and stops respawning
     * once the planet is captured by anyone.
     */
    guardPlanetId: number;
  }> = [];

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
        absorbFlushAcc: 0,
        health: maxHealth,
        maxHealth,
        vx: 0,
        vy: 0,
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
    // Seed live orbiters for authored starting garrisons so the opening
    // swarm is real, tappable units (Auralux starts you with a swarm you
    // can immediately gather) — not phantom garrison that only turns into
    // ships as new production ticks in.
    for (const p of this.planets) {
      if (p.owner === null) continue;
      const live = Math.min(p.garrison, p.maxUnitCapacity);
      for (let i = 0; i < live; i++) this.seedOrbiter(p);
    }

    // Apply hazards from the spec. Discriminated union — only the variant
    // matched by `type` carries the relevant data.
    for (const h of map.hazards ?? []) {
      if (h.type === 'driftingPlanet') {
        const p = this.planets[h.planetId];
        if (p) {
          p.vx = h.vx;
          p.vy = h.vy;
        }
      } else if (h.type === 'asteroidField') {
        this.asteroidFields.push({
          pos: { ...h.pos },
          radius: h.radius,
          slowdown: h.slowdown,
          seed: h.seed,
        });
      } else if (h.type === 'neutralSwarm') {
        const anchorIdx = this.neutralAnchors.length;
        const guardPlanet =
          h.guardPlanetId !== undefined ? this.planets[h.guardPlanetId] : undefined;
        this.neutralAnchors.push({
          // A guardian swarm centers exactly on its prize.
          pos: guardPlanet ? { ...guardPlanet.pos } : { ...h.pos },
          patrolRadius: h.patrolRadius,
          targetCount: h.count,
          respawnAcc: 0,
          guardPlanetId: guardPlanet ? guardPlanet.id : -1,
        });
        for (let i = 0; i < h.count; i++) {
          this.spawnNeutralAt(anchorIdx);
        }
      } else if (h.type === 'blackHole') {
        this.blackHoles.push({
          pos: { ...h.pos },
          horizonRadius: h.horizonRadius,
          gravityRadius: h.gravityRadius,
          captureRadius: h.horizonRadius * BLACK_HOLE_CAPTURE_MULT,
          seed: h.seed,
        });
      } else if (h.type === 'flareStar') {
        this.flareStars.push({
          pos: { ...h.pos },
          period: h.period,
          waveSpeed: h.waveSpeed,
          maxRadius: h.maxRadius,
          seed: h.seed,
          // Stagger the opening charge off the seed so twin stars never sync
          // and the first blast isn't instant.
          charge: ((h.seed % 997) / 997) * h.period * 0.6,
          waveRadius: -1,
        });
      } else if (h.type === 'wormhole') {
        this.wormholes.push({
          a: { ...h.a },
          b: { ...h.b },
          radius: h.radius,
          seed: h.seed,
        });
      }
    }
  }

  hasEdge(a: number, b: number): boolean {
    return this.edges.has(edgeKey(a, b));
  }

  /**
   * Send a one-shot wave of ships straight from source to target. Movement
   * is free-flight (Auralux-style) — the constellation edge lines are purely
   * decorative, so a wave crosses open space directly and can be intercepted
   * anywhere along the way. If `count` is omitted, the entire current
   * garrison of the source launches. Streams are discrete — the player taps
   * again for another wave.
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
    if (!src || src.owner !== owner) return;
    if (!this.planets[target]) return;
    const remaining = count === undefined ? src.garrison : Math.min(count, src.garrison);
    if (remaining <= 0) return;
    this.cancelStreamsFrom(source, owner);
    this.streams.push(
      createStream(
        owner,
        source,
        target,
        DEFAULT_EMIT_INTERVAL,
        remaining,
        opts.absorbOnArrive ?? false,
      ),
    );
  }

  cancelStreamsFrom(source: number, owner: number): void {
    this.streams = this.streams.filter((s) => !(s.source === source && s.owner === owner));
  }

  cancelAllStreamsOf(owner: number): void {
    this.streams = this.streams.filter((s) => s.owner !== owner);
  }

  /**
   * Toggle absorption mode on a friendly planet. While absorbing, orbit units
   * are pulled into the center and consumed — feeding either health (if damaged)
   * or the upgrade meter (which converts into permanent production gains).
   *
   * No-op when a planet has nothing left to absorb into (no unfilled rings
   * and full health): sparing the player from silently feeding units into a
   * sink with no visible payoff.
   */
  triggerAbsorb(planetId: number, owner: number, enabled = true): void {
    const p = this.planets[planetId];
    if (!p || p.owner !== owner) return;
    if (enabled && !canAbsorb(p)) return;
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
    // case (garrison > live-orbiter cap) so commanding a planet's FULL
    // swarm always leaves it at zero. Skipped while the planet still has
    // live orbiters — that means this was a fractional (half) send and the
    // remaining garrison is intentionally staying home.
    for (const pid of drained) {
      if (planetTarget && pid === target.planetId) continue;
      const src = this.planets[pid];
      if (!src || src.owner !== owner) continue;
      if (this.countOrbitersOf(pid) > 0) continue;
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

    // Drift — almost always a no-op (vx == vy == 0). When a planet has the
    // `driftingPlanet` hazard, this advances its position and bounces off
    // the world bounds so it stays in play. Bounds are inset by the planet's
    // radius so it never half-clips the edge.
    for (const p of this.planets) {
      if (p.vx === 0 && p.vy === 0) continue;
      p.pos.x += p.vx * dt;
      p.pos.y += p.vy * dt;
      const minX = p.radius;
      const minY = p.radius;
      const maxX = this.width - p.radius;
      const maxY = this.height - p.radius;
      if (p.pos.x < minX) {
        p.pos.x = minX;
        p.vx = Math.abs(p.vx);
      } else if (p.pos.x > maxX) {
        p.pos.x = maxX;
        p.vx = -Math.abs(p.vx);
      }
      if (p.pos.y < minY) {
        p.pos.y = minY;
        p.vy = Math.abs(p.vy);
      } else if (p.pos.y > maxY) {
        p.pos.y = maxY;
        p.vy = -Math.abs(p.vy);
      }
    }

    // Production. Bigger planets produce meaningfully faster; growth comes
    // from evolving the planet via ring fill (Auralux: Constellations' "explode
    // into a bigger size" mechanic), not from a ring-count multiplier.
    for (const p of this.planets) {
      if (p.capturePulse > 0) p.capturePulse = Math.max(0, p.capturePulse - dt);
      if (p.evolvePulse > 0) p.evolvePulse = Math.max(0, p.evolvePulse - dt * 0.9);
      if (p.owner === null) continue;

      if (p.absorbing) {
        // While absorbing, production still runs — but new units are born
        // already pulling for the center, so the rings keep filling instead
        // of stalling once the existing orbit drains. Auto-cancel absorb
        // once there's nothing left to feed so we don't silently burn units.
        if (!canAbsorb(p)) {
          p.absorbing = false;
        } else {
          p.productionAcc += p.productionRate * dt;
          while (p.productionAcc >= 1) {
            p.productionAcc -= 1;
            p.garrison += 1;
            this.spawnAbsorbingGhost(p);
          }
          // Flush residual garrison that never got a live orbiter (production
          // overflow from before absorb turned on, or from hitting the orbit
          // cap). Rate-limited so a big planet staggers its flush rather than
          // popping 60 ghosts on a single frame.
          const local = this.countLocalShipsOf(p.id);
          const phantom = Math.max(0, p.garrison - local);
          if (phantom > 0) {
            p.absorbFlushAcc += ABSORB_FLUSH_RATE * dt;
            const burst = Math.min(phantom, Math.floor(p.absorbFlushAcc));
            if (burst > 0) {
              p.absorbFlushAcc -= burst;
              for (let i = 0; i < burst; i++) this.spawnAbsorbingGhost(p);
            }
          } else {
            p.absorbFlushAcc = 0;
          }
          continue;
        }
      }

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

    // Drop finished streams, and streams whose source planet the streamer no
    // longer owns — they can never fire again and would otherwise leak.
    this.streams = this.streams.filter((s) => {
      if (s.remaining <= 0) return false;
      const src = this.planets[s.source];
      return !!src && src.owner === s.owner;
    });

    // Ship simulation. Each state runs its own steering pass. Neighbor
    // lookups (separation / cohesion / combat) all go through one spatial
    // grid built here from start-of-tick positions — O(n) instead of the
    // old O(n²) all-pairs scans, which is what kept big battles playable
    // on phones.
    this.rebuildGrid();
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      if (!ship.active) continue;
      ship.age += dt;
      if (ship.warpCooldown > 0) ship.warpCooldown -= dt;
      if (ship.state === 'orbiting') this.stepOrbiting(i, ship, dt);
      else if (ship.state === 'absorbing') this.stepAbsorbing(i, ship, dt);
      else if (ship.state === 'hovering') this.stepHovering(ship, dt, ships);
      else if (ship.state === 'doomed') this.stepDoomed(i, ship, dt);
      else this.stepTransit(i, ship, dt, ships);
    }

    // Mid-flight combat: enemy streams that cross destroy each other 1:1.
    this.stepShipCombat();

    // Flare stars: advance charge timers and sweep any active shockwaves.
    this.stepFlareStars(dt);

    // Neutral hostile pass — wandering green units that attack any ship in
    // range regardless of owner, and never capture planets.
    this.stepNeutrals(dt);

    this.checkGameOver();
  }

  /**
   * Spawn one neutral hostile somewhere in the patrol zone of `anchorIdx`.
   * Spawn position is jittered inside the patrol radius so the swarm reads
   * as a loose cloud rather than a perfect circle.
   */
  private spawnNeutralAt(anchorIdx: number): void {
    const anchor = this.neutralAnchors[anchorIdx];
    if (!anchor) return;
    const a = Math.random() * Math.PI * 2;
    const r = anchor.patrolRadius * Math.sqrt(Math.random());
    this.neutrals.spawn(
      anchor.pos.x + Math.cos(a) * r,
      anchor.pos.y + Math.sin(a) * r,
      Math.random() * Math.PI * 2,
      anchorIdx,
    );
  }

  /**
   * Per-tick neutral hostiles update. The swarm runs a small state machine:
   *
   *   patrol — wander the anchor's patrol band (the original drifting cloud).
   *   pursue — chase a detected intruder with lead-predicted intercept, up to
   *            a leash distance from home. Pursuit is slower than SHIP_SPEED,
   *            so committed waves outrun the pack — the swarm punishes ships
   *            that graze its territory, it doesn't erase armies.
   *   return — leash snapped or target lost: fly home, then resume patrol.
   *   doomed — captured by a black hole; rides the same terminal spiral as
   *            player ships. A pursuing neutral follows prey straight into
   *            the well — kiting the swarm into a hole is fair play.
   *
   * Kills stay 1:1 mutual (the neutral dies in the exchange) and the slow
   * respawn keeps the swarm a persistent threat without flooding the map.
   */
  private stepNeutrals(dt: number): void {
    if (this.neutralAnchors.length === 0 && this.neutrals.activeCount() === 0) return;
    const PATROL_SPEED = 22;
    const PURSUE_SPEED = 36;
    const RETURN_SPEED = PATROL_SPEED * 1.3;
    const DETECT_RADIUS = 90;
    const DETECT_R2 = DETECT_RADIUS * DETECT_RADIUS;
    // Give up when the target pulls beyond 1.6× detection range.
    const DROP_R2 = DETECT_R2 * (1.6 * 1.6);
    const KILL_RADIUS = 14;
    const KILL_R2 = KILL_RADIUS * KILL_RADIUS;
    // Leash: patrol band plus a comfortable chase margin past the detection
    // ring, so anything a neutral can see it can also run down before the
    // leash snaps — but never a map-crossing chase.
    const LEASH_MARGIN = DETECT_RADIUS * 1.2;
    const MAX_PURSUERS_PER_TARGET = 3;
    const SEP_RADIUS = 12;
    const RESPAWN_INTERVAL = 6.5;

    const all = this.neutrals.all;
    const ships = this.ships.all;

    // Guardian anchors shadow their planet so the pack keeps circling the
    // prize even when the driftingPlanet hazard carries it across the map.
    for (const a of this.neutralAnchors) {
      if (a.guardPlanetId < 0) continue;
      const guarded = this.planets[a.guardPlanetId];
      if (guarded) {
        a.pos.x = guarded.pos.x;
        a.pos.y = guarded.pos.y;
      }
    }

    // Standing pursuit claims — lets late acquirers skip already-swarmed
    // targets so a pack naturally splits across a crossing wave.
    this.pursuerCounts.clear();
    for (const n of all) {
      if (!n.active || n.state !== 'pursue' || n.targetIdx < 0) continue;
      this.pursuerCounts.set(n.targetIdx, (this.pursuerCounts.get(n.targetIdx) ?? 0) + 1);
    }

    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (!n.active) continue;
      const anchor = this.neutralAnchors[n.anchorIdx];
      if (!anchor) {
        this.neutrals.kill(i);
        continue;
      }

      // Terminal black hole spiral — same math as doomed ships.
      if (n.state === 'doomed') {
        const bh = this.blackHoles[n.doomHoleIdx];
        if (!bh) {
          this.neutrals.kill(i);
          continue;
        }
        const depth = 1 - n.doomRadius / bh.captureRadius;
        const infall = DOOM_INFALL_BASE + DOOM_INFALL_ACCEL * depth;
        const angVel = n.doomDir * (DOOM_SPIN_BASE + DOOM_SPIN_ACCEL * depth);
        n.doomRadius -= infall * dt;
        n.doomAngle += angVel * dt;
        const r = Math.max(n.doomRadius, 0);
        n.x = bh.pos.x + Math.cos(n.doomAngle) * r;
        n.y = bh.pos.y + Math.sin(n.doomAngle) * r;
        n.heading = n.doomAngle + (n.doomDir > 0 ? Math.PI / 2 : -Math.PI / 2);
        if (n.doomRadius <= bh.horizonRadius) {
          this.events.onNeutralDeath?.(n.x, n.y);
          this.neutrals.kill(i);
        }
        continue;
      }

      // Black hole capture check (any live state).
      let captured = false;
      for (let h = 0; h < this.blackHoles.length; h++) {
        const bh = this.blackHoles[h];
        const bdx = n.x - bh.pos.x;
        const bdy = n.y - bh.pos.y;
        const bd = Math.hypot(bdx, bdy);
        if (bd <= bh.captureRadius) {
          n.state = 'doomed';
          n.doomHoleIdx = h;
          n.doomAngle = Math.atan2(bdy, bdx);
          n.doomRadius = Math.max(bd, bh.horizonRadius + 1);
          const cross = bdx * n.vy - bdy * n.vx;
          n.doomDir = cross >= 0 ? 1 : -1;
          n.targetIdx = -1;
          captured = true;
          break;
        }
      }
      if (captured) continue;

      const adx = anchor.pos.x - n.x;
      const ady = anchor.pos.y - n.y;
      const ad = Math.hypot(adx, ady);
      const leash = anchor.patrolRadius + LEASH_MARGIN;

      // Validate / drop the pursuit target before steering on it.
      if (n.state === 'pursue') {
        const t = n.targetIdx >= 0 ? ships[n.targetIdx] : undefined;
        const alive = t && t.active && t.state !== 'absorbing' && t.state !== 'doomed';
        if (!alive) {
          n.state = 'return';
          n.targetIdx = -1;
        } else {
          const dx = t.x - n.x;
          const dy = t.y - n.y;
          if (dx * dx + dy * dy > DROP_R2 || ad > leash) {
            n.state = 'return';
            n.targetIdx = -1;
          }
        }
      }

      // Acquire: nearest eligible intruder in detection range that isn't
      // already mobbed by the pack. Neutral counts are tiny, so the straight
      // scan over the ship pool stays cheap.
      if (n.state !== 'pursue' && ad < leash) {
        let bestIdx = -1;
        let bestD2 = DETECT_R2;
        for (let j = 0; j < ships.length; j++) {
          const s = ships[j];
          if (!s.active) continue;
          if (s.state === 'absorbing' || s.state === 'doomed') continue;
          if ((this.pursuerCounts.get(j) ?? 0) >= MAX_PURSUERS_PER_TARGET) continue;
          const dx = s.x - n.x;
          const dy = s.y - n.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdx = j;
          }
        }
        if (bestIdx >= 0) {
          n.state = 'pursue';
          n.targetIdx = bestIdx;
          this.pursuerCounts.set(bestIdx, (this.pursuerCounts.get(bestIdx) ?? 0) + 1);
        }
      }

      // Desired velocity by state.
      let desiredX: number;
      let desiredY: number;
      if (n.state === 'pursue') {
        const t = ships[n.targetIdx];
        const dx = t.x - n.x;
        const dy = t.y - n.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= KILL_R2) {
          // Contact — mutual kill keeps the swarm beatable and rewards
          // sustained pushes.
          this.events.onShipDeath?.(t.owner, t.x, t.y);
          this.ships.kill(n.targetIdx);
          this.events.onNeutralDeath?.(n.x, n.y);
          this.neutrals.kill(i);
          continue;
        }
        // Lead pursuit: aim where the target will be, not where it is. The
        // lead is deliberately shorter than the true time-to-intercept —
        // full lead makes a flanking pursuer run parallel to a faster
        // target instead of cutting in toward its path.
        const d = Math.sqrt(d2);
        const lead = Math.min(0.9, (d / PURSUE_SPEED) * 0.7);
        const aimX = t.x + t.vx * lead - n.x;
        const aimY = t.y + t.vy * lead - n.y;
        const am = Math.hypot(aimX, aimY) || 1;
        desiredX = (aimX / am) * PURSUE_SPEED;
        desiredY = (aimY / am) * PURSUE_SPEED;
      } else if (n.state === 'return') {
        if (ad <= anchor.patrolRadius * 0.9) {
          n.state = 'patrol';
        }
        const am = ad || 1;
        desiredX = (adx / am) * RETURN_SPEED;
        desiredY = (ady / am) * RETURN_SPEED;
      } else {
        // Patrol: the original sine wander with a proportional anchor pull
        // past the patrol band, so the swarm holds territory.
        n.heading += Math.sin(this.time * 0.7 + n.phase) * dt * 0.6;
        desiredX = Math.cos(n.heading) * PATROL_SPEED;
        desiredY = Math.sin(n.heading) * PATROL_SPEED;
        const outside = ad - anchor.patrolRadius;
        if (outside > 0 && ad > 0) {
          const k = Math.min(1, outside / anchor.patrolRadius);
          desiredX = desiredX * (1 - k) + (adx / ad) * PATROL_SPEED * k;
          desiredY = desiredY * (1 - k) + (ady / ad) * PATROL_SPEED * k;
        }
      }

      // Idle states shy away from gravity wells; a committed pursuer doesn't.
      if (n.state !== 'pursue') {
        for (const bh of this.blackHoles) {
          const bdx = n.x - bh.pos.x;
          const bdy = n.y - bh.pos.y;
          const bd = Math.hypot(bdx, bdy);
          const avoidR = bh.gravityRadius * 1.15;
          if (bd > 0 && bd < avoidR) {
            const k = 1 - bd / avoidR;
            desiredX += (bdx / bd) * PATROL_SPEED * 2 * k;
            desiredY += (bdy / bd) * PATROL_SPEED * 2 * k;
          }
        }
      }

      // Wing dynamics within the anchor's pack: hard separation up close, and
      // mild velocity alignment when packmates converge on the same target so
      // the group sweeps in as a formation instead of a knot.
      let alignX = 0;
      let alignY = 0;
      let alignN = 0;
      for (let j = 0; j < all.length; j++) {
        if (j === i) continue;
        const m = all[j];
        if (!m.active || m.anchorIdx !== n.anchorIdx || m.state === 'doomed') continue;
        const sx = n.x - m.x;
        const sy = n.y - m.y;
        const sd2 = sx * sx + sy * sy;
        if (sd2 > 0 && sd2 < SEP_RADIUS * SEP_RADIUS) {
          const sd = Math.sqrt(sd2);
          const push = (SEP_RADIUS - sd) / SEP_RADIUS;
          desiredX += (sx / sd) * PATROL_SPEED * push;
          desiredY += (sy / sd) * PATROL_SPEED * push;
        }
        if (n.state === 'pursue' && m.state === 'pursue' && m.targetIdx === n.targetIdx) {
          alignX += m.vx;
          alignY += m.vy;
          alignN++;
        }
      }
      if (alignN > 0) {
        desiredX += (alignX / alignN - n.vx) * 0.3;
        desiredY += (alignY / alignN - n.vy) * 0.3;
      }

      // Smooth toward the desired velocity — reads as banking, not snapping.
      const blend = Math.min(1, dt * (n.state === 'pursue' ? 6 : 2.5));
      n.vx += (desiredX - n.vx) * blend;
      n.vy += (desiredY - n.vy) * blend;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      if (n.vx !== 0 || n.vy !== 0) n.heading = Math.atan2(n.vy, n.vx);
    }

    // Slow respawn — top each anchor's swarm back up to its target count over
    // time. RESPAWN_INTERVAL governs how often a single missing slot refills,
    // so a heavily-thinned swarm takes meaningfully longer to recover.
    for (let ai = 0; ai < this.neutralAnchors.length; ai++) {
      const a = this.neutralAnchors[ai];
      // A guardian swarm whose prize has been claimed stops replenishing —
      // whittling it down is permanent progress, and the captured planet
      // isn't forever ringed by hostiles.
      if (a.guardPlanetId >= 0 && this.planets[a.guardPlanetId]?.owner !== null) {
        a.respawnAcc = 0;
        continue;
      }
      const live = this.neutrals.countAtAnchor(ai);
      if (live >= a.targetCount) {
        a.respawnAcc = 0;
        continue;
      }
      a.respawnAcc += dt;
      if (a.respawnAcc >= RESPAWN_INTERVAL) {
        a.respawnAcc -= RESPAWN_INTERVAL;
        this.spawnNeutralAt(ai);
      }
    }
  }

  /**
   * Rebuild the shared spatial grid from every active ship's current
   * position. Bucket arrays are recycled through `gridBucketPool` so a
   * steady-state battle rebuilds the grid with zero allocations.
   */
  private rebuildGrid(): void {
    for (const arr of this.grid.values()) {
      arr.length = 0;
      this.gridBucketPool.push(arr);
    }
    this.grid.clear();
    const ships = this.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s.active) continue;
      const key = gridKey(Math.floor(s.x / GRID_CELL), Math.floor(s.y / GRID_CELL));
      let arr = this.grid.get(key);
      if (!arr) {
        arr = this.gridBucketPool.pop() ?? [];
        this.grid.set(key, arr);
      }
      arr.push(i);
    }
  }

  /**
   * Collect ship indices from the 3×3 grid cells around (x, y) into the
   * reusable scratch buffer. Returns the number of valid entries. Cell size
   * equals the largest query radius (COHESION_RADIUS), so any check within
   * that radius only needs this one sweep. Callers must filter by state /
   * owner / distance themselves and must not hold onto the buffer.
   */
  private gatherNeighbors(x: number, y: number): number {
    const cx = Math.floor(x / GRID_CELL);
    const cy = Math.floor(y / GRID_CELL);
    const out = this.neighborScratch;
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.grid.get(gridKey(cx + dx, cy + dy));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) out[n++] = arr[k];
      }
    }
    return n;
  }

  /**
   * Check in-flight ships of different owners for proximity; any pair inside
   * `SHIP_COLLIDE_RADIUS` mutually destroys. Uses the shared spatial grid —
   * the `j > i` guard dedupes pairs, and because the grid cell (38) is far
   * larger than the collide radius (5), the 3×3 sweep always covers it.
   */
  private stepShipCombat(): void {
    const ships = this.ships.all;
    const r2 = SHIP_COLLIDE_RADIUS * SHIP_COLLIDE_RADIUS;
    const dead = new Set<number>();
    for (let i = 0; i < ships.length; i++) {
      const si = ships[i];
      if (dead.has(i)) continue;
      if (!si.active || (si.state !== 'transit' && si.state !== 'hovering')) continue;
      const count = this.gatherNeighbors(si.x, si.y);
      for (let k = 0; k < count; k++) {
        const j = this.neighborScratch[k];
        if (j <= i || dead.has(j)) continue; // each pair examined once; 1:1 trades only
        const sj = ships[j];
        if (!sj.active || (sj.state !== 'transit' && sj.state !== 'hovering')) continue;
        if (si.owner === sj.owner) continue;
        const ddx = si.x - sj.x;
        const ddy = si.y - sj.y;
        if (ddx * ddx + ddy * ddy > r2) continue;
        dead.add(i);
        dead.add(j);
        break;
      }
    }

    for (const idx of dead) {
      const s = ships[idx];
      this.events.onShipDeath?.(s.owner, s.x, s.y);
      this.ships.kill(idx);
    }
  }

  /**
   * Spawn an orbiter already settled on its orbit band with tangential
   * velocity — used at world construction so starting garrisons begin as a
   * calm orbiting swarm instead of erupting from the planet center.
   */
  private seedOrbiter(planet: Planet): void {
    if (planet.owner === null) return;
    const angle = Math.random() * Math.PI * 2;
    const orbitRadius = planet.radius * ORBIT_RADIUS_MULT + (Math.random() - 0.5) * 6;
    const pos = vec(
      planet.pos.x + Math.cos(angle) * orbitRadius,
      planet.pos.y + Math.sin(angle) * orbitRadius,
    );
    const orbitDir = Math.random() < 0.5 ? 1 : -1;
    const tangentSpeed = SHIP_SPEED * 0.75 * orbitDir;
    this.ships.spawn(planet.owner, pos, -1, SHIP_SPEED, {
      vx: (-Math.sin(angle)) * tangentSpeed,
      vy: Math.cos(angle) * tangentSpeed,
      turnRate: 2.2 + Math.random() * 1.6,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'orbiting',
      parentPlanet: planet.id,
      orbitRadius,
      orbitDir,
      wanderPhase: Math.random() * Math.PI * 2,
    });
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

  /**
   * Spawn a ship already in absorbing state at the orbit radius so the player
   * sees it immediately streak inward. Used while the planet is in absorb mode
   * to keep rings filling from continuing production and from phantom garrison
   * that never got a live orbiter under the cap.
   */
  private spawnAbsorbingGhost(planet: Planet): void {
    if (planet.owner === null) return;
    const angle = Math.random() * Math.PI * 2;
    const orbitRadius =
      planet.radius * ORBIT_RADIUS_MULT + (Math.random() - 0.5) * 6;
    const spawnPos = vec(
      planet.pos.x + Math.cos(angle) * orbitRadius,
      planet.pos.y + Math.sin(angle) * orbitRadius,
    );
    // Initial velocity points straight at the center so the visual pull reads
    // as decisive even for the first frame of its life.
    const pullSpeed = SHIP_SPEED * 1.6;
    this.ships.spawn(planet.owner, spawnPos, -1, SHIP_SPEED, {
      vx: -Math.cos(angle) * pullSpeed,
      vy: -Math.sin(angle) * pullSpeed,
      turnRate: 2.2,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'absorbing',
      parentPlanet: planet.id,
      orbitRadius,
      orbitDir: 1,
      wanderPhase: 0,
      // Committed absorb — if the player toggles absorb off mid-pull this ship
      // still finishes landing into the planet rather than snapping back to
      // orbit, so a cancelled absorb doesn't feel like it ate units twice.
      absorbOnArrive: true,
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
   * Count every active ship that claims `planetId` as its parent — orbiting
   * OR absorbing. Used by the absorb-flush pass to size `garrison - ships`
   * (phantom overflow waiting to be made visible).
   */
  private countLocalShipsOf(planetId: number): number {
    const all = this.ships.all;
    let n = 0;
    for (const s of all) {
      if (!s.active || s.parentPlanet !== planetId) continue;
      if (s.state === 'orbiting' || s.state === 'absorbing') n++;
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
    this.orbitSeparation(ship, this.sepScratch);
    const sep = this.sepScratch;

    const targetVx = tx * tangentSpeed + rx * radialForce + rx * wander + sep.x;
    const targetVy = ty * tangentSpeed + ry * radialForce + ry * wander + sep.y;

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

  private orbitSeparation(self: Ship, outForce: { x: number; y: number }): void {
    const ships = this.ships.all;
    outForce.x = 0;
    outForce.y = 0;
    const count = this.gatherNeighbors(self.x, self.y);
    for (let k = 0; k < count; k++) {
      const other = ships[this.neighborScratch[k]];
      if (other === self || !other.active) continue;
      if (other.state !== 'orbiting' || other.parentPlanet !== self.parentPlanet) continue;
      const dx = self.x - other.x;
      const dy = self.y - other.y;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || d2 > SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
      const d = Math.sqrt(d2);
      const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
      outForce.x += (dx / d) * push * SEPARATION_WEIGHT;
      outForce.y += (dy / d) * push * SEPARATION_WEIGHT;
    }
  }

  private stepAbsorbing(idx: number, ship: Ship, dt: number): void {
    const planet = this.planets[ship.parentPlanet];
    if (!planet || planet.owner !== ship.owner) {
      this.ships.kill(idx);
      return;
    }
    // The planet has nothing left to feed (healed to full, rings done —
    // e.g. the units ahead of this one finished the job mid-pull): return
    // to orbit instead of being consumed for zero effect. Committed
    // reinforcements included — "committed" means surviving an absorb
    // toggle, never volunteering into a sink with no payoff.
    if (!canAbsorb(planet)) {
      this.releaseAbsorberToOrbit(ship, planet);
      return;
    }
    // If the planet has turned absorb off, fall back to orbit — unless this
    // unit was sent as a reinforcement specifically to be absorbed, in which
    // case it stays committed and finishes its pull to the center.
    if (!planet.absorbing && !ship.absorbOnArrive) {
      this.releaseAbsorberToOrbit(ship, planet);
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

  /**
   * Return an absorbing unit to a healthy orbit around its planet. Ships
   * that arrived as tagged reinforcements never carried orbit parameters,
   * and a mid-pull ship can be sitting well inside the planet body — both
   * need a sane orbit radius or they'd circle the core forever.
   */
  private releaseAbsorberToOrbit(ship: Ship, planet: Planet): void {
    ship.state = 'orbiting';
    ship.absorbOnArrive = false;
    if (ship.orbitRadius < planet.radius) {
      ship.orbitRadius = planet.radius * ORBIT_RADIUS_MULT + (Math.random() - 0.5) * 6;
      ship.orbitDir = Math.random() < 0.5 ? 1 : -1;
      ship.wanderPhase = Math.random() * Math.PI * 2;
    }
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
    for (let i = 0; i < planet.ringCount; i++) {
      const cap = ringCapacity(planet.type, i);
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
    // For drifting planets, lead-predict the catch point and widen arrive
    // tolerance so a ship that's a frame's worth of drift behind still
    // registers as landed. Without this, fast-drifting planets effectively
    // out-pace the steering blend and waves bleed past without capturing.
    const tgtMoving = tgt ? Math.hypot(tgt.vx, tgt.vy) : 0;
    const distToTgt = tgt ? Math.hypot(tgt.pos.x - ship.x, tgt.pos.y - ship.y) : 0;
    const lead = tgt && tgtMoving > 0 ? Math.min(0.6, distToTgt / SHIP_SPEED) : 0;
    const targetX = tgt ? tgt.pos.x + tgt.vx * lead : ship.targetX;
    const targetY = tgt ? tgt.pos.y + tgt.vy * lead : ship.targetY;
    // Arrival tolerance has to account for both the planet drifting away
    // *and* the ship crawling through asteroid drag — without compensating,
    // a slowed ship can chase a drifting target forever, never closing the
    // last few pixels because the planet wanders the same speed the ship
    // approaches at. Take whichever speed deficit dominates and pad arrive
    // dist by ~3 frames' worth of it.
    const drag = this.asteroidDragAt(ship.x, ship.y);
    const dragShortfall = (1 - drag) * ship.speed;
    const slack = Math.max(tgtMoving, dragShortfall);
    const arriveDist = tgt ? tgt.radius + 4 + slack * dt * 6 : 6;
    if (tgt) {
      if (distToTgt <= arriveDist) {
        this.arrive(idx, tgt);
        return;
      }
      // Closing-and-near snap: if the ship is already inside 1.5× the
      // planet's body radius and still moving toward it (positive dot
      // product with the toward-vector), count it as landed. Catches the
      // case where boids separation has the ship orbiting the planet
      // perimeter without crossing the strict arrival threshold.
      const closeRange = tgt.radius * 1.5;
      if (distToTgt <= closeRange) {
        const towardX = tgt.pos.x - ship.x;
        const towardY = tgt.pos.y - ship.y;
        if (ship.vx * towardX + ship.vy * towardY > 0) {
          this.arrive(idx, tgt);
          return;
        }
      }
    } else {
      const d0 = Math.hypot(targetX - ship.x, targetY - ship.y);
      if (d0 <= arriveDist) {
        this.beginHover(ship);
        return;
      }
    }
    // Wormhole routing: when a gate path is meaningfully shorter than the
    // straight line, seek the gate mouth instead of the target. The arrival
    // checks above still run against the true target, so a ship that has
    // already warped just flies its final leg normally.
    let seekX = targetX;
    let seekY = targetY;
    let seekingGate = false;
    if (this.wormholes.length > 0 && ship.warpCooldown <= 0) {
      const gate = this.wormholeEntranceFor(ship.x, ship.y, targetX, targetY);
      if (gate) {
        seekX = gate.x;
        seekY = gate.y;
        seekingGate = true;
      }
    }

    const dx = seekX - ship.x;
    const dy = seekY - ship.y;
    const d = Math.hypot(dx, dy);

    // Seek (Arrive): force toward the target, slowing near arrival.
    const seekStrength = Math.min(1, d / 40);
    const invD = 1 / (d || 1);
    let fx = dx * invD * SEEK_WEIGHT * seekStrength;
    let fy = dy * invD * SEEK_WEIGHT * seekStrength;

    // Boids: separation (hard) + weak cohesion with nearby friendly transits.
    // Neighbors come from the shared spatial grid (cell == COHESION_RADIUS,
    // so the 3×3 sweep covers both radii) instead of an all-ships scan.
    let sepX = 0;
    let sepY = 0;
    let cohX = 0;
    let cohY = 0;
    let cohN = 0;
    const neighborCount = this.gatherNeighbors(ship.x, ship.y);
    for (let k = 0; k < neighborCount; k++) {
      const other = allShips[this.neighborScratch[k]];
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

    // Asteroid drag — `drag` was sampled at the top of this function for
    // the arrive-tolerance widening. Reuse it here: cap speed to the ship's
    // nominal speed scaled by drag so a ship physically crawls through the
    // rocks while still steering normally.

    // Cap speed to the ship's nominal speed (scaled by drag, lifted by any
    // slingshot band the ship is riding).
    const sp = Math.hypot(ship.vx, ship.vy);
    const effectiveSpeed = ship.speed * drag * this.blackHoleSpeedLift(ship.x, ship.y);
    if (sp > effectiveSpeed) {
      ship.vx = (ship.vx / sp) * effectiveSpeed;
      ship.vy = (ship.vy / sp) * effectiveSpeed;
    }

    const step = Math.hypot(ship.vx, ship.vy) * dt;
    // Swept-arrival: if the segment from current → next position passes
    // close to the target body this frame, count it as a landing. Catches
    // edge cases where a fast ship would otherwise fly straight through a
    // moving planet between two snapshots.
    if (tgt) {
      const newX = ship.x + ship.vx * dt;
      const newY = ship.y + ship.vy * dt;
      const minD = pointToSegmentDist(tgt.pos.x, tgt.pos.y, ship.x, ship.y, newX, newY);
      if (minD <= tgt.radius + 1) {
        this.arrive(idx, tgt);
        return;
      }
    }
    if (step >= d && !seekingGate) {
      if (tgt) this.arrive(idx, tgt);
      else this.beginHover(ship);
    } else {
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
      // Wormhole first: a ship that flew into a mouth is elsewhere now.
      if (this.applyWormholes(ship)) return;
      // Gravity last, after the speed cap and integration — a ship at full
      // steering authority still accumulates inward drift it cannot cancel,
      // which is what makes flying near the well genuinely costly.
      this.applyBlackHoleGravity(ship, dt);
    }
  }

  /**
   * Pull `ship` toward any black hole whose gravity radius it is inside.
   * Crossing the capture threshold flips the ship into the 'doomed' scripted
   * spiral. Returns true when the ship was captured this tick.
   */
  private applyBlackHoleGravity(ship: Ship, dt: number): boolean {
    for (let h = 0; h < this.blackHoles.length; h++) {
      const bh = this.blackHoles[h];
      const dx = bh.pos.x - ship.x;
      const dy = bh.pos.y - ship.y;
      const d = Math.hypot(dx, dy);
      if (d >= bh.gravityRadius) continue;
      if (d <= bh.captureRadius) {
        ship.state = 'doomed';
        ship.doomHoleIdx = h;
        ship.doomAngle = Math.atan2(-dy, -dx);
        ship.doomRadius = Math.max(d, bh.horizonRadius + 1);
        // Keep the handedness the ship approached with: sign of the cross
        // product of the radial vector (hole → ship) and its velocity.
        const cross = -dx * ship.vy + dy * ship.vx;
        ship.doomDir = cross >= 0 ? 1 : -1;
        ship.isSelected = false;
        ship.targetPlanet = -1;
        ship.parentPlanet = -1;
        return true;
      }
      // Quadratic ramp — negligible at the outer rim, fierce near capture.
      const t = 1 - (d - bh.captureRadius) / (bh.gravityRadius - bh.captureRadius);
      const a = BLACK_HOLE_G_PEAK * t * t;
      const inv = 1 / d;
      ship.vx += dx * inv * a * dt;
      ship.vy += dy * inv * a * dt;
    }
    return false;
  }

  /**
   * Terminal spiral: radius decays (slow at the rim, plunging near the core)
   * while angular speed climbs — a Kepler-flavored infall that stays readable
   * for the ~2 seconds it takes. Velocity is kept tangential so the ship
   * renderer's motion streak follows the spiral for free.
   */
  private stepDoomed(idx: number, ship: Ship, dt: number): void {
    const bh = this.blackHoles[ship.doomHoleIdx];
    if (!bh) {
      this.ships.kill(idx);
      return;
    }
    const depth = 1 - ship.doomRadius / bh.captureRadius; // 0 at rim → ~0.6 at horizon
    const infall = DOOM_INFALL_BASE + DOOM_INFALL_ACCEL * depth;
    const angVel = ship.doomDir * (DOOM_SPIN_BASE + DOOM_SPIN_ACCEL * depth);
    ship.doomRadius -= infall * dt;
    ship.doomAngle += angVel * dt;
    const r = Math.max(ship.doomRadius, 0);
    const cos = Math.cos(ship.doomAngle);
    const sin = Math.sin(ship.doomAngle);
    ship.x = bh.pos.x + cos * r;
    ship.y = bh.pos.y + sin * r;
    const tangential = angVel * Math.max(r, 6);
    ship.vx = -sin * tangential - cos * infall;
    ship.vy = cos * tangential - sin * infall;
    if (ship.doomRadius <= bh.horizonRadius) {
      this.events.onShipConsumed?.(ship.owner, ship.x, ship.y);
      this.ships.kill(idx);
    }
  }

  /**
   * Flare star pass. While recharging, the star accumulates `charge`; at
   * `period` it detonates (event for audio/FX) and the shockwave expands at
   * `waveSpeed` until `maxRadius`. Each tick the wave kills everything
   * free-flying — transit and hovering ships plus live neutral hostiles —
   * inside the annulus it swept this frame. Orbiting and absorbing units are
   * sheltered by their planet, and doomed ships are already lost to the
   * black hole, so the blast is purely a transit-timing hazard: the map is
   * safe if you respect the star's rhythm.
   */
  private stepFlareStars(dt: number): void {
    for (const fs of this.flareStars) {
      if (fs.waveRadius < 0) {
        fs.charge += dt;
        if (fs.charge >= fs.period) {
          fs.charge = 0;
          fs.waveRadius = 0;
          this.events.onFlareDetonate?.(fs.pos.x, fs.pos.y);
        }
        continue;
      }
      const prev = fs.waveRadius;
      fs.waveRadius = Math.min(fs.maxRadius, fs.waveRadius + fs.waveSpeed * dt);
      const lo = Math.max(0, prev - FLARE_WAVE_PAD);
      const lo2 = lo * lo;
      const hi2 = fs.waveRadius * fs.waveRadius;
      const ships = this.ships.all;
      for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (!s.active) continue;
        if (s.state !== 'transit' && s.state !== 'hovering') continue;
        const dx = s.x - fs.pos.x;
        const dy = s.y - fs.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < lo2 || d2 > hi2) continue;
        this.events.onShipDeath?.(s.owner, s.x, s.y);
        this.ships.kill(i);
      }
      const neutrals = this.neutrals.all;
      for (let i = 0; i < neutrals.length; i++) {
        const n = neutrals[i];
        if (!n.active || n.state === 'doomed') continue;
        const dx = n.x - fs.pos.x;
        const dy = n.y - fs.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < lo2 || d2 > hi2) continue;
        this.events.onNeutralDeath?.(n.x, n.y);
        this.neutrals.kill(i);
      }
      if (fs.waveRadius >= fs.maxRadius) fs.waveRadius = -1;
    }
  }

  /**
   * The wormhole gate (if any) a transit ship at (x, y) headed for (tx, ty)
   * should fly into instead of the direct line. A gate qualifies only when
   * entry-mouth + exit-leg beats the direct distance by a real margin —
   * near-ties would make a wave dither between routes mid-flight.
   */
  private wormholeEntranceFor(x: number, y: number, tx: number, ty: number): Vec2 | null {
    let best: Vec2 | null = null;
    let bestCost = Math.hypot(tx - x, ty - y) - WORMHOLE_DETOUR_MARGIN;
    for (const wh of this.wormholes) {
      const ends: Array<[Vec2, Vec2]> = [
        [wh.a, wh.b],
        [wh.b, wh.a],
      ];
      for (const [enter, exit] of ends) {
        const c =
          Math.hypot(enter.x - x, enter.y - y) + Math.hypot(tx - exit.x, ty - exit.y);
        if (c < bestCost) {
          bestCost = c;
          best = enter;
        }
      }
    }
    return best;
  }

  /**
   * Warp `ship` if it sits inside a wormhole mouth: throw it out of the twin
   * mouth along its current heading and start the re-entry cooldown. Returns
   * true when the ship was warped this tick.
   */
  private applyWormholes(ship: Ship): boolean {
    if (ship.warpCooldown > 0) return false;
    for (const wh of this.wormholes) {
      const ends: Array<[Vec2, Vec2]> = [
        [wh.a, wh.b],
        [wh.b, wh.a],
      ];
      for (const [enter, exit] of ends) {
        const dx = ship.x - enter.x;
        const dy = ship.y - enter.y;
        if (dx * dx + dy * dy > wh.radius * wh.radius) continue;
        const fromX = ship.x;
        const fromY = ship.y;
        const vm = Math.hypot(ship.vx, ship.vy) || 1;
        ship.x = exit.x + (ship.vx / vm) * (wh.radius + WORMHOLE_EXIT_PAD);
        ship.y = exit.y + (ship.vy / vm) * (wh.radius + WORMHOLE_EXIT_PAD);
        ship.warpCooldown = WARP_COOLDOWN;
        this.events.onShipWarp?.(ship.owner, fromX, fromY, ship.x, ship.y);
        return true;
      }
    }
    return false;
  }

  /**
   * Effective speed multiplier for a ship at (x, y). Returns 1 when no
   * asteroid field overlaps the position; the smallest field's slowdown
   * otherwise (overlapping fields stack to the most punishing factor).
   */
  private asteroidDragAt(x: number, y: number): number {
    let drag = 1;
    for (const f of this.asteroidFields) {
      const dx = x - f.pos.x;
      const dy = y - f.pos.y;
      if (dx * dx + dy * dy <= f.radius * f.radius && f.slowdown < drag) {
        drag = f.slowdown;
      }
    }
    return drag;
  }

  /**
   * Slingshot speed multiplier for a ship at (x, y). Inside a gravity well's
   * safe band — outside `captureRadius * SLINGSHOT_INNER_MULT`, inside
   * `gravityRadius` — the speed cap lifts on a parabola that peaks mid-band
   * at SLINGSHOT_PEAK_BOOST and fades to 1 at both edges. Riding the rim is
   * a fast lane; the price is that the same rim drags the flight path toward
   * the fatal capture threshold.
   */
  blackHoleSpeedLift(x: number, y: number): number {
    let lift = 1;
    for (const bh of this.blackHoles) {
      const inner = bh.captureRadius * SLINGSHOT_INNER_MULT;
      const outer = bh.gravityRadius;
      if (outer <= inner) continue;
      const d = Math.hypot(x - bh.pos.x, y - bh.pos.y);
      if (d <= inner || d >= outer) continue;
      const t = (d - inner) / (outer - inner); // 0 at inner edge → 1 at rim
      const boost = 1 + (SLINGSHOT_PEAK_BOOST - 1) * 4 * t * (1 - t);
      if (boost > lift) lift = boost;
    }
    return lift;
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
    const neighborCount = this.gatherNeighbors(ship.x, ship.y);
    for (let k = 0; k < neighborCount; k++) {
      const other = allShips[this.neighborScratch[k]];
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
    // Hover points parked inside a gravity well slowly bleed into it — holding
    // position next to a black hole is a choice the well gets a vote on.
    this.applyBlackHoleGravity(ship, dt);
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
      // Orbiting and it joins the target planet's list". Reinforcements are
      // allowed past the native production cap (up to REINFORCEMENT_ORBIT_CAP)
      // so stacking more waves on a maxed planet visibly thickens the swarm.
      if (this.countOrbitersOf(planet.id) < REINFORCEMENT_ORBIT_CAP) {
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
    // In a free-for-all the match also ends the moment every human is out —
    // there's no reason to make the player spectate two AIs grinding each
    // other down after their own defeat.
    const humansEliminated = this.players.some(
      (pl) => !pl.isAI && this.playersSeen.has(pl.id) && !alive.has(pl.id),
    );
    if (alive.size <= 1 || humansEliminated) {
      this.gameOver = true;
      // Sole survivor wins; on human elimination with rivals still standing,
      // credit the current strongest AI so the end screen has a face.
      if (alive.size === 1) {
        this.winner = [...alive][0];
      } else if (alive.size === 0) {
        this.winner = null;
      } else {
        let best: number | null = null;
        let bestStrength = -1;
        for (const id of alive) {
          const strength = this.totalGarrison(id);
          if (strength > bestStrength) {
            bestStrength = strength;
            best = id;
          }
        }
        this.winner = best;
      }
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

  /**
   * Read-only view of the swarm patrol zones that still have live hostiles —
   * the AI prices flight paths through them the way a player eyeballs the
   * green cloud. Anchors whose pack has been wiped cost nothing.
   */
  swarmZones(): Array<{ pos: Vec2; patrolRadius: number }> {
    const zones: Array<{ pos: Vec2; patrolRadius: number }> = [];
    for (let ai = 0; ai < this.neutralAnchors.length; ai++) {
      if (this.neutrals.countAtAnchor(ai) === 0) continue;
      const a = this.neutralAnchors[ai];
      zones.push({ pos: a.pos, patrolRadius: a.patrolRadius });
    }
    return zones;
  }

  /**
   * Number of enemy ships currently flying at `planetId` (transit state with
   * that planet as target, owner different from `owner`). Drives the HUD's
   * incoming-attack warning; the AI keeps its own richer variant that also
   * counts staged hover fleets.
   */
  incomingAttackers(planetId: number, owner: number): number {
    let n = 0;
    for (const s of this.ships.all) {
      if (!s.active || s.owner === owner) continue;
      if (s.state === 'transit' && s.targetPlanet === planetId) n++;
    }
    return n;
  }

  totalGarrison(owner: number): number {
    let t = 0;
    for (const p of this.planets) if (p.owner === owner) t += p.garrison;
    // Count every free-flying unit: transit waves and standing hover armies.
    // Orbiting and absorbing units are already reflected in planet garrison —
    // counting only 'transit' here made the HUD strength bar visibly dip
    // whenever the player parked a fleet at a hover point.
    for (const s of this.ships.all) {
      if (!s.active || s.owner !== owner) continue;
      if (s.state === 'transit' || s.state === 'hovering') t += 1;
    }
    return t;
  }

  /**
   * Continuous strength for the HUD bar: totalGarrison plus each owned
   * planet's fractional in-progress unit. Whole-unit production ticks land
   * at different moments for each player, so a bar fed by the integer count
   * visibly see-sawed every few seconds even when nobody made a move — the
   * ratio jumped on every finished unit. Counting the accumulator makes both
   * sides grow smoothly and the bar only shifts when relative strength
   * actually changes.
   */
  fleetStrength(owner: number): number {
    let t = this.totalGarrison(owner);
    for (const p of this.planets) {
      if (p.owner === owner) t += Math.min(1, Math.max(0, p.productionAcc));
    }
    return t;
  }
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * Closest distance from point (px, py) to the line segment (ax, ay)–(bx, by).
 * Used for swept-arrival so a ship that flies past a moving planet within
 * one frame still registers as landed, and by the AI to score whether a
 * planned wave's flight line clips a black hole's gravity well.
 */
export const pointToSegmentDist = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
};
