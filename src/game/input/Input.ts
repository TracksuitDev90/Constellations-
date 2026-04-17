import type { Renderer } from '../render/Renderer.js';
import type { World } from '../sim/World.js';

export interface PointerState {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startTime: number;
  moved: boolean;
  sourcePlanet: number | null;
}

export interface InputCallbacks {
  tapPlanet: (planetId: number) => void;
  tapEmpty: () => void;
  dragCommit: (sourcePlanet: number, targetPlanet: number) => void;
  dragPreview: (sourcePlanet: number | null, targetPlanet: number | null) => void;
  pan: (dx: number, dy: number) => void;
  zoom: (scale: number, anchorX: number, anchorY: number) => void;
}

const TAP_MOVE_THRESHOLD = 8; // px
const TAP_TIME_THRESHOLD = 300; // ms

export class Input {
  private el: HTMLElement;
  private renderer: Renderer;
  private world: World;
  private cb: InputCallbacks;
  private pointers = new Map<number, PointerState>();
  private lastPinchDist = 0;
  private lastPanMid: { x: number; y: number } | null = null;

  constructor(el: HTMLElement, renderer: Renderer, world: World, cb: InputCallbacks) {
    this.el = el;
    this.renderer = renderer;
    this.world = world;
    this.cb = cb;

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private screenFromEvent(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private planetAtScreen(sx: number, sy: number): number | null {
    const w = this.renderer.screenToWorld(sx, sy);
    const hit = this.world.planetAt(w.x, w.y, 10 / this.renderer.viewScale);
    return hit ? hit.id : null;
  }

  private onDown = (e: PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const { x, y } = this.screenFromEvent(e);
    const src = this.planetAtScreen(x, y);
    const owned = src !== null && this.world.planets[src].owner === 0 ? src : null;
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      startX: x,
      startY: y,
      x,
      y,
      startTime: performance.now(),
      moved: false,
      sourcePlanet: owned,
    });
    if (this.pointers.size === 2) {
      this.lastPinchDist = this.currentPinchDistance();
      this.lastPanMid = this.currentPinchMidpoint();
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const { x, y } = this.screenFromEvent(e);
    p.x = x;
    p.y = y;
    const moved = Math.hypot(x - p.startX, y - p.startY) > TAP_MOVE_THRESHOLD;
    if (moved) p.moved = true;

    if (this.pointers.size >= 2) {
      // Pinch + two-finger pan
      const dist = this.currentPinchDistance();
      const mid = this.currentPinchMidpoint();
      if (this.lastPinchDist > 0) {
        const scaleFactor = dist / this.lastPinchDist;
        if (Math.abs(scaleFactor - 1) > 0.001) {
          this.cb.zoom(this.renderer.viewScale * scaleFactor, mid.x, mid.y);
        }
      }
      if (this.lastPanMid) {
        this.cb.pan(mid.x - this.lastPanMid.x, mid.y - this.lastPanMid.y);
      }
      this.lastPinchDist = dist;
      this.lastPanMid = mid;
      return;
    }

    if (p.sourcePlanet !== null && p.moved) {
      const hover = this.planetAtScreen(x, y);
      this.cb.dragPreview(p.sourcePlanet, hover);
    }
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) {
      this.lastPinchDist = 0;
      this.lastPanMid = null;
    }

    const dt = performance.now() - p.startTime;
    if (!p.moved && dt < TAP_TIME_THRESHOLD) {
      const hit = this.planetAtScreen(p.x, p.y);
      if (hit !== null) this.cb.tapPlanet(hit);
      else this.cb.tapEmpty();
      return;
    }

    if (p.sourcePlanet !== null) {
      const hover = this.planetAtScreen(p.x, p.y);
      if (hover !== null && hover !== p.sourcePlanet) {
        this.cb.dragCommit(p.sourcePlanet, hover);
      }
    }
    this.cb.dragPreview(null, null);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.cb.zoom(this.renderer.viewScale * factor, sx, sy);
  };

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private currentPinchMidpoint(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
