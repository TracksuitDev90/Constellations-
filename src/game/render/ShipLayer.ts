import { Application, Container, Sprite, Texture } from 'pixi.js';
import { paletteFor } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { makeShipTexture } from './textures.js';

interface ShipSpriteEntry {
  sprite: Sprite;
  active: boolean;
}

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
        sprite.scale.set(0.42);
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
        entry.active = true;
      } else if (entry.active) {
        entry.sprite.visible = false;
        entry.active = false;
      }
    }
  }
}
