import { Application, Container, TilingSprite } from 'pixi.js';
import { makeStarfieldTexture } from './textures.js';

export class BackgroundLayer extends Container {
  private near: TilingSprite;
  private far: TilingSprite;

  constructor(app: Application, width: number, height: number) {
    super();
    const tex = makeStarfieldTexture(app, 512);
    this.far = new TilingSprite({ texture: tex, width, height });
    this.far.alpha = 0.55;
    this.near = new TilingSprite({ texture: tex, width, height });
    this.near.alpha = 0.9;
    this.near.tileScale.set(1.6);
    this.addChild(this.far, this.near);
  }

  update(cameraX: number, cameraY: number): void {
    this.far.tilePosition.set(-cameraX * 0.15, -cameraY * 0.15);
    this.near.tilePosition.set(-cameraX * 0.35, -cameraY * 0.35);
  }

  resize(width: number, height: number): void {
    this.far.width = width;
    this.far.height = height;
    this.near.width = width;
    this.near.height = height;
  }
}
