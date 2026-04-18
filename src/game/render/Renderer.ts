import { Application, Container } from 'pixi.js';
import type { World } from '../sim/World.js';
import { BackgroundLayer } from './BackgroundLayer.js';
import { PlanetLayer } from './PlanetLayer.js';
import { ShipLayer } from './ShipLayer.js';

export class Renderer {
  app: Application;
  world: World;
  bg: BackgroundLayer;
  worldLayer: Container;
  planetLayer: PlanetLayer;
  shipLayer: ShipLayer;

  // Camera / viewport state.
  viewX = 0;
  viewY = 0;
  viewScale = 1;
  minScale = 0.4;
  maxScale = 2.5;

  constructor(app: Application, world: World) {
    this.app = app;
    this.world = world;
    this.bg = new BackgroundLayer(app, app.screen.width, app.screen.height);
    app.stage.addChild(this.bg);

    this.worldLayer = new Container();
    app.stage.addChild(this.worldLayer);

    this.shipLayer = new ShipLayer(app, world);
    this.planetLayer = new PlanetLayer(app, world);

    this.worldLayer.addChild(this.shipLayer);
    this.worldLayer.addChild(this.planetLayer);

    this.fitToScreen();
  }

  fitToScreen(): void {
    const pad = 40;
    const sx = (this.app.screen.width - pad * 2) / this.world.width;
    const sy = (this.app.screen.height - pad * 2) / this.world.height;
    const s = Math.min(sx, sy);
    this.viewScale = Math.max(this.minScale, Math.min(this.maxScale, s));
    this.viewX = this.app.screen.width / 2 - (this.world.width * this.viewScale) / 2;
    this.viewY = this.app.screen.height / 2 - (this.world.height * this.viewScale) / 2;
    this.applyCamera();
  }

  setZoom(scale: number, anchorScreenX: number, anchorScreenY: number): void {
    const next = Math.max(this.minScale, Math.min(this.maxScale, scale));
    const worldAnchor = this.screenToWorld(anchorScreenX, anchorScreenY);
    this.viewScale = next;
    // Keep worldAnchor under the screen anchor after scale change.
    this.viewX = anchorScreenX - worldAnchor.x * this.viewScale;
    this.viewY = anchorScreenY - worldAnchor.y * this.viewScale;
    this.applyCamera();
  }

  panBy(dx: number, dy: number): void {
    this.viewX += dx;
    this.viewY += dy;
    this.applyCamera();
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.viewX) / this.viewScale,
      y: (y - this.viewY) / this.viewScale,
    };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: x * this.viewScale + this.viewX,
      y: y * this.viewScale + this.viewY,
    };
  }

  private applyCamera(): void {
    this.worldLayer.x = this.viewX;
    this.worldLayer.y = this.viewY;
    this.worldLayer.scale.set(this.viewScale);
  }

  onResize(width: number, height: number): void {
    this.bg.resize(width, height);
    this.fitToScreen();
  }

  update(dt: number): void {
    this.bg.update(this.viewX, this.viewY);
    this.planetLayer.update(dt);
    this.shipLayer.update();
  }
}
