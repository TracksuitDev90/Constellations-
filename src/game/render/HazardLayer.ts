import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { World, AsteroidField } from '../sim/World.js';
import { makeShipGlowTexture, makeShipTexture } from './textures.js';

/**
 * Visualizes per-match hazards: asteroid drag zones (translucent disc with
 * drifting rocky particles) and neutral green hostile units. Lives between
 * the ship layer and planet layer so asteroid debris reads behind ships,
 * while neutral combatants render on top so the player can spot them
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
  sprite: Sprite;
  glow: Sprite;
  active: boolean;
}

const NEUTRAL_TINT = 0x9cff7a; // Match PLAYER_PALETTES[2] core; reads as the swarm's banner color.
const NEUTRAL_GLOW = 0x2f8a1d;

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
  private shipTex: Texture;
  private glowTex: Texture;
  private asteroidVisuals: AsteroidVisual[] = [];
  private neutralVisuals: NeutralVisual[] = [];
  private neutralRoot: Container;
  private asteroidRoot: Container;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.world = world;
    this.shipTex = makeShipTexture(app);
    this.glowTex = makeShipGlowTexture(app);
    this.asteroidRoot = new Container();
    this.neutralRoot = new Container();
    this.addChild(this.asteroidRoot);
    this.addChild(this.neutralRoot);

    for (const f of world.asteroidFields) {
      this.asteroidRoot.addChild(this.buildAsteroidVisual(f));
    }
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

    // Sync neutral sprites to the live entity list. New entities materialize
    // a sprite + glow on demand; killed entities just hide their visuals
    // (kept around in the pool for reuse).
    const all = this.world.neutrals.all;
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      let v = this.neutralVisuals[i];
      if (!v) {
        const sprite = new Sprite(this.shipTex);
        sprite.anchor.set(0.5);
        sprite.tint = NEUTRAL_TINT;
        sprite.scale.set(0.78);
        const glow = new Sprite(this.glowTex);
        glow.anchor.set(0.5);
        glow.tint = NEUTRAL_GLOW;
        glow.blendMode = 'add';
        glow.scale.set(0.95);
        glow.visible = false;
        sprite.visible = false;
        this.neutralRoot.addChild(glow);
        this.neutralRoot.addChild(sprite);
        v = { sprite, glow, active: false };
        this.neutralVisuals[i] = v;
      }
      if (n.active) {
        v.sprite.visible = true;
        v.glow.visible = true;
        v.sprite.x = n.x;
        v.sprite.y = n.y;
        v.sprite.rotation = n.heading;
        v.glow.x = n.x;
        v.glow.y = n.y;
        // Slight pulsing so a stationary patrol still reads as alive.
        const pulse = 0.85 + 0.15 * Math.sin(this.time * 3.4 + n.phase);
        v.glow.alpha = 0.65 * pulse;
        v.active = true;
      } else if (v.active) {
        v.sprite.visible = false;
        v.glow.visible = false;
        v.active = false;
      }
    }
  }
}
