/**
 * Loads pre-rendered planet sticker PNGs (1:1 illustrations of a planet
 * centered on a transparent canvas, with a soft drop shadow below) and
 * scales them into the disc size the renderer wants. The artwork is already
 * shaded and outlined, so we deliberately skip any sphere projection or
 * Lambertian lighting — adding either would clash with the cartoon style.
 *
 * Texture set: 39 numbered planet stickers (IMG_0314 … IMG_0352) in
 * public/textures. See public/textures/CREDITS.md.
 *
 * Two of those stickers (IMG_0327 brushstroke ring, IMG_0344 tendril ring)
 * have hand-painted rings around their planet bodies. We load them as the
 * canonical reference for what a ring should look like in this game and
 * extract a body-removed ring-only texture from each, used by PlanetLayer
 * to overlay on every planet rather than re-deriving the look procedurally.
 */
import { Texture } from 'pixi.js';
import { PHOTOGRAPHIC_ARCHETYPES, PROCEDURAL_ONLY, type PlanetArchetype } from './textures.js';

export type RingOverlayStyle = 'brushstroke' | 'spiky';

export interface RingOverlayInfo {
  texture: Texture;
  /** Source image edge length in pixels (square). */
  srcSize: number;
  /** Diameter of the body bbox in source pixels. */
  bodyDiameter: number;
  /** Body bbox center in source pixels. */
  bodyCx: number;
  bodyCy: number;
}

/**
 * The two reference stickers whose painted rings we lift as overlay textures.
 * IMG_0327 is the soft blue brushstroke Saturn ring; IMG_0344 is the teal
 * thorny tendril. PlanetLayer applies one of these on every planet, tinted
 * to the owner's palette.
 */
const RING_OVERLAY_SOURCES: Record<RingOverlayStyle, PlanetArchetype> = {
  brushstroke: 'IMG_0327',
  spiky: 'IMG_0344',
};

const ringOverlays = new Map<RingOverlayStyle, RingOverlayInfo>();

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

    // After the body sources are loaded, lift the painted rings off the two
    // reference stickers and store them as standalone overlay textures.
    for (const [style, archetype] of Object.entries(RING_OVERLAY_SOURCES) as Array<
      [RingOverlayStyle, PlanetArchetype]
    >) {
      const src = sources.get(archetype);
      if (!src) continue;
      ringOverlays.set(style, extractRingOverlay(src.img, src));
    }

    bakedSourceCount = baked;
  })();
  return loadPromise;
};

/**
 * Look up the runtime-baked ring overlay for a given style. Throws if
 * loadPlanetAssets hasn't resolved yet — callers must gate on
 * planetAssetsReady().
 */
export const getRingOverlay = (style: RingOverlayStyle): RingOverlayInfo => {
  const hit = ringOverlays.get(style);
  if (!hit) throw new Error(`Ring overlay '${style}' not loaded — call loadPlanetAssets() first.`);
  return hit;
};

/**
 * Lift the painted ring artwork off a sticker and return it as a Texture
 * with the planet body cleared to alpha=0. The body silhouette is detected
 * by colour-similarity floodfill from the bbox centre — the body has a tight
 * cluster of related fill colours, the ring is a clearly different hue, and
 * the heavy black outline between them stops the floodfill at the body's
 * boundary. We then erode that outline by sweeping a few BFS layers outward
 * from the floodfilled body region, but *only* into pixels whose luminance
 * falls below a threshold, so the body's dark stroke is consumed without
 * eating into the ring's mid-luminance teal/blue paint.
 *
 * Pieces of the ring that cross over the body face survive because their
 * colour is far from the body seed colour — the floodfill stops at them as
 * if they were an outline, and the dark-only outline expansion ignores them.
 */
const extractRingOverlay = (
  img: HTMLImageElement,
  body: { bx: number; by: number; bsize: number },
): RingOverlayInfo => {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;

  const bodyCx = body.bx + (body.bsize >> 1);
  const bodyCy = body.by + (body.bsize >> 1);

  // Sample a 5×5 block of pixels at the body centre and average them — picks
  // up a stable seed colour even if the centre pixel happens to land on a
  // surface-detail streak rather than the bulk body fill.
  let sR = 0;
  let sG = 0;
  let sB = 0;
  let sN = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = bodyCx + dx;
      const y = bodyCy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const idx = (y * W + x) * 4;
      sR += data[idx];
      sG += data[idx + 1];
      sB += data[idx + 2];
      sN++;
    }
  }
  const seedR = sR / sN;
  const seedG = sG / sN;
  const seedB = sB / sN;

  const total = W * H;
  const isBody = new Uint8Array(total);
  // Manhattan-distance threshold from seed colour. Calibrated for the two
  // reference stickers' palettes (pink/magenta body vs blue ring; purple
  // body vs teal ring) so the body fills cluster well below it and the ring
  // hues sit safely above.
  const COLOR_THRESHOLD = 140;

  // Iterative BFS to avoid blowing the JS stack on large source images.
  const stack: number[] = [];
  const seedIdx = bodyCy * W + bodyCx;
  isBody[seedIdx] = 1;
  stack.push(seedIdx);
  while (stack.length > 0) {
    const p = stack.pop() as number;
    const py = (p / W) | 0;
    const px = p - py * W;
    const left = px > 0 ? p - 1 : -1;
    const right = px < W - 1 ? p + 1 : -1;
    const up = py > 0 ? p - W : -1;
    const down = py < H - 1 ? p + W : -1;
    for (const n of [left, right, up, down]) {
      if (n < 0 || isBody[n]) continue;
      const nidx = n * 4;
      if (data[nidx + 3] < 100) continue;
      const dr = Math.abs(data[nidx] - seedR);
      const dg = Math.abs(data[nidx + 1] - seedG);
      const db = Math.abs(data[nidx + 2] - seedB);
      if (dr + dg + db > COLOR_THRESHOLD) continue;
      isBody[n] = 1;
      stack.push(n);
    }
  }

  // Walk a few BFS layers outward from the body region, marking only dark
  // (low-luminance) pixels as part of the body's outline so we erase them.
  // Mid-luminance ring paint is left untouched even if it sits adjacent to
  // the body region.
  const isOutline = new Uint8Array(total);
  const OUTLINE_LUMINANCE_MAX = 110;
  const OUTLINE_EXPAND_LAYERS = 6;
  let frontier: number[] = [];
  for (let i = 0; i < total; i++) if (isBody[i]) frontier.push(i);
  for (let layer = 0; layer < OUTLINE_EXPAND_LAYERS; layer++) {
    const next: number[] = [];
    for (const p of frontier) {
      const py = (p / W) | 0;
      const px = p - py * W;
      const candidates = [
        px > 0 ? p - 1 : -1,
        px < W - 1 ? p + 1 : -1,
        py > 0 ? p - W : -1,
        py < H - 1 ? p + W : -1,
      ];
      for (const n of candidates) {
        if (n < 0 || isBody[n] || isOutline[n]) continue;
        const nidx = n * 4;
        const a = data[nidx + 3];
        if (a < 60) continue;
        const lum = (data[nidx] + data[nidx + 1] + data[nidx + 2]) / 3;
        if (lum > OUTLINE_LUMINANCE_MAX) continue;
        isOutline[n] = 1;
        next.push(n);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  // Clear body + outline pixels to fully transparent. The remaining painted
  // ring artwork (and any drop-shadow) is what we want as the overlay; the
  // shadow is faint enough not to cause issues when composited on top of a
  // new planet body.
  for (let i = 0; i < total; i++) {
    if (isBody[i] || isOutline[i]) data[i * 4 + 3] = 0;
  }

  ctx.putImageData(imgData, 0, 0);
  const texture = Texture.from(canvas);
  return {
    texture,
    srcSize: Math.min(W, H),
    bodyDiameter: body.bsize,
    bodyCx,
    bodyCy,
  };
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
