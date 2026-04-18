import type { Vec2 } from '../../util/math.js';

/** 0 = Regular (no ring), 1 = Large (1 ring), 2 = Extra Large (2 rings). */
export type PlanetType = 0 | 1 | 2;

/** Per-type ring thresholds. Each entry is the garrison required to fill that ring. */
export const RING_THRESHOLDS: Record<PlanetType, number[]> = {
  0: [],
  1: [20],
  2: [25, 60],
};

/** Base production rate per type (ships per second at base size). */
export const BASE_PRODUCTION: Record<PlanetType, number> = {
  0: 0.8,
  1: 1.4,
  2: 2.0,
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
}
