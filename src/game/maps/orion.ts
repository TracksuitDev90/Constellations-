import type { MapSpec } from '../sim/World.js';

/**
 * Orion-inspired 7-node layout. Not a literal star chart copy — it evokes the
 * recognizable silhouette (shoulders, belt, feet) within a 1600x1000 world.
 *
 *   0 (left shoulder)          1 (right shoulder)
 *
 *          2 — 3 — 4   (belt)
 *
 *   5 (left foot)              6 (right foot)
 */
export const ORION_MAP: MapSpec = {
  width: 1600,
  height: 1000,
  planets: [
    { pos: { x: 350, y: 260 }, radius: 34, owner: 0, garrison: 30 }, // 0 player start (left shoulder)
    { pos: { x: 1250, y: 260 }, radius: 34, owner: 1, garrison: 30 }, // 1 AI start (right shoulder)
    { pos: { x: 650, y: 520 }, radius: 22, owner: null, garrison: 14 }, // 2 belt left
    { pos: { x: 800, y: 540 }, radius: 26, owner: null, garrison: 18 }, // 3 belt center (biggest)
    { pos: { x: 950, y: 520 }, radius: 22, owner: null, garrison: 14 }, // 4 belt right
    { pos: { x: 420, y: 800 }, radius: 24, owner: null, garrison: 16 }, // 5 left foot
    { pos: { x: 1180, y: 800 }, radius: 24, owner: null, garrison: 16 }, // 6 right foot
  ],
  edges: [
    [0, 2], // left shoulder -> belt left
    [1, 4], // right shoulder -> belt right
    [2, 3], // belt left -> belt center
    [3, 4], // belt center -> belt right
    [2, 5], // belt left -> left foot
    [4, 6], // belt right -> right foot
    [5, 3], // left foot -> belt center (cross-link)
    [6, 3], // right foot -> belt center
    [0, 5], // shoulder -> foot same side
    [1, 6],
  ],
};
