import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import { RING_CAPACITY_FOR_SIZE, type PlanetType } from '../sim/Planet.js';
import type { World } from '../sim/World.js';
import {
  assignPlanetArchetypes,
  bakedBodyDiameter,
  makePlanetBodyTexture,
  makePlanetHaloTexture,
  makeShipGlowTexture,
  makeShipTexture,
} from './textures.js';
import { planetAssetsReady } from './planetAssets.js';

const MAX_ORBITERS = 48;
/** Major-axis radius of an atom-ring, as a multiple of planet radius. */
const ORBIT_BAND_MAJOR = 1.85;
/**
 * Minor-axis squish range. With few orbiters the ring reads as a near-circular
 * gentle halo; as the swarm grows it slowly flattens into tilted orbits so the
 * atom-symbol shape only emerges under a massive population.
 */
const ORBIT_BAND_SQUISH_LOOSE = 0.92;
const ORBIT_BAND_SQUISH_ATOM = 0.3;
/**
 * Ring tilts for up to 3 nested orbits. Evenly spaced every 60° so the three
 * overlapping ellipses spell out the classic atom-symbol silhouette.
 */
const RING_TILTS = [0, Math.PI / 3, (2 * Math.PI) / 3];
/**
 * Per-ring angular speeds (rad/s). Alternating signs + slightly different
 * magnitudes make the electrons look like independent orbits rather than a
 * rigid merry-go-round. Kept gentle so the motion feels meditative, not busy.
 */
const RING_SPEEDS = [0.32, -0.44, 0.55];
/**
 * Thresholds at which a new orbit ring emerges. Tuned so the default starting
 * garrison (~12) reads as a single loose orbit; the second ring only joins in
 * after a meaningful buildup, and the full three-ring atom requires a massive
 * fleet (near the visible cap). The formation should feel earned.
 */
const RING_GROWTH_THRESHOLDS = [22, 36];
/**
 * Full-atom threshold — the count at which squish and structure are at their
 * most crystalline. Below this, everything eases toward loose/circular.
 */
const FULL_ATOM_COUNT = 42;
/** Min/max ease rate so position transitions feel flowy, not mechanical. */
const ORBIT_POS_EASE_RATE = 1.6;
/** Ring alpha fade rate — slower than position so rings bleed in gradually. */
const RING_ALPHA_EASE_RATE = 0.6;
/** How quickly the eased ring count catches its discrete target. */
const RING_COUNT_EASE_RATE = 0.4;

const ringCountFor = (count: number): number => {
  if (count <= 0) return 0;
  if (count <= RING_GROWTH_THRESHOLDS[0]) return 1;
  if (count <= RING_GROWTH_THRESHOLDS[1]) return 2;
  return 3;
};

const smoothstep = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
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
  /** Wider additive halo behind the sprite — accumulates in dense clusters. */
  glow: Sprite;
  /** Per-orbiter glow scale so clusters don't read as a solid blob. */
  glowScale: number;
  /** Which atom ring (0..2) this electron is assigned to. */
  ringIdx: number;
  /** Personal twinkle phase for alpha flicker. */
  phase: number;
  /** Slow angular drift — small per-ship offset so the swarm breathes. */
  wanderPhase: number;
  /** Per-orbiter phase along its ring's ellipse (0..2π). */
  slotPhase: number;
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
  /** Subtle strength bar beneath the planet — visual stand-in for garrison. */
  strengthBar: Graphics;
  /** Eased bar fill (0..1+) so the indicator glides with population changes. */
  easedStrength: number;
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
  /** Eased, continuous "ring count" that trails the discrete target smoothly. */
  easedRingCount: number;
  /** Eased formation factor (0..1); drives squish and structure sharpness. */
  atomFormation: number;
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
  private shipGlowTex: Texture;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.app = app;
    this.world = world;
    this.shipTex = makeShipTexture(app);
    this.shipGlowTex = makeShipGlowTexture(app);

    // Assign every planet a distinct archetype from the pool before baking
    // any body textures, so no two worlds in the same match share a surface.
    assignPlanetArchetypes(
      world.planets.map((p) => p.id),
      // Use the wall clock as the per-match seed so replays shuffle the pool.
      Date.now() & 0x7fffffff,
    );

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
      const strengthBar = new Graphics();

      const orbitRoot = new Container();

      container.addChild(halo, ring, rings, body, atomPaths, orbitRoot, shockwave, strengthBar);
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
        strengthBar,
        easedStrength: 0,
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
        easedRingCount: 0,
        atomFormation: 0,
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

      const pal = paletteFor(p.owner);

      // Strength bar under the planet — a visual stand-in for the old numeric
      // garrison readout. Length scales with garrison / maxUnitCapacity (past
      // 1.0 it overflows into a pulsing "saturated" glow).
      this.drawStrengthBar(v, p.garrison, p.maxUnitCapacity, effRadius, pal, p.owner, dt);

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

  /**
   * Render the subtle strength indicator beneath the planet. Replaces the old
   * numeric garrison readout with a visual bar whose filled length tracks
   * `garrison / maxUnitCapacity`. Once the garrison saturates, an outer pulse
   * glow communicates overflow rather than breaking the scale.
   */
  private drawStrengthBar(
    v: PlanetView,
    garrison: number,
    capacity: number,
    effRadius: number,
    pal: import('../../util/color.js').PlayerPalette,
    owner: number | null,
    dt: number,
  ): void {
    const g = v.strengthBar;
    g.clear();
    if (owner === null || garrison <= 0) {
      v.easedStrength = 0;
      return;
    }
    const targetFill = capacity > 0 ? garrison / capacity : 0;
    const ease = 1 - Math.exp(-dt * 5);
    v.easedStrength += (targetFill - v.easedStrength) * ease;
    const fill = Math.max(0, v.easedStrength);

    const width = Math.max(24, effRadius * 1.6);
    const height = Math.max(3, effRadius * 0.1);
    const y = effRadius + height + 6;
    const left = -width / 2;

    const radius = height / 2;

    // Backdrop — a dim pill so the bar reads against both starfield and halo.
    g.roundRect(left - 1, y - height / 2 - 1, width + 2, height + 2, radius + 1)
      .fill({ color: 0x000000, alpha: 0.32 });
    g.roundRect(left, y - height / 2, width, height, radius)
      .fill({ color: pal.glow, alpha: 0.22 });

    // Filled portion — clamps at 1, the remainder communicates overflow via
    // the outer pulse below.
    const clipped = Math.min(1, fill);
    const fillW = Math.max(0, width * clipped);
    if (fillW > 0.5) {
      g.roundRect(left, y - height / 2, fillW, height, Math.min(radius, fillW / 2))
        .fill({ color: pal.ring, alpha: 0.95 });
      // Highlight strip along the top of the filled segment for depth.
      g.roundRect(
        left + 1,
        y - height / 2 + 0.5,
        Math.max(0, fillW - 2),
        Math.max(0.8, height * 0.35),
        Math.min(radius, fillW / 2),
      ).fill({ color: 0xffffff, alpha: 0.35 });
    }

    // Saturation glow: beyond full, pulse a soft ring of light around the bar
    // so massive fleets read as "overflowing" instead of silently capping.
    const overflow = Math.max(0, fill - 1);
    if (overflow > 0.01) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 3.8);
      const a = Math.min(0.75, 0.35 + overflow * 0.6) * pulse;
      g.roundRect(left - 2, y - height / 2 - 2, width + 4, height + 4, radius + 2)
        .stroke({ width: 1.4, color: pal.ring, alpha: a });
    }
  }

  private syncOrbiters(v: PlanetView, target: number, owner: number): void {
    const shipTint = paletteFor(owner).ship;

    for (const o of v.orbiters) {
      o.sprite.tint = shipTint;
      o.glow.tint = shipTint;
    }

    while (v.orbiters.length < target) {
      // Glow is added first so it renders under the bright dot. Additive
      // blending means overlapping glows accumulate into bright hotspots
      // wherever orbiters cluster, without each ring reading as a solid blob.
      const glow = new Sprite(this.shipGlowTex);
      glow.anchor.set(0.5);
      glow.blendMode = 'add';
      glow.tint = shipTint;
      const glowScale = 0.42 + Math.random() * 0.22;
      glow.scale.set(glowScale);
      v.orbitRoot.addChild(glow);

      const sprite = new Sprite(this.shipTex);
      sprite.anchor.set(0.5);
      sprite.scale.set(0.36);
      sprite.tint = shipTint;
      const spawnAngle = Math.random() * Math.PI * 2;
      const spawnR = v.baseRadius * (0.9 + Math.random() * 0.3);
      sprite.x = Math.cos(spawnAngle) * spawnR;
      sprite.y = Math.sin(spawnAngle) * spawnR;
      glow.x = sprite.x;
      glow.y = sprite.y;
      v.orbitRoot.addChild(sprite);

      v.orbiters.push({
        sprite,
        glow,
        glowScale,
        ringIdx: 0,
        phase: Math.random() * Math.PI * 2,
        wanderPhase: Math.random() * Math.PI * 2,
        slotPhase: Math.random() * Math.PI * 2,
      });
    }

    while (v.orbiters.length > target) {
      const o = v.orbiters.pop()!;
      v.orbitRoot.removeChild(o.sprite);
      v.orbitRoot.removeChild(o.glow);
      o.sprite.destroy();
      o.glow.destroy();
    }
  }

  private tickOrbiters(v: PlanetView, dt: number): void {
    const count = v.orbiters.length;
    const targetRings = ringCountFor(count);

    // Continuous formation factor — 0 at "empty" or "one loose ring", 1 at the
    // crystalline full-atom limit. Everything that makes the atom "read" as
    // an atom (squish, ring count, path alpha) eases from this value so the
    // structure forms slowly as the population grows instead of snapping in.
    const rawFormation = Math.max(
      0,
      Math.min(1, (count - RING_GROWTH_THRESHOLDS[0]) / Math.max(1, FULL_ATOM_COUNT - RING_GROWTH_THRESHOLDS[0])),
    );
    const formTarget = smoothstep(rawFormation);
    const formEase = 1 - Math.exp(-dt * 0.9);
    v.atomFormation += (formTarget - v.atomFormation) * formEase;

    // Eased ring count — floats toward the discrete target so transitions
    // aren't abrupt even visually (rings fade + orbiters redistribute over
    // several seconds rather than a single frame).
    const rcEase = 1 - Math.exp(-dt * RING_COUNT_EASE_RATE);
    v.easedRingCount += (targetRings - v.easedRingCount) * rcEase;

    // Per-ring alpha trails the eased ring count so ring k is "active"
    // proportionally to how far the structure has grown past it.
    const alphaEase = 1 - Math.exp(-dt * RING_ALPHA_EASE_RATE);
    for (let k = 0; k < 3; k++) {
      const targetA = Math.max(0, Math.min(1, v.easedRingCount - k));
      v.ringAlpha[k] += (targetA - v.ringAlpha[k]) * alphaEase;
    }

    if (count === 0) return;

    // Advance shared phase per active ring. Speeds ramp up with formation
    // so early "single ring" orbits drift slowly and the full atom spins
    // with more character.
    const speedScale = 0.55 + 0.45 * v.atomFormation;
    for (let k = 0; k < targetRings; k++) {
      v.ringPhase[k] += RING_SPEEDS[k] * speedScale * dt;
    }

    // Round-robin assignment, but biased: at low ring counts, later orbiters
    // still live on ring 0 until the formation factor pulls them out. Since
    // targetRings already gates this via ringCountFor, plain i % targetRings
    // gives an even spread that flows naturally when a new ring emerges.
    const memberCount = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const r = i % targetRings;
      v.orbiters[i].ringIdx = r;
      memberCount[r]++;
    }
    const slotIdx = [0, 0, 0];

    const scale = v.displayScale;
    const majorR = v.baseRadius * ORBIT_BAND_MAJOR * scale;
    // Squish morphs from near-circular to elliptical as the atom forms.
    // At low formation every ring reads as a gentle halo; at max formation
    // the overlapping ellipses resolve into the classic atom silhouette.
    const squish =
      ORBIT_BAND_SQUISH_LOOSE +
      (ORBIT_BAND_SQUISH_ATOM - ORBIT_BAND_SQUISH_LOOSE) * v.atomFormation;
    const minorR = majorR * squish;
    const ease = 1 - Math.exp(-dt * ORBIT_POS_EASE_RATE);

    for (let i = 0; i < count; i++) {
      const o = v.orbiters[i];
      o.wanderPhase += dt * 0.7;
      const r = o.ringIdx;
      const slot = slotIdx[r]++;
      const memberSpacing = (slot / memberCount[r]) * Math.PI * 2;
      // Per-orbiter personal slow drift — keeps the swarm breathing instead
      // of marching in lockstep. Amplitude shrinks as the atom crystallizes
      // so the final atom symbol reads as crisp even while single-ring
      // formations feel organic.
      const wanderAmp = 0.35 * (1 - 0.7 * v.atomFormation);
      const wander = Math.sin(o.wanderPhase + o.slotPhase) * wanderAmp;
      const theta = v.ringPhase[r] + memberSpacing + wander;
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

      // Glow follows the sprite; its own twinkle runs at a different phase so
      // the halo pulsing doesn't lock to the dot flicker, which keeps dense
      // clusters from reading as a single solid blob.
      o.glow.x = o.sprite.x;
      o.glow.y = o.sprite.y;
      const glowFlicker = 0.65 + 0.35 * Math.sin(this.time * 3.1 + o.phase * 1.7);
      o.glow.alpha = 0.55 * glowFlicker;
      o.glow.scale.set(o.glowScale);
    }
  }

  /**
   * Faint ghost ellipses along each active atom ring. Fades with ringAlpha
   * so new rings materialize rather than pop. Squish is driven by the
   * continuous formation factor so paths morph from loose circles to the
   * tilted atom ellipses as the swarm grows.
   */
  private drawAtomPaths(v: PlanetView, tint: number): void {
    v.atomPaths.clear();
    const scale = v.displayScale;
    const majorR = v.baseRadius * ORBIT_BAND_MAJOR * scale;
    const squish =
      ORBIT_BAND_SQUISH_LOOSE +
      (ORBIT_BAND_SQUISH_ATOM - ORBIT_BAND_SQUISH_LOOSE) * v.atomFormation;
    const minorR = majorR * squish;
    const segments = 64;
    // Path alpha grows with both per-ring alpha and the overall atom formation
    // — paths stay near-invisible at loose single-ring stages and crystallize
    // only as the atom asserts itself.
    const formationGate = 0.15 + 0.85 * v.atomFormation;
    for (let k = 0; k < 3; k++) {
      const alpha = v.ringAlpha[k] * formationGate;
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
      v.orbitRoot.removeChild(o.glow);
      o.sprite.destroy();
      o.glow.destroy();
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
