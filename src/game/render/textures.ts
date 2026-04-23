import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Texture,
} from 'pixi.js';
import { adjustColor, paletteFor, toward } from '../../util/color.js';
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

export type PlanetArchetype =
  | 'terrestrial'
  | 'gasGiant'
  | 'icy'
  | 'molten'
  | 'alien'
  | 'poison'
  | 'amethyst'
  | 'ember'
  | 'oceanic'
  | 'verdant'
  | 'desert';

/**
 * Every archetype now has a baked equirectangular source in public/textures —
 * procedural-only archetypes were retired in favor of the texture pool.
 */
export const PROCEDURAL_ONLY: ReadonlySet<PlanetArchetype> = new Set();

/**
 * How large (in pixels) the baked sphere texture is for a given planet radius.
 * Stays sharp under zoom while keeping GPU memory reasonable.
 */
export const bakedBodyDiameter = (radius: number): number =>
  Math.max(128, Math.round(radius * 3));

/**
 * Every planet — regardless of size — pulls from the same pool of
 * equirectangular textures in public/textures. Sizes no longer gate the look,
 * so a small world can be a poison swamp and an XXL can be an ocean planet.
 */
const PHOTOGRAPHIC_ARCHETYPES: PlanetArchetype[] = [
  'terrestrial',
  'gasGiant',
  'icy',
  'molten',
  'alien',
  'poison',
  'amethyst',
  'ember',
  'oceanic',
  'verdant',
  'desert',
];

export const archetypeForSeed = (
  seed: number,
  _planetType?: PlanetType,
): PlanetArchetype => {
  const h = Math.abs(Math.imul(seed + 0x9e3779b9, 2654435761)) >>> 0;
  return PHOTOGRAPHIC_ARCHETYPES[h % PHOTOGRAPHIC_ARCHETYPES.length];
};

/**
 * Build a planet body texture that reads as a 3D-lit sphere with archetype-
 * specific surface features. The seed both picks the archetype and perturbs
 * the details so each star in the constellation feels distinct.
 */
export const makePlanetBodyTexture = (
  app: Application,
  ownerId: number | null,
  radius: number,
  seed: number,
  planetType?: PlanetType,
): Texture => {
  const archetype = archetypeForSeed(seed, planetType);

  // Prefer the baked photographic sphere when the asset set is available —
  // unless this is a procedural-only archetype (the alien variants), which
  // intentionally stay graphics-drawn for an otherworldly look.
  // The baked texture does not depend on ownerId, so ownership is carried
  // by the halo/rings/orbiters around the planet.
  if (planetAssetsReady() && !PROCEDURAL_ONLY.has(archetype)) {
    // Bake larger than the sim radius for crisper pixels under zoom. The
    // PlanetLayer scales the sprite down via `bodyBaseScale` so the visible
    // sphere radius still matches `radius`.
    const diameter = bakedBodyDiameter(radius);
    return bakePlanetSphere(archetype, seed, diameter);
  }

  const key = `planet-body:${archetype}:${ownerId ?? 'n'}:${Math.round(radius)}:${seed}`;
  return makeGlowTexture(app, key, (g) => {
    const pal = paletteFor(ownerId);
    const pad = 2;
    const cx = radius + pad;
    const cy = radius + pad;
    const r = radius;
    const rng = mulberry32(seed * 1337 + ((ownerId ?? -1) + 11) * 97 + Math.round(radius) * 7);

    drawArchetype(g, archetype, cx, cy, r, pal.core, rng);

    // Specular highlight near the lit pole (shared across all archetypes).
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

type Rng = () => number;

const drawArchetype = (
  g: Graphics,
  type: PlanetArchetype,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  switch (type) {
    case 'terrestrial':
      return drawTerrestrial(g, cx, cy, r, core, rng);
    case 'gasGiant':
      return drawGasGiant(g, cx, cy, r, core, rng);
    case 'icy':
      return drawIcy(g, cx, cy, r, core, rng);
    case 'molten':
      return drawMolten(g, cx, cy, r, core, rng);
    case 'alien':
      return drawAlien(g, cx, cy, r, core, rng);
    case 'poison':
      return drawSimpleSphere(g, cx, cy, r, 0x220a38, 0x5a1e7a, 0xb6f03a);
    case 'amethyst':
      return drawSimpleSphere(g, cx, cy, r, 0x1e0a3a, 0x5a2c8e, 0xe6d2ff);
    case 'ember':
      return drawSimpleSphere(g, cx, cy, r, 0x0a0606, 0x3c2020, 0xff6a1a);
    case 'oceanic':
      return drawSimpleSphere(g, cx, cy, r, 0x041230, 0x1e5890, 0xd8efff);
    case 'verdant':
      return drawSimpleSphere(g, cx, cy, r, 0x1a2a0a, 0x4a7a28, 0xc2e878);
    case 'desert':
      return drawSimpleSphere(g, cx, cy, r, 0x5a2e18, 0xb0823e, 0xf4d9a0);
  }
};

/** Cheap lit-sphere fallback for archetypes without bespoke procedural art. */
const drawSimpleSphere = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  dark: number,
  base: number,
  lit: number,
): void => {
  drawLitSphere(g, cx, cy, r, dark, base, lit);
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

// ─── Terrestrial (earth-like): oceans, continents, polar caps, clouds ──────
const drawTerrestrial = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  const ocean = toward(core, 0x0a1a2e, 0.2);
  const deep = toward(core, 0x000814, 0.55);
  const shallow = toward(core, 0xffffff, 0.35);
  drawLitSphere(g, cx, cy, r, deep, ocean, shallow);

  // Continents — irregular blobs made from overlapping darker circles.
  const landColor = adjustColor(toward(core, 0x3d2b14, 0.55), 0.9);
  const landLight = toward(landColor, 0xffffff, 0.25);
  const continents = 3 + Math.floor(rng() * 3);
  for (let c = 0; c < continents; c++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * r * 0.55;
    const bx = cx + Math.cos(a) * d;
    const by = cy + Math.sin(a) * d;
    const blobs = 5 + Math.floor(rng() * 5);
    for (let i = 0; i < blobs; i++) {
      const off = rng() * r * 0.28;
      const aa = rng() * Math.PI * 2;
      const px = bx + Math.cos(aa) * off;
      const py = by + Math.sin(aa) * off;
      const pr = r * (0.07 + rng() * 0.13);
      // Only if inside the disc.
      if (Math.hypot(px - cx, py - cy) + pr > r * 0.93) continue;
      const col = rng() < 0.3 ? landLight : landColor;
      g.circle(px, py, pr).fill({ color: col, alpha: 0.85 });
    }
  }

  // Polar ice caps.
  g.ellipse(cx, cy - r * 0.88, r * 0.55, r * 0.18).fill({
    color: 0xf2f8ff,
    alpha: 0.75,
  });
  g.ellipse(cx, cy + r * 0.88, r * 0.5, r * 0.15).fill({
    color: 0xf2f8ff,
    alpha: 0.65,
  });

  // Thin cloud streaks — soft white arcs.
  for (let i = 0; i < 4; i++) {
    const cy2 = cy + (rng() - 0.5) * r * 1.2;
    const rx = r * (0.7 + rng() * 0.25);
    const ry = r * (0.05 + rng() * 0.08);
    g.ellipse(cx + (rng() - 0.5) * r * 0.2, cy2, rx, ry).fill({
      color: 0xffffff,
      alpha: 0.12 + rng() * 0.12,
    });
  }
};

// ─── Gas Giant: horizontal bands + great storm ─────────────────────────────
const drawGasGiant = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  const dark = toward(core, 0x1a0c1f, 0.35);
  const base = core;
  const lit = toward(core, 0xffe8bf, 0.45);
  drawLitSphere(g, cx, cy, r, dark, base, lit);

  // Horizontal cloud bands — ellipses squashed to the disc to imply rotation.
  const bandCount = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < bandCount; i++) {
    const t = (i + 0.5) / bandCount; // 0..1 top→bottom
    const y = cy + (t - 0.5) * 2 * r * 0.9;
    // Narrowing ellipse width near the poles for spherical foreshortening.
    const wFactor = Math.sqrt(1 - Math.pow(t * 2 - 1, 2));
    const bw = r * 0.98 * wFactor;
    const bh = r * (0.045 + rng() * 0.06);
    const tint =
      i % 2 === 0
        ? toward(core, 0xffe4b8, 0.35 + rng() * 0.15)
        : toward(core, 0x2a1410, 0.35 + rng() * 0.2);
    g.ellipse(cx, y, bw, bh).fill({ color: tint, alpha: 0.55 });

    // Turbulent streaks — thinner offset ellipses for swirl detail.
    if (rng() < 0.7) {
      const sw = bw * (0.4 + rng() * 0.4);
      const sh = bh * 0.55;
      const sx = cx + (rng() - 0.5) * (bw - sw);
      const stint = toward(tint, 0xffffff, 0.4);
      g.ellipse(sx, y + (rng() - 0.5) * bh * 0.4, sw, sh).fill({
        color: stint,
        alpha: 0.4,
      });
    }
  }

  // A "great storm" oval.
  if (rng() < 0.85) {
    const sa = rng() * Math.PI * 2;
    const sd = rng() * r * 0.35;
    const sx = cx + Math.cos(sa) * sd;
    const sy = cy + Math.sin(sa) * sd * 0.4; // keep roughly on equator
    const sr = r * (0.16 + rng() * 0.1);
    const stormColor = toward(core, 0xff4a3b, 0.55);
    g.ellipse(sx, sy, sr, sr * 0.55).fill({ color: stormColor, alpha: 0.65 });
    g.ellipse(sx, sy, sr * 0.7, sr * 0.35).fill({
      color: toward(stormColor, 0xffffff, 0.45),
      alpha: 0.7,
    });
  }
};

// ─── Icy: pale surface with frost cracks and bright caps ───────────────────
const drawIcy = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  const paleBase = toward(core, 0xf0faff, 0.55);
  const dark = toward(core, 0x0b1a2a, 0.4);
  const lit = toward(paleBase, 0xffffff, 0.55);
  drawLitSphere(g, cx, cy, r, dark, paleBase, lit);

  // Frost cracks — thin chord-like strokes.
  const cracks = 6 + Math.floor(rng() * 5);
  const crackColor = toward(core, 0x1a2a3a, 0.55);
  for (let i = 0; i < cracks; i++) {
    const a0 = rng() * Math.PI * 2;
    const a1 = a0 + (rng() - 0.5) * 1.6;
    const r0 = r * (0.3 + rng() * 0.55);
    const r1 = r * (0.3 + rng() * 0.55);
    const x0 = cx + Math.cos(a0) * r0;
    const y0 = cy + Math.sin(a0) * r0;
    const x1 = cx + Math.cos(a1) * r1;
    const y1 = cy + Math.sin(a1) * r1;
    const mx = (x0 + x1) / 2 + (rng() - 0.5) * r * 0.2;
    const my = (y0 + y1) / 2 + (rng() - 0.5) * r * 0.2;
    g.moveTo(x0, y0)
      .quadraticCurveTo(mx, my, x1, y1)
      .stroke({
        width: Math.max(0.8, r * 0.025),
        color: crackColor,
        alpha: 0.45,
      });
  }

  // Bright polar caps — larger than terrestrial.
  g.ellipse(cx, cy - r * 0.82, r * 0.8, r * 0.28).fill({
    color: 0xffffff,
    alpha: 0.8,
  });
  g.ellipse(cx, cy + r * 0.82, r * 0.75, r * 0.25).fill({
    color: 0xffffff,
    alpha: 0.7,
  });

  // Subtle sheen spots on ice (cool highlights).
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * r * 0.6;
    const px = cx + Math.cos(a) * d;
    const py = cy + Math.sin(a) * d;
    const pr = r * (0.06 + rng() * 0.08);
    if (Math.hypot(px - cx, py - cy) + pr > r * 0.92) continue;
    g.circle(px, py, pr).fill({ color: 0xc9e8ff, alpha: 0.35 });
  }
};

// ─── Molten / Venus-like: warm swirling cloud cover with glowing cracks ────
const drawMolten = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  const warmBase = toward(core, 0xd86a1f, 0.35);
  const dark = toward(warmBase, 0x1a0300, 0.55);
  const lit = toward(warmBase, 0xfff0c0, 0.45);
  drawLitSphere(g, cx, cy, r, dark, warmBase, lit);

  // Swirly cloud bands — curved arc strokes.
  const swirls = 9 + Math.floor(rng() * 5);
  for (let i = 0; i < swirls; i++) {
    const cy2 = cy + (rng() - 0.5) * r * 1.5;
    const rx = r * (0.6 + rng() * 0.35);
    const ry = r * (0.05 + rng() * 0.09);
    const hueMix = rng();
    const tint =
      hueMix < 0.5
        ? toward(warmBase, 0xffe4a0, 0.45 + rng() * 0.2)
        : toward(warmBase, 0x3a0a00, 0.35 + rng() * 0.25);
    const rot = (rng() - 0.5) * 0.4;
    g.ellipse(cx, cy2, rx, ry).fill({ color: tint, alpha: 0.45 + rng() * 0.25 });
    // Offset sibling ellipse fakes a rotated highlight.
    g.ellipse(cx + Math.cos(rot) * r * 0.2, cy2 + Math.sin(rot) * r * 0.06, rx * 0.7, ry * 0.6)
      .fill({ color: toward(tint, 0xffffff, 0.3), alpha: 0.3 });
  }

  // Glowing lava cracks peeking through the clouds.
  const cracks = 4 + Math.floor(rng() * 4);
  const glow = toward(core, 0xffdd66, 0.5);
  for (let i = 0; i < cracks; i++) {
    const a0 = rng() * Math.PI * 2;
    const a1 = a0 + (rng() - 0.5) * 1.2;
    const r0 = r * (0.2 + rng() * 0.6);
    const r1 = r * (0.2 + rng() * 0.6);
    const x0 = cx + Math.cos(a0) * r0;
    const y0 = cy + Math.sin(a0) * r0;
    const x1 = cx + Math.cos(a1) * r1;
    const y1 = cy + Math.sin(a1) * r1;
    const mx = (x0 + x1) / 2 + (rng() - 0.5) * r * 0.3;
    const my = (y0 + y1) / 2 + (rng() - 0.5) * r * 0.3;
    g.moveTo(x0, y0)
      .quadraticCurveTo(mx, my, x1, y1)
      .stroke({
        width: Math.max(0.8, r * 0.035),
        color: glow,
        alpha: 0.7,
      });
  }

  // Keep poles — dim dusty caps instead of ice.
  g.ellipse(cx, cy - r * 0.9, r * 0.45, r * 0.14).fill({
    color: toward(warmBase, 0x000000, 0.55),
    alpha: 0.5,
  });
  g.ellipse(cx, cy + r * 0.9, r * 0.45, r * 0.14).fill({
    color: toward(warmBase, 0x000000, 0.55),
    alpha: 0.5,
  });
};

// ─── Alien / exotic: neon swirls and glowing patches ───────────────────────
const drawAlien = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  core: number,
  rng: Rng,
): void => {
  const base = toward(core, 0x3b0a4a, 0.25);
  const dark = toward(base, 0x02000a, 0.65);
  const lit = toward(core, 0xd98bff, 0.5);
  drawLitSphere(g, cx, cy, r, dark, base, lit);

  // Neon swirl arcs — multiple curved strokes running around the disc.
  const swirls = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < swirls; i++) {
    const a0 = rng() * Math.PI * 2;
    const sweep = Math.PI * (0.3 + rng() * 0.7);
    const rr = r * (0.35 + rng() * 0.55);
    const tint =
      rng() < 0.5
        ? toward(core, 0x00ffe0, 0.55)
        : toward(core, 0xff5cf0, 0.5);
    g.arc(cx, cy, rr, a0, a0 + sweep).stroke({
      width: Math.max(1, r * (0.04 + rng() * 0.04)),
      color: tint,
      alpha: 0.55,
    });
  }

  // Glowing plasma patches.
  const patches = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < patches; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * r * 0.65;
    const px = cx + Math.cos(a) * d;
    const py = cy + Math.sin(a) * d;
    const pr = r * (0.08 + rng() * 0.12);
    if (Math.hypot(px - cx, py - cy) + pr > r * 0.93) continue;
    const color =
      rng() < 0.5
        ? toward(core, 0x00f0ff, 0.6)
        : toward(core, 0xff40c0, 0.55);
    // Halo under the patch for glow.
    g.circle(px, py, pr * 1.4).fill({ color, alpha: 0.12 });
    g.circle(px, py, pr).fill({ color, alpha: 0.55 });
    g.circle(px, py, pr * 0.55).fill({ color: 0xffffff, alpha: 0.4 });
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
