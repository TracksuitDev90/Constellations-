import type { Vec2 } from '../../util/math.js';

/**
 * Planet sizes. A planet evolves up the chain when the last of its rings is
 * filled with absorbed units (Auralux: Constellations' "explode into a bigger
 * size" mechanic). XXL is the cap.
 */
export type PlanetType = 0 | 1 | 2 | 3; // Small, Large, Extra Large, XXL

/** Authored ring count per planet — independent of size, capped by the size. */
export type RingCount = 0 | 1 | 2;

/**
 * World-space radius for each size. The spread is deliberately wide
 * (small → XXL is ~3.5×, up from the old ~2.4×) so the four tiers are
 * unmistakable at a glance — a Large visibly dwarfs a Small, and an XXL
 * dominates its neighborhood. XXL is only ever reached through evolution —
 * map authors should not pick it as a starting type.
 */
export const SIZE_RADIUS: Record<PlanetType, number> = {
  0: 22,
  1: 38,
  2: 55,
  3: 76,
};

/**
 * Base production rate (ships/sec) per size. Roughly doubling per tier
 * (Auralux's curve) so an evolved planet is genuinely scary — the flat old
 * curve (0.8/1.3/1.9/2.6) made upgrading feel optional and matches drag on.
 */
export const BASE_PRODUCTION: Record<PlanetType, number> = {
  0: 0.8,
  1: 1.6,
  2: 3.0,
  3: 5.0,
};

/**
 * Soft cap on live orbit ships per size. Tightened at the top so late-game
 * wins come from production tempo and map control, not from one planet
 * hoarding an unbeatable stockpile.
 */
export const BASE_UNIT_CAPACITY: Record<PlanetType, number> = {
  0: 40,
  1: 70,
  2: 100,
  3: 130,
};

/**
 * Absorbed-unit cost to fill one ring, by the planet's *current* size. A ring
 * on a bigger starting planet costs more — the bigger the leap, the bigger
 * the investment.
 */
export const RING_CAPACITY_FOR_SIZE: Record<PlanetType, number> = {
  0: 15, // Small → Large
  1: 25, // Large → Extra Large (single ring)
  2: 35, // Extra Large → XXL (2 rings)
  3: 0, // XXL is terminal.
};

/**
 * Per-ring difficulty multiplier — the second ring on a planet costs more
 * units than the first, so two-ring worlds are a meaningful long-term
 * investment that the opponent has time to contest. Index 0 is the inner
 * ring, index 1 the outer.
 */
export const RING_CAPACITY_MULT: number[] = [1.0, 1.6];

/** Absorbed-unit cost for a specific ring slot on a planet of the given size. */
export const ringCapacity = (type: PlanetType, ringIdx: number): number =>
  RING_CAPACITY_FOR_SIZE[type] * (RING_CAPACITY_MULT[ringIdx] ?? 1.0);

/** Max ring count the size is allowed to author. */
export const MAX_RING_COUNT: Record<PlanetType, RingCount> = {
  0: 1,
  1: 1,
  2: 2,
  3: 0,
};

/** HP pool per size. Absorb heals before it fills rings. */
export const BASE_MAX_HEALTH: Record<PlanetType, number> = {
  0: 3,
  1: 5,
  2: 7,
  3: 10,
};

export interface Planet {
  id: number;
  pos: Vec2;
  radius: number;
  owner: number | null;
  garrison: number;
  type: PlanetType;
  productionRate: number;
  productionAcc: number;
  capturePulse: number;
  /** Flash intensity [0..1] on evolution; renderer decays it. */
  evolvePulse: number;
  /** Number of unfilled rings this planet carries (0..MAX_RING_COUNT[type]). */
  ringCount: RingCount;
  /**
   * Per-ring absorbed-unit counter, length == ringCount. Only increases while
   * the planet is in absorb mode and not healing.
   */
  ringFillProgress: number[];
  maxUnitCapacity: number;
  /** When true, orbit ships are pulled to the center and consumed on contact. */
  absorbing: boolean;
  /**
   * Sub-unit accumulator for the "phantom garrison" flush while absorbing.
   * Drives how many extra absorbing ghost ships spawn per second to convert
   * uncounted production overflow into visible pulls — so the player sees
   * every garrisoned unit streak inward instead of silently vanishing.
   */
  absorbFlushAcc: number;
  /** HP for absorb-to-heal routing. */
  health: number;
  maxHealth: number;
  /**
   * Per-frame drift velocity in world units / second. Almost always 0; only
   * non-zero on the planet picked by the per-match `driftingPlanet` hazard,
   * which makes that one world physically wander across the map and bounce
   * off the bounds. Pathfinding stays graph-based on `edges`, so the drift
   * is purely a positional effect.
   */
  vx: number;
  vy: number;
}

/** True when the planet has rings and every one is at its per-slot capacity. */
export const ringsComplete = (planet: Planet): boolean => {
  if (planet.ringCount === 0) return false;
  for (let i = 0; i < planet.ringCount; i++) {
    if ((planet.ringFillProgress[i] ?? 0) < ringCapacity(planet.type, i)) return false;
  }
  return true;
};

/** Clamp an authored ring count to the size's allowed max. */
export const clampRingCount = (type: PlanetType, want: number): RingCount => {
  const max = MAX_RING_COUNT[type];
  if (want <= 0) return 0;
  if (want >= max) return max;
  return want as RingCount;
};
