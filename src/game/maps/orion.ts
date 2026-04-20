import type { MapSpec } from '../sim/World.js';

/**
 * Orion-inspired 7-node layout. Positions are randomized per-load inside
 * role-specific zones so every match feels fresh, while the connectivity
 * graph (shoulders → belt → feet) stays stable enough that strategy reads
 * the same from game to game.
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

const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

/** Pairwise minimum center-to-center distance when rolling positions. */
const MIN_PLANET_SEPARATION = 220;

interface Zone {
  x: [number, number];
  y: [number, number];
}

interface PlanetTemplate {
  zone: Zone;
  owner: number | null;
  garrison: number;
  type: 0 | 1 | 2;
  ringCount: 0 | 1 | 2;
}

/**
 * Role-aligned zones keep the player/AI on opposite sides and neutrals in
 * between, so randomization doesn't scramble the strategic layout.
 */
const TEMPLATES: PlanetTemplate[] = [
  // 0 player start: Small with 1 ring — exercises Small → Large.
  { zone: { x: [220, 520], y: [120, 380] }, owner: 0, garrison: 12, type: 0, ringCount: 1 },
  // 1 AI start: Small, plain.
  { zone: { x: [1080, 1380], y: [120, 380] }, owner: 1, garrison: 12, type: 0, ringCount: 0 },
  // 2 belt left: Large, no ring (flat reinforcement target).
  { zone: { x: [500, 720], y: [420, 660] }, owner: null, garrison: 10, type: 1, ringCount: 0 },
  // 3 belt center: Extra Large with 2 rings — exercises XL → XXL.
  { zone: { x: [720, 880], y: [420, 660] }, owner: null, garrison: 14, type: 2, ringCount: 2 },
  // 4 belt right: Large with 1 ring — exercises Large → XL.
  { zone: { x: [880, 1100], y: [420, 660] }, owner: null, garrison: 10, type: 1, ringCount: 1 },
  // 5 left foot: Large, no ring.
  { zone: { x: [220, 520], y: [700, 920] }, owner: null, garrison: 10, type: 1, ringCount: 0 },
  // 6 right foot: Large with 1 ring.
  { zone: { x: [1080, 1380], y: [700, 920] }, owner: null, garrison: 10, type: 1, ringCount: 1 },
];

const EDGES: Array<[number, number]> = [
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
];

const rollInZone = (zone: Zone): { x: number; y: number } => ({
  x: zone.x[0] + Math.random() * (zone.x[1] - zone.x[0]),
  y: zone.y[0] + Math.random() * (zone.y[1] - zone.y[0]),
});

/**
 * Generate a fresh Orion-shaped map. Positions are re-rolled per call;
 * connectivity and per-planet role (owner, size, ring count) stay constant
 * so the map always plays as the intended scenario.
 */
export const generateOrionMap = (): MapSpec => {
  const planets: MapSpec['planets'] = [];
  const placed: Array<{ x: number; y: number }> = [];
  for (const t of TEMPLATES) {
    let pos = rollInZone(t.zone);
    // Rejection sample so neighbors don't visually smash their atom rings
    // into each other. Fall back to the last roll if we exhaust attempts.
    for (let attempt = 0; attempt < 32; attempt++) {
      const ok = placed.every(
        (q) => Math.hypot(q.x - pos.x, q.y - pos.y) >= MIN_PLANET_SEPARATION,
      );
      if (ok) break;
      pos = rollInZone(t.zone);
    }
    placed.push(pos);
    planets.push({
      pos,
      owner: t.owner,
      garrison: t.garrison,
      type: t.type,
      ringCount: t.ringCount,
    });
  }
  return { width: MAP_WIDTH, height: MAP_HEIGHT, planets, edges: EDGES };
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
  edges: EDGES,
};
