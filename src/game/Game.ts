import { Application, AlphaFilter } from 'pixi.js';
import { BasicAI } from './ai/BasicAI.js';
import { Audio } from './audio/Audio.js';
import { Input } from './input/Input.js';
import { Selection } from './input/Selection.js';
import { ORION_MAP } from './maps/orion.js';
import { Renderer } from './render/Renderer.js';
import { World } from './sim/World.js';
import { Hud } from '../ui/Hud.js';
import { showOverlay } from '../ui/Overlay.js';

const FIXED_DT = 1 / 30;

export class Game {
  private app: Application;
  private ui: HTMLElement;
  private world!: World;
  private renderer!: Renderer;
  private selection!: Selection;
  private ai!: BasicAI;
  private hud!: Hud;
  private audio = new Audio();
  private accumulator = 0;
  private paused = false;
  private activeOverlay: HTMLDivElement | null = null;

  constructor(app: Application, ui: HTMLElement) {
    this.app = app;
    this.ui = ui;
  }

  start(): void {
    this.showMainMenu();
  }

  private showMainMenu(): void {
    this.activeOverlay = showOverlay(
      this.ui,
      'Constellations',
      `A meditative real-time strategy game inspired by <em>Auralux</em>.<br/>
       Tap or click a planet you own, then a target, to route ships along the
       constellation. Pinch or scroll to zoom; drag with two fingers to pan.<br/>
       Capture every star to win.`,
      [
        {
          label: 'Begin',
          onClick: () => {
            this.audio.unlock();
            this.dismissOverlay();
            this.startMatch();
          },
        },
      ],
    );
  }

  private dismissOverlay(): void {
    this.activeOverlay?.remove();
    this.activeOverlay = null;
  }

  private startMatch(): void {
    // Reset stage.
    this.app.stage.removeChildren();
    this.app.stage.filters = [];

    this.world = new World(
      ORION_MAP,
      [
        { id: 0, isAI: false, name: 'You' },
        { id: 1, isAI: true, name: 'Rival' },
      ],
      {
        onShipLaunch: (owner) => {
          if (owner === 0) this.audio.shipLaunch();
        },
        onPlanetCapture: () => {
          this.audio.planetCaptured();
        },
        onGameOver: (winner) => {
          this.audio.endSting(winner === 0);
          this.paused = true;
          this.showEndScreen(winner === 0);
        },
      },
    );

    this.renderer = new Renderer(this.app, this.world);

    // Soft bloom via alpha-blended duplicate would require a filter dep we skipped.
    // Use AlphaFilter as a lightweight overall sheen instead.
    this.app.stage.filters = [new AlphaFilter({ alpha: 1 })];

    this.selection = new Selection(this.world, 0);
    this.ai = new BasicAI(this.world, 1);

    new Input(this.app.canvas as unknown as HTMLCanvasElement, this.renderer, this.world, {
      tapPlanet: (id) => {
        const p = this.world.planets[id];
        if (p.owner === 0) {
          this.selection.toggle(id);
        } else if (this.selection.ids.size > 0) {
          this.selection.routeTo(id);
        }
      },
      tapEmpty: () => this.selection.clear(),
      dragCommit: (src, tgt) => {
        if (this.world.planets[src].owner !== 0) return;
        this.world.openStream(0, src, tgt);
      },
      dragPreview: () => {
        // Could render a preview arrow; skipped for v1 to keep visuals clean.
      },
      pan: (dx, dy) => this.renderer.panBy(dx, dy),
      zoom: (scale, ax, ay) => this.renderer.setZoom(scale, ax, ay),
    });

    window.addEventListener('keydown', this.onKey);

    this.hud = new Hud(this.ui, this.world, () => {
      this.audio.setMuted(!this.audio.muted);
      return this.audio.muted;
    });

    this.accumulator = 0;
    this.paused = false;
    this.app.ticker.add(this.loop);

    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    this.app.renderer.resize(window.innerWidth, window.innerHeight);
    this.renderer.onResize(window.innerWidth, window.innerHeight);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'a' || e.key === 'A') {
      this.selection.selectAllOwned();
    } else if (e.key === 'Escape') {
      this.selection.clear();
    } else if (e.key === ' ') {
      e.preventDefault();
      this.paused = !this.paused;
    }
  };

  private loop = (): void => {
    if (this.paused) return;
    const frameMs = this.app.ticker.deltaMS;
    this.accumulator += frameMs / 1000;
    let guard = 6;
    while (this.accumulator >= FIXED_DT && guard-- > 0) {
      this.world.step(FIXED_DT);
      this.ai.update(FIXED_DT);
      this.selection.sync();
      this.accumulator -= FIXED_DT;
    }
    this.renderer.planetLayer.setSelection(this.selection.ids);
    this.renderer.update(frameMs / 1000);
    this.hud.update(this.world);
  };

  private showEndScreen(won: boolean): void {
    this.activeOverlay = showOverlay(
      this.ui,
      won ? 'Victory' : 'Defeat',
      won
        ? 'The constellation is yours. Well played.'
        : 'The rival has claimed every star. The night belongs to them — for now.',
      [
        {
          label: 'Play again',
          onClick: () => {
            this.dismissOverlay();
            this.cleanup();
            this.startMatch();
          },
        },
      ],
    );
  }

  private cleanup(): void {
    this.app.ticker.remove(this.loop);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.hud?.destroy();
  }
}
