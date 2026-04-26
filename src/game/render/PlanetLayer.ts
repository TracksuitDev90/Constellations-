import { Application, Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { adjustColor, hueJitter, paletteFor } from '../../util/color.js';
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
import { getRingOverlay, planetAssetsReady, type RingOverlayStyle } from './planetAssets.js';

/**
 * Upper bound on atom-electron sprites per planet. Bigger planets get more
 * so a full XXL garrison actually reads as a dense swarm rather than capping
 * at the small-planet ceiling; small ones stay capped low to preserve the
 * "lone orbit" silhouette. Accepts overflow well past maxUnitCapacity (up
 * to HARD_ORBITER_CAP) so reinforcement stacks visibly on a maxed planet.
 */
const HARD_ORBITER_CAP = 300;
const orbiterCapFor = (maxUnitCapacity: number): number =>
  Math.max(32, Math.min(maxUnitCapacity * 2, HARD_ORBITER_CAP));
/**
 * Seconds a newly-produced orbiter spends "being born" — ramping up from a
 * tiny scale at the planet center out to its ring slot. Long enough that the
 * player's eye reads production as a pump-out even on XXL worlds.
 */
const ORBITER_BIRTH_DURATION = 0.55;
/**
 * Seconds a production pulse ring lingers on the planet surface after a unit
 * spawns. Drawn on top of the body so even when the orbit is already at cap
 * the player sees a steady "emitting" heartbeat from the planet.
 */
const PRODUCTION_PULSE_DURATION = 0.65;
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
 * evolve pop. The body and halo both scale by this so the world reads as
 * physically swelling. We bias the curve so early absorbed units produce a
 * visible bump (`Math.pow(progress, 0.55)`) — a 35 % cap with a linear curve
 * was the prior tuning, which felt indistinguishable from the empty ring
 * state until the player was almost done filling it.
 */
const RING_GROWTH_MAX = 0.7;
const RING_GROWTH_CURVE = 0.55;

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
  /**
   * Seconds since the orbiter was born. While below ORBITER_BIRTH_DURATION
   * the sprite scales up from 0 and its position eases out from the planet
   * center, giving new production a clear "pumped out" read even on big
   * planets where the atom ring is always dense.
   */
  birthAge: number;
  /** Angle along which the orbiter emerges from the planet surface. */
  birthAngle: number;
}

/**
 * One painted ring overlay slot for a planet — the artwork lifted from
 * IMG_0327 (brushstroke) or IMG_0344 (tendril) by planetAssets, rendered as
 * a pair of sprites split around the body sprite so the overlay reads as
 * "in front of the body" without needing a mask. Both sprites share the
 * same texture; the per-slot scale + rotation is recomputed each frame.
 *
 * `back` is parented under the planet's `ringsBack` container so it draws
 * before the body sprite (the rim of the ring that orbits behind the world);
 * `front` is parented under `ringsFront` and draws after the body (the rim
 * crossing in front). The painted overlay's natural front/back composition
 * already handles the visual occlusion — duplicating it across both layers
 * gives the same painted strokes a consistent silhouette regardless of where
 * the body lands in the Z order.
 */
interface RingOverlay {
  back: Sprite;
  front: Sprite;
  /** Random ±1 horizontal flip baked at construction so identical archetypes don't all face the same direction. */
  flip: number;
}

interface PlanetView {
  planetId: number;
  container: Container;
  halo: Sprite;
  body: Sprite;
  ring: Graphics;
  /**
   * Painted ring overlay split across a back/front layer pair — the back
   * sprite is parented before the body so the painted strokes that fall
   * outside the planet silhouette read as orbiting behind it; the front
   * sprite is parented after the body so the painted strokes crossing the
   * planet face composite over the body. Both share the same overlay
   * texture lifted from IMG_0327 / IMG_0344 by planetAssets.
   */
  ringsBack: Container;
  ringsFront: Container;
  /** Capacity-progress bead glow drawn on top of the overlay in each layer. */
  ringBeadsBack: Graphics;
  ringBeadsFront: Graphics;
  /** Per-ring-slot painted overlay sprite pair. */
  ringOverlays: RingOverlay[];
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
  /**
   * Last observed productionAcc — used to detect a sub-unit wraparound and
   * emit a production pulse even on planets already at the visual orbiter
   * cap, so bigger worlds still visibly "pump" when the atom ring is full.
   */
  lastProductionAcc: number;
  /** Active production pulses; each fades over PRODUCTION_PULSE_DURATION. */
  productionPulses: Array<{ age: number; angle: number }>;
  /** Graphics layer for production pulses, drawn on top of the body. */
  productionFx: Graphics;
  /**
   * Tilt of each capacity ring's plane — the angle the ring makes with the
   * screen's horizontal axis (radians). Picked once per planet so different
   * worlds rotate at different inclinations rather than all looking identical.
   */
  capRingTilt: number[];
  /** Yaw orientation of each ring's tilt axis around the planet (radians). */
  capRingYaw: number[];
  /** Current spin phase of each ring (advances each frame). */
  capRingSpin: number[];
  /** Per-ring rotation speed (rad/sec). Slight variance keeps stacked rings independent. */
  capRingSpinSpeed: number[];
  /**
   * Visual style picked per capacity ring slot. Stable across re-renders
   * because it's derived from the planet id, so a given world's rings never
   * "swap looks" between frames.
   */
  ringStyle: RingOverlayStyle[];
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
      const ringsBack = new Container();
      const ringsFront = new Container();
      const ringBeadsBack = new Graphics();
      const ringBeadsFront = new Graphics();
      ringsBack.addChild(ringBeadsBack);
      ringsFront.addChild(ringBeadsFront);
      const atomPaths = new Graphics();
      const shockwave = new Graphics();
      const strengthBar = new Graphics();
      const productionFx = new Graphics();

      const orbitRoot = new Container();

      // Z-order — the textured capacity rings split across the body so the
      // back-half geometry occludes behind it and the front-half crosses over
      // it, selling a 3D rotating ring rather than a flat overlay.
      container.addChild(
        halo,
        ring,
        ringsBack,
        body,
        ringsFront,
        productionFx,
        atomPaths,
        orbitRoot,
        shockwave,
        strengthBar,
      );
      this.addChild(container);

      // Per-planet ring tilt + spin: deterministic from the planet id so a
      // given world keeps its inclination across re-renders, but varied
      // enough across the map that no two rings look identical.
      const tiltSeed = planet.id * 37 + 11;
      const tiltPick = (k: number): number =>
        0.55 + seeded(tiltSeed + k * 13) * 0.7; // ~32°–72°
      const yawPick = (k: number): number =>
        seeded(tiltSeed + k * 19 + 5) * Math.PI;
      const speedPick = (k: number): number =>
        (0.18 + seeded(tiltSeed + k * 23 + 3) * 0.18) *
        (Math.random() < 0.5 ? -1 : 1);
      const stylePick = (k: number): RingOverlayStyle =>
        seeded(tiltSeed + k * 29 + 41) < 0.5 ? 'brushstroke' : 'spiky';
      const ringStyles: RingOverlayStyle[] = [stylePick(0), stylePick(1), stylePick(2)];
      const ringOverlays: RingOverlay[] = [
        buildRingOverlay(ringStyles[0], planet.id * 13 + 0, ringsBack, ringsFront),
        buildRingOverlay(ringStyles[1], planet.id * 13 + 1, ringsBack, ringsFront),
        buildRingOverlay(ringStyles[2], planet.id * 13 + 2, ringsBack, ringsFront),
      ];
      this.views.push({
        planetId: planet.id,
        container,
        halo,
        body,
        ring,
        ringsBack,
        ringsFront,
        ringBeadsBack,
        ringBeadsFront,
        ringOverlays,
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
        lastProductionAcc: 0,
        productionPulses: [],
        productionFx,
        capRingTilt: [tiltPick(0), tiltPick(1)],
        capRingYaw: [yawPick(0), yawPick(1)],
        capRingSpin: [
          seeded(tiltSeed + 7) * Math.PI * 2,
          seeded(tiltSeed + 17) * Math.PI * 2,
        ],
        capRingSpinSpeed: [speedPick(0), speedPick(1)],
        ringStyle: ringStyles,
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

      // Track the planet's live position so drifting hazard planets visibly
      // wander. For static planets this is a cheap no-op write (same coords
      // as last frame). The planet container holds halo, body, rings, and
      // orbiters as children, so updating the container origin moves them
      // all together without re-laying anything out.
      v.container.x = p.pos.x;
      v.container.y = p.pos.y;

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
      // Front-load the growth so the player sees the world swell from the
      // first absorbed unit, not just at the very end of filling.
      const ringGrowth =
        1 + Math.pow(ringFillNorm, RING_GROWTH_CURVE) * RING_GROWTH_MAX;

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

      // Capacity rings: hand-painted overlay sprites lifted from the
      // reference stickers (IMG_0327 brushstroke, IMG_0344 tendril), one
      // pair per ring slot, tinted to the owner palette. Sprites are split
      // across a back/front layer so painted strokes that should orbit
      // behind the body draw before it and strokes crossing the planet
      // face draw after. Capacity progress reads via the bead glow on top.
      v.ringBeadsBack.clear();
      v.ringBeadsFront.clear();
      const RING_WIDTH = Math.max(4, v.baseRadius * 0.35);
      const RING_GAP = Math.max(3, v.baseRadius * 0.12);
      const RING_INSET = Math.max(6, v.baseRadius * 0.22);
      // Hide every overlay sprite by default; active ring slots reveal
      // their own below so a planet that loses ring slots stops drawing
      // stale art.
      for (const overlay of v.ringOverlays) {
        overlay.back.visible = false;
        overlay.front.visible = false;
      }

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

          v.capRingSpin[k] += (v.capRingSpinSpeed[k] ?? 0.25) * dt;

          // Owner-tinted overlay. The brushstroke artwork is already light
          // blue, so pal.ring (a saturated owner hue) reads cleanly when
          // multiplied. The tendril artwork is a darker teal, so we darken
          // the owner ring colour slightly so its tendril stays as a
          // contrast accent rather than washing out against the body.
          const style = v.ringStyle[k] ?? 'brushstroke';
          const jitterSeed = p.id * 73 + k * 19;
          const tint =
            style === 'spiky'
              ? adjustColor(hueJitter(pal.ring, jitterSeed, 0.18), 0.55)
              : hueJitter(pal.ring, jitterSeed, 0.18);

          if (k < v.ringOverlays.length) {
            updateRingOverlay(
              v.ringOverlays[k],
              style,
              effRadius,
              rMid,
              tint,
              v.capRingTilt[k] ?? 0.6,
              v.capRingYaw[k] ?? 0,
              v.capRingSpin[k] ?? 0,
            );
          }

          drawFillBeads(
            v.ringBeadsBack,
            v.ringBeadsFront,
            rMid,
            RING_WIDTH,
            progress,
            pal.glow,
            p.id * 13 + k,
            this.time,
            v.capRingSpin[k] ?? 0,
            Math.sin(v.capRingTilt[k] ?? 0.6),
            Math.cos(v.capRingTilt[k] ?? 0.6),
            Math.cos(v.capRingYaw[k] ?? 0),
            Math.sin(v.capRingYaw[k] ?? 0),
          );
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

      // Production detection: a sub-unit accumulator wrap means the sim just
      // spawned a ship this frame. Fire a production pulse even when the
      // visual orbiter cap is already saturated so bigger planets still read
      // as actively "pumping out" units, which was the missing feedback the
      // player lost once garrison climbed past the atom-ring population.
      if (p.owner !== null && p.productionAcc < v.lastProductionAcc - 0.05) {
        v.productionPulses.push({ age: 0, angle: Math.random() * Math.PI * 2 });
      }
      v.lastProductionAcc = p.owner === null ? 0 : p.productionAcc;

      // Orbiters: represent garrison (up to cap) as atom-symbol electrons.
      if (p.owner !== null) {
        this.syncOrbiters(v, Math.min(p.garrison, orbiterCapFor(p.maxUnitCapacity)), p.owner);
        this.tickOrbiters(v, dt);
        this.drawAtomPaths(v, pal.ring);
      } else {
        if (v.orbiters.length > 0) this.clearOrbiters(v);
        v.atomPaths.clear();
        v.productionPulses.length = 0;
      }

      this.drawProductionPulses(v, dt, effRadius, pal);
    }
  }

  /**
   * Update and render any in-flight production pulses on this planet. Each
   * pulse is a short-lived ring + spark at a random angle on the planet's
   * surface; it fades as its age approaches PRODUCTION_PULSE_DURATION. Drawn
   * on top of the body so it reads cleanly against any texture.
   */
  private drawProductionPulses(
    v: PlanetView,
    dt: number,
    effRadius: number,
    pal: import('../../util/color.js').PlayerPalette,
  ): void {
    const g = v.productionFx;
    g.clear();
    if (v.productionPulses.length === 0) return;
    // Cap history so a long match can't leak pulses; 16 concurrent is plenty
    // given how short each one lives.
    if (v.productionPulses.length > 16) v.productionPulses.splice(0, v.productionPulses.length - 16);
    for (let i = v.productionPulses.length - 1; i >= 0; i--) {
      const pulse = v.productionPulses[i];
      pulse.age += dt;
      const t = pulse.age / PRODUCTION_PULSE_DURATION;
      if (t >= 1) {
        v.productionPulses.splice(i, 1);
        continue;
      }
      const ease = t * t;
      // Expanding arc just outside the planet surface.
      const r = effRadius * (1 + 0.2 * ease);
      const sweep = Math.PI * 0.55;
      const start = pulse.angle - sweep / 2;
      const end = pulse.angle + sweep / 2;
      g.arc(0, 0, r, start, end).stroke({
        width: Math.max(1.2, effRadius * 0.06) * (1 - t),
        color: pal.glow,
        alpha: 0.65 * (1 - t),
      });
      // Bright spark at the emission point on the surface.
      const sx = Math.cos(pulse.angle) * effRadius;
      const sy = Math.sin(pulse.angle) * effRadius;
      g.circle(sx, sy, Math.max(1.5, effRadius * 0.08) * (1 - t * 0.5)).fill({
        color: pal.ring,
        alpha: 0.9 * (1 - t),
      });
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
      // Start at zero scale and right at the planet center. tickOrbiters
      // ramps scale + position out during the birth window so newly-produced
      // units visibly emerge *from* the planet rather than materialize in orbit.
      sprite.scale.set(0);
      sprite.tint = shipTint;
      const birthAngle = Math.random() * Math.PI * 2;
      sprite.x = 0;
      sprite.y = 0;
      glow.x = 0;
      glow.y = 0;
      glow.alpha = 0;
      v.orbitRoot.addChild(sprite);

      v.orbiters.push({
        sprite,
        glow,
        glowScale,
        ringIdx: 0,
        phase: Math.random() * Math.PI * 2,
        wanderPhase: Math.random() * Math.PI * 2,
        slotPhase: Math.random() * Math.PI * 2,
        birthAge: 0,
        birthAngle,
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
      o.birthAge += dt;
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

      // Birth emergence: during the first ORBITER_BIRTH_DURATION seconds the
      // orbiter's ring-ease is overridden by a direct center→surface→ring
      // trajectory so the player reads the unit being *ejected* from the
      // planet instead of popping into its ring slot.
      const bp = Math.min(1, o.birthAge / ORBITER_BIRTH_DURATION);
      if (bp < 1) {
        const eased = smoothstep(bp);
        // First half: center → planet surface along the birth angle.
        // Second half: surface → assigned ring slot.
        const surfaceR = v.baseRadius * 0.95;
        const sx = Math.cos(o.birthAngle) * surfaceR;
        const sy = Math.sin(o.birthAngle) * surfaceR;
        let bx: number;
        let by: number;
        if (eased < 0.5) {
          const t = eased / 0.5;
          bx = sx * t;
          by = sy * t;
        } else {
          const t = (eased - 0.5) / 0.5;
          bx = sx + (tx - sx) * t;
          by = sy + (ty - sy) * t;
        }
        o.sprite.x = bx;
        o.sprite.y = by;
        const birthScale = 0.36 * eased;
        o.sprite.scale.set(birthScale);
      } else {
        o.sprite.x += (tx - o.sprite.x) * ease;
        o.sprite.y += (ty - o.sprite.y) * ease;
        o.sprite.scale.set(0.36);
      }

      const a = 0.7 + 0.3 * Math.sin(this.time * 2.2 + o.phase);
      o.sprite.alpha = a * (bp < 1 ? bp : 1);

      // Glow follows the sprite; its own twinkle runs at a different phase so
      // the halo pulsing doesn't lock to the dot flicker, which keeps dense
      // clusters from reading as a single solid blob. Glow also ramps up
      // during birth so a freshly spawned unit doesn't flash a full-strength
      // halo at t=0.
      o.glow.x = o.sprite.x;
      o.glow.y = o.sprite.y;
      const glowFlicker = 0.65 + 0.35 * Math.sin(this.time * 3.1 + o.phase * 1.7);
      o.glow.alpha = 0.55 * glowFlicker * (bp < 1 ? bp : 1);
      o.glow.scale.set(o.glowScale * (bp < 1 ? 0.4 + 0.6 * bp : 1));
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
 * Allocate one painted-overlay sprite pair for a single ring slot. The pair
 * shares the same texture lifted off the reference sticker by planetAssets;
 * the back sprite is parented under `ringsBack` (drawn before the body),
 * the front sprite under `ringsFront` (drawn after). Both stay invisible
 * until `updateRingOverlay` reveals them when the planet has at least
 * `k+1` ring slots active.
 *
 * Each pair gets a deterministic 50% horizontal flip baked at construction
 * so two same-style ring slots on the same planet (or different planets
 * that happened to land on the same archetype) don't all face the same
 * direction.
 */
const buildRingOverlay = (
  style: RingOverlayStyle,
  seed: number,
  ringsBack: Container,
  ringsFront: Container,
): RingOverlay => {
  const overlay = planetAssetsReady() ? getRingOverlay(style) : null;
  const tex = overlay?.texture;
  const back = new Sprite(tex ?? undefined);
  const front = new Sprite(tex ?? undefined);
  // Anchor the body centre of the source artwork at the sprite origin so
  // scaling around (0, 0) keeps the painted body footprint locked to the
  // planet centre. Falls back to (0.5, 0.5) if the overlay isn't ready yet
  // (the sprite stays invisible in that case anyway).
  if (overlay) {
    back.anchor.set(overlay.bodyCx / tex!.width, overlay.bodyCy / tex!.height);
    front.anchor.set(overlay.bodyCx / tex!.width, overlay.bodyCy / tex!.height);
  } else {
    back.anchor.set(0.5);
    front.anchor.set(0.5);
  }
  back.visible = false;
  front.visible = false;
  ringsBack.addChild(back);
  ringsFront.addChild(front);
  return {
    back,
    front,
    flip: seeded(seed * 31 + 7) < 0.5 ? -1 : 1,
  };
};

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
 * Project a parameter angle θ around a tilted ring of radius `r` into screen
 * space. `sin(tilt)` foreshortens the ellipse's vertical axis; `yaw` rotates
 * the resulting ellipse around the planet centre. Returns a depth coordinate
 * so callers can split drawing into back/front halves and produce the
 * orbit-around-planet 3D illusion.
 */
const projectRing = (
  theta: number,
  r: number,
  sinT: number,
  cosT: number,
  cosY: number,
  sinY: number,
): { x: number; y: number; depth: number } => {
  const lx = Math.cos(theta) * r;
  const ly = Math.sin(theta) * r;
  const tx = lx;
  const ty = ly * sinT;
  const tz = ly * cosT;
  const rx = tx * cosY - ty * sinY;
  const ry = tx * sinY + ty * cosY;
  return { x: rx, y: ry, depth: tz };
};

const FILL_START = -Math.PI / 2;

/**
 * Draw a glowing leading-edge arc along the filled portion of the ring.
 * Shared between both ring styles so progress always reads at a glance.
 */
const drawFillBeads = (
  back: import('pixi.js').Graphics,
  front: import('pixi.js').Graphics,
  rMid: number,
  ringWidth: number,
  progress: number,
  glowColor: number,
  seed: number,
  time: number,
  spin: number,
  sinT: number,
  cosT: number,
  cosY: number,
  sinY: number,
): void => {
  if (progress <= 0.01) return;
  const sweep = Math.PI * 2 * progress;
  const beadCount = Math.max(8, Math.floor(34 * progress));
  const rimPulse = 0.65 + 0.25 * Math.sin(time * 2.2 + seed * 0.7);
  for (let i = 0; i <= beadCount; i++) {
    const t = i / beadCount;
    const a = FILL_START + sweep * t + spin;
    const p = projectRing(a, rMid, sinT, cosT, cosY, sinY);
    const target = p.depth >= 0 ? front : back;
    target
      .circle(p.x, p.y, Math.max(1.2, ringWidth * 0.09))
      .fill({ color: 0xffffff, alpha: 0.55 * rimPulse * progress });
    target
      .circle(p.x, p.y, Math.max(2.4, ringWidth * 0.18))
      .fill({ color: glowColor, alpha: 0.22 * progress });
  }
};

/**
 * Position, scale, rotate and tint the painted overlay sprite pair for one
 * ring slot. Both back/front sprites share identical transforms — having
 * the same artwork parented under both layers ensures the overlay survives
 * regardless of whether the body lands above or below it in the local Z
 * order. The `effRadius`/`rMid` ratio determines how far outward (relative
 * to the planet body) the painted ring rests; for stacked ring slots
 * (`k > 0`) `rMid` is larger so the overlay scales up and the painted ring
 * sits further out, matching the gameplay-defined ring spacing.
 */
const updateRingOverlay = (
  overlay: RingOverlay,
  style: RingOverlayStyle,
  effRadius: number,
  rMid: number,
  tint: number,
  tilt: number,
  yaw: number,
  spin: number,
): void => {
  if (!planetAssetsReady()) {
    overlay.back.visible = false;
    overlay.front.visible = false;
    return;
  }
  const info = getRingOverlay(style);
  // Refresh texture/anchor on first reveal — buildRingOverlay may have run
  // before assets finished loading, in which case the sprites were created
  // with a placeholder texture.
  if (overlay.back.texture !== info.texture) {
    overlay.back.texture = info.texture;
    overlay.front.texture = info.texture;
    overlay.back.anchor.set(info.bodyCx / info.texture.width, info.bodyCy / info.texture.height);
    overlay.front.anchor.set(info.bodyCx / info.texture.width, info.bodyCy / info.texture.height);
  }

  // Scale so the body cut-out region in the source matches the planet's
  // current effective radius. With this scale the painted ring naturally
  // lands at its source-art radius from the body centre, then we expand by
  // `rMid / effRadius` to push the painted ring outward proportionally to
  // the gameplay-defined ring radius for this slot — ring slot 1 sits
  // wider than slot 0, slot 2 wider still.
  const baseScale = (2 * effRadius) / info.bodyDiameter;
  const radialScale = rMid / Math.max(1, effRadius);
  const scale = baseScale * radialScale;
  // Tilt is a mild vertical squash so the ring reads as a flattened orbit
  // rather than a perfect circle. Subtle — the painted artwork already
  // has its own perspective baked in, so we don't squash too aggressively.
  const verticalSquash = 0.78 + 0.18 * Math.cos(tilt);

  for (const sprite of [overlay.back, overlay.front]) {
    sprite.visible = true;
    sprite.tint = tint;
    sprite.rotation = yaw + spin;
    sprite.scale.set(scale * overlay.flip, scale * verticalSquash);
    sprite.x = 0;
    sprite.y = 0;
  }
};
