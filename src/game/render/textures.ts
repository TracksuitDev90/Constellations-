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
 * Source files in public/textures that already include painted-in rings or
 * comet-trail decorations. Excluded from the assignment pool so the new
 * runtime ring renderer never has to fight a pre-baked ring on the body.
 *   - IMG_0320: Saturn-style tan rings through the body.
 *   - IMG_0327: cyan swirl/aura that spirals around the body.
 *   - IMG_0344: a dark trailing tendril hanging off the planet.
 */
const RING_PAINTED_TEXTURES: ReadonlySet<PlanetArchetype> = new Set([
  'IMG_0320',
  'IMG_0327',
  'IMG_0344',
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

/**
 * Bake a Graphics build into a fixed-size RenderTexture. Differs from
 * `makeGlowTexture` in that the output size is the caller-supplied (w, h)
 * rather than the build's bounding box — important when the texture has to
 * have a known aspect ratio (e.g. a brush stroke that will be warped along
 * a path by `MeshRope`).
 */
const bakeFixedTexture = (
  app: Application,
  key: string,
  width: number,
  height: number,
  build: (g: Graphics) => void,
): Texture => {
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new Graphics();
  build(g);
  const rt = RenderTexture.create({
    width,
    height,
    resolution: app.renderer.resolution,
    antialias: true,
  });
  app.renderer.render({ container: g, target: rt });
  cache.set(key, rt);
  return rt;
};

/**
 * Painterly brush stroke baked into a long horizontal texture. Designed to be
 * stretched along a path via `MeshRope`: the horizontal axis of the texture
 * follows the path, the vertical axis becomes the stroke's perpendicular
 * width. The shape tapers to fine points at both ends and has irregular
 * top/bottom edges plus internal bristle streaks so the result reads as a
 * confident, hand-painted mark rather than a clean ribbon. White only — the
 * caller tints the rope at runtime.
 */
export const makeBrushStrokeTexture = (app: Application): Texture => {
  const W = 512;
  const H = 64;
  return bakeFixedTexture(app, 'ring-brush-stroke', W, H, (g) => {
    const rng = mulberry32(0xb20a51);
    const cy = H / 2;

    // Build the stroke as a polygon with irregular top/bottom edges. Walking
    // along x, perturb the half-height by a low-frequency noise so the edge
    // looks bristled rather than ruler-straight.
    const samples = 64;
    const top: number[] = [];
    const bottom: number[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = t * W;
      // Tapered width: 0 at ends, ~max in the middle, with the peak biased
      // slightly off-centre so the mark feels human rather than mathematical.
      const taperPeak = Math.pow(Math.sin(Math.pow(t, 0.85) * Math.PI), 0.7);
      const halfH = (H * 0.42) * taperPeak;
      // Per-edge noise: independent low-frequency wobbles for top vs bottom
      // so the stroke doesn't look symmetric.
      const topNoise = (rng() - 0.5) * 1.6 + Math.sin(t * 11 + 1.3) * 1.4;
      const botNoise = (rng() - 0.5) * 1.6 + Math.sin(t * 13 + 4.7) * 1.4;
      top.push(x, cy - halfH + topNoise);
      bottom.push(x, cy + halfH + botNoise);
    }
    const poly: number[] = top.slice();
    for (let i = bottom.length - 2; i >= 0; i -= 2) {
      poly.push(bottom[i], bottom[i + 1]);
    }
    g.poly(poly).fill({ color: 0xffffff, alpha: 1 });

    // Internal bristle streaks — a few thin alpha stripes parallel to the
    // stroke direction give the painterly grain you'd see in a real brush
    // mark on textured paper.
    for (let i = 0; i < 14; i++) {
      const t0 = rng() * 0.85 + 0.05;
      const t1 = Math.min(1, t0 + rng() * 0.35 + 0.08);
      const yOff = (rng() - 0.5) * H * 0.45;
      g.rect(t0 * W, cy + yOff - 0.6, (t1 - t0) * W, 1.2)
        .fill({ color: 0xffffff, alpha: 0.45 });
    }

    // Pigment specks scattered just outside the main mark — sells the
    // watercolour "splatter" feel without overpowering the silhouette.
    for (let i = 0; i < 22; i++) {
      const x = rng() * W;
      const y = cy + (rng() - 0.5) * H * 0.95;
      const r = rng() * 1.6 + 0.4;
      g.circle(x, y, r).fill({ color: 0xffffff, alpha: 0.55 });
    }
  });
};

/**
 * Solid tendril band baked as a long horizontal texture, used for the body
 * of the spiky-tendril ring. Differs from the brush stroke in that it has
 * full width all the way across (no end taper) — the rope wraps the full
 * ellipse, so the stroke is a closed loop. Slight thickness wobble keeps the
 * silhouette organic, and a darker outline along top/bottom edges produces
 * the visible rim seen on the reference dragon-spine band.
 */
export const makeTendrilBodyTexture = (app: Application): Texture => {
  const W = 512;
  const H = 32;
  return bakeFixedTexture(app, 'ring-tendril-body', W, H, (g) => {
    const rng = mulberry32(0x7e7d12);
    const cy = H / 2;
    const samples = 64;
    const top: number[] = [];
    const bottom: number[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = t * W;
      const halfH = H * 0.36 * (1 + Math.sin(t * 7.2) * 0.18 + (rng() - 0.5) * 0.12);
      top.push(x, cy - halfH);
      bottom.push(x, cy + halfH);
    }
    const poly: number[] = top.slice();
    for (let i = bottom.length - 2; i >= 0; i -= 2) {
      poly.push(bottom[i], bottom[i + 1]);
    }
    g.poly(poly).fill({ color: 0xffffff, alpha: 1 });

    // Faint inner streaks for painterly texture along the band.
    for (let i = 0; i < 10; i++) {
      const t0 = rng();
      const t1 = Math.min(1, t0 + rng() * 0.25 + 0.06);
      const yOff = (rng() - 0.5) * H * 0.3;
      g.rect(t0 * W, cy + yOff - 0.5, (t1 - t0) * W, 1)
        .fill({ color: 0xffffff, alpha: 0.4 });
    }
  });
};

/**
 * Painterly triangular spike used for the dragon-spine spikes on the
 * spiky-tendril ring. Tip points up (texture's −y), base spans the bottom.
 * Sprites stamp this with anchor at the base centre and rotate so the tip
 * follows each spike's outward normal. White only — caller tints.
 */
export const makeSpikeTexture = (app: Application): Texture => {
  const W = 48;
  const H = 96;
  return bakeFixedTexture(app, 'ring-spike', W, H, (g) => {
    const rng = mulberry32(0x312fae);
    const cx = W / 2;
    // Slightly asymmetric base so the spike doesn't look mathematically
    // perfect — left/right base offsets are independently jittered.
    const baseLeftX = cx - W * 0.42 + (rng() - 0.5) * 2;
    const baseRightX = cx + W * 0.42 + (rng() - 0.5) * 2;
    const baseY = H - 1;
    const tipX = cx + (rng() - 0.5) * 3;
    const tipY = 1;

    g.poly([baseLeftX, baseY, baseRightX, baseY, tipX, tipY])
      .fill({ color: 0xffffff, alpha: 1 });

    // Inner highlight — a narrower, slightly shorter triangle in lighter
    // alpha down the middle, like a wet-edge gloss on the spike.
    const innerLeftX = cx - W * 0.18;
    const innerRightX = cx + W * 0.18;
    const innerBaseY = H * 0.72;
    const innerTipY = H * 0.18;
    g.poly([innerLeftX, innerBaseY, innerRightX, innerBaseY, cx, innerTipY])
      .fill({ color: 0xffffff, alpha: 0.4 });
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
