import { Application, Container, Sprite, Texture } from 'pixi.js';
import { paletteFor, toward } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { SHIP_SPEED } from '../sim/World.js';
import {
  SHIP_TRAIL_LENGTH,
  makeShipGlowTexture,
  makeShipTexture,
  makeShipTrailTexture,
} from './textures.js';

interface ShipSpriteEntry {
  sprite: Sprite;
  /** Soft additive halo behind the ship — accumulates into bright hotspots. */
  glow: Sprite;
  /** Comet tail along the heading — only while the ship is flying. */
  trail: Sprite;
  /** Per-ship baseline glow scale so swarms don't read as uniform dots. */
  glowScale: number;
  /** Per-ship flicker phase for subtle twinkle. */
  flickerPhase: number;
  active: boolean;
}

const BASE_SCALE = 0.42;
/** In-flight cores are slightly tighter — the trail carries the motion. */
const TRANSIT_CORE_SCALE = 0.36;
/** World-space trail length at cruising speed. */
const TRAIL_WORLD_LENGTH = 15;
/** Baseline scale of the density-glow halo (multiplied by per-ship jitter). */
const GLOW_BASE_SCALE = 0.5;
const GLOW_SCALE_JITTER = 0.35;

export class ShipLayer extends Container {
  private texture: Texture;
  private glowTex: Texture;
  private trailTex: Texture;
  private world: World;
  private entries: ShipSpriteEntry[] = [];
  /** Separate container for glow sprites so they render below the ship dots. */
  private glowRoot: Container;
  private trailRoot: Container;
  private shipRoot: Container;
  private time = 0;
  /** Ambient-music breathing (0..1), fed by Game each frame via setBeat. */
  private beat = 0;
  /** Zoom compensation from the Renderer — keeps swarms legible on phones. */
  unitScale = 1;

  setBeat(v: number): void {
    this.beat = v;
  }

  constructor(app: Application, world: World) {
    super();
    this.world = world;
    this.texture = makeShipTexture(app);
    this.glowTex = makeShipGlowTexture(app);
    this.trailTex = makeShipTrailTexture(app);
    this.glowRoot = new Container();
    this.trailRoot = new Container();
    this.shipRoot = new Container();
    this.addChild(this.glowRoot);
    this.addChild(this.trailRoot);
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
        const trail = new Sprite(this.trailTex);
        trail.anchor.set(1, 0.5);
        trail.blendMode = 'add';
        trail.visible = false;
        this.trailRoot.addChild(trail);
        entry = {
          sprite,
          glow,
          trail,
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
        // Selected in-flight units read brighter (tint pushed toward white,
        // larger glow) so a lasso grab has visible feedback — previously
        // `isSelected` was never rendered anywhere.
        const baseTint = paletteFor(s.owner).ship;
        // Doomed ships blue-shift toward white as they spiral in — the light
        // of a unit already lost to the hole.
        const tint = s.isSelected
          ? toward(baseTint, 0xffffff, 0.65)
          : s.state === 'doomed'
            ? toward(baseTint, 0xffffff, 0.5)
            : baseTint;
        entry.sprite.tint = tint;
        const us = this.unitScale;
        entry.sprite.rotation = 0;
        if (s.state === 'transit' || s.state === 'doomed') {
          // A crisp core with a comet tail along the heading: the swarm reads
          // as a flowing current of light, and the tail length doubles as a
          // speedometer (crawling through rocks, whipping round a hole).
          const speed = Math.hypot(s.vx, s.vy);
          entry.sprite.scale.set(TRANSIT_CORE_SCALE * us);
          const t = entry.trail;
          t.visible = speed > 1;
          if (t.visible) {
            t.x = s.x;
            t.y = s.y;
            t.rotation = Math.atan2(s.vy, s.vx);
            const len = Math.min(1.8, speed / SHIP_SPEED) * TRAIL_WORLD_LENGTH * us;
            t.scale.set(len / SHIP_TRAIL_LENGTH, 0.42 * us);
            t.tint = tint;
            t.alpha = s.isSelected ? 0.95 : 0.7;
          }
        } else {
          entry.trail.visible = false;
          entry.sprite.scale.set(BASE_SCALE * us);
        }
        // Density halo: additive glow that accumulates in dense clusters.
        // Per-ship flicker + scale jitter keeps swarms from reading as a
        // solid blob even when many overlap.
        entry.glow.visible = !hidden;
        entry.glow.x = s.x;
        entry.glow.y = s.y;
        entry.glow.tint = tint;
        const flicker = 0.75 + 0.25 * Math.sin(this.time * 4.5 + entry.flickerPhase);
        const breathe = 0.88 + 0.24 * this.beat;
        entry.glow.alpha = (s.isSelected ? 0.8 : 0.55) * flicker * breathe;
        entry.glow.scale.set(entry.glowScale * (s.isSelected ? 1.35 : 1) * us);
        entry.active = true;
      } else if (entry.active) {
        entry.sprite.visible = false;
        entry.glow.visible = false;
        entry.trail.visible = false;
        entry.active = false;
      }
    }
  }
}
