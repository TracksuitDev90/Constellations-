import { Container, Graphics } from 'pixi.js';
import type { World } from '../sim/World.js';

export class LinkLayer extends Container {
  private g = new Graphics();
  private world: World;

  constructor(world: World) {
    super();
    this.world = world;
    this.addChild(this.g);
    this.draw();
  }

  draw(): void {
    const g = this.g;
    g.clear();
    for (const key of this.world.edges) {
      const [aStr, bStr] = key.split('-');
      const a = this.world.planets[+aStr];
      const b = this.world.planets[+bStr];
      g.moveTo(a.pos.x, a.pos.y).lineTo(b.pos.x, b.pos.y);
    }
    g.stroke({ width: 1, color: 0x4a5a7a, alpha: 0.35 });
  }
}
