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
 * World-space radius for each size. Every tier is sized 1.5× the original
 * baseline so planets read big on screen. XXL is only ever reached through
 * evolution — map authors should not pick it as a starting type.
 */
export const SIZE_RADIUS: Record<PlanetType, number> = {
  0: 27,
  1: 39,
  2: 51,
  3: 66,
};

/** Base production rate (ships/sec) per size. Bigger = meaningfully faster. */
export const BASE_PRODUCTION: Record<PlanetType, number> = {
  0: 0.8,
  1: 1.3,
  2: 1.9,
  3: 2.6,
};

/** Soft cap on live orbit ships per size. */
export const BASE_UNIT_CAPACITY: Record<PlanetType, number> = {
  0: 40,
  1: 70,
  2: 110,
  3: 160,
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
}

/** True when the planet has rings and every one is at capacity. */
export const ringsComplete = (planet: Planet): boolean => {
  if (planet.ringCount === 0) return false;
  const cap = RING_CAPACITY_FOR_SIZE[planet.type];
  for (let i = 0; i < planet.ringCount; i++) {
    if ((planet.ringFillProgress[i] ?? 0) < cap) return false;
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
