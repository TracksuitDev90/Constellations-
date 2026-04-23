import { Application, Container, Sprite, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { makeShipGlowTexture, makeShipTexture } from './textures.js';

interface ShipSpriteEntry {
  sprite: Sprite;
  /** Soft additive halo behind the ship — accumulates into bright hotspots. */
  glow: Sprite;
  /** Per-ship baseline glow scale so swarms don't read as uniform dots. */
  glowScale: number;
  /** Per-ship flicker phase for subtle twinkle. */
  flickerPhase: number;
  active: boolean;
}

const BASE_SCALE = 0.42;
/** Transit ships stretch along their velocity axis so they read as streaks. */
const TRANSIT_STRETCH = 1.7;
const TRANSIT_NARROW = 0.55;
/** Baseline scale of the density-glow halo (multiplied by per-ship jitter). */
const GLOW_BASE_SCALE = 0.5;
const GLOW_SCALE_JITTER = 0.35;

export class ShipLayer extends Container {
  private texture: Texture;
  private glowTex: Texture;
  private world: World;
  private entries: ShipSpriteEntry[] = [];
  /** Separate container for glow sprites so they render below the ship dots. */
  private glowRoot: Container;
  private shipRoot: Container;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.world = world;
    this.texture = makeShipTexture(app);
    this.glowTex = makeShipGlowTexture(app);
    this.glowRoot = new Container();
    this.shipRoot = new Container();
    this.addChild(this.glowRoot);
    this.addChild(this.shipRoot);
  }

  update(dt = 1 / 60): void {
    this.time += dt;
    const ships = this.world.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      let entry = this.entries[i];
      if (!entry) {
        const sprite = new Sprite(this.texture);
        sprite.anchor.set(0.5);
        sprite.scale.set(BASE_SCALE);
        sprite.visible = false;
        this.shipRoot.addChild(sprite);
        const glow = new Sprite(this.glowTex);
        glow.anchor.set(0.5);
        glow.blendMode = 'add';
        glow.visible = false;
        this.glowRoot.addChild(glow);
        entry = {
          sprite,
          glow,
          glowScale: GLOW_BASE_SCALE * (1 + (Math.random() - 0.5) * GLOW_SCALE_JITTER),
          flickerPhase: Math.random() * Math.PI * 2,
          active: false,
        };
        this.entries[i] = entry;
      }
      if (s.active) {
        // Orbiting ships are drawn exclusively by the PlanetLayer's atom-ring
        // visualization. Hiding them here avoids double-rendering the
        // garrison as both loose orbit dots and structured atom electrons.
        const hidden = s.state === 'orbiting';
        entry.sprite.visible = !hidden;
        entry.sprite.x = s.x;
        entry.sprite.y = s.y;
        const tint = paletteFor(s.owner).ship;
        entry.sprite.tint = tint;
        if (s.state === 'transit') {
          const speed = Math.hypot(s.vx, s.vy);
          if (speed > 0.01) entry.sprite.rotation = Math.atan2(s.vy, s.vx);
          entry.sprite.scale.set(BASE_SCALE * TRANSIT_STRETCH, BASE_SCALE * TRANSIT_NARROW);
        } else {
          entry.sprite.rotation = 0;
          entry.sprite.scale.set(BASE_SCALE);
        }
        // Density halo: additive glow that accumulates in dense clusters.
        // Per-ship flicker + scale jitter keeps swarms from reading as a
        // solid blob even when many overlap.
        entry.glow.visible = !hidden;
        entry.glow.x = s.x;
        entry.glow.y = s.y;
        entry.glow.tint = tint;
        const flicker = 0.75 + 0.25 * Math.sin(this.time * 4.5 + entry.flickerPhase);
        entry.glow.alpha = 0.55 * flicker;
        entry.glow.scale.set(entry.glowScale);
        entry.active = true;
      } else if (entry.active) {
        entry.sprite.visible = false;
        entry.glow.visible = false;
        entry.active = false;
      }
    }
  }
}
