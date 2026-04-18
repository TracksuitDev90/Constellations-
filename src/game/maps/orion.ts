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
 *
 * Planet types: 0 Regular, 1 Large (1 ring), 2 Extra Large (2 rings).
 */
export const ORION_MAP: MapSpec = {
  width: 1600,
  height: 1000,
  planets: [
    { pos: { x: 350, y: 260 }, radius: 18, owner: 0, garrison: 12, type: 0 },   // 0 player start (regular)
    { pos: { x: 1250, y: 260 }, radius: 18, owner: 1, garrison: 12, type: 0 },  // 1 AI start (regular)
    { pos: { x: 650, y: 520 }, radius: 22, owner: null, garrison: 10, type: 1 }, // 2 belt left (large)
    { pos: { x: 800, y: 540 }, radius: 28, owner: null, garrison: 14, type: 2 }, // 3 belt center (XL)
    { pos: { x: 950, y: 520 }, radius: 22, owner: null, garrison: 10, type: 1 }, // 4 belt right (large)
    { pos: { x: 420, y: 800 }, radius: 22, owner: null, garrison: 10, type: 1 }, // 5 left foot (large)
    { pos: { x: 1180, y: 800 }, radius: 22, owner: null, garrison: 10, type: 1 }, // 6 right foot (large)
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
