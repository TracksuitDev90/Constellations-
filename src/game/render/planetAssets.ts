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
/** In-flight per-archetype loads, deduped across calls. */
const pending = new Map<PlanetArchetype, Promise<void>>();
/** Archetypes whose source failed to load — these stay procedural. */
const failed = new Set<PlanetArchetype>();

/**
 * Load the source bitmaps for the given archetypes (defaults to the full
 * pool). A match only ever uses the ≤9 archetypes assigned to its planets,
 * so callers should pass that subset — loading and alpha-scanning all 39
 * stickers (~5 MB) up front was a multi-second stall on mobile connections.
 *
 * Never rejects: an individual texture that fails to load (flaky network,
 * missing file) is recorded in `failed` and its planet falls back to the
 * procedural body, instead of one 404 disabling the entire photographic
 * pipeline as `Promise.all` used to.
 */
export const loadPlanetAssets = (
  archetypes: readonly PlanetArchetype[] = PHOTOGRAPHIC_ARCHETYPES,
): Promise<void> => {
  const jobs: Array<Promise<void>> = [];
  for (const arch of archetypes) {
    if (sources.has(arch)) continue;
    // A past failure (flaky network, dropped connection) gets one fresh
    // attempt per load call — a single hiccup shouldn't consign an
    // archetype to the procedural fallback for the whole session.
    failed.delete(arch);
    let job = pending.get(arch);
    if (!job) {
      job = (async () => {
        try {
          const img = await loadImage(resolveAsset(TEXTURE_PATHS[arch]));
          const bounds = computePlanetBounds(img);
          sources.set(arch, { img, ...bounds });
        } catch (err) {
          failed.add(arch);
          console.warn(`planet texture ${arch} failed to load; using procedural body`, err);
        } finally {
          pending.delete(arch);
        }
      })();
      pending.set(arch, job);
    }
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
};

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

  let bx = minX;
  let by = minY;
  if (w > h) {
    // Slide a D-wide window across the bbox horizontally, pick the densest.
    // Precompute per-column opaque counts within the D-tall band, then walk
    // the window incrementally — O(W·D) instead of recounting the full
    // window at every offset (O(W·D²), a visible main-thread stall on the
    // larger stickers).
    const colCounts = new Int32Array(w);
    for (let x = minX; x <= maxX; x++) {
      let n = 0;
      for (let y = minY; y < minY + D; y++) {
        if (data[(y * c.width + x) * 4 + 3] >= ALPHA_THRESHOLD) n++;
      }
      colCounts[x - minX] = n;
    }
    let windowSum = 0;
    for (let x = 0; x < D; x++) windowSum += colCounts[x];
    let bestX = minX;
    let bestCount = windowSum;
    for (let x = minX + 1; x + D <= maxX + 1; x++) {
      windowSum += colCounts[x - minX + D - 1] - colCounts[x - minX - 1];
      if (windowSum > bestCount) {
        bestCount = windowSum;
        bestX = x;
      }
    }
    bx = bestX;
  } else if (h > w) {
    const rowCounts = new Int32Array(h);
    for (let y = minY; y <= maxY; y++) {
      let n = 0;
      const row = y * c.width;
      for (let x = minX; x < minX + D; x++) {
        if (data[(row + x) * 4 + 3] >= ALPHA_THRESHOLD) n++;
      }
      rowCounts[y - minY] = n;
    }
    let windowSum = 0;
    for (let y = 0; y < D; y++) windowSum += rowCounts[y];
    let bestY = minY;
    let bestCount = windowSum;
    for (let y = minY + 1; y + D <= maxY + 1; y++) {
      windowSum += rowCounts[y - minY + D - 1] - rowCounts[y - minY - 1];
      if (windowSum > bestCount) {
        bestCount = windowSum;
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
