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
  /**
   * How far the sticker's ring/aura artwork extends past the solid planet
   * body, as a ratio of the body's half-size (1 = no ring, 1.6 = the ring
   * reaches 60% past the body edge). Baking expands the canvas by this
   * factor so a painted ring is displayed in full instead of being cropped
   * at the body's bounding box.
   */
  ringExtent: number;
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
 *
 * A second, looser scan tracks the "ring" bbox: pixels solid enough to be
 * painted ring/aura artwork (but not soft drop shadow). Its overhang past
 * the body box becomes `ringExtent`, which the baker uses to expand the
 * canvas so ringed planets (Saturn-style) display their entire ring.
 */
const computePlanetBounds = (
  img: HTMLImageElement,
): { bx: number; by: number; bsize: number; ringExtent: number } => {
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
  // Ring-artwork bbox (looser alpha cut). 160 keeps painted rings — which
  // are near-opaque — while dropping the soft low-alpha drop shadows.
  let rMinX = c.width;
  let rMinY = c.height;
  let rMaxX = -1;
  let rMaxY = -1;
  const ALPHA_THRESHOLD = 254;
  const ALPHA_RING = 160;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const a = data[(y * c.width + x) * 4 + 3];
      if (a >= ALPHA_RING) {
        if (x < rMinX) rMinX = x;
        if (x > rMaxX) rMaxX = x;
        if (y < rMinY) rMinY = y;
        if (y > rMaxY) rMaxY = y;
      }
      if (a >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // No opaque pixels — fall back to the whole image.
    return { bx: 0, by: 0, bsize: Math.min(c.width, c.height), ringExtent: 1 };
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

  // Ring overhang: max distance from the body box center to any edge of the
  // ring-artwork bbox, relative to the body's half-size. Ratios below 1.12
  // are treated as slop (aura fuzz, antialiased edges) and ignored; large
  // ratios are clamped so one extreme sticker can't balloon GPU memory.
  const cx = bx + bsize / 2;
  const cy = by + bsize / 2;
  const half = bsize / 2;
  let ringExtent = 1;
  if (rMaxX >= 0 && half > 0) {
    const reach = Math.max(cx - rMinX, rMaxX - cx, cy - rMinY, rMaxY - cy);
    const ratio = reach / half;
    if (ratio >= 1.12) ringExtent = Math.min(ratio, 2.6);
  }
  return { bx, by, bsize, ringExtent };
};

/** Whether a particular archetype has a baked photographic source. */
export const hasBakedSource = (archetype: PlanetArchetype): boolean =>
  !PROCEDURAL_ONLY.has(archetype) && sources.has(archetype);

/**
 * Render the archetype's sticker into a square canvas, scaled so the solid
 * planet body spans exactly `diameter` pixels centered in the canvas. When
 * the artwork carries a ring/aura that extends past the body, the canvas is
 * expanded by the source's `ringExtent` so the entire ring is displayed —
 * the sprite's anchor stays on the body center, and the renderer's
 * body-to-world scale is unaffected because the body still spans `diameter`
 * pixels. The `seed` argument is accepted for API compatibility with the
 * previous baker but is unused — these illustrations are fixed-pose.
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

  const canvasSize = Math.max(32, Math.round(size * src.ringExtent));
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Draw the whole sticker (not just the body crop) so ring artwork survives;
  // position it so the body box center lands on the canvas center. Anything
  // past the ring extent falls off the canvas edge, which the extent already
  // accounts for.
  const scale = size / src.bsize;
  ctx.drawImage(
    src.img,
    canvasSize / 2 - (src.bx + src.bsize / 2) * scale,
    canvasSize / 2 - (src.by + src.bsize / 2) * scale,
    src.img.naturalWidth * scale,
    src.img.naturalHeight * scale,
  );

  const tex = Texture.from(canvas);
  bakedCache.set(cacheKey, tex);
  return tex;
};
