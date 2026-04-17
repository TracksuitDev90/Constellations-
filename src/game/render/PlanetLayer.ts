import { Application, Container, Graphics, Text } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { makePlanetSprite } from './textures.js';

interface PlanetView {
  container: Container;
  body: Container;
  ring: Graphics;
  count: Text;
  lastOwner: number | null;
}

export class PlanetLayer extends Container {
  private views: PlanetView[] = [];
  private app: Application;
  private world: World;
  private selectedSources = new Set<number>();

  constructor(app: Application, world: World) {
    super();
    this.app = app;
    this.world = world;
    for (const planet of world.planets) {
      const container = new Container();
      container.x = planet.pos.x;
      container.y = planet.pos.y;

      const ring = new Graphics();
      const body = makePlanetSprite(app, planet.owner, planet.radius);
      const count = new Text({
        text: String(planet.garrison),
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
          fontSize: Math.max(14, Math.round(planet.radius * 0.8)),
          fontWeight: '600',
          fill: 0xffffff,
          align: 'center',
        },
      });
      count.anchor.set(0.5);

      container.addChild(ring, body, count);
      this.addChild(container);
      this.views.push({ container, body, ring, count, lastOwner: planet.owner });
    }
  }

  setSelection(ids: Iterable<number>): void {
    this.selectedSources = new Set(ids);
  }

  update(_dt: number): void {
    for (let i = 0; i < this.world.planets.length; i++) {
      const p = this.world.planets[i];
      const v = this.views[i];

      if (p.owner !== v.lastOwner) {
        v.body.removeChildren();
        const fresh = makePlanetSprite(this.app, p.owner, p.radius);
        while (fresh.children.length) {
          v.body.addChild(fresh.children[0]);
        }
        v.lastOwner = p.owner;
      }

      const pulse = 1 + p.capturePulse * 0.25;
      v.body.scale.set(pulse);

      v.count.text = String(p.garrison);

      const pal = paletteFor(p.owner);
      const ring = v.ring;
      ring.clear();
      if (this.selectedSources.has(p.id)) {
        const r = p.radius + 6 + Math.sin(this.world.time * 4) * 1.5;
        ring.circle(0, 0, r).stroke({ width: 2, color: pal.ring, alpha: 0.95 });
      }
    }
  }
}
