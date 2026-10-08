import { Application, Container, Sprite, type Texture } from 'pixi.js';
import { FX_RING_RADIUS, makeFxRingTexture, makeShipGlowTexture } from './textures.js';

/**
 * Short-lived additive bursts: the flash-and-shockwave of ships trading 1:1
 * in open space, a hit landing on a planet, a swarm hostile going down, a
 * ship swallowed by a black hole, a warp. Every burst is two pooled sprites
 * (bloom + ring) driven by one 0..1 clock, so a brawl with hundreds of
 * deaths costs a fixed sprite budget and zero allocations — when the pool
 * is exhausted the oldest burst is recycled, which in a fight that dense is
 * invisible.
 */

interface Burst {
  bloom: Sprite;
  ring: Sprite;
  active: boolean;
  life: number;
  ttl: number;
  /** World-space radius the ring expands to. */
  size: number;
  /** Peak bloom alpha. */
  strength: number;
}

const POOL_SIZE = 180;
/** Baked radius of the ship-glow texture used as the bloom. */
const BLOOM_TEX_RADIUS = 28;

export interface BurstOptions {
  /** World-space radius the ring reaches (default 9). */
  size?: number;
  /** Lifetime in seconds (default 0.42). */
  ttl?: number;
  /** Peak bloom alpha (default 0.9). */
  strength?: number;
}

export class FxLayer extends Container {
  private pool: Burst[] = [];
  private nextSlot = 0;
  private bloomTex: Texture;
  private ringTex: Texture;
  /** Zoom compensation from the Renderer — bursts stay readable on phones. */
  unitScale = 1;

  constructor(app: Application) {
    super();
    this.bloomTex = makeShipGlowTexture(app);
    this.ringTex = makeFxRingTexture(app);
  }

  burst(x: number, y: number, color: number, opts: BurstOptions = {}): void {
    const b = this.acquire();
    b.active = true;
    b.life = 0;
    b.ttl = opts.ttl ?? 0.42;
    b.size = (opts.size ?? 9) * this.unitScale;
    b.strength = opts.strength ?? 0.9;
    b.bloom.x = b.ring.x = x;
    b.bloom.y = b.ring.y = y;
    b.bloom.tint = color;
    b.ring.tint = color;
    b.bloom.visible = b.ring.visible = true;
    this.pose(b, 0);
  }

  update(dt: number): void {
    for (const b of this.pool) {
      if (!b.active) continue;
      b.life += dt;
      const t = b.life / b.ttl;
      if (t >= 1) {
        b.active = false;
        b.bloom.visible = b.ring.visible = false;
        continue;
      }
      this.pose(b, t);
    }
  }

  /** Lay out one burst at normalized age `t` (0 → 1). */
  private pose(b: Burst, t: number): void {
    // Ease-out expansion: the shock snaps open and then coasts.
    const open = 1 - (1 - t) * (1 - t);
    b.ring.scale.set(((0.25 + 0.75 * open) * b.size) / FX_RING_RADIUS);
    b.ring.alpha = 0.85 * (1 - t);
    // The bloom flares hard for the first few frames, then fades fast.
    const flash = t < 0.15 ? 1 : Math.pow(1 - (t - 0.15) / 0.85, 2);
    b.bloom.scale.set(((0.6 + 0.6 * open) * b.size) / BLOOM_TEX_RADIUS * 1.6);
    b.bloom.alpha = b.strength * flash;
  }

  /** Next free burst, or the oldest live one once the pool is full. */
  private acquire(): Burst {
    if (this.pool.length < POOL_SIZE) {
      const bloom = new Sprite(this.bloomTex);
      bloom.anchor.set(0.5);
      bloom.blendMode = 'add';
      const ring = new Sprite(this.ringTex);
      ring.anchor.set(0.5);
      ring.blendMode = 'add';
      this.addChild(bloom, ring);
      const b: Burst = {
        bloom,
        ring,
        active: false,
        life: 0,
        ttl: 1,
        size: 1,
        strength: 1,
      };
      this.pool.push(b);
      return b;
    }
    for (let k = 0; k < this.pool.length; k++) {
      const idx = (this.nextSlot + k) % this.pool.length;
      if (!this.pool[idx].active) {
        this.nextSlot = (idx + 1) % this.pool.length;
        return this.pool[idx];
      }
    }
    const b = this.pool[this.nextSlot];
    this.nextSlot = (this.nextSlot + 1) % this.pool.length;
    return b;
  }
}
