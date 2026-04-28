/**
 * Loads pre-rendered planet sticker PNGs (1:1 illustrations of a planet
 * centered on a transparent canvas, with a soft drop shadow below) and
 * scales them into the disc size the renderer wants. The artwork is already
 * shaded and outlined, so we deliberately skip any sphere projection or
 * Lambertian lighting — adding either would clash with the cartoon style.
 *
 * Texture set: 39 numbered planet stickers (IMG_0314 … IMG_0352) in
 * public/textures. See public/textures/CREDITS.md.
 */
import { Texture } from 'pixi.js';
import { PHOTOGRAPHIC_ARCHETYPES, PROCEDURAL_ONLY, type PlanetArchetype } from './textures.js';

/**
 * Source equirectangular maps for every archetype in the pool. Each archetype
 * id matches the base filename of its texture in public/textures.
 */
const TEXTURE_PATHS: Record<PlanetArchetype, string> = Object.fromEntries(
  PHOTOGRAPHIC_ARCHETYPES.map((id) => [id, `textures/${id}.png`]),
) as Record<PlanetArchetype, string>;

/** Resolve the URL respecting Vite's BASE_URL (set via vite.config). */
const resolveAsset = (path: string): string => {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? '/';
  return (base.endsWith('/') ? base : base + '/') + path;
};

/**
 * A loaded source — the original sticker plus the tight bounding box of the
 * planet artwork. The bbox is computed from the alpha channel so we can
 * crop out the surrounding transparent margin and drop shadow when scaling
 * the planet into the disc.
 */
interface SourceMap {
  img: HTMLImageElement;
  bx: number;
  by: number;
  bsize: number;
}

const sources = new Map<PlanetArchetype, SourceMap>();
const bakedCache = new Map<string, Texture>();
let loadPromise: Promise<void> | null = null;

export const loadPlanetAssets = (): Promise<void> => {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const entries = Object.entries(TEXTURE_PATHS) as Array<[PlanetArchetype, string]>;
    const baked = entries.length;
    await Promise.all(
      entries.map(async ([arch, path]) => {
        const img = await loadImage(resolveAsset(path));
        const bounds = computePlanetBounds(img);
        sources.set(arch, { img, ...bounds });
      }),
    );

    bakedSourceCount = baked;
  })();
  return loadPromise;
};

let bakedSourceCount = 0;

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });

/**
 * Find the planet's tight square bounding box inside the sticker. We threshold
 * on near-fully-opaque pixels so semi-transparent ring/aura overlays (Saturn,
 * swirl auras) drop out and only the solid planet body contributes — those
 * overlays would otherwise stretch the bbox sideways and visually shift the
 * planet off-center within the disc, leaving a "ghost" bit of artwork
 * floating beside the planet's actual position.
 *
 * If a fully-opaque tail/moon still extends past the planet (rare but real),
 * we square the box by taking `min(w, h)` and slide it within the longer
 * axis to the position with the highest opaque-pixel count — i.e. wherever
 * the solid planet body is densest.
 */
const computePlanetBounds = (img: HTMLImageElement): { bx: number; by: number; bsize: number } => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width;
  let minY = c.height;
  let maxX = -1;
  let maxY = -1;
  const ALPHA_THRESHOLD = 254;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // No opaque pixels — fall back to the whole image.
    return { bx: 0, by: 0, bsize: Math.min(c.width, c.height) };
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const D = Math.min(w, h);

  // Helper: count opaque pixels inside [x0, x0+D) × [y0, y0+D).
  const countOpaque = (x0: number, y0: number): number => {
    let n = 0;
    const x1 = x0 + D;
    const y1 = y0 + D;
    for (let y = y0; y < y1; y++) {
      const row = y * c.width;
      for (let x = x0; x < x1; x++) {
        if (data[(row + x) * 4 + 3] >= ALPHA_THRESHOLD) n++;
      }
    }
    return n;
  };

  let bx = minX;
  let by = minY;
  if (w > h) {
    // Slide a D-wide window across the bbox horizontally, pick the densest.
    let bestX = minX;
    let bestCount = -1;
    for (let x = minX; x + D <= maxX + 1; x++) {
      const n = countOpaque(x, minY);
      if (n > bestCount) {
        bestCount = n;
        bestX = x;
      }
    }
    bx = bestX;
  } else if (h > w) {
    let bestY = minY;
    let bestCount = -1;
    for (let y = minY; y + D <= maxY + 1; y++) {
      const n = countOpaque(minX, y);
      if (n > bestCount) {
        bestCount = n;
        bestY = y;
      }
    }
    by = bestY;
  }

  if (bx < 0) bx = 0;
  if (by < 0) by = 0;
  let bsize = D;
  if (bx + bsize > c.width) bsize = c.width - bx;
  if (by + bsize > c.height) bsize = c.height - by;
  return { bx, by, bsize };
};

/** True once every photographic archetype's source bitmap has been sampled. */
export const planetAssetsReady = (): boolean =>
  bakedSourceCount > 0 && sources.size === bakedSourceCount;

/** Whether a particular archetype has a baked photographic source. */
export const hasBakedSource = (archetype: PlanetArchetype): boolean =>
  !PROCEDURAL_ONLY.has(archetype) && sources.has(archetype);

/**
 * Render the archetype's sticker into a square canvas of the requested
 * diameter, scaled so the planet artwork fills the canvas edge-to-edge. The
 * `seed` argument is accepted for API compatibility with the previous baker
 * but is unused — these illustrations are fixed-pose, no per-planet rotation.
 */
export const bakePlanetSphere = (
  archetype: PlanetArchetype,
  _seed: number,
  diameter: number,
): Texture => {
  const size = Math.max(32, Math.round(diameter));
  const cacheKey = `${archetype}:${size}`;
  const hit = bakedCache.get(cacheKey);
  if (hit) return hit;

  const src = sources.get(archetype);
  if (!src) throw new Error(`Planet texture ${archetype} not loaded — call loadPlanetAssets() first.`);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.img, src.bx, src.by, src.bsize, src.bsize, 0, 0, size, size);

  const tex = Texture.from(canvas);
  bakedCache.set(cacheKey, tex);
  return tex;
};
