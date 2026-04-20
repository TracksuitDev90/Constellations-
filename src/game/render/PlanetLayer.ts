import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import { RING_CAPACITY_FOR_SIZE, type PlanetType } from '../sim/Planet.js';
import type { World } from '../sim/World.js';
import {
  bakedBodyDiameter,
  makePlanetBodyTexture,
  makePlanetHaloTexture,
  makeShipTexture,
} from './textures.js';
import { planetAssetsReady } from './planetAssets.js';

const MAX_ORBITERS = 48;
/** Major-axis radius of an atom-ring, as a multiple of planet radius. */
const ORBIT_BAND_MAJOR = 1.85;
/** Minor-axis as a fraction of major — small enough to read as tilted orbits. */
const ORBIT_BAND_SQUISH = 0.32;
/**
 * Ring tilts for up to 3 nested orbits. Evenly spaced every 60° so the three
 * overlapping ellipses spell out the classic atom-symbol silhouette.
 */
const RING_TILTS = [0, Math.PI / 3, (2 * Math.PI) / 3];
/**
 * Per-ring angular speeds (rad/s). Alternating signs + slightly different
 * magnitudes make the electrons look like independent orbits rather than a
 * rigid merry-go-round.
 */
const RING_SPEEDS = [0.55, -0.78, 0.94];
/**
 * Thresholds at which a new orbit ring emerges. Fewer orbiters ⇒ a simple
 * single ring. As the garrison grows a second and eventually third ring
 * pop in, producing the atom-symbol shape the player recognizes.
 */
const RING_GROWTH_THRESHOLDS = [8, 16];

const ringCountFor = (count: number): number => {
  if (count <= 0) return 0;
  if (count <= RING_GROWTH_THRESHOLDS[0]) return 1;
  if (count <= RING_GROWTH_THRESHOLDS[1]) return 2;
  return 3;
};

/** Starting visual scale used when a planet evolves — it pops up from this. */
const EVOLVE_POP_START = 0.72;
/**
 * Extra visual scale applied when every ring is completely full, before the
 * evolve pop. Lets the planet visibly swell as it "fills up" so the player
 * feels the growth build up before the explosive tier-up.
 */
const RING_GROWTH_MAX = 0.35;

/** Map the baked body's pixel diameter back down to the planet's world radius. */
const computeBodyBaseScale = (radius: number): number => {
  if (!planetAssetsReady()) return 1; // procedural body already matches radius.
  const diameter = bakedBodyDiameter(radius);
  return (radius * 2) / diameter;
};

interface Orbiter {
  sprite: Sprite;
  /** Which atom ring (0..2) this electron is assigned to. */
  ringIdx: number;
  /** Personal twinkle phase for alpha flicker. */
  phase: number;
}

interface PlanetView {
  planetId: number;
  container: Container;
  halo: Sprite;
  body: Sprite;
  ring: Graphics;
  rings: Graphics; // capacity rings (per-planet ringCount)
  atomPaths: Graphics; // faint orbit ellipses that the electrons follow
  shockwave: Graphics;
  count: Text;
  orbitRoot: Container;
  orbiters: Orbiter[];
  lastOwner: number | null;
  displayScale: number;
  baseRadius: number;
  type: PlanetType;
  ringCount: number;
  swirlPhase: number;
  /** Eased progress per ring (0..1). */
  ringProgress: number[];
  /** Per-atom-ring shared phase, advanced by RING_SPEEDS each frame. */
  ringPhase: number[];
  /** Per-atom-ring alpha [0..1] for smooth fade-in as new rings emerge. */
  ringAlpha: number[];
  /**
   * Scale that maps the body sprite's pixel diameter to the desired world
   * radius. Rebuilt on size evolution so higher-res textures stay crisp.
   */
  bodyBaseScale: number;
}

export class PlanetLayer extends Container {
  private app: Application;
  private world: World;
  private views: PlanetView[] = [];
  private selectedSources = new Set<number>();
  private shipTex: Texture;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.app = app;
    this.world = world;
    this.shipTex = makeShipTexture(app);

    for (const planet of world.planets) {
      const container = new Container();
      container.x = planet.pos.x;
      container.y = planet.pos.y;

      const halo = new Sprite(makePlanetHaloTexture(app, planet.owner, planet.radius));
      halo.anchor.set(0.5);
      halo.tint = paletteFor(planet.owner).glow;

      const body = new Sprite(
        makePlanetBodyTexture(app, planet.owner, planet.radius, planet.id, planet.type),
      );
      body.anchor.set(0.5);

      const ring = new Graphics();
      const rings = new Graphics();
      const atomPaths = new Graphics();
      const shockwave = new Graphics();

      const orbitRoot = new Container();

      const count = new Text({
        text: String(planet.garrison),
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
          fontSize: Math.max(13, Math.round(planet.radius * 0.7)),
          fontWeight: '600',
          fill: 0xffffff,
          align: 'center',
          stroke: { color: 0x000000, width: 2, alpha: 0.55 },
        },
      });
      count.anchor.set(0.5);

      container.addChild(halo, ring, rings, body, atomPaths, orbitRoot, shockwave, count);
      this.addChild(container);

      this.views.push({
        planetId: planet.id,
        container,
        halo,
        body,
        ring,
        rings,
        atomPaths,
        shockwave,
        count,
        orbitRoot,
        orbiters: [],
        lastOwner: planet.owner,
        displayScale: 1,
        baseRadius: planet.radius,
        type: planet.type,
        ringCount: planet.ringCount,
        swirlPhase: Math.random() * Math.PI * 2,
        ringProgress: new Array(planet.ringCount).fill(0),
        ringPhase: [
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
        ],
        ringAlpha: [0, 0, 0],
        bodyBaseScale: computeBodyBaseScale(planet.radius),
      });
    }
  }

  setSelection(ids: Iterable<number>): void {
    this.selectedSources = new Set(ids);
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.world.planets.length; i++) {
      const p = this.world.planets[i];
      const v = this.views[i];

      // Evolution: when the planet's size changes, rebake the body texture at
      // the new radius, reset ring state, and pop the visual scale so the
      // planet visibly "explodes" into its larger form.
      if (p.type !== v.type || p.radius !== v.baseRadius) {
        v.type = p.type;
        v.baseRadius = p.radius;
        v.bodyBaseScale = computeBodyBaseScale(p.radius);
        v.body.texture = makePlanetBodyTexture(this.app, p.owner, p.radius, p.id, p.type);
        v.halo.texture = makePlanetHaloTexture(this.app, p.owner, p.radius);
        v.displayScale = EVOLVE_POP_START;
        v.count.style.fontSize = Math.max(13, Math.round(p.radius * 0.7));
      }

      // Owner change → halo re-tints. The body stays as the baked planet map
      // (ownership is communicated by the halo + rings + orbiters).
      if (p.owner !== v.lastOwner) {
        if (!planetAssetsReady()) {
          v.body.texture = makePlanetBodyTexture(this.app, p.owner, p.radius, p.id, p.type);
        }
        v.halo.texture = makePlanetHaloTexture(this.app, p.owner, p.radius);
        v.halo.tint = paletteFor(p.owner).glow;
        v.lastOwner = p.owner;
      }

      // Ring count can change on evolution or capture. Resize the eased
      // progress array to match the live planet.
      if (p.ringCount !== v.ringCount) {
        v.ringCount = p.ringCount;
        v.ringProgress = new Array(p.ringCount).fill(0);
      }

      // Ease displayScale back to 1 after an evolution pop.
      const ease = 1 - Math.exp(-dt * 3);
      v.displayScale += (1 - v.displayScale) * ease;

      // Subtle swirl once the planet has at least one filled-ring fraction.
      const anyRingActive = v.ringProgress.some((x) => x > 0.001);
      v.swirlPhase += dt * (0.6 + (anyRingActive ? 0.35 : 0));
      const swirlWobble = anyRingActive ? 1 + Math.sin(v.swirlPhase) * 0.012 : 1;

      // Aggregate eased ring fill — drives a smooth size-up as the player
      // feeds orbit units into the planet. Resets to 0 on evolve (rings clear).
      let ringFillNorm = 0;
      if (v.ringCount > 0) {
        let s = 0;
        for (let k = 0; k < v.ringCount; k++) s += v.ringProgress[k] ?? 0;
        ringFillNorm = Math.max(0, Math.min(1, s / v.ringCount));
      }
      const ringGrowth = 1 + ringFillNorm * RING_GROWTH_MAX;

      const pulse = 1 + p.capturePulse * 0.2 + p.evolvePulse * 0.15;
      v.body.scale.set(v.bodyBaseScale * v.displayScale * pulse * swirlWobble * ringGrowth);
      v.body.rotation = anyRingActive ? Math.sin(v.swirlPhase * 0.5) * 0.06 : 0;
      v.halo.scale.set(v.displayScale * pulse * ringGrowth);

      // Effective radius rings / count / selection should space themselves off.
      const effRadius = v.baseRadius * v.displayScale * ringGrowth;

      // Count readout sits just below the planet.
      v.count.text = String(p.garrison);
      v.count.y = effRadius + 16;

      const pal = paletteFor(p.owner);

      // Capacity rings: many fine concentric sub-bands that fill with the
      // owner's color as absorbed units accumulate. Sub-bands of varied width
      // and density read as dust/ice debris rather than a solid hoop.
      v.rings.clear();
      const RING_WIDTH = Math.max(4, v.baseRadius * 0.35);
      const RING_GAP = Math.max(3, v.baseRadius * 0.12);
      const RING_INSET = Math.max(6, v.baseRadius * 0.22);
      if (p.ringCount > 0) {
        const cap = RING_CAPACITY_FOR_SIZE[p.type];
        for (let k = 0; k < p.ringCount; k++) {
          const fill = p.ringFillProgress[k] ?? 0;
          const target = cap > 0 ? Math.max(0, Math.min(1, fill / cap)) : 0;
          const prog = v.ringProgress[k] ?? 0;
          const eased = 1 - Math.exp(-dt * 4);
          v.ringProgress[k] = prog + (target - prog) * eased;
          const progress = v.ringProgress[k];

          const rMid =
            effRadius +
            RING_INSET +
            RING_WIDTH / 2 +
            k * (RING_WIDTH + RING_GAP);

          drawRealisticRing(
            v.rings,
            rMid,
            RING_WIDTH,
            progress,
            pal.ring,
            pal.glow,
            p.id * 13 + k,
            this.time,
          );

          if (progress > 0.995) {
            const pulseR = rMid + RING_WIDTH / 2 + 1 + Math.sin(this.time * 3 + k * 0.8) * 1.2;
            v.rings.circle(0, 0, pulseR).stroke({
              width: 1.5,
              color: pal.glow,
              alpha: 0.5,
            });
          }
        }
      }

      // Evolve shockwave: a fading ring that expands outward past the halo
      // whenever a planet has just grown to a new tier.
      v.shockwave.clear();
      if (p.evolvePulse > 0.01) {
        const t = 1 - p.evolvePulse; // 0 at spawn → 1 as it fades.
        const baseR = effRadius;
        const shockR = baseR * (1.2 + t * 2.4);
        const alpha = p.evolvePulse * 0.85;
        v.shockwave
          .circle(0, 0, shockR)
          .stroke({ width: 3 + p.evolvePulse * 4, color: pal.glow, alpha });
        v.shockwave
          .circle(0, 0, shockR * 0.72)
          .stroke({ width: 2, color: pal.ring, alpha: alpha * 0.6 });
      }

      // Selection ring (pulsing) sits outside the capacity rings.
      v.ring.clear();
      if (this.selectedSources.has(p.id)) {
        const ringsOuter =
          p.ringCount > 0
            ? RING_INSET + p.ringCount * (RING_WIDTH + RING_GAP) - RING_GAP
            : 8;
        const outer = effRadius + ringsOuter + 8 + Math.sin(this.time * 4) * 1.6;
        v.ring.circle(0, 0, outer).stroke({ width: 2.5, color: pal.ring, alpha: 0.95 });
      }

      // Orbiters: represent garrison (up to cap) as atom-symbol electrons.
      if (p.owner !== null) {
        this.syncOrbiters(v, Math.min(p.garrison, MAX_ORBITERS), p.owner);
        this.tickOrbiters(v, dt);
        this.drawAtomPaths(v, pal.ring);
      } else {
        if (v.orbiters.length > 0) this.clearOrbiters(v);
        v.atomPaths.clear();
      }
    }
  }

  private syncOrbiters(v: PlanetView, target: number, owner: number): void {
    const shipTint = paletteFor(owner).ship;

    for (const o of v.orbiters) o.sprite.tint = shipTint;

    while (v.orbiters.length < target) {
      const sprite = new Sprite(this.shipTex);
      sprite.anchor.set(0.5);
      sprite.scale.set(0.36);
      sprite.tint = shipTint;
      // Seed new electrons at a random point along the outermost active
      // orbit so they slide into formation rather than popping in at origin.
      sprite.x = (Math.random() - 0.5) * v.baseRadius * 0.5;
      sprite.y = (Math.random() - 0.5) * v.baseRadius * 0.5;
      v.orbitRoot.addChild(sprite);
      v.orbiters.push({
        sprite,
        ringIdx: 0,
        phase: Math.random() * Math.PI * 2,
      });
    }

    while (v.orbiters.length > target) {
      const o = v.orbiters.pop()!;
      v.orbitRoot.removeChild(o.sprite);
      o.sprite.destroy();
    }
  }

  private tickOrbiters(v: PlanetView, dt: number): void {
    const count = v.orbiters.length;
    const ringCount = ringCountFor(count);

    // Fade each ring's alpha toward its active state — new rings emerge
    // smoothly, retiring rings fade out, so transitions look like matter
    // settling rather than teleporting.
    const alphaEase = 1 - Math.exp(-dt * 3);
    for (let k = 0; k < 3; k++) {
      const targetA = k < ringCount ? 1 : 0;
      v.ringAlpha[k] += (targetA - v.ringAlpha[k]) * alphaEase;
    }

    if (count === 0) return;

    // Advance shared phase per active ring.
    for (let k = 0; k < ringCount; k++) {
      v.ringPhase[k] += RING_SPEEDS[k] * dt;
    }

    // Round-robin assignment: distribute electrons evenly across rings.
    const memberCount = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const r = i % ringCount;
      v.orbiters[i].ringIdx = r;
      memberCount[r]++;
    }
    const slotIdx = [0, 0, 0];

    const scale = v.displayScale;
    const majorR = v.baseRadius * ORBIT_BAND_MAJOR * scale;
    const minorR = majorR * ORBIT_BAND_SQUISH;
    const ease = 1 - Math.exp(-dt * 5);

    for (let i = 0; i < count; i++) {
      const o = v.orbiters[i];
      const r = o.ringIdx;
      const slot = slotIdx[r]++;
      const theta = v.ringPhase[r] + (slot / memberCount[r]) * Math.PI * 2;
      const tilt = RING_TILTS[r];
      const ex = Math.cos(theta) * majorR;
      const ey = Math.sin(theta) * minorR;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      const tx = ex * cosT - ey * sinT;
      const ty = ex * sinT + ey * cosT;

      o.sprite.x += (tx - o.sprite.x) * ease;
      o.sprite.y += (ty - o.sprite.y) * ease;
      const a = 0.7 + 0.3 * Math.sin(this.time * 2.2 + o.phase);
      o.sprite.alpha = a;
    }
  }

  /**
   * Faint ghost ellipses along each active atom ring. Fades with ringAlpha
   * so new rings materialize rather than pop. Uses a short polyline instead
   * of an ellipse stroke so we can follow the ring's tilt precisely.
   */
  private drawAtomPaths(v: PlanetView, tint: number): void {
    v.atomPaths.clear();
    const scale = v.displayScale;
    const majorR = v.baseRadius * ORBIT_BAND_MAJOR * scale;
    const minorR = majorR * ORBIT_BAND_SQUISH;
    const segments = 48;
    for (let k = 0; k < 3; k++) {
      const alpha = v.ringAlpha[k];
      if (alpha <= 0.02) continue;
      const tilt = RING_TILTS[k];
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      for (let s = 0; s < segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        const ex = Math.cos(theta) * majorR;
        const ey = Math.sin(theta) * minorR;
        const x = ex * cosT - ey * sinT;
        const y = ex * sinT + ey * cosT;
        if (s === 0) v.atomPaths.moveTo(x, y);
        else v.atomPaths.lineTo(x, y);
      }
      v.atomPaths.closePath();
      v.atomPaths.stroke({ width: 1.2, color: tint, alpha: 0.22 * alpha });
    }
  }

  private clearOrbiters(v: PlanetView): void {
    for (const o of v.orbiters) {
      v.orbitRoot.removeChild(o.sprite);
      o.sprite.destroy();
    }
    v.orbiters.length = 0;
  }
}

/**
 * Deterministic hash → [0, 1). Keeps each planet's ring pattern identical
 * frame-to-frame so sub-bands don't shimmer at the pixel level.
 */
const seeded = (seed: number): number => {
  // Multiply-with-carry style; fine for visual-only jitter.
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

/**
 * Render a single capacity ring as a dense stack of fine sub-bands — Saturn-
 * style dust/ice rings rather than a solid hoop. The filled arc (0..progress)
 * lights each sub-band in the owner's color; the empty arc shows the same
 * bands at a dim neutral alpha so the band structure reads even at 0% fill.
 *
 * All randomness is seeded off a per-ring id so the pattern is stable.
 */
const drawRealisticRing = (
  g: import('pixi.js').Graphics,
  rMid: number,
  ringWidth: number,
  progress: number,
  ringColor: number,
  glowColor: number,
  seed: number,
  time: number,
): void => {
  const innerR = rMid - ringWidth / 2;
  const outerR = rMid + ringWidth / 2;
  const sweep = Math.PI * 2 * progress;
  const start = -Math.PI / 2;

  // Faint wide dust halo behind the structured bands — gives the whole ring
  // a soft, hazy body.
  g.circle(0, 0, rMid).stroke({ width: ringWidth + 2, color: ringColor, alpha: 0.05 });

  // Pre-compute sub-band layout. 9 bands with jittered positions + widths.
  const subCount = 9;
  const bands: Array<{ r: number; w: number; a: number; glow: boolean }> = [];
  for (let i = 0; i < subCount; i++) {
    const t = (i + 0.5) / subCount;
    // Slight variance in radial position (± up to 12% of its own cell width).
    const cellH = ringWidth / subCount;
    const jitter = (seeded(seed + i) - 0.5) * cellH * 0.6;
    const r = innerR + t * ringWidth + jitter;
    // Width varies — most bands thin, a couple wide — mimicking real dust density.
    const wRand = seeded(seed + i * 7 + 3);
    const w = wRand < 0.18
      ? cellH * (1.4 + seeded(seed + i * 11) * 0.5) // occasional thick band
      : cellH * (0.35 + seeded(seed + i * 13) * 0.55); // typical thin strand
    const aRand = seeded(seed + i * 17);
    // Base opacity skews middle-heavy so edges fade out naturally.
    const edgeFade = 1 - Math.pow(Math.abs(t - 0.5) * 2, 1.8);
    const a = 0.18 + aRand * 0.28 * edgeFade;
    const glow = wRand < 0.12; // rare bright "Cassini-adjacent" band
    bands.push({ r, w, a, glow });
  }

  // Dim empty rails at the exact inner/outer extents — keeps the ring
  // silhouette crisp even when every band is low-alpha.
  g.circle(0, 0, innerR).stroke({ width: 0.8, color: ringColor, alpha: 0.35 });
  g.circle(0, 0, outerR).stroke({ width: 0.8, color: ringColor, alpha: 0.35 });

  // Empty arc: bands in a muted neutral tone so the ring reads as structure
  // even before the player has fed it anything.
  if (progress < 0.999) {
    const emptyStart = start + sweep;
    const emptyEnd = start + Math.PI * 2;
    for (const b of bands) {
      g.arc(0, 0, b.r, emptyStart, emptyEnd).stroke({
        width: b.w,
        color: ringColor,
        alpha: b.a * 0.45,
      });
    }
  }

  // Filled arc: same band layout, owner-tinted and brighter. A subtle outer
  // glow arc underneath sells the emissive look.
  if (progress > 0.001) {
    const filledEnd = start + sweep;
    g.arc(0, 0, rMid, start, filledEnd).stroke({
      width: ringWidth + 4,
      color: glowColor,
      alpha: 0.22,
    });
    for (const b of bands) {
      g.arc(0, 0, b.r, start, filledEnd).stroke({
        width: b.w,
        color: b.glow ? glowColor : ringColor,
        alpha: Math.min(1, b.a * 2.6),
      });
    }
    // A fine bright "rim" along the middle of the filled arc reads as the
    // leading edge of the accumulated matter.
    const rimPulse = 0.55 + 0.2 * Math.sin(time * 2.6 + seed * 0.5);
    g.arc(0, 0, rMid, start, filledEnd).stroke({
      width: Math.max(1, ringWidth * 0.12),
      color: 0xffffff,
      alpha: 0.45 * progress * rimPulse,
    });
  }
};
