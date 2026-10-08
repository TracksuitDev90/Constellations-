import { Application, Container, Graphics, Text } from 'pixi.js';
import { PLAYER_PALETTES } from '../../util/color.js';
import type { World } from '../sim/World.js';
import { BackgroundLayer } from './BackgroundLayer.js';
import { FxLayer } from './FxLayer.js';
import { HazardLayer } from './HazardLayer.js';
import { PlanetLayer } from './PlanetLayer.js';
import { ShipLayer } from './ShipLayer.js';

/** Screen pixels kept clear at the top for the HUD's strength bars. */
const HUD_RESERVE_PX = 56;
/** Zoom below which unit sprites start growing to stay legible. */
const UNIT_READABLE_SCALE = 0.62;

export class Renderer {
  app: Application;
  world: World;
  bg: BackgroundLayer;
  worldLayer: Container;
  planetLayer: PlanetLayer;
  shipLayer: ShipLayer;
  hazardLayer: HazardLayer;
  /** Combat bursts — above planets so hits on a world flash over its body. */
  fx: FxLayer;
  lasso: Graphics;
  /** Drag-to-send aim line + target ring, redrawn per frame while live. */
  private dragGfx = new Graphics();
  private dragLabel: Text;
  private drag: { src: number; tgt: number | null; x: number; y: number } | null = null;
  private time = 0;

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
  /** Orientation the current fit was computed for (refit when it flips). */
  private fitPortrait = false;

  constructor(app: Application, world: World) {
    this.app = app;
    this.world = world;
    // Wall-clock seed: each match rolls its own (possible) nebulae.
    this.bg = new BackgroundLayer(
      app,
      app.screen.width,
      app.screen.height,
      Date.now() & 0x7fffffff,
    );
    app.stage.addChild(this.bg);

    this.worldLayer = new Container();
    app.stage.addChild(this.worldLayer);

    this.shipLayer = new ShipLayer(app, world);
    this.hazardLayer = new HazardLayer(app, world);
    this.planetLayer = new PlanetLayer(app, world);
    this.fx = new FxLayer(app);
    this.lasso = new Graphics();

    // Z-order: ship streams at the bottom, beneath asteroid debris, then
    // planets and their halos on top, then hazard neutrals over everything
    // so their dots stay legible against busy traffic. The HazardLayer
    // internally splits its asteroid vs. neutral subroots, so we add it
    // twice — once before planets (asteroids will be in their first child)
    // and the neutral overlay sits inside the same container above planets
    // via z-index. (The world's edge graph still exists for stream routing,
    // but the constellation lines themselves are intentionally not drawn.)
    this.worldLayer.addChild(this.shipLayer);
    this.worldLayer.addChild(this.hazardLayer);
    this.worldLayer.addChild(this.planetLayer);
    this.worldLayer.addChild(this.fx);
    this.worldLayer.addChild(this.lasso);
    this.dragLabel = new Text({
      text: '',
      style: {
        fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 15,
        fontWeight: '600',
        fill: 0xffffff,
      },
    });
    this.dragLabel.resolution = 2;
    this.dragLabel.anchor.set(0.5);
    this.dragLabel.visible = false;
    this.worldLayer.addChild(this.dragGfx, this.dragLabel);

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

  /**
   * Live aim for a drag-to-send gesture: pass the source planet, the planet
   * under the finger (null over empty space), and the finger's world point.
   * `null` source clears it. Drawn every frame in `update` while live so the
   * marching dashes animate and a drifting target stays locked.
   */
  setDragPreview(src: number | null, tgt: number | null, x = 0, y = 0): void {
    this.drag = src === null ? null : { src, tgt, x, y };
    if (!this.drag) {
      this.dragGfx.clear();
      this.dragLabel.visible = false;
    }
  }

  private drawDragPreview(): void {
    const g = this.dragGfx;
    g.clear();
    const d = this.drag;
    const src = d ? this.world.planets[d.src] : undefined;
    if (!d || !src || src.owner !== 0) {
      this.dragLabel.visible = false;
      return;
    }
    const pal = PLAYER_PALETTES[0];
    const px = 1 / this.viewScale; // one screen pixel in world units
    const tgt = d.tgt !== null && d.tgt !== d.src ? this.world.planets[d.tgt] : null;
    const ex = tgt ? tgt.pos.x : d.x;
    const ey = tgt ? tgt.pos.y : d.y;
    const dx = ex - src.pos.x;
    const dy = ey - src.pos.y;
    const len = Math.hypot(dx, dy);
    if (len < src.radius + 6) {
      this.dragLabel.visible = false;
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const x0 = src.pos.x + ux * (src.radius + 4);
    const y0 = src.pos.y + uy * (src.radius + 4);
    const stop = len - (tgt ? tgt.radius + 10 * px : 0);
    const x1 = src.pos.x + ux * stop;
    const y1 = src.pos.y + uy * stop;
    const color = tgt ? pal.core : pal.ring;
    const alpha = tgt ? 0.95 : 0.6;
    // Marching dashes in screen-constant sizes so the aim reads the same
    // at any zoom.
    const dash = 12 * px;
    const gap = 8 * px;
    const span = Math.hypot(x1 - x0, y1 - y0);
    let t = -((this.time * 60 * px) % (dash + gap));
    while (t < span) {
      const a = Math.max(0, t);
      const b = Math.min(span, t + dash);
      if (b > a) {
        g.moveTo(x0 + ux * a, y0 + uy * a).lineTo(x0 + ux * b, y0 + uy * b);
      }
      t += dash + gap;
    }
    g.stroke({ width: 7 * px, color: pal.glow, alpha: alpha * 0.3 });
    // Re-trace the same dashes as a crisp core.
    t = -((this.time * 60 * px) % (dash + gap));
    while (t < span) {
      const a = Math.max(0, t);
      const b = Math.min(span, t + dash);
      if (b > a) {
        g.moveTo(x0 + ux * a, y0 + uy * a).lineTo(x0 + ux * b, y0 + uy * b);
      }
      t += dash + gap;
    }
    g.stroke({ width: 2.5 * px, color, alpha });
    // Arrowhead at the business end.
    const ah = 11 * px;
    g.poly([
      x1 + ux * ah * 0.4, y1 + uy * ah * 0.4,
      x1 - ux * ah + -uy * ah * 0.6, y1 - uy * ah + ux * ah * 0.6,
      x1 - ux * ah - -uy * ah * 0.6, y1 - uy * ah - ux * ah * 0.6,
    ]).fill({ color, alpha });
    if (tgt) {
      // Lock-on ring: friendly reinforcement in the player's glow, an attack
      // in a hot white so "this will hit them" is unmistakable.
      const pulse = 1 + 0.06 * Math.sin(this.time * 8);
      const r = (tgt.radius + 7 * px) * pulse;
      const ringColor = tgt.owner === 0 ? pal.core : 0xffffff;
      g.circle(tgt.pos.x, tgt.pos.y, r).stroke({ width: 2.5 * px, color: ringColor, alpha: 0.9 });
      g.circle(tgt.pos.x, tgt.pos.y, r + 4 * px).stroke({
        width: 6 * px,
        color: pal.glow,
        alpha: 0.3,
      });
    }
    // How many ships this release commits — the whole garrison.
    const label = this.dragLabel;
    label.text = String(src.garrison);
    label.visible = src.garrison > 0;
    label.scale.set(px);
    // Offset sideways from the aim point so the finger doesn't cover it.
    label.x = x1 - uy * 22 * px - ux * 18 * px;
    label.y = y1 + ux * 22 * px - uy * 18 * px;
    label.tint = pal.ship;
  }

  /**
   * Screen rectangle the map is fitted into. Side padding shrinks on small
   * screens (every pixel counts on a phone), and the top keeps clear of the
   * HUD strip so start worlds never hide under the strength bars.
   */
  private fitRect(): { x: number; y: number; w: number; h: number } {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const pad = Math.max(10, Math.min(40, Math.min(sw, sh) * 0.04));
    const top = Math.max(pad, HUD_RESERVE_PX);
    return { x: pad, y: top, w: sw - pad * 2, h: sh - top - pad };
  }

  /** Scale at which the whole world rectangle fits the screen. */
  private fitScale(): number {
    const r = this.fitRect();
    return Math.min(r.w / this.world.width, r.h / this.world.height);
  }

  /**
   * World-space box around everything the player needs to see at match
   * start: planets with their orbit bands, and the hazard footprints. The
   * generator keeps a wide empty margin inside the world rectangle, so
   * framing the content instead of the rectangle buys a much closer camera —
   * which on a phone is the difference between tappable worlds and specks.
   * A drifting planet roams the whole map, so it opts back into full bounds.
   */
  private contentBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const w = this.world;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number, r: number): void => {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    };
    for (const p of w.planets) {
      if (p.vx !== 0 || p.vy !== 0) return { x0: 0, y0: 0, x1: w.width, y1: w.height };
      add(p.pos.x, p.pos.y, p.radius * 2.3 + 10);
    }
    for (const f of w.asteroidFields) add(f.pos.x, f.pos.y, f.radius);
    for (const bh of w.blackHoles) add(bh.pos.x, bh.pos.y, bh.gravityRadius);
    for (const fs of w.flareStars) add(fs.pos.x, fs.pos.y, fs.maxRadius * 0.6);
    for (const wh of w.wormholes) {
      add(wh.a.x, wh.a.y, wh.radius * 1.8);
      add(wh.b.x, wh.b.y, wh.radius * 1.8);
    }
    for (const z of w.swarmZones()) add(z.pos.x, z.pos.y, z.patrolRadius);
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: w.width, y1: w.height };
    return {
      x0: Math.max(0, x0),
      y0: Math.max(0, y0),
      x1: Math.min(w.width, x1),
      y1: Math.min(w.height, y1),
    };
  }

  /** Let small screens zoom out far enough to see the whole constellation. */
  private updateScaleBounds(): void {
    this.minScale = Math.min(0.4, this.fitScale() * 0.9);
  }

  fitToScreen(): void {
    this.updateScaleBounds();
    const r = this.fitRect();
    const b = this.contentBounds();
    const s = Math.min(r.w / (b.x1 - b.x0), r.h / (b.y1 - b.y0));
    this.viewScale = Math.max(this.minScale, Math.min(this.maxScale, s));
    this.viewX = r.x + r.w / 2 - ((b.x0 + b.x1) / 2) * this.viewScale;
    this.viewY = r.y + r.h / 2 - ((b.y0 + b.y1) / 2) * this.viewScale;
    this.fitPortrait = this.app.screen.height > this.app.screen.width;
    this.applyCamera();
  }

  /**
   * World-space multiplier for unit sprites so swarms never shrink below a
   * readable size on screen. 1 at desktop zoom; on a zoomed-out phone the
   * dots grow (up to 2×) instead of dissolving into sub-pixel specks.
   */
  get unitScale(): number {
    return Math.max(1, Math.min(2, UNIT_READABLE_SCALE / this.viewScale));
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
    // A device rotation reframes everything — the old zoom was chosen for
    // the other aspect, so refit instead of clamping a now-wrong view.
    if (height > width !== this.fitPortrait) {
      this.fitToScreen();
      return;
    }
    // Preserve the player's zoom/pan — mobile browsers fire resize whenever
    // the toolbar collapses/expands, and resetting the camera mid-match made
    // the view snap away under the player's fingers. Just refresh the scale
    // floor and re-clamp against the new screen size.
    this.updateScaleBounds();
    this.viewScale = Math.max(this.minScale, Math.min(this.maxScale, this.viewScale));
    this.applyCamera();
  }

  update(dt: number): void {
    this.time += dt;
    if (this.drag) this.drawDragPreview();
    const unitScale = this.unitScale;
    this.planetLayer.unitScale = unitScale;
    this.planetLayer.labelScale = Math.max(1, 0.9 / this.viewScale);
    this.shipLayer.unitScale = unitScale;
    this.hazardLayer.unitScale = unitScale;
    this.fx.unitScale = unitScale;
    this.bg.update(this.viewX, this.viewY, dt);
    this.planetLayer.update(dt);
    this.hazardLayer.update(dt);
    this.shipLayer.update(dt);
    this.fx.update(dt);
  }
}
