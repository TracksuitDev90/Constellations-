import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { adjustColor, hueJitter, paletteFor, toward } from '../../util/color.js';
import { ringCapacity, type PlanetType } from '../sim/Planet.js';
import type { World } from '../sim/World.js';
import {
  archetypeForSeed,
  bakedBodyDiameter,
  makePlanetBodyTexture,
  makePlanetHaloTexture,
  makeShipGlowTexture,
  makeShipTexture,
} from './textures.js';
import { hasBakedSource } from './planetAssets.js';

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
/**
 * Seconds between heavy Graphics rebuilds (capacity rings, atom paths).
 * Rebuilding Pixi Graphics is the single most expensive per-frame CPU cost
 * on phones, and the content it draws animates slowly (ring spins are
 * 0.2–0.5 rad/s) — a ~12 Hz cadence is visually indistinguishable from 60.
 * Pulses (capture/evolve) force an immediate redraw so fast FX stay smooth.
 */
const FX_REDRAW_INTERVAL = 1 / 12;
/** Max pooled (hidden) orbiter sprites retained per planet. */
const ORBITER_POOL_MAX = 64;
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
const computeBodyBaseScale = (radius: number, planetId: number): number => {
  // Procedural fallback bodies are already drawn at the world radius.
  if (!hasBakedSource(archetypeForSeed(planetId))) return 1;
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

interface PlanetView {
  planetId: number;
  container: Container;
  halo: Sprite;
  body: Sprite;
  ring: Graphics;
  /**
   * Capacity-ring strokes split across two Graphics so the rear half of each
   * tilted ring draws before the body sprite (occluded behind the world) and
   * the front half draws after, giving each ring a 3D orbit silhouette. The
   * leading-edge fill beads share the same Graphics so progress reads at the
   * same depth as the painted stroke.
   */
  ringsBack: Graphics;
  ringsFront: Graphics;
  atomPaths: Graphics; // faint orbit ellipses that the electrons follow
  shockwave: Graphics;
  /**
   * Hull-integrity bar beneath the planet. Shows `health / maxHealth` as
   * discrete HP pips — the pool attackers chip through once the garrison is
   * gone, i.e. the actual "how close is this world to falling" number.
   */
  healthBar: Graphics;
  /** Eased health fill (0..1) so the pips drain smoothly, not in snaps. */
  easedHealth: number;
  /** Last observed hull HP — a drop triggers the damage flash. */
  lastHealth: number;
  /** 1→0 red flash after a hull hit; makes incoming damage unmissable. */
  damageFlash: number;
  orbitRoot: Container;
  orbiters: Orbiter[];
  /** Hidden, reusable orbiter sprites — avoids destroy/create churn in combat. */
  orbiterPool: Orbiter[];
  /** Accumulator gating the ~12 Hz heavy Graphics rebuild cadence. */
  fxRedrawAcc: number;
  /** Last health fill actually drawn — lets static bars skip redraw. */
  lastDrawnHealth: number;
  lastDrawnBarOwner: number | null;
  /**
   * Victory-cascade state: `celebrateDelay` counts down to this planet's
   * turn in the winner's shockwave chain; `celebratePulse` then decays 1→0
   * while an expanding ring renders. Renderer-driven (the sim is frozen at
   * game over, so it can't reuse the sim's evolvePulse).
   */
  celebrateDelay: number;
  celebratePulse: number;
  /**
   * "n/cap" readout for the current ring while the planet is the player's
   * and has rings — makes the upgrade economy legible (Auralux always
   * tells you how far a level-up is). Lazily created on first use.
   */
  costLabel: Text | null;
  lastCostText: string;
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
}

export class PlanetLayer extends Container {
  private app: Application;
  private world: World;
  private views: PlanetView[] = [];
  private selectedSources = new Set<number>();
  private shipTex: Texture;
  private shipGlowTex: Texture;
  private time = 0;
  /** Ambient-music breathing (0..1), fed by Game each frame via setBeat. */
  private beat = 0;

  constructor(app: Application, world: World) {
    super();
    this.app = app;
    this.world = world;
    this.shipTex = makeShipTexture(app);
    this.shipGlowTex = makeShipGlowTexture(app);

    // Archetype → planet assignment happens in Game.startMatch (before the
    // per-match texture subset is loaded), so by the time this constructor
    // bakes body textures every assignment is already in place.

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
      const ringsBack = new Graphics();
      const ringsFront = new Graphics();
      const atomPaths = new Graphics();
      const shockwave = new Graphics();
      const healthBar = new Graphics();
      const productionFx = new Graphics();

      const orbitRoot = new Container();

      // Z-order — `ringsBack` draws before the body so the rear half of each
      // tilted capacity ring is occluded by the world; `ringsFront` draws
      // after so the near half crosses over the body, selling 3D depth.
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
        healthBar,
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
        (seeded(tiltSeed + k * 31 + 9) < 0.5 ? -1 : 1);
      this.views.push({
        planetId: planet.id,
        container,
        halo,
        body,
        ring,
        ringsBack,
        ringsFront,
        atomPaths,
        shockwave,
        healthBar,
        easedHealth: 1,
        lastHealth: planet.health,
        damageFlash: 0,
        orbitRoot,
        orbiters: [],
        orbiterPool: [],
        // Random phase offset so all planets don't rebuild Graphics on the
        // same frame — spreads the 12 Hz cost across the cadence window.
        fxRedrawAcc: Math.random() * FX_REDRAW_INTERVAL,
        lastDrawnHealth: -1,
        lastDrawnBarOwner: null,
        celebrateDelay: 0,
        celebratePulse: 0,
        costLabel: null,
        lastCostText: '',
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
        bodyBaseScale: computeBodyBaseScale(planet.radius, planet.id),
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
      });
    }
  }

  setSelection(ids: Iterable<number>): void {
    this.selectedSources = new Set(ids);
  }

  /**
   * Ambient-music breathing (0..1), set once per frame by the Game so halo
   * and electron glows swell with the soundtrack — the Auralux trick that
   * makes the whole board feel alive.
   */
  setBeat(v: number): void {
    this.beat = v;
  }

  /**
   * Kick off the victory cascade: a staggered chain of shockwaves across
   * every planet the winner owns. Purely renderer-side, since the sim is
   * frozen once the match ends.
   */
  celebrate(owner: number): void {
    let k = 0;
    for (let i = 0; i < this.world.planets.length; i++) {
      if (this.world.planets[i].owner !== owner) continue;
      this.views[i].celebrateDelay = 0.12 + k * 0.22;
      k++;
    }
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
        v.bodyBaseScale = computeBodyBaseScale(p.radius, p.id);
        v.body.texture = makePlanetBodyTexture(this.app, p.owner, p.radius, p.id, p.type);
        v.halo.texture = makePlanetHaloTexture(this.app, p.owner, p.radius);
        v.displayScale = EVOLVE_POP_START;
      }

      // Owner change → halo re-tints. The body stays as the baked planet map
      // (ownership is communicated by the halo + rings + orbiters).
      if (p.owner !== v.lastOwner) {
        if (!hasBakedSource(archetypeForSeed(p.id))) {
          // Procedural fallback bodies are owner-tinted, so rebake on flip.
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
      // Halo breathes with the ambient music bed so the whole board swells
      // and settles together — subtle, but it ties sight to sound.
      v.halo.alpha = 0.82 + 0.18 * this.beat;

      // Effective radius rings / count / selection should space themselves off.
      const effRadius = v.baseRadius * v.displayScale * ringGrowth;

      const pal = paletteFor(p.owner);

      // Heavy Graphics rebuilds run on a ~12 Hz cadence; active FX (capture
      // flash, evolve pop, size ease) force per-frame redraws so the fast
      // animations don't stutter.
      const animating =
        p.capturePulse > 0.01 ||
        p.evolvePulse > 0.01 ||
        Math.abs(1 - v.displayScale) > 0.01;
      v.fxRedrawAcc += dt;
      const redrawHeavy = animating || v.fxRedrawAcc >= FX_REDRAW_INTERVAL;
      if (v.fxRedrawAcc >= FX_REDRAW_INTERVAL) v.fxRedrawAcc %= FX_REDRAW_INTERVAL;

      // Hull-integrity bar under the planet — one pip per HP. Garrison is
      // already legible from the orbiting swarm, so the bar tracks the thing
      // nothing else shows: how much hull an attacker still has to chew
      // through before the world goes neutral.
      this.drawHealthBar(v, p.health, p.maxHealth, effRadius, pal, p.owner, dt, animating);

      // Capacity rings: drawn procedurally as 3D-tilted brushstroke arcs,
      // split across `ringsBack` (rear half, behind the body) and
      // `ringsFront` (near half, over the body) so each ring reads as
      // orbiting around the world. Fill progress paints a coloured arc
      // along the leading edge with sparkle beads on top. Easing/spin state
      // advances every frame; only the (expensive) stroke rebuild is gated.
      const RING_WIDTH = Math.max(4, v.baseRadius * 0.35);
      const RING_GAP = Math.max(3, v.baseRadius * 0.12);
      const RING_INSET = Math.max(6, v.baseRadius * 0.22);

      if (p.ringCount > 0) {
        for (let k = 0; k < p.ringCount; k++) {
          const cap = ringCapacity(p.type, k);
          const fill = p.ringFillProgress[k] ?? 0;
          const target = cap > 0 ? Math.max(0, Math.min(1, fill / cap)) : 0;
          const prog = v.ringProgress[k] ?? 0;
          const eased = 1 - Math.exp(-dt * 4);
          v.ringProgress[k] = prog + (target - prog) * eased;
          v.capRingSpin[k] += (v.capRingSpinSpeed[k] ?? 0.25) * dt;
        }
        if (redrawHeavy) {
          v.ringsBack.clear();
          v.ringsFront.clear();
          for (let k = 0; k < p.ringCount; k++) {
            const rMid =
              effRadius +
              RING_INSET +
              RING_WIDTH / 2 +
              k * (RING_WIDTH + RING_GAP);

            const jitterSeed = p.id * 73 + k * 19;
            const baseColor = hueJitter(pal.ring, jitterSeed, 0.18);

            drawProceduralRing(
              v.ringsBack,
              v.ringsFront,
              rMid,
              RING_WIDTH,
              v.capRingTilt[k] ?? 0.6,
              v.capRingYaw[k] ?? 0,
              v.capRingSpin[k] ?? 0,
              baseColor,
              pal.glow,
              v.ringProgress[k] ?? 0,
              this.time,
              p.id * 13 + k,
            );
          }
        }
      } else if (redrawHeavy) {
        // Rings may have just cleared (evolve/capture) — wipe stale strokes.
        v.ringsBack.clear();
        v.ringsFront.clear();
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
      // Capture flash: a soft radial bloom that expands outward and fades
      // as `capturePulse` decays. Adds weight to the moment of ownership
      // change without needing extra event wiring — the sim already drives
      // capturePulse on capture, we just light it up here.
      if (p.capturePulse > 0.01) {
        const flashR = effRadius * (1 + (1 - p.capturePulse) * 1.6);
        v.shockwave
          .circle(0, 0, flashR)
          .fill({ color: pal.glow, alpha: p.capturePulse * 0.45 });
        v.shockwave
          .circle(0, 0, flashR * 0.6)
          .fill({ color: pal.ring, alpha: p.capturePulse * 0.25 });
      }
      // Victory cascade: renderer-driven shockwaves chained across the
      // winner's worlds (the sim is frozen at game over, so this can't ride
      // on the sim's evolvePulse).
      if (v.celebrateDelay > 0) {
        v.celebrateDelay -= dt;
        if (v.celebrateDelay <= 0) v.celebratePulse = 1;
      }
      if (v.celebratePulse > 0.01) {
        v.celebratePulse = Math.max(0, v.celebratePulse - dt * 0.7);
        const t = 1 - v.celebratePulse;
        const shockR = effRadius * (1.1 + t * 3.2);
        const alpha = v.celebratePulse * 0.8;
        v.shockwave
          .circle(0, 0, shockR)
          .stroke({ width: 3 + v.celebratePulse * 5, color: pal.glow, alpha });
        v.shockwave
          .circle(0, 0, shockR * 0.8)
          .stroke({ width: 2, color: 0xffffff, alpha: alpha * 0.5 });
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
      // Electron sprites move every frame (cheap transforms); the ghost
      // ellipse paths are Graphics and follow the 12 Hz rebuild cadence.
      if (p.owner !== null) {
        this.syncOrbiters(v, Math.min(p.garrison, orbiterCapFor(p.maxUnitCapacity)), p.owner);
        this.tickOrbiters(v, dt);
        if (redrawHeavy) this.drawAtomPaths(v, pal.ring);
      } else {
        if (v.orbiters.length > 0) this.clearOrbiters(v);
        v.atomPaths.clear();
        v.productionPulses.length = 0;
      }

      this.drawProductionPulses(v, dt, effRadius, pal);
      this.updateCostLabel(v, p, effRadius);
    }
  }

  /**
   * "n / cap" readout for the player's ringed planets — the upgrade economy
   * in plain numbers, so the cost of the next evolution is never a mystery.
   * Lazily creates the Text and only touches it when the string changes.
   */
  private updateCostLabel(
    v: PlanetView,
    p: import('../sim/Planet.js').Planet,
    effRadius: number,
  ): void {
    const show = p.owner === 0 && p.ringCount > 0;
    if (!show) {
      if (v.costLabel && v.costLabel.visible) v.costLabel.visible = false;
      return;
    }
    // Status of the first unfilled ring (rings fill in order).
    let fill = 0;
    let cap = 0;
    for (let k = 0; k < p.ringCount; k++) {
      cap = ringCapacity(p.type, k);
      fill = p.ringFillProgress[k] ?? 0;
      if (fill < cap) break;
    }
    const text = `${Math.min(fill, cap)} / ${cap}`;
    if (!v.costLabel) {
      const label = new Text({
        text,
        style: {
          fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: 12,
          fill: 0xdbe6f8,
        },
      });
      label.resolution = 2;
      label.anchor.set(0.5, 0);
      label.alpha = 0.8;
      v.container.addChild(label);
      v.costLabel = label;
      v.lastCostText = text;
    } else if (text !== v.lastCostText) {
      v.costLabel.text = text;
      v.lastCostText = text;
    }
    v.costLabel.visible = true;
    // Sits just below the health bar (bar bottom ≈ effRadius + height + 6).
    v.costLabel.x = 0;
    v.costLabel.y = effRadius + Math.max(3, effRadius * 0.1) + 12;
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
      // Explicit moveTo before the arc — without it Pixi connects the arc to
      // the previous path point (e.g. an earlier pulse's spark circle),
      // drawing a stray chord line across the planet.
      g.moveTo(Math.cos(start) * r, Math.sin(start) * r);
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
   * Render the hull-integrity bar beneath the planet: one pip per HP,
   * draining right-to-left as attackers chip the hull. Near-invisible while
   * the hull is intact (no noise on a peaceful board), it brightens and
   * shifts amber → red as damage lands, with a flash on each hit — so "this
   * planet is being broken" is readable at a glance from across the map.
   */
  private drawHealthBar(
    v: PlanetView,
    health: number,
    maxHealth: number,
    effRadius: number,
    pal: import('../../util/color.js').PlayerPalette,
    owner: number | null,
    dt: number,
    forceRedraw: boolean,
  ): void {
    const g = v.healthBar;
    if (owner === null || maxHealth <= 0) {
      v.easedHealth = 1;
      v.lastHealth = health;
      v.damageFlash = 0;
      if (v.lastDrawnHealth !== 0) {
        g.clear();
        v.lastDrawnHealth = 0;
        v.lastDrawnBarOwner = owner;
      }
      return;
    }

    // A hull hit landed since last frame — kick the red flash.
    if (health < v.lastHealth) v.damageFlash = 1;
    v.lastHealth = health;
    v.damageFlash = Math.max(0, v.damageFlash - dt * 2.2);

    const targetFill = Math.max(0, Math.min(1, health / maxHealth));
    const ease = 1 - Math.exp(-dt * 6);
    v.easedHealth += (targetFill - v.easedHealth) * ease;
    const fill = v.easedHealth;

    // Fully healed and no active flash → the bar is static; skip the rebuild.
    const settled =
      !forceRedraw &&
      owner === v.lastDrawnBarOwner &&
      v.damageFlash <= 0.001 &&
      Math.abs(fill - v.lastDrawnHealth) < 0.003;
    if (settled) return;
    v.lastDrawnHealth = fill;
    v.lastDrawnBarOwner = owner;
    g.clear();

    const width = Math.max(26, effRadius * 1.5);
    const height = Math.max(3, effRadius * 0.1);
    const y = effRadius + height + 6;
    const left = -width / 2;
    const gap = Math.max(1, height * 0.45);
    const segW = (width - gap * (maxHealth - 1)) / maxHealth;
    const segR = Math.min(height / 2, segW / 2);

    // Intact hull whispers; damaged hull shouts.
    const damaged = fill < 0.999;
    const baseAlpha = damaged ? 0.95 : 0.3;

    // Color runs owner-tint → amber → red as the hull fails.
    const barColor =
      fill > 0.6
        ? pal.ring
        : fill > 0.3
          ? toward(0xffaa33, pal.ring, (fill - 0.3) / 0.3)
          : toward(0xff4040, 0xffaa33, fill / 0.3);

    // Backdrop pill so the pips read against both starfield and halo.
    g.roundRect(left - 1.5, y - height / 2 - 1.5, width + 3, height + 3, segR + 1.5)
      .fill({ color: 0x000000, alpha: damaged ? 0.45 : 0.25 });

    const filledSegs = fill * maxHealth;
    for (let s = 0; s < maxHealth; s++) {
      const sx = left + s * (segW + gap);
      // Empty socket — a faint outline of the missing HP.
      g.roundRect(sx, y - height / 2, segW, height, segR)
        .fill({ color: pal.glow, alpha: damaged ? 0.16 : 0.1 });
      const segFill = Math.max(0, Math.min(1, filledSegs - s));
      if (segFill <= 0.02) continue;
      // The draining pip shrinks within its socket for a smooth bleed-out.
      g.roundRect(sx, y - height / 2, segW * segFill, height, Math.min(segR, (segW * segFill) / 2))
        .fill({ color: barColor, alpha: baseAlpha });
      if (damaged) {
        g.roundRect(
          sx + 0.5,
          y - height / 2 + 0.5,
          Math.max(0, segW * segFill - 1),
          Math.max(0.8, height * 0.35),
          segR,
        ).fill({ color: 0xffffff, alpha: 0.3 });
      }
    }

    // Damage flash: a red-hot stroke that blooms on the hit and fades out.
    if (v.damageFlash > 0.01) {
      const f = v.damageFlash;
      g.roundRect(left - 2.5, y - height / 2 - 2.5, width + 5, height + 5, segR + 2.5)
        .stroke({ width: 1.5 + f * 1.5, color: 0xff5544, alpha: 0.85 * f });
    }
  }

  private syncOrbiters(v: PlanetView, target: number, owner: number): void {
    const shipTint = paletteFor(owner).ship;

    for (const o of v.orbiters) {
      o.sprite.tint = shipTint;
      o.glow.tint = shipTint;
    }

    while (v.orbiters.length < target) {
      // Reuse a pooled orbiter when available — garrisons oscillate every
      // few seconds in combat, and destroy/create sprite churn was a
      // measurable GC + scene-graph cost on phones.
      const pooled = v.orbiterPool.pop();
      if (pooled) {
        pooled.sprite.visible = true;
        pooled.glow.visible = true;
        pooled.sprite.tint = shipTint;
        pooled.glow.tint = shipTint;
        pooled.sprite.scale.set(0);
        pooled.sprite.x = 0;
        pooled.sprite.y = 0;
        pooled.glow.x = 0;
        pooled.glow.y = 0;
        pooled.glow.alpha = 0;
        pooled.birthAge = 0;
        pooled.birthAngle = Math.random() * Math.PI * 2;
        pooled.phase = Math.random() * Math.PI * 2;
        pooled.wanderPhase = Math.random() * Math.PI * 2;
        pooled.slotPhase = Math.random() * Math.PI * 2;
        v.orbiters.push(pooled);
        continue;
      }

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
      this.retireOrbiter(v, v.orbiters.pop()!);
    }
  }

  /** Hide an orbiter into the per-planet pool, or destroy past the cap. */
  private retireOrbiter(v: PlanetView, o: Orbiter): void {
    if (v.orbiterPool.length < ORBITER_POOL_MAX) {
      o.sprite.visible = false;
      o.glow.visible = false;
      v.orbiterPool.push(o);
      return;
    }
    v.orbitRoot.removeChild(o.sprite);
    v.orbitRoot.removeChild(o.glow);
    o.sprite.destroy();
    o.glow.destroy();
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
      const breathe = 0.88 + 0.24 * this.beat;
      o.glow.alpha = 0.55 * glowFlicker * breathe * (bp < 1 ? bp : 1);
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
    for (const o of v.orbiters) this.retireOrbiter(v, o);
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
/** Number of segments around each ring; high enough that the painterly
 * jitter reads as continuous brushstroke rather than discrete dashes. */
const RING_SEGMENTS = 72;

/**
 * Draw one capacity ring as a 3D-tilted painterly stroke split between
 * `back` (rear half, behind body) and `front` (near half, over body) so
 * the result reads as orbiting around the planet. Layered passes — dark
 * underglow, jittered body stroke, lit highlight, then the filled-arc
 * progress pass with bead sparkle — give the rim a brushstroke look that
 * matches the painted planet textures rather than a clean geometric arc.
 */
const drawProceduralRing = (
  back: import('pixi.js').Graphics,
  front: import('pixi.js').Graphics,
  rMid: number,
  ringWidth: number,
  tilt: number,
  yaw: number,
  spin: number,
  baseColor: number,
  fillColor: number,
  progress: number,
  time: number,
  seed: number,
): void => {
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // `adjustColor` multiplies channels, so darken with a 0..1 factor and
  // lighten by blending toward white — the old `-0.4` / `0.45` calls
  // produced a pure-black underglow and a *darker* "highlight".
  const underColor = adjustColor(baseColor, 0.6);
  const hiColor = toward(baseColor, 0xffffff, 0.45);

  // Pre-sample each segment's screen position + depth + per-segment radial
  // jitter so all four passes hit the exact same painterly silhouette.
  const points: Array<{ x: number; y: number; depth: number; theta: number }> = [];
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const theta = (i / RING_SEGMENTS) * Math.PI * 2 + spin;
    const jitter = (seeded(seed * 257 + i) - 0.5) * ringWidth * 0.3;
    const r = rMid + jitter;
    const p = projectRing(theta, r, sinT, cosT, cosY, sinY);
    points.push({ x: p.x, y: p.y, depth: p.depth, theta });
  }

  // Polyline pass: walk consecutive segments, swap targets when depth flips
  // sign so the rear half lands on `back` and the near half on `front`.
  // Each contiguous run on a single layer is stroked as one polyline.
  const drawPass = (
    width: number,
    color: number,
    alpha: number,
    onlyFront: boolean,
  ): void => {
    let target: import('pixi.js').Graphics | null = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const segFront = (a.depth + b.depth) >= 0;
      if (onlyFront && !segFront) {
        if (target) target.stroke({ width, color, alpha });
        target = null;
        continue;
      }
      const layer = segFront ? front : back;
      if (layer !== target) {
        if (target) target.stroke({ width, color, alpha });
        target = layer;
        target.moveTo(a.x, a.y);
      }
      target.lineTo(b.x, b.y);
    }
    if (target) target.stroke({ width, color, alpha });
  };

  // Empty-track passes are deliberately dim: the unfilled ring should read
  // as a hollow "socket" waiting for investment, so the coloured fill arc
  // below carries all the visual weight of absorb progress.
  // Pass 1: dark underline behind the body stroke — gives the ring weight.
  drawPass(ringWidth * 1.1, underColor, 0.14, false);
  // Pass 2: main body stroke at base color, the brushy silhouette.
  drawPass(ringWidth, baseColor, 0.28, false);
  // Pass 3: lit highlight, only on the near half — gives the ring the
  // "sun-lit upper rim" look that sells the 3D tilt without any shader.
  drawPass(ringWidth * 0.35, hiColor, 0.3, true);

  // Pass 4: the fill — paint the absorbed fraction of the ring at FULL ring
  // width in the owner's glow colour, so the ring literally "fills in" as
  // units are fed to the planet. A brighter core stroke and a white-hot bead
  // at the leading edge make the growth front unmistakable.
  if (progress > 0.01) {
    const sweep = Math.PI * 2 * progress;
    const fillSegs = Math.max(6, Math.floor(RING_SEGMENTS * progress));
    const coreColor = toward(fillColor, 0xffffff, 0.4);
    const strokeFill = (layer: import('pixi.js').Graphics): void => {
      layer.stroke({ width: ringWidth * 1.05, color: fillColor, alpha: 0.9 });
    };
    let target: import('pixi.js').Graphics | null = null;
    // Track the runs so the bright core pass can retrace the same geometry.
    const runs: Array<{ layer: import('pixi.js').Graphics; pts: Array<{ x: number; y: number }> }> = [];
    for (let i = 0; i <= fillSegs; i++) {
      const t = i / fillSegs;
      const theta = FILL_START + sweep * t + spin;
      const p = projectRing(theta, rMid, sinT, cosT, cosY, sinY);
      const layer = p.depth >= 0 ? front : back;
      if (layer !== target) {
        if (target) strokeFill(target);
        target = layer;
        target.moveTo(p.x, p.y);
        runs.push({ layer, pts: [{ x: p.x, y: p.y }] });
      } else {
        target.lineTo(p.x, p.y);
        runs[runs.length - 1].pts.push({ x: p.x, y: p.y });
      }
    }
    if (target) strokeFill(target);

    // Bright core retrace — a hot centre line inside the painted fill that
    // pulses softly, keeping the filled arc luminous rather than flat.
    const corePulse = 0.55 + 0.2 * Math.sin(time * 1.8 + seed * 0.9);
    for (const run of runs) {
      if (run.pts.length < 2) continue;
      run.layer.moveTo(run.pts[0].x, run.pts[0].y);
      for (let i = 1; i < run.pts.length; i++) run.layer.lineTo(run.pts[i].x, run.pts[i].y);
      run.layer.stroke({ width: ringWidth * 0.4, color: coreColor, alpha: corePulse });
    }

    // Leading-edge tip: a white-hot bead with a glow halo marking exactly
    // where the fill front sits — the "write head" of the progress arc.
    const tipTheta = FILL_START + sweep + spin;
    const tip = projectRing(tipTheta, rMid, sinT, cosT, cosY, sinY);
    const tipLayer = tip.depth >= 0 ? front : back;
    const tipPulse = 0.7 + 0.3 * Math.sin(time * 3.4 + seed);
    tipLayer
      .circle(tip.x, tip.y, Math.max(3, ringWidth * 0.5) * tipPulse)
      .fill({ color: fillColor, alpha: 0.45 });
    tipLayer
      .circle(tip.x, tip.y, Math.max(1.6, ringWidth * 0.22))
      .fill({ color: 0xffffff, alpha: 0.9 });

    // Sparse bead sparkle along the filled arc for texture.
    const beadCount = Math.max(5, Math.floor(20 * progress));
    const rimPulse = 0.65 + 0.25 * Math.sin(time * 2.2 + seed * 0.7);
    for (let i = 0; i <= beadCount; i++) {
      const t = i / beadCount;
      const a = FILL_START + sweep * t + spin;
      const p = projectRing(a, rMid, sinT, cosT, cosY, sinY);
      const layer = p.depth >= 0 ? front : back;
      layer
        .circle(p.x, p.y, Math.max(1.2, ringWidth * 0.09))
        .fill({ color: 0xffffff, alpha: 0.45 * rimPulse });
    }
  }
};
