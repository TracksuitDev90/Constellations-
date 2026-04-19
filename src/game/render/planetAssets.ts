/**
 * Loads real equirectangular planet maps and bakes them into lit, spherical
 * sprites on the CPU. The bake step samples the 2:1 source map for each
 * pixel of the output disc, applies Lambertian shading and a rim highlight,
 * and writes the result to a canvas → Pixi Texture. We can't easily spin a
 * 3D sphere in Pixi 8 without a custom shader, so this offline projection
 * gives us a photographic read without the runtime cost of a shader.
 *
 * Texture source: jeromeetienne/threex.planets (MIT), themselves sourced from
 * Jim Hastings-Trew's Planet Pixel Emporium. See public/textures/CREDITS.md.
 */
import { Texture } from 'pixi.js';
import type { PlanetArchetype } from './textures.js';

const TEXTURE_PATHS: Record<PlanetArchetype, string> = {
  terrestrial: 'textures/terrestrial.jpg',
  gasGiant: 'textures/gasgiant.jpg',
  icy: 'textures/icy.jpg',
  molten: 'textures/molten.jpg',
  alien: 'textures/alien.jpg',
};

/** Resolve the URL respecting Vite's BASE_URL (set via vite.config). */
const resolveAsset = (path: string): string => {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? '/';
  return (base.endsWith('/') ? base : base + '/') + path;
};

interface SourceMap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const sources = new Map<PlanetArchetype, SourceMap>();
const bakedCache = new Map<string, Texture>();
let loadPromise: Promise<void> | null = null;

export const loadPlanetAssets = (): Promise<void> => {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const entries = Object.entries(TEXTURE_PATHS) as Array<[PlanetArchetype, string]>;
    await Promise.all(
      entries.map(async ([arch, path]) => {
        const img = await loadImage(resolveAsset(path));
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2D context unavailable');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        sources.set(arch, {
          data: imageData.data,
          width: canvas.width,
          height: canvas.height,
        });
      }),
    );
  })();
  return loadPromise;
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });

/** True once every archetype's source bitmap has been sampled into memory. */
export const planetAssetsReady = (): boolean =>
  sources.size === Object.keys(TEXTURE_PATHS).length;

/**
 * Bake a lit, sphere-projected disc for the given archetype. Seed picks a
 * stable rotation so each planet shows a different face of the same map.
 */
export const bakePlanetSphere = (
  archetype: PlanetArchetype,
  seed: number,
  diameter: number,
): Texture => {
  const size = Math.max(32, Math.round(diameter));
  const cacheKey = `${archetype}:${size}:${seed}`;
  const hit = bakedCache.get(cacheKey);
  if (hit) return hit;

  const src = sources.get(archetype);
  if (!src) throw new Error(`Planet texture ${archetype} not loaded — call loadPlanetAssets() first.`);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  const out = ctx.createImageData(size, size);
  projectSphere(out, src, seed);
  ctx.putImageData(out, 0, 0);

  const tex = Texture.from(canvas);
  bakedCache.set(cacheKey, tex);
  return tex;
};

/** Project an equirectangular map onto a lit disc, writing into ImageData. */
const projectSphere = (out: ImageData, src: SourceMap, seed: number): void => {
  const size = out.width;
  const r = size / 2;
  const rng = mulberry32(seed * 1001 + 17);
  // Per-planet longitude offset so identical archetypes show different faces.
  const lon0 = rng() * Math.PI * 2;
  // Small latitude tilt so some planets look tilted.
  const tilt = (rng() - 0.5) * 0.3;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);

  // Light direction — from upper-left front quadrant.
  const Lx = -0.4;
  const Ly = -0.45;
  const Lz = 0.8;
  const Llen = Math.hypot(Lx, Ly, Lz);
  const lx = Lx / Llen;
  const ly = Ly / Llen;
  const lz = Lz / Llen;

  const sw = src.width;
  const sh = src.height;
  const sd = src.data;

  const AA_EDGE = 0.985 * 0.985;
  const DISC = 1.0;

  for (let py = 0; py < size; py++) {
    const ny = (py - r + 0.5) / r;
    for (let px = 0; px < size; px++) {
      const nx = (px - r + 0.5) / r;
      const d2 = nx * nx + ny * ny;
      const oi = (py * size + px) * 4;
      if (d2 > DISC) {
        out.data[oi + 3] = 0;
        continue;
      }
      const nz = Math.sqrt(Math.max(0, 1 - d2));

      // Apply tilt around X axis: (y, z) rotates.
      const ty = ny * cosT - nz * sinT;
      const tz = ny * sinT + nz * cosT;

      // Rotate around Y axis for longitude offset.
      const cL = Math.cos(lon0);
      const sL = Math.sin(lon0);
      const rx = nx * cL + tz * sL;
      const rz = -nx * sL + tz * cL;

      // Equirectangular sampling.
      const lon = Math.atan2(rx, rz);
      const latClamp = Math.max(-1, Math.min(1, ty));
      const lat = Math.asin(latClamp);
      const u = (lon + Math.PI) / (2 * Math.PI);
      const v = 1 - (lat + Math.PI / 2) / Math.PI;
      let sx = Math.floor(u * sw);
      let sy = Math.floor(v * sh);
      if (sx < 0) sx = 0;
      else if (sx >= sw) sx = sw - 1;
      if (sy < 0) sy = 0;
      else if (sy >= sh) sy = sh - 1;
      const si = (sy * sw + sx) * 4;
      let r8 = sd[si];
      let g8 = sd[si + 1];
      let b8 = sd[si + 2];

      // Lambertian lighting on the sphere normal (nx, ny, nz) — use the
      // pre-tilt normal so shading matches what we see, not the tilted map.
      const lambert = Math.max(0, nx * lx + ny * ly + nz * lz);
      const ambient = 0.22;
      const bright = ambient + (1 - ambient) * lambert;
      r8 = Math.min(255, r8 * bright);
      g8 = Math.min(255, g8 * bright);
      b8 = Math.min(255, b8 * bright);

      // Specular bump on the sunward pole.
      const spec = Math.pow(lambert, 24) * 180;
      r8 = Math.min(255, r8 + spec);
      g8 = Math.min(255, g8 + spec);
      b8 = Math.min(255, b8 + spec);

      // Cool rim toward the limb so the silhouette reads as a sphere.
      const rim = Math.pow(1 - nz, 3);
      r8 = Math.min(255, r8 + rim * 14);
      g8 = Math.min(255, g8 + rim * 22);
      b8 = Math.min(255, b8 + rim * 38);

      // Smooth the outer 1–2 px for antialiasing.
      let alpha = 255;
      if (d2 > AA_EDGE) {
        const t = 1 - (d2 - AA_EDGE) / (DISC - AA_EDGE);
        alpha = Math.max(0, Math.min(255, Math.floor(255 * t)));
      }

      out.data[oi] = r8;
      out.data[oi + 1] = g8;
      out.data[oi + 2] = b8;
      out.data[oi + 3] = alpha;
    }
  }
};

const mulberry32 = (seed: number) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
