import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { World, AsteroidField, BlackHole } from '../sim/World.js';
import {
  BH_TEXTURE_HORIZON,
  makeAccretionDiskTexture,
  makeEngineFlareTexture,
  makeHostileShipTexture,
  makeLensHaloTexture,
  makeShipGlowTexture,
} from './textures.js';

/**
 * Visualizes per-match hazards: asteroid drag zones (translucent disc with
 * drifting rocky particles), black holes (lensing halo, accretion disk,
 * photon ring, infalling matter), and neutral green hostile ships. Lives
 * between the ship layer and planet layer so asteroid debris reads behind
 * ships, while neutral combatants render on top so the player can spot them
 * against busy traffic.
 */

interface AsteroidVisual {
  /** Background tint disc that signals the slow-zone footprint. */
  zone: Graphics;
  /** Per-rock sprite list, animated each frame for a slow drift. */
  rocks: Array<{
    sprite: Graphics;
    /** Base position relative to field center, in world units. */
    x: number;
    y: number;
    /** Per-rock orbital angular speed (rad/s). */
    omega: number;
    /** Per-rock distance from field center for the slow swirl. */
    r: number;
    /** Per-rock starting angle for swirl. */
    theta: number;
    /** Per-rock visual scale jitter. */
    scale: number;
  }>;
}

interface NeutralVisual {
  hull: Sprite;
  glow: Sprite;
  engine: Sprite;
  active: boolean;
}

interface InfallParticle {
  dot: Graphics;
  r: number;
  theta: number;
}

interface BlackHoleVisual {
  hole: BlackHole;
  disk: Sprite;
  photonRing: Graphics;
  particles: InfallParticle[];
}

const NEUTRAL_GLOW = 0x2f8a1d; // Green is reserved for the swarm — no player palette uses it.

const ROCK_DENSITY = 1 / 1800; // rocks per square pixel of zone area.
const ROCK_MAX = 60;

const seeded = (seed: number): (() => number) => {
  let a = seed | 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class HazardLayer extends Container {
  private world: World;
  private hullTex: Texture;
  private glowTex: Texture;
  private engineTex: Texture;
  private asteroidVisuals: AsteroidVisual[] = [];
  private neutralVisuals: NeutralVisual[] = [];
  private blackHoleVisuals: BlackHoleVisual[] = [];
  private neutralRoot: Container;
  private asteroidRoot: Container;
  private blackHoleRoot: Container;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.world = world;
    this.hullTex = makeHostileShipTexture(app);
    this.glowTex = makeShipGlowTexture(app);
    this.engineTex = makeEngineFlareTexture(app);
    this.asteroidRoot = new Container();
    this.blackHoleRoot = new Container();
    this.neutralRoot = new Container();
    this.addChild(this.asteroidRoot);
    this.addChild(this.blackHoleRoot);
    this.addChild(this.neutralRoot);

    for (const f of world.asteroidFields) {
      this.asteroidRoot.addChild(this.buildAsteroidVisual(f));
    }
    for (const bh of world.blackHoles) {
      this.blackHoleRoot.addChild(this.buildBlackHoleVisual(app, bh));
    }
  }

  /**
   * A black hole, built bottom-up from cheap baked sprites and Graphics —
   * no shaders: dotted gravity boundary (the danger telegraph, matching the
   * asteroid-field convention), additive lensing halo (starlight bunched
   * around the shadow), spinning squashed accretion disk with a lensed
   * vertical arc hinting at the far side, a flat black event horizon, a
   * brilliant photon ring, and a slow rain of infalling debris.
   */
  private buildBlackHoleVisual(app: Application, hole: BlackHole): Container {
    const root = new Container();
    root.x = hole.pos.x;
    root.y = hole.pos.y;
    const H = hole.horizonRadius;
    const texScale = H / BH_TEXTURE_HORIZON;

    // 1. Gravity boundary — dashed circle, cool gray-violet.
    const boundary = new Graphics();
    const segs = 90;
    for (let i = 0; i < segs; i++) {
      if (i % 2 === 0) continue;
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      boundary
        .arc(0, 0, hole.gravityRadius, a0, a1)
        .stroke({ width: 1.5, color: 0x8a7ad0, alpha: 0.28 });
    }
    root.addChild(boundary);

    // 2. Lensing halo.
    const lens = new Sprite(makeLensHaloTexture(app));
    lens.anchor.set(0.5);
    lens.scale.set(texScale);
    lens.blendMode = 'add';
    lens.alpha = 0.85;
    root.addChild(lens);

    // 3. Lensed far side of the disk — faint vertical arc over/under the shadow.
    const lensedArc = new Graphics();
    lensedArc
      .ellipse(0, 0, H * 1.3, H * 2.1)
      .stroke({ width: 1.4, color: 0xffe8c4, alpha: 0.22 });
    lensedArc.blendMode = 'add';
    root.addChild(lensedArc);

    // 4. Accretion disk, squashed and spinning.
    const disk = new Sprite(makeAccretionDiskTexture(app, hole.seed));
    disk.anchor.set(0.5);
    disk.scale.set(texScale, texScale * 0.45);
    disk.blendMode = 'add';
    root.addChild(disk);

    // 5. Event horizon — pure black, on top of the disk.
    const core = new Graphics();
    core.circle(0, 0, H).fill({ color: 0x000000, alpha: 1 });
    root.addChild(core);

    // 6. Photon ring hugging the shadow.
    const photonRing = new Graphics();
    photonRing.circle(0, 0, H * 1.15).stroke({ width: 2, color: 0xfff6e0, alpha: 0.9 });
    photonRing.blendMode = 'add';
    root.addChild(photonRing);

    // 7. Infalling debris — seeded dots on decaying polar paths.
    const rng = seeded(hole.seed);
    const particles: InfallParticle[] = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const dot = new Graphics();
      dot.circle(0, 0, 0.8 + rng() * 1.1).fill({ color: 0xffd9a0, alpha: 1 });
      dot.blendMode = 'add';
      root.addChild(dot);
      particles.push({
        dot,
        r: hole.captureRadius + rng() * (hole.gravityRadius * 0.85 - hole.captureRadius),
        theta: rng() * Math.PI * 2,
      });
    }

    this.blackHoleVisuals.push({ hole, disk, photonRing, particles });
    return root;
  }

  private buildAsteroidVisual(field: AsteroidField): Container {
    const root = new Container();
    root.x = field.pos.x;
    root.y = field.pos.y;

    // Soft outer halo so the field reads as a hazard zone even when no rocks
    // sit at the border. Layered alpha rings give a vignette without a shader.
    const zone = new Graphics();
    for (let i = 6; i > 0; i--) {
      const t = i / 6;
      const rr = field.radius * (0.55 + 0.45 * t);
      zone
        .circle(0, 0, rr)
        .fill({ color: 0x3a2c1a, alpha: 0.06 + 0.04 * (1 - t) });
    }
    // Crisp dotted boundary so the slow-zone edge is unambiguous.
    const ringSegments = 80;
    for (let i = 0; i < ringSegments; i++) {
      if (i % 2 === 0) continue;
      const a0 = (i / ringSegments) * Math.PI * 2;
      const a1 = ((i + 1) / ringSegments) * Math.PI * 2;
      zone
        .arc(0, 0, field.radius, a0, a1)
        .stroke({ width: 2, color: 0xb89a6c, alpha: 0.45 });
    }
    root.addChild(zone);

    // Particle rocks: small dark polygons with a hint of warm tint. Each rock
    // gets a tiny per-frame swirl so the field looks alive without the cost
    // of a full physics pass.
    const area = Math.PI * field.radius * field.radius;
    const count = Math.min(ROCK_MAX, Math.max(8, Math.round(area * ROCK_DENSITY)));
    const rng = seeded(field.seed);
    const visual: AsteroidVisual = { zone, rocks: [] };
    for (let i = 0; i < count; i++) {
      const r = field.radius * Math.sqrt(rng()) * 0.95;
      const theta = rng() * Math.PI * 2;
      const sprite = new Graphics();
      const size = 2 + rng() * 4;
      const sides = 5 + Math.floor(rng() * 3);
      sprite.poly(
        Array.from({ length: sides }, (_, k) => {
          const a = (k / sides) * Math.PI * 2;
          const wob = 0.6 + rng() * 0.5;
          return { x: Math.cos(a) * size * wob, y: Math.sin(a) * size * wob };
        }),
      ).fill({ color: 0x6f5a3a, alpha: 0.9 });
      sprite.x = Math.cos(theta) * r;
      sprite.y = Math.sin(theta) * r;
      root.addChild(sprite);
      visual.rocks.push({
        sprite,
        x: sprite.x,
        y: sprite.y,
        omega: (rng() - 0.5) * 0.18,
        r,
        theta,
        scale: 0.85 + rng() * 0.45,
      });
    }
    this.asteroidVisuals.push(visual);
    return root;
  }

  update(dt: number): void {
    this.time += dt;

    // Slow swirl for the asteroid debris — each rock orbits its initial
    // distance with its personal omega so the field reads as a churning
    // belt rather than a still backdrop.
    for (const v of this.asteroidVisuals) {
      for (const rock of v.rocks) {
        const theta = rock.theta + rock.omega * this.time;
        rock.sprite.x = Math.cos(theta) * rock.r;
        rock.sprite.y = Math.sin(theta) * rock.r;
        rock.sprite.scale.set(rock.scale * (0.92 + 0.08 * Math.sin(this.time * 1.7 + rock.theta)));
      }
    }

    // Black holes: spin the disk, breathe the photon ring, and rain the
    // debris field inward — faster and brighter as each mote nears the core.
    for (const v of this.blackHoleVisuals) {
      const { hole } = v;
      v.disk.rotation += dt * 0.5;
      v.photonRing.alpha = 0.8 + 0.2 * Math.sin(this.time * 2.1);
      for (const p of v.particles) {
        p.r -= (3 + 900 / p.r) * dt;
        p.theta += (45 / p.r) * dt * 3;
        if (p.r <= hole.horizonRadius * 1.05) {
          // Consumed — respawn at the outer rim on a fresh bearing.
          p.r = hole.captureRadius + Math.random() * (hole.gravityRadius * 0.85 - hole.captureRadius);
          p.theta = Math.random() * Math.PI * 2;
        }
        p.dot.x = Math.cos(p.theta) * p.r;
        p.dot.y = Math.sin(p.theta) * p.r;
        p.dot.alpha = 0.2 + 0.55 * (1 - p.r / hole.gravityRadius);
      }
    }

    // Sync neutral ship visuals to the live entity list. New entities
    // materialize hull + glow + engine flare on demand; killed entities just
    // hide their visuals (kept around in the pool for reuse).
    const all = this.world.neutrals.all;
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      let v = this.neutralVisuals[i];
      if (!v) {
        const hull = new Sprite(this.hullTex);
        hull.anchor.set(0.5);
        hull.scale.set(0.9);
        const glow = new Sprite(this.glowTex);
        glow.anchor.set(0.5);
        glow.tint = NEUTRAL_GLOW;
        glow.blendMode = 'add';
        glow.scale.set(0.95);
        const engine = new Sprite(this.engineTex);
        engine.anchor.set(1, 0.5); // flare trails from the hull's tail
        engine.blendMode = 'add';
        glow.visible = false;
        hull.visible = false;
        engine.visible = false;
        this.neutralRoot.addChild(glow);
        this.neutralRoot.addChild(engine);
        this.neutralRoot.addChild(hull);
        v = { hull, glow, engine, active: false };
        this.neutralVisuals[i] = v;
      }
      if (n.active) {
        v.hull.visible = true;
        v.glow.visible = true;
        v.engine.visible = true;
        v.hull.x = n.x;
        v.hull.y = n.y;
        v.hull.rotation = n.heading;
        v.glow.x = n.x;
        v.glow.y = n.y;
        const cos = Math.cos(n.heading);
        const sin = Math.sin(n.heading);
        v.engine.x = n.x - cos * 5;
        v.engine.y = n.y - sin * 5;
        v.engine.rotation = n.heading;
        // Engine output telegraphs intent: hot in pursuit, idling on patrol.
        const flicker = 0.8 + 0.2 * Math.sin(this.time * 11 + n.phase);
        v.engine.alpha =
          (n.state === 'pursue' ? 1 : n.state === 'return' ? 0.6 : 0.35) * flicker;
        // Slight pulsing so a stationary patrol still reads as alive.
        const pulse = 0.85 + 0.15 * Math.sin(this.time * 3.4 + n.phase);
        v.glow.alpha = (n.state === 'pursue' ? 0.8 : 0.6) * pulse;
        v.active = true;
      } else if (v.active) {
        v.hull.visible = false;
        v.glow.visible = false;
        v.engine.visible = false;
        v.active = false;
      }
    }
  }
}
