import { Application, Container, Sprite, TilingSprite } from 'pixi.js';
import { makeNebulaTexture, makeStarfieldTexture } from './textures.js';

/**
 * Occasional nebula color pairs. Deliberately desaturated deep hues so the
 * fog reads at very low alpha without competing with the saturated player
 * palettes — and never green, which is reserved for the hostile swarm.
 */
const NEBULA_PALETTES: Array<[number, number]> = [
  [0x1a4a5e, 0x2a2060], // teal → indigo
  [0x5e1a4a, 0x1a2050], // magenta → deep blue
  [0x5e401a, 0x40201a], // amber → rust
];

/** Chance a match's sky rolls any nebulae at all. */
const NEBULA_CHANCE = 0.65;

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
  private time = 0;
  private screenW: number;
  private screenH: number;

  constructor(app: Application, width: number, height: number, seed = 1) {
    super();
    this.screenW = width;
    this.screenH = height;
    const tex = makeStarfieldTexture(app, 512);
    this.far = new TilingSprite({ texture: tex, width, height });
    this.far.alpha = 0.55;
    this.near = new TilingSprite({ texture: tex, width, height });
    this.near.alpha = 0.9;
    this.near.tileScale.set(1.6);
    this.addChild(this.far);

    // Nebulae sit between the two star planes so near stars still twinkle in
    // front of the fog. Two stacked copies of the same cloud counter-rotate
    // slowly — a cheap swirl/flow illusion with zero shader work. Roughly a
    // third of matches stay clean so a nebular sky keeps feeling special.
    const rng = mulberry32(seed);
    if (rng() < NEBULA_CHANCE) {
      const count = 1 + Math.floor(rng() * 3);
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
        b.alpha = 0.7;
        root.addChild(a, b);
        const scale = 1.2 + rng() * 1.0;
        root.scale.set(scale);
        const dir = rng() < 0.5 ? 1 : -1;
        const cloud: NebulaCloud = {
          root,
          fx: 0.15 + rng() * 0.7,
          fy: 0.15 + rng() * 0.7,
          spinA: dir * (0.004 + rng() * 0.006),
          spinB: -dir * (0.004 + rng() * 0.006),
          driftPhase: rng() * Math.PI * 2,
          driftRate: 0.01 + rng() * 0.012,
          baseAlpha: 0.26 + rng() * 0.12,
        };
        root.alpha = cloud.baseAlpha;
        this.clouds.push(cloud);
        this.addChild(root);
      }
    }

    this.addChild(this.near);
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
      c.root.alpha = c.baseAlpha * (0.8 + 0.2 * Math.sin(this.time * 0.16 + c.driftPhase));
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
