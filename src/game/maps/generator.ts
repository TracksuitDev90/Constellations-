import type { HazardSpec, MapSpec } from '../sim/World.js';
import type { PlanetType } from '../sim/Planet.js';
import { SIZE_RADIUS } from '../sim/Planet.js';

/**
 * Procedural constellation generator, parameterized per campaign level.
 * Every match rolls:
 *   - One start world per player (2–4), placed in per-count corner zones so
 *     free-for-alls begin at fair distances.
 *   - Neutral planets inside a wide central band, with a randomized
 *     minimum-separation so spacing varies between matches without ever
 *     letting two worlds visually overlap.
 *   - Edge connectivity by nearest-neighbor with a connectivity backstop.
 *     The lines are purely decorative (movement is free-flight), but they
 *     ARE the constellation — every map should read as one.
 *   - At most one hazard, drawn from the level's allowed pool.
 *
 * Planet ids 0..playerCount-1 are the start worlds, in player order.
 */

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

/** Per-match rejection-sampling range for minimum planet center distance. */
const MIN_SEPARATION_RANGE: [number, number] = [200, 280];

export type HazardKind = 'driftingPlanet' | 'asteroidField' | 'neutralSwarm';

export interface MapGenConfig {
  playerCount: 2 | 3 | 4;
  /** Inclusive range of total planets, start worlds included. */
  totalPlanets: [number, number];
  /** Hazard kinds this level may roll. Empty = always calm. */
  hazardPool: HazardKind[];
  /** Chance the match stays calm even with a non-empty pool. */
  calmChance: number;
  /** Starting garrison for the human (planet 0). */
  playerGarrison: number;
  /** Starting garrison for each AI start world. */
  enemyGarrison: number;
  /** Give the player's start a ring so the evolution path is always there. */
  playerRing: boolean;
}

interface PlacementZone {
  x: [number, number];
  y: [number, number];
}

/**
 * Start zones per player count. Two players face off across the midline;
 * three form a triangle; four take the corners. Zones are inset enough
 * that even max-radius starts don't clip the map bounds.
 */
const START_ZONES: Record<2 | 3 | 4, PlacementZone[]> = {
  2: [
    { x: [180, 540], y: [120, 380] },
    { x: [1060, 1420], y: [120, 380] },
  ],
  3: [
    { x: [180, 480], y: [120, 340] },
    { x: [1120, 1420], y: [120, 340] },
    { x: [620, 980], y: [700, 900] },
  ],
  4: [
    { x: [180, 460], y: [120, 320] },
    { x: [1140, 1420], y: [120, 320] },
    { x: [180, 460], y: [680, 880] },
    { x: [1140, 1420], y: [680, 880] },
  ],
};

/** Wide central band where neutral worlds spawn. */
const NEUTRAL_ZONE: PlacementZone = { x: [220, 1380], y: [220, 820] };

const rollInZone = (zone: PlacementZone): { x: number; y: number } => ({
  x: zone.x[0] + Math.random() * (zone.x[1] - zone.x[0]),
  y: zone.y[0] + Math.random() * (zone.y[1] - zone.y[0]),
});

/** Inclusive integer roll. */
const irange = (lo: number, hi: number): number =>
  lo + Math.floor(Math.random() * (hi - lo + 1));

/** Linear roll in [lo, hi). */
const frange = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Uniformly pick one of the supplied weighted entries. */
const weightedPick = <T>(entries: Array<[T, number]>): T => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
};

/** Quick-and-dirty rejection sampler against a list of already-placed points. */
const tryPlace = (
  zone: PlacementZone,
  placed: Array<{ x: number; y: number; r: number }>,
  ownRadius: number,
  minSep: number,
  attempts = 60,
): { x: number; y: number } | null => {
  for (let i = 0; i < attempts; i++) {
    const candidate = rollInZone(zone);
    let ok = true;
    for (const q of placed) {
      const dx = q.x - candidate.x;
      const dy = q.y - candidate.y;
      const need = minSep + (q.r - SIZE_RADIUS[1]) * 0.5 + (ownRadius - SIZE_RADIUS[1]) * 0.5;
      if (dx * dx + dy * dy < need * need) {
        ok = false;
        break;
      }
    }
    if (ok) return candidate;
  }
  return null;
};

/**
 * Build the decorative constellation lines: nearest-neighbor edges plus a
 * connectivity sweep so the figure reads as one linked constellation.
 */
const buildEdges = (
  positions: ReadonlyArray<{ x: number; y: number }>,
): Array<[number, number]> => {
  const edges = new Set<string>();
  const key = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    edges.add(key(a, b));
  };
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    const distances: Array<{ j: number; d: number }> = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      distances.push({ j, d: dx * dx + dy * dy });
    }
    distances.sort((a, b) => a.d - b.d);
    addEdge(i, distances[0].j);
    if (distances.length > 1) addEdge(i, distances[1].j);
  }
  // Connectivity sweep — link any stranded component to its nearest reached
  // neighbor so the whole figure is one constellation.
  const visited = new Set<number>([0]);
  const stack = [0];
  const adj = new Map<number, number[]>();
  for (let i = 0; i < n; i++) adj.set(i, []);
  for (const k of edges) {
    const [a, b] = k.split('-').map(Number);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of adj.get(cur)!) {
      if (!visited.has(nb)) {
        visited.add(nb);
        stack.push(nb);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    let bestJ = 0;
    let bestD = Infinity;
    for (const j of visited) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    addEdge(i, bestJ);
    visited.add(i);
    adj.get(i)!.push(bestJ);
    adj.get(bestJ)!.push(i);
  }
  return [...edges].map((k) => k.split('-').map(Number) as [number, number]);
};

interface NeutralSeed {
  type: PlanetType;
  ringCount: 0 | 1 | 2;
  garrison: number;
}

/**
 * Independent roll for ring count: 70% no rings, 25% one ring, 5% two rings.
 * Two-ring rolls require an XL planet (size 2); downgrades to 1 otherwise.
 * Most worlds end up bare so a ringed planet feels like a meaningful target.
 */
const rollRingCount = (type: PlanetType): 0 | 1 | 2 => {
  const r = Math.random();
  if (r < 0.7) return 0;
  if (r < 0.95) return 1;
  return type === 2 ? 2 : 1;
};

/** Roll one neutral planet's profile so the pool reads as a varied bunch. */
const rollNeutralSeed = (): NeutralSeed => {
  const type = weightedPick<PlanetType>([
    [0, 1],
    [1, 3],
    [2, 1.2],
  ]);
  const ringCount = rollRingCount(type);
  const garrison = type === 2 ? irange(12, 18) : type === 1 ? irange(8, 14) : irange(6, 10);
  return { type, ringCount, garrison };
};

/**
 * Roll the level's hazard from its allowed pool (or none). Placement keeps
 * hazards central so they interfere with contested space, never with a
 * start world.
 */
const rollHazard = (
  cfg: MapGenConfig,
  positions: ReadonlyArray<{ x: number; y: number; r: number }>,
): HazardSpec | null => {
  if (cfg.hazardPool.length === 0) return null;
  if (Math.random() < cfg.calmChance) return null;
  const variant = cfg.hazardPool[Math.floor(Math.random() * cfg.hazardPool.length)];
  const starts = positions.slice(0, cfg.playerCount);

  if (variant === 'driftingPlanet') {
    // Only neutral worlds drift — the start worlds stay anchored.
    const candidates: number[] = [];
    for (let i = cfg.playerCount; i < positions.length; i++) candidates.push(i);
    if (candidates.length === 0) return null;
    const planetId = candidates[Math.floor(Math.random() * candidates.length)];
    const speed = frange(14, 26);
    const heading = Math.random() * Math.PI * 2;
    return {
      type: 'driftingPlanet',
      planetId,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
    };
  }

  if (variant === 'asteroidField') {
    // Drop the field between two neutral planets so it sits in a likely
    // flight path. Falls back to mid-map if there aren't enough neutrals.
    let cx = MAP_WIDTH / 2;
    let cy = MAP_HEIGHT / 2;
    const firstNeutral = cfg.playerCount;
    if (positions.length >= firstNeutral + 2) {
      const a = positions[firstNeutral];
      const b = positions[firstNeutral + 1];
      cx = (a.x + b.x) / 2 + frange(-60, 60);
      cy = (a.y + b.y) / 2 + frange(-60, 60);
    }
    return {
      type: 'asteroidField',
      pos: { x: cx, y: cy },
      radius: frange(150, 220),
      slowdown: 0.32,
      seed: Math.floor(Math.random() * 1e9),
    };
  }

  // neutralSwarm — anchor it well clear of every start world.
  let pos = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 + frange(-80, 120) };
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = {
      x: frange(MAP_WIDTH * 0.25, MAP_WIDTH * 0.75),
      y: frange(MAP_HEIGHT * 0.3, MAP_HEIGHT * 0.75),
    };
    const clear = starts.every(
      (s) => Math.hypot(candidate.x - s.x, candidate.y - s.y) > 260,
    );
    if (clear) {
      pos = candidate;
      break;
    }
  }
  return {
    type: 'neutralSwarm',
    pos,
    count: irange(4, 6),
    patrolRadius: frange(110, 160),
    seed: Math.floor(Math.random() * 1e9),
  };
};

/** Generate a fresh constellation for the given level configuration. */
export const generateMap = (cfg: MapGenConfig): MapSpec => {
  const totalPlanets = Math.max(
    cfg.playerCount + 2,
    irange(cfg.totalPlanets[0], cfg.totalPlanets[1]),
  );
  const neutralCount = totalPlanets - cfg.playerCount;
  const minSep = frange(MIN_SEPARATION_RANGE[0], MIN_SEPARATION_RANGE[1]);

  const placed: Array<{ x: number; y: number; r: number }> = [];
  const planets: MapSpec['planets'] = [];

  // Start worlds, one per player. The human (player 0) can get a ring so
  // the Small → Large evolution path is always available from turn one.
  const zones = START_ZONES[cfg.playerCount];
  for (let pid = 0; pid < cfg.playerCount; pid++) {
    const pos = rollInZone(zones[pid]);
    planets.push({
      pos,
      owner: pid,
      garrison: pid === 0 ? cfg.playerGarrison : cfg.enemyGarrison,
      type: 0,
      ringCount: pid === 0 && cfg.playerRing ? 1 : 0,
    });
    placed.push({ ...pos, r: SIZE_RADIUS[0] });
  }

  // Neutrals — rejection-sample the central band; relax separation slightly
  // on failure so we always hit the requested count.
  for (let i = 0; i < neutralCount; i++) {
    const seed = rollNeutralSeed();
    const ownR = SIZE_RADIUS[seed.type];
    let pos = tryPlace(NEUTRAL_ZONE, placed, ownR, minSep);
    let relaxed = minSep;
    while (!pos && relaxed > MIN_SEPARATION_RANGE[0] - 50) {
      relaxed -= 20;
      pos = tryPlace(NEUTRAL_ZONE, placed, ownR, relaxed);
    }
    if (!pos) pos = rollInZone(NEUTRAL_ZONE);
    planets.push({
      pos,
      owner: null,
      garrison: seed.garrison,
      type: seed.type,
      ringCount: seed.ringCount,
    });
    placed.push({ ...pos, r: ownR });
  }

  const edges = buildEdges(placed);
  const hazard = rollHazard(cfg, placed);

  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    planets,
    edges,
    hazards: hazard ? [hazard] : [],
  };
};
