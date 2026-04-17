import type { Vec2 } from '../../util/math.js';

export interface Planet {
  id: number;
  pos: Vec2;
  radius: number;
  owner: number | null;
  garrison: number;
  productionRate: number;
  productionAcc: number;
  capturePulse: number;
}

export const createPlanet = (
  id: number,
  pos: Vec2,
  radius: number,
  owner: number | null,
  garrison: number,
): Planet => ({
  id,
  pos,
  radius,
  owner,
  garrison,
  productionRate: radius / 22,
  productionAcc: 0,
  capturePulse: 0,
});
