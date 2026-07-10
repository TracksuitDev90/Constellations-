import { Application, Container, Sprite, TilingSprite } from 'pixi.js';
import {
  makeNebulaTexture,
  makeShootingStarTexture,
  makeStarfieldTexture,
  makeTwinkleTexture,
} from './textures.js';

/**
 * Occasional nebula color pairs. Rich mid-value hues — bright enough to
 * clearly lift off the near-black sky, desaturated enough not to compete
 * with the player palettes — and never green, which is reserved for the
 * hostile swarm.
 */
const NEBULA_PALETTES: Array<[number, number]> = [
  [0x2b6b85, 0x3d2f8f], // teal → indigo
  [0x8a2a6e, 0x38428f], // magenta → slate blue
  [0x9a6e30, 0x84443a], // amber → rust
];

/** Chance a match's sky rolls any nebulae at all. */
const NEBULA_CHANCE = 0.85;

/** Twinkling foreground stars — sparse on purpose. */
const TWINKLE_COUNT = 12;
/** Max simultaneous shooting stars; more reads as a meteor storm. */
const SHOOTING_POOL = 2;
/** Seconds between shooting stars: base + random spread. */
const SHOOTING_GAP_MIN = 7;
const SHOOTING_GAP_SPREAD = 13;

interface NebulaCloud {
  /** Holds the two counter-rotating copies; positioned in screen space. */
  root: Container;
  /** Screen-fraction base position (re-scattered on resize). */
  fx: number;
  fy: number;
  /** Counter-rotation speeds (rad/s) for the two stacked copies. */
  spinA: number;
  spinB: number;
  /** Autonomous drift oscillator phase/rate. */
  driftPhase: number;
  driftRate: number;
  baseAlpha: number;
}

interface TwinkleStar {
  sprite: Sprite;
  /** Screen-fraction position, wrapped under parallax. */
  fx: number;
  fy: number;
  phase: number;
  /** Slow glint oscillator rate (rad/s) — each star flashes on its own beat. */
  rate: number;
  baseAlpha: number;
  baseScale: number;
}

interface ShootingStar {
  sprite: Sprite;
  active: boolean;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
}

const mulberry32 = (seed: number) => {
  let a = seed | 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class BackgroundLayer extends Container {
  private near: TilingSprite;
  private far: TilingSprite;
  private clouds: NebulaCloud[] = [];
  private twinkles: TwinkleStar[] = [];
  private shooters: ShootingStar[] = [];
  private shootTimer: number;
  private time = 0;
  private screenW: number;
  private screenH: number;

  constructor(app: Application, width: number, height: number, seed = 1) {
    super();
    this.screenW = width;
    this.screenH = height;
    // Far plane keeps the opaque deep-space backdrop; the near plane MUST be
    // transparent — it stacks above the nebulae, and an opaque tile at high
    // alpha was a dark curtain that all but erased the dust clouds.
    this.far = new TilingSprite({ texture: makeStarfieldTexture(app, 512), width, height });
    this.far.alpha = 1;
    this.near = new TilingSprite({
      texture: makeStarfieldTexture(app, 512, false),
      width,
      height,
    });
    this.near.alpha = 0.9;
    this.near.tileScale.set(1.6);
    this.addChild(this.far);

    // Nebulae sit between the two star planes so near stars still twinkle in
    // front of the fog. Two stacked copies of the same cloud counter-rotate
    // slowly — a cheap swirl/flow illusion with zero shader work. A minority
    // of matches stay clean so a nebular sky keeps feeling special.
    const rng = mulberry32(seed);
    if (rng() < NEBULA_CHANCE) {
      const count = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < count; i++) {
        // Draw from a small pool of baked variants (texture cache is
        // never evicted, so unbounded seeds would slowly leak GPU memory
        // across replays). Placement/scale/spin still vary per match.
        const variant = Math.floor(rng() * 8);
        const pal = NEBULA_PALETTES[variant % NEBULA_PALETTES.length];
        const tex = makeNebulaTexture(app, 0x515 + variant * 977, pal[0], pal[1]);
        const root = new Container();
        const a = new Sprite(tex);
        a.anchor.set(0.5);
        const b = new Sprite(tex);
        b.anchor.set(0.5);
        b.blendMode = 'add';
        b.rotation = Math.PI * rng();
        b.alpha = 0.6;
        root.addChild(a, b);
        // Keep the bake near 1:1 on screen — stretching the 512px cloud much
        // past its native size smears the filaments and dust lanes into a
        // structureless haze, which is exactly what makes fog look fake.
        const scale = 0.95 + rng() * 0.65;
        root.scale.set(scale);
        const dir = rng() < 0.5 ? 1 : -1;
        // Scatter with rejection so clouds spread across the sky — three
        // clouds stacked in one corner read as a wall of fog, not a sky.
        let fx = 0.15 + rng() * 0.7;
        let fy = 0.15 + rng() * 0.7;
        for (let tries = 0; tries < 12; tries++) {
          const clear = this.clouds.every(
            (c) => Math.hypot(c.fx - fx, c.fy - fy) > 0.35,
          );
          if (clear) break;
          fx = 0.15 + rng() * 0.7;
          fy = 0.15 + rng() * 0.7;
        }
        const cloud: NebulaCloud = {
          root,
          fx,
          fy,
          spinA: dir * (0.004 + rng() * 0.006),
          spinB: -dir * (0.004 + rng() * 0.006),
          driftPhase: rng() * Math.PI * 2,
          driftRate: 0.01 + rng() * 0.012,
          // 0.85 was the original 15% transparency cut (full-strength clouds
          // pulled the eye away from the planets); the further 0.9 is a
          // deliberate extra 10% cut so the dust reads subtle and real
          // rather than painted on.
          baseAlpha: (0.45 + rng() * 0.15) * 0.85 * 0.9,
        };
        root.alpha = cloud.baseAlpha;
        this.clouds.push(cloud);
        this.addChild(root);
      }
    }

    this.addChild(this.near);

    // Twinkling stars live above the near plane so their glints read on top
    // of the fog. Each has a slow personal glint beat plus a fine shimmer —
    // most of the time they're dim points, then one softly flares.
    const twinkleTex = makeTwinkleTexture(app);
    for (let i = 0; i < TWINKLE_COUNT; i++) {
      const sprite = new Sprite(twinkleTex);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.alpha = 0;
      const star: TwinkleStar = {
        sprite,
        fx: 0.02 + rng() * 0.96,
        fy: 0.02 + rng() * 0.96,
        phase: rng() * Math.PI * 2,
        rate: 0.35 + rng() * 0.9,
        baseAlpha: 0.5 + rng() * 0.45,
        baseScale: 0.5 + rng() * 0.7,
      };
      sprite.scale.set(star.baseScale);
      this.twinkles.push(star);
      this.addChild(sprite);
    }

    // Shooting stars: a tiny pool of streaks, one every 7–20 seconds. They
    // fly in screen space (their whole life is under a second, parallax
    // would be imperceptible) and fade in/out over their arc.
    const shootTex = makeShootingStarTexture(app);
    for (let i = 0; i < SHOOTING_POOL; i++) {
      const sprite = new Sprite(shootTex);
      sprite.anchor.set(0.92, 0.5); // anchor at the bright head
      sprite.blendMode = 'add';
      sprite.alpha = 0;
      this.shooters.push({ sprite, active: false, vx: 0, vy: 0, life: 0, ttl: 1 });
      this.addChild(sprite);
    }
    this.shootTimer = SHOOTING_GAP_MIN + rng() * SHOOTING_GAP_SPREAD;
  }

  /** Launch one meteor from the upper half of the screen on a falling diagonal. */
  private spawnShootingStar(): void {
    const s = this.shooters.find((sh) => !sh.active);
    if (!s) return;
    // 27°–63° below horizontal, mirrored half the time.
    const angle = Math.PI * (0.15 + Math.random() * 0.2);
    const dirX = Math.random() < 0.5 ? 1 : -1;
    const speed = 700 + Math.random() * 500;
    s.vx = Math.cos(angle) * speed * dirX;
    s.vy = Math.sin(angle) * speed;
    s.ttl = 0.65 + Math.random() * 0.5;
    s.life = 0;
    s.active = true;
    s.sprite.x = this.screenW * (0.1 + Math.random() * 0.8);
    s.sprite.y = this.screenH * (0.05 + Math.random() * 0.45);
    s.sprite.rotation = Math.atan2(s.vy, s.vx);
    s.sprite.scale.set(0.7 + Math.random() * 0.5, 0.8);
    s.sprite.alpha = 0;
  }

  update(cameraX: number, cameraY: number, dt = 0): void {
    this.time += dt;
    this.far.tilePosition.set(-cameraX * 0.15, -cameraY * 0.15);
    this.near.tilePosition.set(-cameraX * 0.35, -cameraY * 0.35);
    for (const c of this.clouds) {
      const [spriteA, spriteB] = c.root.children;
      spriteA.rotation += c.spinA * dt;
      spriteB.rotation += c.spinB * dt;
      // Parallax between the two star planes, plus a slow autonomous drift
      // and an alpha breath so the fog visibly flows even with a still camera.
      const t = this.time * c.driftRate + c.driftPhase;
      c.root.x = c.fx * this.screenW - cameraX * 0.22 + Math.sin(t) * 30;
      c.root.y = c.fy * this.screenH - cameraY * 0.22 + Math.cos(t * 0.8) * 24;
      c.root.alpha = c.baseAlpha * (0.85 + 0.15 * Math.sin(this.time * 0.16 + c.driftPhase));
    }

    // Twinkles: mostly-dim points that occasionally flare. The quartic on
    // the slow oscillator keeps each star dark ~80% of its cycle, so at any
    // moment only two or three are visibly glinting.
    const W = this.screenW;
    const H = this.screenH;
    for (const tw of this.twinkles) {
      const glint = Math.pow(Math.max(0, Math.sin(this.time * tw.rate + tw.phase)), 4);
      const shimmer = 0.75 + 0.25 * Math.sin(this.time * 7.3 + tw.phase * 3.1);
      tw.sprite.alpha = tw.baseAlpha * glint * shimmer;
      tw.sprite.scale.set(tw.baseScale * (0.8 + 0.5 * glint));
      // Parallax between the star planes; wrap so panning never strands them.
      tw.sprite.x = ((tw.fx * W - cameraX * 0.28) % W + W) % W;
      tw.sprite.y = ((tw.fy * H - cameraY * 0.28) % H + H) % H;
    }

    // Shooting stars: countdown to the next streak, then fly active ones.
    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      this.spawnShootingStar();
      this.shootTimer = SHOOTING_GAP_MIN + Math.random() * SHOOTING_GAP_SPREAD;
    }
    for (const s of this.shooters) {
      if (!s.active) continue;
      s.life += dt;
      if (s.life >= s.ttl) {
        s.active = false;
        s.sprite.alpha = 0;
        continue;
      }
      s.sprite.x += s.vx * dt;
      s.sprite.y += s.vy * dt;
      // Sine envelope: quick fade-in, longer fade-out; capped well under 1
      // so a meteor accents the sky instead of demanding the player's eye.
      s.sprite.alpha = Math.sin(Math.PI * (s.life / s.ttl)) * 0.7;
    }
  }

  resize(width: number, height: number): void {
    this.screenW = width;
    this.screenH = height;
    this.far.width = width;
    this.far.height = height;
    this.near.width = width;
    this.near.height = height;
  }
}
