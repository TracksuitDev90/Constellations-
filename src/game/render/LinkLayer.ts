import { Container, Graphics } from 'pixi.js';
import type { World } from '../sim/World.js';

/**
 * Faint constellation lines along the world's edge graph. Streams route
 * their multi-hop waves along these edges (`World.findPath`), so without
 * this layer the player watches waves follow an invisible map — and the
 * lines are also the signature look of a constellation chart.
 *
 * Positions are static for every planet except one under the drifting
 * hazard, so the Graphics is rebuilt only when a drifting planet exists;
 * otherwise it is drawn exactly once.
 */
const LINK_COLOR = 0x8fa8d8;
const LINK_ALPHA = 0.14;
const LINK_GLOW_ALPHA = 0.05;

export class LinkLayer extends Container {
  private world: World;
  private g: Graphics;
  private hasDrifter: boolean;
  private drawn = false;

  constructor(world: World) {
    super();
    this.world = world;
    this.g = new Graphics();
    this.addChild(this.g);
    this.hasDrifter = world.planets.some((p) => p.vx !== 0 || p.vy !== 0);
  }

  update(): void {
    if (this.drawn && !this.hasDrifter) return;
    this.drawn = true;
    const g = this.g;
    g.clear();
    for (const key of this.world.edges) {
      const dash = key.indexOf('-');
      const a = this.world.planets[Number(key.slice(0, dash))];
      const b = this.world.planets[Number(key.slice(dash + 1))];
      if (!a || !b) continue;
      // Soft under-glow pass then a crisp hairline, both faint enough to sit
      // behind ship traffic without competing with it.
      g.moveTo(a.pos.x, a.pos.y).lineTo(b.pos.x, b.pos.y);
    }
    g.stroke({ width: 5, color: LINK_COLOR, alpha: LINK_GLOW_ALPHA });
    for (const key of this.world.edges) {
      const dash = key.indexOf('-');
      const a = this.world.planets[Number(key.slice(0, dash))];
      const b = this.world.planets[Number(key.slice(dash + 1))];
      if (!a || !b) continue;
      g.moveTo(a.pos.x, a.pos.y).lineTo(b.pos.x, b.pos.y);
    }
    g.stroke({ width: 1.2, color: LINK_COLOR, alpha: LINK_ALPHA });
  }
}
