import { Container, Graphics } from 'pixi.js';
import type { World } from '../sim/World.js';

export class LinkLayer extends Container {
  private wide = new Graphics();
  private core = new Graphics();
  private world: World;

  constructor(world: World) {
    super();
    this.world = world;
    this.addChild(this.wide, this.core);
    this.draw();
  }

  draw(): void {
    const wide = this.wide;
    const core = this.core;
    wide.clear();
    core.clear();
    for (const key of this.world.edges) {
      const [aStr, bStr] = key.split('-');
      const a = this.world.planets[+aStr];
      const b = this.world.planets[+bStr];
      wide.moveTo(a.pos.x, a.pos.y).lineTo(b.pos.x, b.pos.y);
      core.moveTo(a.pos.x, a.pos.y).lineTo(b.pos.x, b.pos.y);
    }
    // Soft wider glow underneath.
    wide.stroke({ width: 6, color: 0x7ad4ff, alpha: 0.14 });
    // Crisp bright line on top.
    core.stroke({ width: 2, color: 0xbcd9ee, alpha: 0.65 });
  }
}
