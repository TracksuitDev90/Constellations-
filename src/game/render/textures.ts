import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Texture,
} from 'pixi.js';
import { paletteFor, toward } from '../../util/color.js';
import { bakePlanetSphere, hasBakedSource } from './planetAssets.js';
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
 * The full pool of available planet textures: IMG_0314 … IMG_0352. Stickers
 * whose artwork carries painted rings (e.g. IMG_0320's Saturn-style tan
 * rings) are included — the baker measures each sticker's ring extent and
 * expands the baked canvas so the entire ring is displayed. Adding a new
 * map means dropping the file in public/textures and extending this list —
 * the baker keys off the id directly.
 */
export const PHOTOGRAPHIC_ARCHETYPES: readonly PlanetArchetype[] = Array.from(
  { length: 39 },
  (_, i) => `IMG_${String(314 + i).padStart(4, '0')}`,
);

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
): PlanetArchetype[] => {
  archetypeAssignments.clear();
  const shuffled = shuffledArchetypes(seed);
  const assigned = new Set<PlanetArchetype>();
  for (let i = 0; i < planetIds.length; i++) {
    const arch = shuffled[i % shuffled.length];
    archetypeAssignments.set(planetIds[i], arch);
    assigned.add(arch);
  }
  // Return the distinct archetype set so the caller can preload exactly the
  // textures this match will draw (see loadPlanetAssets).
  return [...assigned];
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

  if (hasBakedSource(archetype)) {
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

/**
 * Simple starfield texture (tiled). `opaque` bakes the deep-space backdrop
 * color in; pass false for planes stacked ABOVE other art (the near parallax
 * layer) — an opaque near plane at high alpha acts as a dark curtain over
 * everything beneath it, which is what made the nebulae nearly invisible.
 */
export const makeStarfieldTexture = (
  app: Application,
  size = 512,
  opaque = true,
): Texture => {
  return makeGlowTexture(app, `stars:${size}:${opaque ? 'o' : 't'}`, (g) => {
    g.rect(0, 0, size, size).fill({
      color: opaque ? 0x050810 : 0x000000,
      alpha: opaque ? 1 : 0.001,
    });
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

/**
 * A dust cloud for the background nebulae, layered the way real ones are:
 *
 *   1. A broad, dim molecular envelope — the diffuse outer mass.
 *   2. Filaments — correlated random walks tracing wispy internal streamers,
 *      like the pillars and tendrils in emission nebulae.
 *   3. Emission knots — a few hot, bright cores where the cloud is lit from
 *      within (star-forming pockets), lerped toward white.
 *   4. Dark dust lanes — near-black streaks laid OVER the bright mass, the
 *      signature look of Barnard-style absorption nebulae.
 *   5. A scatter of embedded stars glinting through the fog.
 *
 * Seeded so each match's sky can roll its own shapes.
 */
export const makeNebulaTexture = (
  app: Application,
  seed: number,
  colorA: number,
  colorB: number,
): Texture => {
  const size = 512;
  return makeGlowTexture(app, `nebula:${seed}:${colorA}:${colorB}`, (g) => {
    // Transparent anchor rect so the baked bounds cover the full tile even
    // though every blob is soft-edged.
    g.rect(0, 0, size, size).fill({ color: 0x000000, alpha: 0.001 });
    const rng = mulberry32(seed);
    const margin = 96;
    const cx = size / 2;
    const cy = size / 2;

    /** Correlated random walk; calls `draw` at every step. */
    const walk = (
      x0: number,
      y0: number,
      steps: number,
      stepLen: [number, number],
      turn: number,
      draw: (x: number, y: number, t: number) => void,
    ): void => {
      let x = x0;
      let y = y0;
      let dir = rng() * Math.PI * 2;
      for (let i = 0; i < steps; i++) {
        dir += (rng() - 0.5) * turn;
        x += Math.cos(dir) * (stepLen[0] + rng() * (stepLen[1] - stepLen[0]));
        y += Math.sin(dir) * (stepLen[0] + rng() * (stepLen[1] - stepLen[0]));
        if (x < margin || x > size - margin || y < margin || y > size - margin) {
          // Turn the walk back toward the middle so the cloud stays framed.
          dir = Math.atan2(cy - y, cx - x) + (rng() - 0.5) * 0.8;
          x = Math.min(Math.max(x, margin), size - margin);
          y = Math.min(Math.max(y, margin), size - margin);
        }
        draw(x, y, i / (steps - 1));
      }
    };

    /** Soft radial blob — layered fills approximate a gaussian falloff. */
    const blob = (x: number, y: number, radius: number, color: number, peak: number): void => {
      const layers = 7;
      for (let k = layers; k > 0; k--) {
        const t = k / layers;
        g.circle(x, y, radius * t).fill({
          color,
          alpha: Math.pow(1 - t, 1.5) * peak + 0.01,
        });
      }
    };

    // 1. Envelope: a short fat walk of big dim blobs — one connected mass.
    walk(cx, cy, 18, [22, 46], 1.3, (x, y) => {
      blob(x, y, 85 + rng() * 70, toward(colorA, colorB, rng() * 0.7), 0.3);
    });

    // 2. Filaments: longer, tighter walks of small brighter blobs. Each
    // filament keeps its own color bias so the streamers read as distinct
    // currents inside the same cloud.
    const filaments = 3 + Math.floor(rng() * 2);
    const knotSpots: Array<{ x: number; y: number }> = [];
    for (let f = 0; f < filaments; f++) {
      const bias = rng();
      const fx = cx + (rng() - 0.5) * 120;
      const fy = cy + (rng() - 0.5) * 120;
      walk(fx, fy, 26 + Math.floor(rng() * 12), [9, 18], 0.9, (x, y) => {
        const col = toward(colorA, colorB, Math.min(1, bias + (rng() - 0.5) * 0.3));
        blob(x, y, 14 + rng() * 22, col, 0.34);
        if (rng() < 0.08) knotSpots.push({ x, y });
      });
    }

    // 3. Emission knots: hot pockets lit from within. Prefer spots the
    // filaments actually passed through so the light sits inside the dust.
    const knots = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < knots; k++) {
      const spot =
        knotSpots.length > 0
          ? knotSpots[Math.floor(rng() * knotSpots.length)]
          : { x: cx + (rng() - 0.5) * 160, y: cy + (rng() - 0.5) * 160 };
      const base = toward(colorA, colorB, rng());
      blob(spot.x, spot.y, 26 + rng() * 22, toward(base, 0xffffff, 0.45), 0.3);
      blob(spot.x, spot.y, 9 + rng() * 8, toward(base, 0xffffff, 0.8), 0.5);
    }

    // 4. Dark dust lanes: absorption streaks drawn over the glow. Normal
    // blending with near-black reads as occlusion — the classic rift look.
    const lanes = 1 + Math.floor(rng() * 2);
    for (let l = 0; l < lanes; l++) {
      walk(cx + (rng() - 0.5) * 140, cy + (rng() - 0.5) * 140, 18, [12, 24], 0.7, (x, y) => {
        blob(x, y, 16 + rng() * 26, 0x04060c, 0.18);
      });
    }

    // 5. Embedded stars: pinpricks glinting through the fog.
    const stars = 10 + Math.floor(rng() * 8);
    for (let s = 0; s < stars; s++) {
      const x = cx + (rng() - 0.5) * 280;
      const y = cy + (rng() - 0.5) * 280;
      const r = 0.5 + rng() * 1.1;
      g.circle(x, y, r * 2.4).fill({ color: 0xdfe8ff, alpha: 0.1 });
      g.circle(x, y, r).fill({ color: 0xffffff, alpha: 0.45 + rng() * 0.4 });
    }
  });
};

/**
 * A small diffraction-spiked star used for the twinkling foreground layer:
 * soft halo, four thin rays, hot core. Rendered additively and pulsed by
 * the BackgroundLayer.
 */
export const makeTwinkleTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'twinkle', (g) => {
    const C = 12;
    for (let i = 8; i > 0; i--) {
      const t = i / 8;
      g.circle(C, C, 7 * t).fill({ color: 0xdfe8ff, alpha: 0.05 * (1 - t) + 0.01 });
    }
    // Four diffraction rays — slim diamonds so the tips fade naturally.
    g.poly([
      { x: C - 9, y: C },
      { x: C, y: C - 0.8 },
      { x: C + 9, y: C },
      { x: C, y: C + 0.8 },
    ]).fill({ color: 0xffffff, alpha: 0.5 });
    g.poly([
      { x: C, y: C - 9 },
      { x: C + 0.8, y: C },
      { x: C, y: C + 9 },
      { x: C - 0.8, y: C },
    ]).fill({ color: 0xffffff, alpha: 0.5 });
    g.circle(C, C, 1.5).fill({ color: 0xffffff, alpha: 1 });
  });
};

/**
 * A meteor streak: long fading tail, hot head at +x. The BackgroundLayer
 * rotates it to the flight heading and slides it across the screen.
 */
export const makeShootingStarTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'shooting-star', (g) => {
    const L = 90;
    const y = 5;
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      g.circle(t * L, y, 0.4 + 2.2 * t).fill({
        color: toward(0xbfd4ff, 0xffffff, t),
        alpha: 0.02 + 0.3 * t * t * t,
      });
    }
    g.circle(L, y, 4.6).fill({ color: 0xffffff, alpha: 0.2 });
    g.circle(L, y, 2.4).fill({ color: 0xffffff, alpha: 1 });
  });
};

/**
 * A flare star's body: white-hot core inside a broad amber corona. The
 * HazardLayer scales/brightens it against the charge fraction so the star
 * visibly overloads before every detonation.
 */
export const makeFlareStarTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'flare-star', (g) => {
    const R = 28;
    for (let i = 20; i > 0; i--) {
      const t = i / 20;
      g.circle(R, R, R * t).fill({
        color: toward(0xffd9a0, 0xff7830, t),
        alpha: 0.06 * (1 - t) + 0.008,
      });
    }
    g.circle(R, R, 5.5).fill({ color: 0xffd9a0, alpha: 1 });
    g.circle(R, R, 3.2).fill({ color: 0xfff6e0, alpha: 1 });
  });
};

/**
 * A wormhole mouth: violet-to-cyan spiral arms winding into a dark throat,
 * with a crisp cyan rim. The HazardLayer stacks two counter-rotating copies
 * so the gate visibly churns.
 */
export const makeWormholeTexture = (app: Application, seed: number): Texture => {
  return makeGlowTexture(app, `wormhole:${seed}`, (g) => {
    const R = 30;
    g.rect(0, 0, R * 2, R * 2).fill({ color: 0x000000, alpha: 0.001 });
    const rng = mulberry32(seed || 1);
    const arms = 3;
    for (let a = 0; a < arms; a++) {
      const phase = (a / arms) * Math.PI * 2 + rng() * 0.5;
      for (let k = 0; k < 22; k++) {
        const t = k / 22;
        const r = R * (0.24 + 0.72 * (1 - t));
        const a0 = phase + t * 3.4;
        g.arc(R, R, r, a0, a0 + 0.9 - t * 0.3).stroke({
          width: 1.2 + 1.4 * t,
          color: toward(0x6f5bd8, 0x9adcff, t),
          alpha: 0.14 + 0.3 * t,
        });
      }
    }
    g.circle(R, R, R * 0.97).stroke({ width: 1.6, color: 0x9adcff, alpha: 0.65 });
    // Dark throat — the gate should read as a hole, not a disc.
    for (let i = 6; i > 0; i--) {
      const t = i / 6;
      g.circle(R, R, R * 0.24 * t).fill({ color: 0x050310, alpha: 0.35 });
    }
  });
};

/**
 * The neutral swarm's hull: a small swept-wing dart, nose along +x so
 * `rotation = heading` points it in the flight direction. Pre-colored in the
 * reserved hostile green so the sprite is used untinted.
 */
export const makeHostileShipTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'hostile-ship', (g) => {
    // Wings swept back from the nose, notched tail so the silhouette reads
    // as a ship even at gameplay zoom.
    g.poly([
      { x: 10, y: 0 },
      { x: -3, y: -2.4 },
      { x: -8, y: -6.5 },
      { x: -5, y: 0 },
      { x: -8, y: 6.5 },
      { x: -3, y: 2.4 },
    ]).fill({ color: 0x35502a, alpha: 1 });
    g.poly([
      { x: 10, y: 0 },
      { x: -3, y: -2.4 },
      { x: -8, y: -6.5 },
      { x: -5, y: 0 },
      { x: -8, y: 6.5 },
      { x: -3, y: 2.4 },
    ]).stroke({ width: 1, color: 0x9cff7a, alpha: 0.9 });
    // Canopy glint just behind the nose.
    g.circle(3.2, 0, 1.7).fill({ color: 0x9cff7a, alpha: 1 });
    g.circle(3.2, 0, 0.8).fill({ color: 0xe8ffd8, alpha: 1 });
  });
};

/** Elongated additive engine flare drawn trailing along -x behind the hull. */
export const makeEngineFlareTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'engine-flare', (g) => {
    for (let i = 8; i > 0; i--) {
      const t = i / 8;
      g.ellipse(-2 * (1 - t), 0, 7 * t, 2.6 * t).fill({
        color: toward(0x9cff7a, 0xffffff, 1 - t),
        alpha: 0.14 * (1 - t) + 0.05,
      });
    }
  });
};

/** Nominal horizon radius the black hole textures are baked against; the
 * HazardLayer scales its sprites by `horizonRadius / BH_TEXTURE_HORIZON`. */
export const BH_TEXTURE_HORIZON = 20;

/**
 * Faked gravitational lensing: concentric additive rings that brighten
 * toward ~1.5× the horizon and vanish inside it, reading as background
 * starlight bunched around the shadow. Additive black inside the horizon
 * adds nothing, so the texture needs no explicit cutout.
 */
export const makeLensHaloTexture = (app: Application): Texture => {
  return makeGlowTexture(app, 'bh-lens-halo', (g) => {
    const H = BH_TEXTURE_HORIZON;
    const R = H * 2.4;
    g.rect(0, 0, R * 2, R * 2).fill({ color: 0x000000, alpha: 0.001 });
    for (let r = H * 1.02; r <= R; r += 1.2) {
      // Gaussian brightness bump centered a bit outside the photon ring.
      const d = (r - H * 1.5) / (H * 0.55);
      const a = Math.exp(-d * d) * 0.11;
      if (a < 0.004) continue;
      g.circle(R, R, r).stroke({ width: 1.6, color: 0xbfd4ff, alpha: a });
    }
  });
};

/**
 * Seeded accretion disk: streaky warm arcs from white-hot at the inner edge
 * to deep ember at the rim, with one side brighter (Doppler beaming). Drawn
 * flat; the HazardLayer squashes it to an ellipse and spins it.
 */
export const makeAccretionDiskTexture = (app: Application, seed: number): Texture => {
  const H = BH_TEXTURE_HORIZON;
  const inner = H * 1.25;
  const outer = H * 4;
  return makeGlowTexture(app, `bh-disk:${seed}`, (g) => {
    g.rect(0, 0, outer * 2, outer * 2).fill({ color: 0x000000, alpha: 0.001 });
    const rng = mulberry32(seed || 1);
    const arcs = 110;
    for (let i = 0; i < arcs; i++) {
      const t = Math.pow(rng(), 0.75); // bias streaks toward the hot inner edge
      const r = inner + t * (outer - inner);
      const a0 = rng() * Math.PI * 2;
      const len = 0.35 + rng() * 1.5;
      const mid = a0 + len / 2;
      // Doppler beaming: the side sweeping toward the viewer glows brighter.
      const doppler = 1 + 0.8 * Math.sin(mid);
      const col = toward(0xfff3d6, 0xb33c10, t);
      const alpha = Math.min(0.5, (0.2 - t * 0.13) * doppler + 0.02);
      g.arc(outer, outer, r, a0, a0 + len).stroke({
        width: 1 + rng() * 1.8,
        color: col,
        alpha,
      });
    }
    // A hot continuous inner rim anchors the streaks.
    for (let k = 0; k < 4; k++) {
      g.circle(outer, outer, inner + k * 1.1).stroke({
        width: 1.4,
        color: toward(0xfff3d6, 0xffb060, k / 4),
        alpha: 0.16 - k * 0.03,
      });
    }
  });
};
