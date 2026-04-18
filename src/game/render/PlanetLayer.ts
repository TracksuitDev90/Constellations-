import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import type { World } from '../sim/World.js';
import {
  makePlanetBodyTexture,
  makePlanetHaloTexture,
  makeShipTexture,
} from './textures.js';

const MAX_ORBITERS = 48;
const ORBIT_BAND_INNER = 1.35; // × planet radius
const ORBIT_BAND_OUTER = 1.7;
const ORBIT_SPEED_MIN = 0.5; // rad/s
const ORBIT_SPEED_MAX = 1.1;

/** Visual tier of a planet based on garrison. */
const planetLevel = (garrison: number): number => (garrison >= 50 ? 2 : garrison >= 20 ? 1 : 0);
const LEVEL_SCALE = [1.0, 1.22, 1.48];

interface Orbiter {
  sprite: Sprite;
  angle: number;
  radius: number;
  speed: number;
  phase: number;
}

interface PlanetView {
  planetId: number;
  container: Container;
  halo: Sprite;
  body: Sprite;
  ring: Graphics;
  count: Text;
  orbitRoot: Container;
  orbiters: Orbiter[];
  lastOwner: number | null;
  lastLevel: number;
  displayScale: number;
  baseRadius: number;
}

export class PlanetLayer extends Container {
  private app: Application;
  private world: World;
  private views: PlanetView[] = [];
  private selectedSources = new Set<number>();
  private shipTex: Texture;
  private time = 0;

  constructor(app: Application, world: World) {
    super();
    this.app = app;
    this.world = world;
    this.shipTex = makeShipTexture(app);

    for (const planet of world.planets) {
      const container = new Container();
      container.x = planet.pos.x;
      container.y = planet.pos.y;

      const halo = new Sprite(makePlanetHaloTexture(app, planet.owner, planet.radius));
      halo.anchor.set(0.5);
      halo.tint = paletteFor(planet.owner).glow;

      const body = new Sprite(makePlanetBodyTexture(app, planet.owner, planet.radius, planet.id));
      body.anchor.set(0.5);

      const ring = new Graphics();

      const orbitRoot = new Container();

      const count = new Text({
        text: String(planet.garrison),
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
          fontSize: Math.max(13, Math.round(planet.radius * 0.7)),
          fontWeight: '600',
          fill: 0xffffff,
          align: 'center',
          stroke: { color: 0x000000, width: 2, alpha: 0.55 },
        },
      });
      count.anchor.set(0.5);

      container.addChild(halo, ring, body, orbitRoot, count);
      this.addChild(container);

      this.views.push({
        planetId: planet.id,
        container,
        halo,
        body,
        ring,
        count,
        orbitRoot,
        orbiters: [],
        lastOwner: planet.owner,
        lastLevel: planetLevel(planet.garrison),
        displayScale: LEVEL_SCALE[planetLevel(planet.garrison)],
        baseRadius: planet.radius,
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

      // Owner change → regenerate body + halo textures.
      if (p.owner !== v.lastOwner) {
        v.body.texture = makePlanetBodyTexture(this.app, p.owner, p.radius, p.id);
        v.halo.texture = makePlanetHaloTexture(this.app, p.owner, p.radius);
        v.halo.tint = paletteFor(p.owner).glow;
        v.lastOwner = p.owner;
      }

      // Level / size growth on reinforcement.
      const level = planetLevel(p.garrison);
      if (level !== v.lastLevel) v.lastLevel = level;
      const targetScale = LEVEL_SCALE[level];
      // Ease toward target scale.
      const ease = 1 - Math.exp(-dt * 4);
      v.displayScale += (targetScale - v.displayScale) * ease;
      const pulse = 1 + p.capturePulse * 0.2;
      v.body.scale.set(v.displayScale * pulse);
      v.halo.scale.set(v.displayScale * pulse);

      // Count readout sits just below the planet.
      v.count.text = String(p.garrison);
      v.count.y = v.baseRadius * v.displayScale + 10;

      // Selection ring.
      const pal = paletteFor(p.owner);
      v.ring.clear();
      if (this.selectedSources.has(p.id)) {
        const r = v.baseRadius * v.displayScale + 8 + Math.sin(this.time * 4) * 1.6;
        v.ring.circle(0, 0, r).stroke({ width: 2.5, color: pal.ring, alpha: 0.95 });
      }

      // Orbiters: represent garrison (up to cap) as floating ships.
      if (p.owner !== null) {
        this.syncOrbiters(v, Math.min(p.garrison, MAX_ORBITERS), p.owner);
        this.tickOrbiters(v, dt);
      } else {
        // Neutral planets: no orbiters; fade out any leftover.
        if (v.orbiters.length > 0) this.clearOrbiters(v);
      }
    }
  }

  private syncOrbiters(v: PlanetView, target: number, owner: number): void {
    const shipTint = paletteFor(owner).ship;

    // Update tint on existing (in case ownership flipped).
    for (const o of v.orbiters) o.sprite.tint = shipTint;

    // Grow.
    while (v.orbiters.length < target) {
      const sprite = new Sprite(this.shipTex);
      sprite.anchor.set(0.5);
      sprite.scale.set(0.36);
      sprite.tint = shipTint;
      v.orbitRoot.addChild(sprite);
      v.orbiters.push({
        sprite,
        angle: Math.random() * Math.PI * 2,
        radius:
          v.baseRadius *
          (ORBIT_BAND_INNER + Math.random() * (ORBIT_BAND_OUTER - ORBIT_BAND_INNER)),
        speed:
          (ORBIT_SPEED_MIN + Math.random() * (ORBIT_SPEED_MAX - ORBIT_SPEED_MIN)) *
          (Math.random() < 0.5 ? 1 : -1),
        phase: Math.random() * Math.PI * 2,
      });
    }

    // Shrink.
    while (v.orbiters.length > target) {
      const o = v.orbiters.pop()!;
      v.orbitRoot.removeChild(o.sprite);
      o.sprite.destroy();
    }
  }

  private tickOrbiters(v: PlanetView, dt: number): void {
    const scale = v.displayScale;
    for (const o of v.orbiters) {
      o.angle += o.speed * dt;
      const r = o.radius * scale;
      o.sprite.x = Math.cos(o.angle) * r;
      o.sprite.y = Math.sin(o.angle) * r;
      // Gentle alpha pulse so the swarm feels alive.
      const a = 0.65 + 0.35 * Math.sin(this.time * 2.2 + o.phase);
      o.sprite.alpha = a;
    }
  }

  private clearOrbiters(v: PlanetView): void {
    for (const o of v.orbiters) {
      v.orbitRoot.removeChild(o.sprite);
      o.sprite.destroy();
    }
    v.orbiters.length = 0;
  }
}
