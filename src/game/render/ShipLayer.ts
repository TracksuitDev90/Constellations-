import { Application, Container, Sprite, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { makeShipTexture } from './textures.js';

interface ShipSpriteEntry {
  sprite: Sprite;
  active: boolean;
}

const BASE_SCALE = 0.42;
/** Transit ships stretch along their velocity axis so they read as streaks. */
const TRANSIT_STRETCH = 1.7;
const TRANSIT_NARROW = 0.55;

export class ShipLayer extends Container {
  private texture: Texture;
  private world: World;
  private entries: ShipSpriteEntry[] = [];

  constructor(app: Application, world: World) {
    super();
    this.world = world;
    this.texture = makeShipTexture(app);
  }

  update(): void {
    const ships = this.world.ships.all;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      let entry = this.entries[i];
      if (!entry) {
        const sprite = new Sprite(this.texture);
        sprite.anchor.set(0.5);
        sprite.scale.set(BASE_SCALE);
        sprite.visible = false;
        this.addChild(sprite);
        entry = { sprite, active: false };
        this.entries[i] = entry;
      }
      if (s.active) {
        entry.sprite.visible = true;
        entry.sprite.x = s.x;
        entry.sprite.y = s.y;
        entry.sprite.tint = paletteFor(s.owner).ship;
        // Transit ships align to velocity and stretch into a comet. Orbiters
        // and absorb/hover units stay compact glow dots.
        if (s.state === 'transit') {
          const speed = Math.hypot(s.vx, s.vy);
          if (speed > 0.01) entry.sprite.rotation = Math.atan2(s.vy, s.vx);
          entry.sprite.scale.set(BASE_SCALE * TRANSIT_STRETCH, BASE_SCALE * TRANSIT_NARROW);
        } else {
          entry.sprite.rotation = 0;
          entry.sprite.scale.set(BASE_SCALE);
        }
        entry.active = true;
      } else if (entry.active) {
        entry.sprite.visible = false;
        entry.active = false;
      }
    }
  }
}
