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
 * Sizes: 0 Small, 1 Large, 2 Extra Large, 3 XXL.
 * ringCount is authored per-planet: a ringed planet's rings fill from
 * absorbed orbiters (tap to toggle absorb). When every ring fills, the
 * planet evolves to the next size.
 */
export const ORION_MAP: MapSpec = {
  width: 1600,
  height: 1000,
  planets: [
    // 0 player start: Small with 1 ring — exercises Small → Large.
    { pos: { x: 350, y: 260 }, owner: 0, garrison: 12, type: 0, ringCount: 1 },
    // 1 AI start: Small, plain.
    { pos: { x: 1250, y: 260 }, owner: 1, garrison: 12, type: 0, ringCount: 0 },
    // 2 belt left: Large, no ring (flat reinforcement target).
    { pos: { x: 650, y: 520 }, owner: null, garrison: 10, type: 1, ringCount: 0 },
    // 3 belt center: Extra Large with 2 rings — exercises XL → XXL.
    { pos: { x: 800, y: 540 }, owner: null, garrison: 14, type: 2, ringCount: 2 },
    // 4 belt right: Large with 1 ring — exercises Large → XL.
    { pos: { x: 950, y: 520 }, owner: null, garrison: 10, type: 1, ringCount: 1 },
    // 5 left foot: Large, no ring.
    { pos: { x: 420, y: 800 }, owner: null, garrison: 10, type: 1, ringCount: 0 },
    // 6 right foot: Large with 1 ring.
    { pos: { x: 1180, y: 800 }, owner: null, garrison: 10, type: 1, ringCount: 1 },
  ],
  edges: [
    [0, 2], // left shoulder -> belt left
    [1, 4], // right shoulder -> belt right
    [2, 3], // belt left -> belt center
    [3, 4], // belt center -> belt right
    [2, 5], // belt left -> left foot
    [4, 6], // belt right -> right foot
    [5, 3], // left foot -> belt center
    [6, 3], // right foot -> belt center
    [0, 5], // shoulder -> foot same side
    [1, 6],
  ],
};
