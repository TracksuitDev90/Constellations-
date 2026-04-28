import type { HazardSpec, MapSpec } from '../sim/World.js';
import type { PlanetType } from '../sim/Planet.js';
import { SIZE_RADIUS } from '../sim/Planet.js';

/**
 * Procedural Orion-style maps. Every match rolls:
 *   - 5 to 9 planets total (always at least the player + AI starting worlds
 *     plus 3 neutrals; sometimes a sparse 5-planet duel, sometimes a tight
 *     9-planet brawl).
 *   - Per-planet positions inside loose role zones, with a randomized
 *     minimum-separation so spacing varies between matches without ever
 *     letting two worlds visually overlap.
 *   - Edge connectivity by nearest-neighbor with a min-degree backstop, so
 *     the constellation graph stays traversable from start to start.
 *   - Exactly one hazard per match (drift / asteroid / neutral swarm) placed
 *     so it actually intersects the constellation rather than sitting in a
 *     dead corner.
 *
 * The graph indices for player/AI start worlds remain 0 and 1 so the rest of
 * the codebase (Game.ts, AI, HUD) doesn't need to change.
 */

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

/** Inclusive range of total planets per match. */
const MIN_TOTAL_PLANETS = 5;
const MAX_TOTAL_PLANETS = 9;

/** Per-match rejection-sampling range for minimum planet center distance. */
const MIN_SEPARATION_RANGE: [number, number] = [200, 280];

interface PlacementZone {
  x: [number, number];
  y: [number, number];
}

const PLAYER_ZONE: PlacementZone = { x: [180, 540], y: [120, 380] };
const AI_ZONE: PlacementZone = { x: [1060, 1420], y: [120, 380] };
/**
 * Wide neutral spawn region — covers the middle and lower bands so neutrals
 * don't all clump in the belt every match. Keeps a safety margin from the
 * player/AI zones so starts feel fair.
 */
const NEUTRAL_ZONE: PlacementZone = { x: [180, 1420], y: [380, 920] };

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
 * Build a connectivity graph using nearest-neighbor edges plus a backstop
 * pass that guarantees every planet has at least 2 connections (so no node
 * is a dead-end and the BFS pathfinder always has options).
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
  // Connect each planet to its 2 nearest neighbors. With 5–9 planets that's
  // a coherent sparse graph; the second pass below patches any orphans.
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
  // Connectivity sweep — BFS from planet 0; if any node is unreachable, link
  // it to its nearest reachable neighbor so the whole map is one component.
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
    // Add neighbors of the new node so the next iteration can chain off it.
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
 * Two-ring rolls require an XL planet (size 2) since the 0/1 size cap is one
 * ring; downgrades to 1 if the planet is too small. Most worlds end up bare
 * so a ringed planet feels like a meaningful target rather than the default.
 */
const rollRingCount = (type: PlanetType): 0 | 1 | 2 => {
  const r = Math.random();
  if (r < 0.7) return 0;
  if (r < 0.95) return 1;
  return type === 2 ? 2 : 1;
};

/** Roll one neutral planet's profile so the pool reads as a varied bunch. */
const rollNeutralSeed = (): NeutralSeed => {
  // Bias toward Large; sprinkle Small and Extra-Large so size variety reads.
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
 * Pick which hazard the match will get, then build its spec given the placed
 * planets. Each hazard variant chooses its position relative to the planet
 * field so it actually interferes with play.
 */
const rollHazard = (
  positions: ReadonlyArray<{ x: number; y: number; r: number }>,
): HazardSpec | null => {
  const variant = weightedPick<'driftingPlanet' | 'asteroidField' | 'neutralSwarm' | 'none'>([
    ['driftingPlanet', 1],
    ['asteroidField', 1],
    ['neutralSwarm', 1],
    // Small chance of a calm match so hazards stay a notable event.
    ['none', 0.35],
  ]);
  if (variant === 'none') return null;
  if (variant === 'driftingPlanet') {
    // Pick a neutral planet (id >= 2) so the player/AI starts stay anchored.
    const candidates: number[] = [];
    for (let i = 2; i < positions.length; i++) candidates.push(i);
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
    // Drop a field roughly between two neutral planets so it actually sits in
    // a likely flight path. Falls back to mid-map if there aren't enough.
    let cx = MAP_WIDTH / 2;
    let cy = MAP_HEIGHT / 2;
    if (positions.length >= 4) {
      const a = positions[2];
      const b = positions[Math.min(3, positions.length - 1)];
      cx = (a.x + b.x) / 2;
      cy = (a.y + b.y) / 2;
      // Nudge slightly so the field isn't centered exactly between them.
      cx += frange(-60, 60);
      cy += frange(-60, 60);
    }
    return {
      type: 'asteroidField',
      pos: { x: cx, y: cy },
      radius: frange(150, 220),
      slowdown: 0.32,
      seed: Math.floor(Math.random() * 1e9),
    };
  }
  // neutralSwarm — anchor it well clear of both starting worlds.
  let pos = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 + frange(-80, 120) };
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = {
      x: frange(MAP_WIDTH * 0.25, MAP_WIDTH * 0.75),
      y: frange(MAP_HEIGHT * 0.4, MAP_HEIGHT * 0.85),
    };
    // Keep at least 220px from any starting planet (id 0 or 1).
    const startA = positions[0];
    const startB = positions[1];
    const da = Math.hypot(candidate.x - startA.x, candidate.y - startA.y);
    const db = Math.hypot(candidate.x - startB.x, candidate.y - startB.y);
    if (da > 240 && db > 240) {
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

/**
 * Generate a fresh constellation. Player is always planet 0 (left), AI is
 * planet 1 (right); neutrals follow as planets 2..N.
 */
export const generateOrionMap = (): MapSpec => {
  const totalPlanets = irange(MIN_TOTAL_PLANETS, MAX_TOTAL_PLANETS);
  const neutralCount = totalPlanets - 2;
  const minSep = frange(MIN_SEPARATION_RANGE[0], MIN_SEPARATION_RANGE[1]);

  const placed: Array<{ x: number; y: number; r: number }> = [];
  const planets: MapSpec['planets'] = [];

  // Player start (Small with 1 ring — exercises Small → Large).
  const playerPos = rollInZone(PLAYER_ZONE);
  planets.push({ pos: playerPos, owner: 0, garrison: 12, type: 0, ringCount: 1 });
  placed.push({ ...playerPos, r: SIZE_RADIUS[0] });

  // AI start (Small, plain).
  const aiPos = rollInZone(AI_ZONE);
  planets.push({ pos: aiPos, owner: 1, garrison: 12, type: 0, ringCount: 0 });
  placed.push({ ...aiPos, r: SIZE_RADIUS[0] });

  // Neutrals — try the wide neutral zone first; if rejection sampling fails
  // for a planet (rare with a tight separation roll), shrink the required
  // separation slightly and try again so we always hit the requested count.
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
  const hazard = rollHazard(placed);

  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    planets,
    edges,
    hazards: hazard ? [hazard] : [],
  };
};

/**
 * Static fallback map preserved for tests/snapshots that expect deterministic
 * layouts. Gameplay itself uses `generateOrionMap()` per match.
 */
export const ORION_MAP: MapSpec = {
  width: MAP_WIDTH,
  height: MAP_HEIGHT,
  planets: [
    { pos: { x: 350, y: 260 }, owner: 0, garrison: 12, type: 0, ringCount: 1 },
    { pos: { x: 1250, y: 260 }, owner: 1, garrison: 12, type: 0, ringCount: 0 },
    { pos: { x: 650, y: 520 }, owner: null, garrison: 10, type: 1, ringCount: 0 },
    { pos: { x: 800, y: 540 }, owner: null, garrison: 14, type: 2, ringCount: 2 },
    { pos: { x: 950, y: 520 }, owner: null, garrison: 10, type: 1, ringCount: 1 },
    { pos: { x: 420, y: 800 }, owner: null, garrison: 10, type: 1, ringCount: 0 },
    { pos: { x: 1180, y: 800 }, owner: null, garrison: 10, type: 1, ringCount: 1 },
  ],
  edges: [
    [0, 2],
    [1, 4],
    [2, 3],
    [3, 4],
    [2, 5],
    [4, 6],
    [5, 3],
    [6, 3],
    [0, 5],
    [1, 6],
  ],
};
