import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  Texture,
} from 'pixi.js';
import { paletteFor } from '../../util/color.js';

const cache = new Map<string, Texture>();

/** Radial-gradient glow disc, rendered once into a cached texture. */
export const makeGlowTexture = (app: Application, key: string, build: (g: Graphics) => void): Texture => {
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new Graphics();
  build(g);
  const bounds = g.getBounds();
  const size = Math.max(bounds.width, bounds.height);
  const rt = RenderTexture.create({
    width: Math.ceil(size),
    height: Math.ceil(size),
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

/** A soft white glow dot used tinted for ships. */
export const makeShipTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'ship', (g) => {
    for (let i = 12; i > 0; i--) {
      const a = (i / 12) * 0.18;
      g.circle(16, 16, i).fill({ color: 0xffffff, alpha: a });
    }
    g.circle(16, 16, 3).fill({ color: 0xffffff, alpha: 1 });
  });
};

/** Per-owner planet sprite: core disc + soft halo. Returns a ready-to-add container. */
export const makePlanetSprite = (
  app: Application,
  ownerId: number | null,
  radius: number,
): Container => {
  const pal = paletteFor(ownerId);
  const key = `planet:${ownerId ?? 'n'}:${Math.round(radius)}`;
  const haloKey = `${key}:halo`;

  const core = makeGlowTexture(app, key, (g) => {
    const r = radius;
    g.circle(r, r, r).fill({ color: pal.core, alpha: 1 });
    g.circle(r, r, r * 0.7).fill({ color: 0xffffff, alpha: 0.25 });
  });
  const halo = makeGlowTexture(app, haloKey, (g) => {
    const r = radius * 2.4;
    for (let i = 20; i > 0; i--) {
      const t = i / 20;
      g.circle(r, r, r * t).fill({ color: pal.glow, alpha: 0.05 * t });
    }
  });

  const container = new Container();
  const haloSprite = new Sprite(halo);
  haloSprite.anchor.set(0.5);
  haloSprite.tint = pal.glow;
  const coreSprite = new Sprite(core);
  coreSprite.anchor.set(0.5);
  container.addChild(haloSprite, coreSprite);
  return container;
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

