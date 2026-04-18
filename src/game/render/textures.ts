import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Texture,
} from 'pixi.js';
import { adjustColor, paletteFor, toward } from '../../util/color.js';

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
 * Build a planet body texture that reads as a 3D-lit sphere: a dark terminator,
 * a bright lit side, and a small amount of procedural surface detail seeded per
 * planet so each star in the constellation feels distinct.
 */
export const makePlanetBodyTexture = (
  app: Application,
  ownerId: number | null,
  radius: number,
  seed: number,
): Texture => {
  const key = `planet-body:${ownerId ?? 'n'}:${Math.round(radius)}:${seed}`;
  return makeGlowTexture(app, key, (g) => {
    const pal = paletteFor(ownerId);
    const pad = 2;
    const cx = radius + pad;
    const cy = radius + pad;
    const r = radius;
    const rng = mulberry32(seed * 1337 + ((ownerId ?? -1) + 11) * 97 + Math.round(radius) * 7);

    // Build up a lit sphere with stacked, offset circles from dark -> light.
    const darkSide = adjustColor(pal.core, 0.25);
    const baseColor = pal.core;
    const litColor = toward(pal.core, 0xffffff, 0.45);

    const STEPS = 18;
    for (let i = 0; i < STEPS; i++) {
      const t = i / (STEPS - 1);
      const rr = r * (1 - t * 0.55);
      const ox = -r * 0.28 * t;
      const oy = -r * 0.28 * t;
      const col =
        t < 0.5
          ? toward(darkSide, baseColor, t * 2)
          : toward(baseColor, litColor, (t - 0.5) * 2);
      g.circle(cx + ox, cy + oy, rr).fill({ color: col, alpha: 1 });
    }

    // Small surface speckle ("continents" / craters) — kept fully inside disc.
    const specks = 7;
    for (let i = 0; i < specks; i++) {
      const a = rng() * Math.PI * 2;
      const maxD = r * 0.72;
      const d = Math.sqrt(rng()) * maxD;
      const blobR = r * (0.08 + rng() * 0.16);
      if (d + blobR > r * 0.92) continue; // keep inside disc
      const sx = cx + Math.cos(a) * d;
      const sy = cy + Math.sin(a) * d;
      const dark = rng() < 0.55;
      const color = dark ? adjustColor(pal.core, 0.55) : toward(pal.core, 0xffffff, 0.3);
      g.circle(sx, sy, blobR).fill({ color, alpha: 0.35 });
    }

    // Specular highlight near the lit pole.
    g.circle(cx - r * 0.38, cy - r * 0.4, r * 0.22).fill({
      color: 0xffffff,
      alpha: 0.4,
    });
    g.circle(cx - r * 0.42, cy - r * 0.45, r * 0.1).fill({
      color: 0xffffff,
      alpha: 0.7,
    });

    // Crisp rim highlight (thin bright edge on the lit side).
    g.arc(cx, cy, r * 0.98, Math.PI * 1.1, Math.PI * 1.75).stroke({
      width: Math.max(1, r * 0.04),
      color: toward(pal.core, 0xffffff, 0.6),
      alpha: 0.5,
    });

    // Faint atmospheric ring on the dark limb.
    g.arc(cx, cy, r * 0.99, Math.PI * 0.15, Math.PI * 0.9).stroke({
      width: Math.max(1, r * 0.03),
      color: toward(pal.core, 0x000000, 0.4),
      alpha: 0.35,
    });
  });
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
