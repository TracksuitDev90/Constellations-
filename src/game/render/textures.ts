import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Texture,
} from 'pixi.js';
import { paletteFor, toward } from '../../util/color.js';
import { bakePlanetSphere, planetAssetsReady } from './planetAssets.js';
import type { PlanetType } from '../sim/Planet.js';

const cache = new Map<string, Texture>();

/** Render a Graphics build function once into a cached texture. */
export const makeGlowTexture = (
  app: Application,
  key: string,
  build: (g: Graphics) => void,
): Texture => {
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new Graphics();
  build(g);
  const bounds = g.getBounds();
  const w = Math.max(1, Math.ceil(bounds.width));
  const h = Math.max(1, Math.ceil(bounds.height));
  const rt = RenderTexture.create({
    width: w,
    height: h,
    resolution: app.renderer.resolution,
    antialias: true,
  });
  const container = new Container();
  container.addChild(g);
  container.x = -bounds.x;
  container.y = -bounds.y;
  app.renderer.render({ container, target: rt });
  cache.set(key, rt);
  return rt;
};

/** A soft white glow dot used tinted for ships / orbiters. */
export const makeShipTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'ship', (g) => {
    for (let i = 12; i > 0; i--) {
      const a = (i / 12) * 0.18;
      g.circle(16, 16, i).fill({ color: 0xffffff, alpha: a });
    }
    g.circle(16, 16, 3).fill({ color: 0xffffff, alpha: 1 });
  });
};

/**
 * A wider, softer halo used behind each unit with additive blending so that
 * clusters of units accumulate into visibly brighter hotspots without losing
 * the read of individual ships. Radius is much larger than the ship texture
 * so overlaps are common whenever units are near each other.
 */
export const makeShipGlowTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'ship-glow', (g) => {
    const R = 28;
    for (let i = R; i > 0; i--) {
      const t = i / R;
      // Gaussian-ish falloff so the glow has a bright core and a long tail
      // that fades out cleanly at the edges.
      const a = Math.pow(1 - t, 2) * 0.085;
      g.circle(R, R, i).fill({ color: 0xffffff, alpha: a });
    }
  });
};

/**
 * An archetype id is the base filename of one of the equirectangular maps in
 * public/textures (e.g. 'IMG_0314'). Every planet pulls a stable archetype id
 * from the pool and the baker projects that map onto a lit sphere at runtime.
 */
export type PlanetArchetype = string;

/**
 * Source files in public/textures whose painted artwork would clash with
 * the runtime ring overlay system. IMG_0327 (blue brushstroke ring) and
 * IMG_0344 (teal tendril) are still loaded — their painted rings are the
 * canonical reference that planetAssets.ts lifts and applies as overlays —
 * but we keep IMG_0320 (Saturn-style tan rings) out of the body pool because
 * its ring style doesn't match the unified overlay look.
 */
const RING_PAINTED_TEXTURES: ReadonlySet<PlanetArchetype> = new Set([
  'IMG_0320',
]);

/**
 * The full pool of available planet textures: IMG_0314 … IMG_0352 minus the
 * ones whose source artwork already contains rings or trails. Adding a new
 * map means dropping the file in public/textures and extending this list —
 * the baker keys off the id directly.
 */
export const PHOTOGRAPHIC_ARCHETYPES: readonly PlanetArchetype[] = Array.from(
  { length: 39 },
  (_, i) => `IMG_${String(314 + i).padStart(4, '0')}`,
).filter((id) => !RING_PAINTED_TEXTURES.has(id));

/**
 * Reserved for archetypes that should stay procedural instead of using a
 * baked map. Currently empty — every archetype has a photographic source.
 */
export const PROCEDURAL_ONLY: ReadonlySet<PlanetArchetype> = new Set();

/**
 * How large (in pixels) the baked sphere texture is for a given planet radius.
 * Stays sharp under zoom while keeping GPU memory reasonable.
 */
export const bakedBodyDiameter = (radius: number): number =>
  Math.max(128, Math.round(radius * 3));

/**
 * Per-match archetype assignment. Populated by `assignPlanetArchetypes` at the
 * start of a match so every planet pulls a *distinct* texture from the pool
 * while the pool is large enough (no two planets share the same baked map
 * unless the match has more planets than archetypes). Cleared + refilled on
 * each new match so replays feel fresh.
 */
const archetypeAssignments = new Map<number, PlanetArchetype>();

/**
 * Deterministic Fisher–Yates shuffle — same seed in → same sequence out, so
 * a match's texture set is stable within itself (tests, re-bakes on evolve)
 * but varies between matches when the caller passes a time-based seed.
 */
const shuffledArchetypes = (seed: number): PlanetArchetype[] => {
  const arr = PHOTOGRAPHIC_ARCHETYPES.slice();
  let a = (seed | 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
};

/**
 * Assign a unique archetype to every planet id for the lifetime of a match.
 * If the map has more planets than available archetypes we wrap around,
 * ensuring we still maximize spread rather than collapsing to a few repeats.
 */
export const assignPlanetArchetypes = (
  planetIds: readonly number[],
  seed: number,
): void => {
  archetypeAssignments.clear();
  const shuffled = shuffledArchetypes(seed);
  for (let i = 0; i < planetIds.length; i++) {
    archetypeAssignments.set(planetIds[i], shuffled[i % shuffled.length]);
  }
};

export const archetypeForSeed = (
  seed: number,
  _planetType?: PlanetType,
): PlanetArchetype => {
  const assigned = archetypeAssignments.get(seed);
  if (assigned) return assigned;
  const h = Math.abs(Math.imul(seed + 0x9e3779b9, 2654435761)) >>> 0;
  return PHOTOGRAPHIC_ARCHETYPES[h % PHOTOGRAPHIC_ARCHETYPES.length];
};

/**
 * Build a planet body texture that reads as a 3D-lit sphere. Whenever the
 * baked photographic source is ready we project it onto the disc; otherwise
 * we fall back to a generic lit-sphere placeholder for the brief window
 * before assets finish loading.
 */
export const makePlanetBodyTexture = (
  app: Application,
  ownerId: number | null,
  radius: number,
  seed: number,
  planetType?: PlanetType,
): Texture => {
  const archetype = archetypeForSeed(seed, planetType);

  if (planetAssetsReady() && !PROCEDURAL_ONLY.has(archetype)) {
    // Bake larger than the sim radius for crisper pixels under zoom. The
    // PlanetLayer scales the sprite down via `bodyBaseScale` so the visible
    // sphere radius still matches `radius`.
    const diameter = bakedBodyDiameter(radius);
    return bakePlanetSphere(archetype, seed, diameter);
  }

  const key = `planet-body:fallback:${ownerId ?? 'n'}:${Math.round(radius)}:${seed}`;
  return makeGlowTexture(app, key, (g) => {
    const pal = paletteFor(ownerId);
    const pad = 2;
    const cx = radius + pad;
    const cy = radius + pad;
    const r = radius;

    const dark = toward(pal.core, 0x000000, 0.6);
    const lit = toward(pal.core, 0xffffff, 0.45);
    drawLitSphere(g, cx, cy, r, dark, pal.core, lit);

    // Specular highlight near the lit pole.
    g.circle(cx - r * 0.38, cy - r * 0.4, r * 0.22).fill({
      color: 0xffffff,
      alpha: 0.35,
    });
    g.circle(cx - r * 0.44, cy - r * 0.46, r * 0.1).fill({
      color: 0xffffff,
      alpha: 0.65,
    });

    // Crisp rim highlight on the lit side.
    g.arc(cx, cy, r * 0.98, Math.PI * 1.1, Math.PI * 1.75).stroke({
      width: Math.max(1, r * 0.045),
      color: toward(pal.core, 0xffffff, 0.65),
      alpha: 0.55,
    });

    // Faint atmosphere on the dark limb.
    g.arc(cx, cy, r * 0.99, Math.PI * 0.15, Math.PI * 0.9).stroke({
      width: Math.max(1, r * 0.035),
      color: toward(pal.core, 0x000000, 0.4),
      alpha: 0.35,
    });
  });
};

/** Stacked, offset circles produce a cheap lit-sphere gradient. */
const drawLitSphere = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  dark: number,
  base: number,
  lit: number,
  steps = 18,
): void => {
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const rr = r * (1 - t * 0.55);
    const ox = -r * 0.28 * t;
    const oy = -r * 0.28 * t;
    const col =
      t < 0.5
        ? toward(dark, base, t * 2)
        : toward(base, lit, (t - 0.5) * 2);
    g.circle(cx + ox, cy + oy, rr).fill({ color: col, alpha: 1 });
  }
};

/** Large soft halo behind a planet, tinted to owner glow. */
export const makePlanetHaloTexture = (
  app: Application,
  ownerId: number | null,
  radius: number,
): Texture => {
  const key = `planet-halo:${ownerId ?? 'n'}:${Math.round(radius)}`;
  return makeGlowTexture(app, key, (g) => {
    const pal = paletteFor(ownerId);
    const r = radius * 2.6;
    for (let i = 20; i > 0; i--) {
      const t = i / 20;
      g.circle(r, r, r * t).fill({ color: pal.glow, alpha: 0.06 * t });
    }
  });
};

/** Simple starfield texture (tiled). */
export const makeStarfieldTexture = (app: Application, size = 512): Texture => {
  return makeGlowTexture(app, `stars:${size}`, (g) => {
    g.rect(0, 0, size, size).fill({ color: 0x050810, alpha: 1 });
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < size / 2; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = rng() * 1.4 + 0.2;
      const a = rng() * 0.7 + 0.1;
      g.circle(x, y, r).fill({ color: 0xcfd6e4, alpha: a });
    }
  });
};

const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
