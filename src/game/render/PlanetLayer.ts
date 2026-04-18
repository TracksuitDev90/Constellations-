import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import { RING_THRESHOLDS, type PlanetType } from '../sim/Planet.js';
import type { World } from '../sim/World.js';
import {
  makePlanetBodyTexture,
  makePlanetHaloTexture,
  makeShipTexture,
} from './textures.js';

const MAX_ORBITERS = 48;
const ORBIT_BAND_INNER = 1.55; // × planet radius (outside ring art)
const ORBIT_BAND_OUTER = 1.9;
const ORBIT_SPEED_MIN = 0.5; // rad/s
const ORBIT_SPEED_MAX = 1.1;

/** Extra scale added per filled ring. */
const RING_GROWTH = 0.28;

/** Cumulative display scale for a given set of filled rings. */
const scaleForFilled = (filled: number): number => 1 + filled * RING_GROWTH;

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
  rings: Graphics; // capacity rings (type 1 / 2)
  count: Text;
  orbitRoot: Container;
  orbiters: Orbiter[];
  lastOwner: number | null;
  displayScale: number;
  baseRadius: number;
  type: PlanetType;
  swirlPhase: number;
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
      const rings = new Graphics();

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

      container.addChild(halo, ring, rings, body, orbitRoot, count);
      this.addChild(container);

      this.views.push({
        planetId: planet.id,
        container,
        halo,
        body,
        ring,
        rings,
        count,
        orbitRoot,
        orbiters: [],
        lastOwner: planet.owner,
        displayScale: 1,
        baseRadius: planet.radius,
        type: planet.type,
        swirlPhase: Math.random() * Math.PI * 2,
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

      // Growth: each filled capacity ring grows the planet wider. Partial
      // progress shows in the ring fill but not in scale until the ring closes.
      const thresholds = RING_THRESHOLDS[v.type];
      let filled = 0;
      for (const t of thresholds) if (p.garrison >= t) filled++;
      const targetScale = scaleForFilled(filled);
      const ease = 1 - Math.exp(-dt * 3);
      v.displayScale += (targetScale - v.displayScale) * ease;

      // Subtle swirl once any ring is filled.
      v.swirlPhase += dt * (0.6 + filled * 0.35);
      const swirlWobble = filled > 0 ? 1 + Math.sin(v.swirlPhase) * 0.015 * filled : 1;

      const pulse = 1 + p.capturePulse * 0.2;
      v.body.scale.set(v.displayScale * pulse * swirlWobble);
      v.body.rotation = filled > 0 ? Math.sin(v.swirlPhase * 0.5) * 0.08 : 0;
      v.halo.scale.set(v.displayScale * pulse);

      // Count readout sits just below the planet.
      v.count.text = String(p.garrison);
      v.count.y = v.baseRadius * v.displayScale + 16;

      const pal = paletteFor(p.owner);

      // Capacity rings (type 1 / 2): one or two concentric progress arcs.
      v.rings.clear();
      if (thresholds.length > 0) {
        let prevThreshold = 0;
        for (let k = 0; k < thresholds.length; k++) {
          const cap = thresholds[k];
          const progress = Math.max(
            0,
            Math.min(1, (p.garrison - prevThreshold) / (cap - prevThreshold)),
          );
          const r = v.baseRadius * v.displayScale + 10 + k * 8;
          // Background ring (dim).
          v.rings.circle(0, 0, r).stroke({
            width: 2,
            color: pal.ring,
            alpha: 0.18,
          });
          // Filled progress arc.
          if (progress > 0) {
            const sweep = Math.PI * 2 * progress;
            const start = -Math.PI / 2;
            v.rings
              .arc(0, 0, r, start, start + sweep)
              .stroke({ width: 2.5, color: pal.ring, alpha: 0.9 });
          }
          prevThreshold = cap;
        }
      }

      // Selection ring (pulsing) sits outside the capacity rings.
      v.ring.clear();
      if (this.selectedSources.has(p.id)) {
        const outer =
          v.baseRadius * v.displayScale +
          10 +
          thresholds.length * 8 +
          8 +
          Math.sin(this.time * 4) * 1.6;
        v.ring.circle(0, 0, outer).stroke({ width: 2.5, color: pal.ring, alpha: 0.95 });
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
