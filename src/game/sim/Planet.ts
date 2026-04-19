import type { Vec2 } from '../../util/math.js';

/** 0 = Regular (no ring), 1 = Large (1 ring), 2 = Extra Large (2 rings). */
export type PlanetType = 0 | 1 | 2;

/** Per-type ring thresholds. Each entry is the garrison required to fill that ring. */
export const RING_THRESHOLDS: Record<PlanetType, number[]> = {
  0: [],
  1: [20],
  2: [25, 60],
};

/** Base production rate per type (ships per second at base size, zero rings filled). */
export const BASE_PRODUCTION: Record<PlanetType, number> = {
  0: 0.8,
  1: 1.1,
  2: 1.4,
};

/**
 * Multiplier on base production once N rings are filled. Lets ringed planets
 * grow into significant powerhouses once a player invests garrison in them —
 * the Auralux Constellations "fill the rings to upgrade" loop.
 */
export const RING_PRODUCTION_BOOST: Record<PlanetType, number[]> = {
  0: [1],
  1: [1, 1.9],
  2: [1, 1.7, 2.8],
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
  /** Highest ring index whose threshold the garrison has crossed (-1 = none). */
  ringsFilled: number;
}

/** Count how many of this planet's ring thresholds are met by current garrison. */
export const filledRingCount = (planet: Planet): number => {
  const thresholds = RING_THRESHOLDS[planet.type];
  let n = 0;
  for (const t of thresholds) if (planet.garrison >= t) n++;
  return n;
};

/** Production-rate multiplier reflecting how many rings are currently filled. */
export const productionMultiplier = (planet: Planet): number => {
  const table = RING_PRODUCTION_BOOST[planet.type];
  const filled = Math.min(filledRingCount(planet), table.length - 1);
  return table[filled];
};
