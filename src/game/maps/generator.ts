import type { HazardSpec, MapSpec } from '../sim/World.js';
import type { PlanetType, RingCount } from '../sim/Planet.js';
import { SIZE_RADIUS, clampRingCount } from '../sim/Planet.js';

/**
 * Procedural constellation generator, parameterized per campaign level.
 * Every match rolls:
 *   - A layout archetype (scatter / lanes / ringworld / clusters) that shapes
 *     the map's geography — and with it, the shape of the whole match.
 *   - One start world per player (2–4), placed in per-count corner zones so
 *     free-for-alls begin at fair distances.
 *   - Neutral planets whose worth follows a value gradient: cheap, bare
 *     worlds near the starts for safe expansion; bigger, ringed, better
 *     defended worlds in contested space. "Why this planet" should always
 *     have an answer you can read off the map.
 *   - Edge connectivity by nearest-neighbor with a connectivity backstop.
 *     The edges are invisible (movement is free-flight, and the line layer
 *     is intentionally not rendered) but streams still route along them.
 *   - Up to two hazards of distinct kinds — and hazards guard rewards: an
 *     asteroid belt hides a sweetened treasure world, a green swarm patrols
 *     a prize, planets near a black hole carry extra rings, and a drifting
 *     planet is a moving treasure.
 *
 * Planet ids 0..playerCount-1 are the start worlds, in player order.
 */

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

/** Per-match rejection-sampling range for minimum planet center distance. */
const MIN_SEPARATION_RANGE: [number, number] = [200, 280];

export type HazardKind = 'driftingPlanet' | 'asteroidField' | 'neutralSwarm' | 'blackHole';

/**
 * Map geography archetypes. Each rolls a different set of neutral placement
 * zones, so the same planet count produces very different strategic shapes:
 *
 *   - scatter: the classic open sky — neutrals anywhere in the central band.
 *   - lanes: two or three horizontal corridors with empty space between.
 *     Every attack picks a road; flanking through the other lane is real.
 *   - ringworld: neutrals on a wide ellipse around one rich central prize.
 *     Taking the middle is tempting and exposed from every direction.
 *   - clusters: tight planet groups separated by open space — hold a whole
 *     cluster and its interior is defensible territory.
 */
export type LayoutKind = 'scatter' | 'lanes' | 'ringworld' | 'clusters';

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
  /** Layout archetypes this level may roll. Defaults to ['scatter']. */
  layouts?: LayoutKind[];
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

/** Wide central band where neutral worlds spawn in the scatter layout. */
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

/** One neutral planet's placement recipe under the rolled layout. */
interface NeutralSlot {
  zone: PlacementZone;
  /** Ringworld's central prize — forced rich regardless of the value roll. */
  rich?: boolean;
}

const clampZone = (zone: PlacementZone): PlacementZone => ({
  x: [Math.max(150, zone.x[0]), Math.min(MAP_WIDTH - 150, zone.x[1])],
  y: [Math.max(130, zone.y[0]), Math.min(MAP_HEIGHT - 130, zone.y[1])],
});

const boxAround = (x: number, y: number, half: number): PlacementZone =>
  clampZone({ x: [x - half, x + half], y: [y - half, y + half] });

/**
 * Turn the rolled layout into one placement zone per neutral planet. The
 * zones are the whole difference between layouts — placement itself always
 * runs through the same rejection sampler.
 */
const buildNeutralSlots = (layout: LayoutKind, count: number): NeutralSlot[] => {
  if (layout === 'lanes') {
    const laneCount = count >= 6 && Math.random() < 0.5 ? 3 : 2;
    const centers =
      laneCount === 3 ? [270, 520, 770] : [330, 690];
    const slots: NeutralSlot[] = [];
    for (let i = 0; i < count; i++) {
      const y = centers[i % laneCount];
      slots.push({ zone: clampZone({ x: [240, 1360], y: [y - 80, y + 80] }) });
    }
    return slots;
  }

  if (layout === 'ringworld') {
    const cx = MAP_WIDTH / 2 + frange(-40, 40);
    const cy = MAP_HEIGHT / 2 + frange(-30, 30);
    const rx = frange(420, 500);
    const ry = frange(260, 310);
    const slots: NeutralSlot[] = [{ zone: boxAround(cx, cy, 50), rich: true }];
    const spokes = count - 1;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < spokes; i++) {
      const a = phase + (i / Math.max(1, spokes)) * Math.PI * 2;
      slots.push({
        zone: boxAround(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 90),
      });
    }
    return slots;
  }

  if (layout === 'clusters') {
    const k = irange(3, 4);
    const centers: Array<{ x: number; y: number }> = [];
    for (let attempt = 0; attempt < 80 && centers.length < k; attempt++) {
      const c = { x: frange(340, 1260), y: frange(280, 720) };
      if (centers.every((q) => Math.hypot(q.x - c.x, q.y - c.y) > 330)) centers.push(c);
    }
    while (centers.length < k) centers.push({ x: frange(340, 1260), y: frange(280, 720) });
    const slots: NeutralSlot[] = [];
    for (let i = 0; i < count; i++) {
      const c = centers[i % centers.length];
      slots.push({ zone: boxAround(c.x, c.y, 130) });
    }
    return slots;
  }

  // scatter
  return Array.from({ length: count }, () => ({ zone: NEUTRAL_ZONE }));
};

interface NeutralSeed {
  type: PlanetType;
  ringCount: RingCount;
  garrison: number;
}

/**
 * Roll a neutral planet's profile from its contestedness `value` in [0, 1].
 * Low value (close to somebody's start): small, bare, lightly held — quick,
 * safe expansion food. High value (deep contested space): bigger, likelier
 * to carry rings, and garrisoned to match. The gradient is what makes target
 * selection a real decision instead of "nearest first, always".
 */
const rollNeutralFromValue = (value: number, rich = false): NeutralSeed => {
  if (rich) {
    // Ringworld center: a two-ring XL worth fighting every neighbor for.
    return { type: 2, ringCount: 2, garrison: irange(18, 24) };
  }
  const type = weightedPick<PlanetType>([
    [0, 2.2 - 1.6 * value],
    [1, 2.4],
    [2, 0.3 + 1.9 * value],
  ]);
  let ringCount: RingCount = 0;
  if (Math.random() < 0.12 + 0.6 * value) {
    ringCount = type === 2 && value > 0.65 && Math.random() < 0.35 ? 2 : 1;
  }
  ringCount = clampRingCount(type, ringCount);
  const baseGarrison =
    type === 2 ? irange(12, 18) : type === 1 ? irange(8, 14) : irange(5, 9);
  const garrison = Math.max(3, Math.round(baseGarrison * (0.75 + 0.7 * value)));
  return { type, ringCount, garrison };
};

type PlanetDraft = MapSpec['planets'][number];

/** Add one unfilled ring to a drafted planet, respecting its size cap. */
const addRing = (p: PlanetDraft): boolean => {
  const type = (p.type ?? 0) as PlanetType;
  const next = clampRingCount(type, (p.ringCount ?? 0) + 1);
  if (next === (p.ringCount ?? 0)) return false;
  p.ringCount = next;
  return true;
};

/** Rough worth of a drafted planet — used to pick which world a hazard guards. */
const draftValue = (p: PlanetDraft): number =>
  p.garrison + (p.ringCount ?? 0) * 8 + ((p.type ?? 0) as number) * 6;

/**
 * Pick a neutral planet id biased toward the valuable end: sort by worth and
 * choose randomly among the top three, so treasure hunts vary between matches
 * without ever guarding a worthless rock.
 */
const pickValuableNeutral = (
  planets: ReadonlyArray<PlanetDraft>,
  firstNeutral: number,
  exclude?: (id: number) => boolean,
): number | null => {
  const ids: number[] = [];
  for (let i = firstNeutral; i < planets.length; i++) {
    if (exclude?.(i)) continue;
    ids.push(i);
  }
  if (ids.length === 0) return null;
  ids.sort((a, b) => draftValue(planets[b]) - draftValue(planets[a]));
  return ids[Math.floor(Math.random() * Math.min(3, ids.length))];
};

/** Chance a hazardous match rolls a second hazard of a different kind. */
const SECOND_HAZARD_CHANCE = 0.3;

/**
 * Roll one hazard of the given kind. Hazards guard rewards: most rolls latch
 * onto a neutral planet and sweeten it (extra ring, deeper garrison), so the
 * danger zone on the map is also the treasure map. `planets` is mutated when
 * a hazard upgrades the world it guards.
 */
const rollHazardOfKind = (
  variant: HazardKind,
  cfg: MapGenConfig,
  planets: PlanetDraft[],
  positions: ReadonlyArray<{ x: number; y: number; r: number }>,
): HazardSpec | null => {
  const starts = positions.slice(0, cfg.playerCount);
  const firstNeutral = cfg.playerCount;

  if (variant === 'driftingPlanet') {
    // Only neutral worlds drift — the start worlds stay anchored. Prefer a
    // ringed drifter (a moving treasure whose capture timing matters); if
    // none rolled, mint one so the wanderer is always worth chasing.
    const ringed: number[] = [];
    const bare: number[] = [];
    for (let i = firstNeutral; i < planets.length; i++) {
      ((planets[i].ringCount ?? 0) > 0 ? ringed : bare).push(i);
    }
    const pool = ringed.length > 0 ? ringed : bare;
    if (pool.length === 0) return null;
    const planetId = pool[Math.floor(Math.random() * pool.length)];
    if (ringed.length === 0) addRing(planets[planetId]);
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
    // Treasure in the rocks: most fields wrap a neutral planet, and that
    // planet gets sweeter — an extra ring and a deeper garrison. Slow going
    // for the attacker, but also for anyone counterattacking the new owner.
    const guarded = Math.random() < 0.65 ? pickValuableNeutral(planets, firstNeutral) : null;
    if (guarded !== null) {
      const p = planets[guarded];
      addRing(p);
      p.garrison = Math.round(p.garrison * 1.5);
      const bodyR = SIZE_RADIUS[(p.type ?? 0) as PlanetType];
      return {
        type: 'asteroidField',
        pos: { x: p.pos.x, y: p.pos.y },
        radius: Math.max(frange(150, 220), bodyR * 2.8),
        slowdown: 0.32,
        seed: Math.floor(Math.random() * 1e9),
      };
    }
    // Fallback: a free-floating belt between two neutral planets, sitting in
    // a likely flight path. Mid-map when there aren't enough neutrals.
    let cx = MAP_WIDTH / 2;
    let cy = MAP_HEIGHT / 2;
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

  if (variant === 'blackHole') {
    // The hardest hazard: a gravity well in the contested middle. Placement
    // must leave every planet's orbit band untouched (center far enough that
    // orbiters never feel pull) and stay well clear of the start worlds. If
    // the map is too dense, shrink the well before giving up — a null roll
    // just means this match stays hole-free.
    const horizonRadius = irange(16, 20);
    let gravityRadius = frange(130, 170);
    while (gravityRadius >= 110) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = {
          x: frange(MAP_WIDTH * 0.28, MAP_WIDTH * 0.72),
          y: frange(MAP_HEIGHT * 0.3, MAP_HEIGHT * 0.7),
        };
        const clearOfPlanets = positions.every(
          (p) => Math.hypot(candidate.x - p.x, candidate.y - p.y) > gravityRadius + 110,
        );
        const clearOfStarts = starts.every(
          (s) => Math.hypot(candidate.x - s.x, candidate.y - s.y) > 340,
        );
        if (clearOfPlanets && clearOfStarts) {
          // Dangerous riches: neutrals in the well's neighborhood gain a
          // ring. Attacking or holding them means flying the slingshot line
          // every time — a skill play with a fatal inner edge.
          let sweetened = 0;
          for (let i = firstNeutral; i < planets.length && sweetened < 2; i++) {
            const p = planets[i];
            const d = Math.hypot(candidate.x - p.pos.x, candidate.y - p.pos.y);
            if (d < gravityRadius * 2.2 && addRing(p)) sweetened++;
          }
          return {
            type: 'blackHole',
            pos: candidate,
            horizonRadius,
            gravityRadius,
            seed: Math.floor(Math.random() * 1e9),
          };
        }
      }
      gravityRadius -= 15;
    }
    return null;
  }

  // neutralSwarm — a guardian pack anchored on a prize worth guarding. The
  // guarded world gets sweeter (ring + garrison), the swarm patrols right on
  // top of it, and once the planet is captured the pack stops replenishing.
  const guarded = pickValuableNeutral(planets, firstNeutral);
  if (guarded !== null) {
    const p = planets[guarded];
    if ((p.ringCount ?? 0) === 0) addRing(p);
    p.garrison = Math.round(p.garrison * 1.25);
    const bodyR = SIZE_RADIUS[(p.type ?? 0) as PlanetType];
    return {
      type: 'neutralSwarm',
      pos: { x: p.pos.x, y: p.pos.y },
      count: irange(4, 6),
      patrolRadius: Math.max(frange(110, 160), bodyR * 2.4 + 30),
      seed: Math.floor(Math.random() * 1e9),
      guardPlanetId: guarded,
    };
  }
  // Fallback (no neutrals at all): free-floating swarm clear of the starts.
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

/**
 * Roll the match's hazards from the level's allowed pool (or none). A
 * hazardous match always gets one hazard; when the pool offers more than
 * one kind there's a further chance of a second, distinct-kind hazard —
 * so drifting planets and asteroid belts genuinely show up over a session
 * rather than living only in a rare corner of the roll table.
 */
const rollHazards = (
  cfg: MapGenConfig,
  planets: PlanetDraft[],
  positions: ReadonlyArray<{ x: number; y: number; r: number }>,
): HazardSpec[] => {
  if (cfg.hazardPool.length === 0) return [];
  if (Math.random() < cfg.calmChance) return [];
  const pool = [...new Set(cfg.hazardPool)];
  const first = pool[Math.floor(Math.random() * pool.length)];
  const hazards: HazardSpec[] = [];
  const rolled = rollHazardOfKind(first, cfg, planets, positions);
  if (rolled) hazards.push(rolled);
  const rest = pool.filter((k) => k !== first);
  if (hazards.length > 0 && rest.length > 0 && Math.random() < SECOND_HAZARD_CHANCE) {
    const second = rollHazardOfKind(
      rest[Math.floor(Math.random() * rest.length)],
      cfg,
      planets,
      positions,
    );
    if (second) hazards.push(second);
  }
  return hazards;
};

/** Generate a fresh constellation for the given level configuration. */
export const generateMap = (cfg: MapGenConfig): MapSpec => {
  const totalPlanets = Math.max(
    cfg.playerCount + 2,
    irange(cfg.totalPlanets[0], cfg.totalPlanets[1]),
  );
  const neutralCount = totalPlanets - cfg.playerCount;
  const minSep = frange(MIN_SEPARATION_RANGE[0], MIN_SEPARATION_RANGE[1]);
  const layouts = cfg.layouts && cfg.layouts.length > 0 ? cfg.layouts : ['scatter' as const];
  const layout = layouts[Math.floor(Math.random() * layouts.length)];

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

  // Neutrals — place first (layout decides where), value them second (their
  // position decides what they're worth). Placement uses a mid-size radius
  // stand-in; the separation floor dwarfs any radius delta.
  const slots = buildNeutralSlots(layout, neutralCount);
  const neutralPositions: Array<{ x: number; y: number; rich: boolean }> = [];
  for (const slot of slots) {
    let pos = tryPlace(slot.zone, placed, SIZE_RADIUS[1], minSep);
    let relaxed = minSep;
    while (!pos && relaxed > MIN_SEPARATION_RANGE[0] - 50) {
      relaxed -= 20;
      pos = tryPlace(slot.zone, placed, SIZE_RADIUS[1], relaxed);
    }
    if (!pos) pos = rollInZone(slot.zone);
    neutralPositions.push({ ...pos, rich: slot.rich ?? false });
    placed.push({ ...pos, r: SIZE_RADIUS[1] });
  }

  // Contestedness: distance to the nearest start, min-max normalized across
  // this map's neutrals. Worlds near somebody's doorstep come out cheap;
  // deep-space worlds come out rich and defended.
  const starts = placed.slice(0, cfg.playerCount);
  const nearestStart = neutralPositions.map((p) =>
    Math.min(...starts.map((s) => Math.hypot(s.x - p.x, s.y - p.y))),
  );
  const dMin = Math.min(...nearestStart);
  const dMax = Math.max(...nearestStart);
  const span = Math.max(1, dMax - dMin);

  neutralPositions.forEach((p, i) => {
    const value = (nearestStart[i] - dMin) / span;
    const seed = rollNeutralFromValue(value, p.rich);
    planets.push({
      pos: { x: p.x, y: p.y },
      owner: null,
      garrison: seed.garrison,
      type: seed.type,
      ringCount: seed.ringCount,
    });
    placed[cfg.playerCount + i].r = SIZE_RADIUS[seed.type];
  });

  const edges = buildEdges(placed);
  const hazards = rollHazards(cfg, planets, placed);

  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    planets,
    edges,
    hazards,
  };
};
