import { Application, Container, Graphics } from 'pixi.js';
import { PLAYER_PALETTES } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { BackgroundLayer } from './BackgroundLayer.js';
import { HazardLayer } from './HazardLayer.js';
import { LinkLayer } from './LinkLayer.js';
import { PlanetLayer } from './PlanetLayer.js';
import { ShipLayer } from './ShipLayer.js';

export class Renderer {
  app: Application;
  world: World;
  bg: BackgroundLayer;
  worldLayer: Container;
  linkLayer: LinkLayer;
  planetLayer: PlanetLayer;
  shipLayer: ShipLayer;
  hazardLayer: HazardLayer;
  lasso: Graphics;

  // Camera / viewport state.
  viewX = 0;
  viewY = 0;
  viewScale = 1;
  /**
   * Recomputed per screen size in `updateScaleBounds` — a phone in portrait
   * needs to zoom out well past the old fixed 0.4 floor to see the whole
   * 1600×1000 map.
   */
  minScale = 0.4;
  maxScale = 2.5;

  constructor(app: Application, world: World) {
    this.app = app;
    this.world = world;
    this.bg = new BackgroundLayer(app, app.screen.width, app.screen.height);
    app.stage.addChild(this.bg);

    this.worldLayer = new Container();
    app.stage.addChild(this.worldLayer);

    this.linkLayer = new LinkLayer(world);
    this.shipLayer = new ShipLayer(app, world);
    this.hazardLayer = new HazardLayer(app, world);
    this.planetLayer = new PlanetLayer(app, world);
    this.lasso = new Graphics();

    // Z-order: constellation edge lines at the very bottom, ship streams
    // beneath asteroid debris, then planets and their halos on top, then
    // hazard neutrals over everything so their dots stay legible against
    // busy traffic. The HazardLayer internally splits its asteroid vs.
    // neutral subroots, so we add it twice — once before planets (asteroids
    // will be in their first child) and the neutral overlay sits inside the
    // same container above planets via z-index.
    this.worldLayer.addChild(this.linkLayer);
    this.worldLayer.addChild(this.shipLayer);
    this.worldLayer.addChild(this.hazardLayer);
    this.worldLayer.addChild(this.planetLayer);
    this.worldLayer.addChild(this.lasso);

    this.fitToScreen();
  }

  setLasso(x0: number, y0: number, x1: number, y1: number): void {
    // Circular selection centered at the drag origin. Radius tracks the
    // current drag distance, giving a clean planet-like disc.
    const radius = Math.hypot(x1 - x0, y1 - y0);
    if (radius < 1) {
      this.lasso.clear();
      return;
    }
    const pal = PLAYER_PALETTES[0];
    const stroke = Math.max(1.5, 2.5 / this.viewScale);
    this.lasso.clear();
    // Soft outer glow ring.
    this.lasso.circle(x0, y0, radius + stroke * 1.5).stroke({
      width: stroke * 2,
      color: pal.glow,
      alpha: 0.35,
    });
    // Filled disc + crisp rim.
    this.lasso
      .circle(x0, y0, radius)
      .fill({ color: pal.core, alpha: 0.1 })
      .stroke({ width: stroke, color: pal.core, alpha: 0.85 });
    // Small marker pip at the drag origin so the anchor reads clearly.
    this.lasso.circle(x0, y0, Math.max(2, 3 / this.viewScale)).fill({
      color: pal.ship,
      alpha: 0.9,
    });
  }

  clearLasso(): void {
    this.lasso.clear();
  }

  /** Scale at which the whole map fits the current screen (with padding). */
  private fitScale(): number {
    const pad = 40;
    const sx = (this.app.screen.width - pad * 2) / this.world.width;
    const sy = (this.app.screen.height - pad * 2) / this.world.height;
    return Math.min(sx, sy);
  }

  /** Let small screens zoom out far enough to see the whole constellation. */
  private updateScaleBounds(): void {
    this.minScale = Math.min(0.4, this.fitScale() * 0.9);
  }

  fitToScreen(): void {
    this.updateScaleBounds();
    const s = this.fitScale();
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
    this.clampCamera();
    this.worldLayer.x = this.viewX;
    this.worldLayer.y = this.viewY;
    this.worldLayer.scale.set(this.viewScale);
  }

  /**
   * Keep the map on screen: the visible window may never be panned more
   * than ~25% of the screen past the world bounds, so the player can't
   * fling the constellation away and get lost in empty space.
   */
  private clampCamera(): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const worldW = this.world.width * this.viewScale;
    const worldH = this.world.height * this.viewScale;
    const marginX = sw * 0.25;
    const marginY = sh * 0.25;
    // Require at least `margin` of overlap between the world's span and the
    // screen: the world's right edge may not go left of marginX, and its
    // left edge may not go right of (screen − margin).
    this.viewX = Math.max(marginX - worldW, Math.min(sw - marginX, this.viewX));
    this.viewY = Math.max(marginY - worldH, Math.min(sh - marginY, this.viewY));
  }

  onResize(width: number, height: number): void {
    this.bg.resize(width, height);
    // Preserve the player's zoom/pan — mobile browsers fire resize whenever
    // the toolbar collapses/expands, and resetting the camera mid-match made
    // the view snap away under the player's fingers. Just refresh the scale
    // floor and re-clamp against the new screen size.
    this.updateScaleBounds();
    this.viewScale = Math.max(this.minScale, Math.min(this.maxScale, this.viewScale));
    this.applyCamera();
  }

  update(dt: number): void {
    this.bg.update(this.viewX, this.viewY);
    this.linkLayer.update();
    this.planetLayer.update(dt);
    this.hazardLayer.update(dt);
    this.shipLayer.update(dt);
  }
}
