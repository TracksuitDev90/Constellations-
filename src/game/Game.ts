import { Application } from 'pixi.js';
import { BasicAI } from './ai/BasicAI.js';
import { Audio } from './audio/Audio.js';
import { Input } from './input/Input.js';
import { Selection } from './input/Selection.js';
import { generateOrionMap } from './maps/orion.js';
import { ringCapacity, type Planet } from './sim/Planet.js';
import { loadPlanetAssets } from './render/planetAssets.js';
import { assignPlanetArchetypes } from './render/textures.js';
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
  private hud: Hud | null = null;
  private input: Input | null = null;
  private audio = new Audio();
  private accumulator = 0;
  private paused = false;
  private activeOverlay: HTMLDivElement | null = null;
  /** True while a match's loop/listeners are live (guards double-teardown). */
  private matchRunning = false;
  /**
   * Rolling 1.0s window of ship-death timestamps. Each frame the size of
   * this window normalizes into a 0..1 combat-tension score that drives
   * the persistent rumble in Audio so a brawl audibly swells and fades.
   */
  private deathTimestamps: number[] = [];

  constructor(app: Application, ui: HTMLElement) {
    this.app = app;
    this.ui = ui;
  }

  start(): void {
    // Auto-pause + audio suspend when the tab/app goes to background; saves
    // battery on mobile and stops the ambient drone from playing over other
    // apps. Registered once for the Game's lifetime.
    document.addEventListener('visibilitychange', this.onVisibility);
    // iOS can leave the AudioContext in 'suspended'/'interrupted' after a
    // phone call, Siri, or an audio-route change; any fresh touch re-arms it.
    window.addEventListener('pointerdown', this.onPointerResume, { passive: true });
    this.showMainMenu();
  }

  private onPointerResume = (): void => {
    if (!document.hidden) this.audio.resume();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.matchRunning && !this.paused) {
        this.paused = true;
        this.hud?.setPausedUI(true);
      }
      this.audio.suspend();
    } else {
      this.audio.resume();
    }
  };

  private showMainMenu(): void {
    this.activeOverlay = showOverlay(
      this.ui,
      'Constellations',
      `A meditative real-time strategy game inspired by <em>Auralux</em>.<br/>
       Tap a planet you own, then any planet to send a wave. Selection sticks,
       so keep tapping targets to redirect. Tap a friendly ringed world (with
       nothing else selected) to <em>absorb</em> its orbit units — they fill
       the rings, and when every ring is full the planet explodes into a
       bigger, faster size. Absorb also heals damage first.<br/>
       Pinch or scroll to zoom; drag with two fingers to pan. Capture every
       star to win.`,
      [
        {
          label: 'Begin',
          onClick: () => {
            this.audio.unlock();
            this.dismissOverlay();
            this.startMatch().catch((err) => {
              console.error('startMatch failed', err);
              this.showError(err);
            });
          },
        },
      ],
    );
  }

  private dismissOverlay(): void {
    this.activeOverlay?.remove();
    this.activeOverlay = null;
  }

  private async startMatch(): Promise<void> {
    // Tear down any previous match first — Input/HUD/ticker/listeners must
    // never stack across restarts (every retained Input duplicated taps and
    // hit-tested against a stale World).
    this.teardownMatch();

    // Generate the map and assign each planet its texture archetype before
    // loading, so we fetch + alpha-scan only the ≤9 stickers this match
    // actually draws instead of the whole 39-image pool.
    const map = generateOrionMap();
    const archetypes = assignPlanetArchetypes(
      map.planets.map((_, i) => i),
      // Wall-clock seed so replays shuffle the pool.
      Date.now() & 0x7fffffff,
    );
    // Never throws — individual failures fall back to procedural bodies.
    await loadPlanetAssets(archetypes);

    // Reset stage. Destroy children so old Graphics/Sprites release their
    // GPU buffers (removeChildren alone leaked them across restarts); shared
    // cached textures survive because texture destruction stays off.
    for (const child of this.app.stage.removeChildren()) {
      child.destroy({ children: true, texture: false });
    }

    this.world = new World(
      map,
      [
        { id: 0, isAI: false, name: 'You' },
        { id: 1, isAI: true, name: 'Rival' },
      ],
      {
        onShipLaunch: (owner) => {
          if (owner === 0) this.audio.shipLaunch();
        },
        onShipArrive: (planetId, owner, friendly) => {
          // Only chime for events that involve the player — either landing
          // on player territory, or the player chipping at an enemy world.
          const planet = this.world.planets[planetId];
          const isPlayerEvent = owner === 0 || planet.owner === 0;
          if (!isPlayerEvent) return;
          const fill = ringFillProgress(planet);
          this.audio.shipArrival(planetId, friendly, fill);
        },
        onRingFilled: (_planetId, ringIndex, owner) => {
          if (owner !== 0) return;
          this.audio.ringFilled(ringIndex);
        },
        onRingProgress: (planetId, ringIndex, owner) => {
          if (owner !== 0) return;
          this.audio.ringTick(planetId, ringIndex);
        },
        onShipAbsorbed: (planetId, owner) => {
          if (owner !== 0) return;
          this.audio.shipAbsorbed(planetId);
        },
        onShipDeath: () => {
          this.audio.shipDeath();
          this.deathTimestamps.push(performance.now());
        },
        onPlanetEvolve: (_planetId, owner, newType) => {
          if (owner !== 0) return;
          this.audio.planetEvolve(newType);
        },
        onPlanetCapture: () => {
          this.audio.planetCaptured();
        },
        onPlanetNeutralized: () => {
          // The planet's hull finally gave out — a distinct "broken shield"
          // cue so the player registers it as a different event from a
          // normal ownership flip.
          this.audio.planetNeutralized();
        },
        onGameOver: (winner) => {
          this.audio.endSting(winner === 0);
          this.paused = true;
          this.showEndScreen(winner === 0);
        },
      },
    );

    this.renderer = new Renderer(this.app, this.world);

    this.selection = new Selection(this.world, 0);
    this.ai = new BasicAI(this.world, 1);

    this.input = new Input(this.app.canvas as unknown as HTMLCanvasElement, this.renderer, this.world, {
      tapPlanet: (id) => {
        const p = this.world.planets[id];
        const selectedIds = this.selection.ids;
        const hasSelection = selectedIds.size > 0;
        const isOnlySelected = selectedIds.size === 1 && selectedIds.has(id);

        if (p.owner === 0) {
          // Friendly planet. Three behaviors depending on current selection:
          //   (a) No selection → select this planet.
          //   (b) Selected other planets → reinforce this planet (route to it).
          //       If it has rings (or damage), arriving units auto-absorb so
          //       the player sees rings fill and the planet grow from one tap.
          //   (c) This planet is the sole selection → toggle absorb (fills
          //       rings / heals / feeds upgrade meter).
          if (!hasSelection) {
            this.selection.set(id);
          } else if (isOnlySelected) {
            this.world.triggerAbsorb(id, 0, !p.absorbing);
          } else {
            const absorb = p.ringCount > 0 || p.health < p.maxHealth;
            this.selection.routeTo(id, absorb);
          }
        } else if (hasSelection) {
          // Enemy or neutral planet with selection → attack.
          this.selection.routeTo(id);
        }
      },
      tapEmpty: (wx, wy) => {
        // With units selected, tap-empty sends them to that world point and
        // they loiter there. Without a selection, tap-empty clears state.
        if (this.selection.ids.size > 0) {
          const sent = this.selection.routeToPoint(wx, wy);
          if (sent === 0) this.selection.clear();
        } else {
          this.selection.clear();
        }
      },
      dragCommit: (src, tgt) => {
        if (this.world.planets[src].owner !== 0) return;
        this.world.openStream(0, src, tgt);
      },
      dragPreview: () => {
        // Could render a preview arrow; skipped for v1 to keep visuals clean.
      },
      lassoUpdate: (x0, y0, x1, y1) => this.renderer.setLasso(x0, y0, x1, y1),
      lassoCommit: (x0, y0, x1, y1) => {
        const radius = Math.hypot(x1 - x0, y1 - y0);
        this.selection.selectInCircle(x0, y0, radius);
        this.renderer.clearLasso();
      },
      lassoCancel: () => this.renderer.clearLasso(),
      pan: (dx, dy) => this.renderer.panBy(dx, dy),
      zoom: (scale, ax, ay) => this.renderer.setZoom(scale, ax, ay),
    });

    window.addEventListener('keydown', this.onKey);

    this.hud = new Hud(
      this.ui,
      this.world,
      () => {
        this.audio.setMuted(!this.audio.muted);
        return this.audio.muted;
      },
      () => {
        this.paused = !this.paused;
        return this.paused;
      },
    );

    this.accumulator = 0;
    this.paused = false;
    this.deathTimestamps.length = 0;
    this.app.ticker.add(this.loop);

    window.addEventListener('resize', this.onResize);
    this.matchRunning = true;
  }

  /** Undo everything `startMatch` set up. Safe to call when nothing is live. */
  private teardownMatch(): void {
    if (!this.matchRunning) return;
    this.matchRunning = false;
    this.app.ticker.remove(this.loop);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.input?.destroy();
    this.input = null;
    this.hud?.destroy();
    this.hud = null;
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
      // Also cancel any in-progress absorb so Escape is a universal "stop".
      for (const p of this.world.planets) {
        if (p.owner === 0 && p.absorbing) this.world.triggerAbsorb(p.id, 0, false);
      }
    } else if (e.key === 'f' || e.key === 'F') {
      // Keyboard shortcut: toggle absorb on every selected friendly planet.
      for (const id of this.selection.ids) {
        const p = this.world.planets[id];
        if (p.owner === 0) this.world.triggerAbsorb(id, 0, !p.absorbing);
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      this.paused = !this.paused;
      this.hud?.setPausedUI(this.paused);
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
    // Drop unpayable sim debt. If a slow device exhausts the step guard, the
    // leftover accumulator would otherwise grow without bound and pin every
    // subsequent frame at max catch-up work — the classic fixed-timestep
    // death spiral. Trading dropped time for a stable frame rate is the
    // right call on mobile.
    if (this.accumulator > FIXED_DT * 4) this.accumulator = FIXED_DT * 4;
    this.renderer.planetLayer.setSelection(this.selection.ids);
    this.renderer.update(frameMs / 1000);
    this.hud?.update(this.world);

    // Combat tension: count ship deaths in the trailing 1s window and pass
    // the normalized intensity to the audio rumble. ~8 deaths/s saturates.
    const nowMs = performance.now();
    const windowStart = nowMs - 1000;
    while (this.deathTimestamps.length > 0 && this.deathTimestamps[0] < windowStart) {
      this.deathTimestamps.shift();
    }
    this.audio.combatTension(Math.min(1, this.deathTimestamps.length / 8));
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
            this.startMatch().catch((err) => {
              console.error('restart failed', err);
              this.showError(err);
            });
          },
        },
      ],
    );
  }

  private showError(err: unknown): void {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    this.activeOverlay = showOverlay(
      this.ui,
      'Something went wrong',
      `The match failed to start.<br/><br/><code style="font-size:12px;opacity:0.8">${escapeHtml(msg)}</code>`,
      [
        {
          label: 'Retry',
          onClick: () => {
            this.dismissOverlay();
            this.startMatch().catch((e) => {
              console.error('retry failed', e);
              this.showError(e);
            });
          },
        },
      ],
    );
  }
}

/** 0..1 progress toward filling the planet's next capacity ring. */
const ringFillProgress = (planet: Planet): number => {
  if (planet.ringCount === 0) return 0;
  for (let i = 0; i < planet.ringCount; i++) {
    const cap = ringCapacity(planet.type, i);
    if (cap <= 0) continue;
    const fill = planet.ringFillProgress[i] ?? 0;
    if (fill < cap) return Math.max(0, Math.min(1, fill / cap));
  }
  return 1;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
