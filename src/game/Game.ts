import { Application, ColorMatrixFilter } from 'pixi.js';
import { BasicAI } from './ai/BasicAI.js';
import { Audio } from './audio/Audio.js';
import { LEVELS, loadUnlockedCount, recordVictory } from './campaign.js';
import { Input } from './input/Input.js';
import { Selection } from './input/Selection.js';
import { generateMap } from './maps/generator.js';
import { ringCapacity, type Planet } from './sim/Planet.js';
import { loadPlanetAssets } from './render/planetAssets.js';
import { assignPlanetArchetypes } from './render/textures.js';
import { Renderer } from './render/Renderer.js';
import { World } from './sim/World.js';
import { Hud } from '../ui/Hud.js';
import { showOverlay } from '../ui/Overlay.js';
import { Tutorial, tutorialCompleted } from '../ui/Tutorial.js';

const FIXED_DT = 1 / 30;

export class Game {
  private app: Application;
  private ui: HTMLElement;
  private world!: World;
  private renderer!: Renderer;
  private selection!: Selection;
  /** One AI driver per rival — free-for-all levels have up to three. */
  private ais: BasicAI[] = [];
  /** Campaign level currently being played. */
  private levelIdx = 0;
  /** Sim-speed multiplier (1 / 2 / 4), cycled from the HUD. */
  private speed = 1;
  /**
   * End-of-match dramatization. −1 = match live. ≥0 = seconds since game
   * over: victory plays a shockwave cascade across the winner's worlds,
   * defeat desaturates the sky; the end overlay appears once it has played.
   */
  private endingT = -1;
  private endingWon = false;
  private desat: ColorMatrixFilter | null = null;
  private hud: Hud | null = null;
  private input: Input | null = null;
  private tutorial: Tutorial | null = null;
  private audio = new Audio();
  private accumulator = 0;
  private paused = false;
  private activeOverlay: HTMLDivElement | null = null;
  /** True while a match's loop/listeners are live (guards double-teardown). */
  private matchRunning = false;
  /** Last empty-space tap, for the double-tap "select entire fleet" gesture. */
  private lastEmptyTap = { t: -Infinity, x: 0, y: 0 };
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
    this.showLevelSelect();
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

  /** Campaign level select — the game's home screen. */
  private showLevelSelect(): void {
    this.dismissOverlay();
    const unlocked = loadUnlockedCount();
    this.activeOverlay = showOverlay(
      this.ui,
      'Constellations',
      `A meditative real-time strategy game in the spirit of <em>Auralux</em>.<br/>
       Tap a star to gather half its swarm — again for all of it — then tap
       anywhere to send them. Capture every star to win the sky.`,
      LEVELS.map((level, i) => {
        const locked = i >= unlocked;
        return {
          label: `${i + 1}. ${level.name}${locked ? ' 🔒' : ''}`,
          sub: locked ? 'Win the previous constellation to unlock.' : level.blurb,
          disabled: locked,
          onClick: () => {
            this.audio.unlock();
            this.dismissOverlay();
            this.launchLevel(i);
          },
        };
      }),
    );
  }

  private launchLevel(levelIdx: number): void {
    this.startMatch(levelIdx).catch((err) => {
      console.error('startMatch failed', err);
      this.showError(err);
    });
  }

  private dismissOverlay(): void {
    this.activeOverlay?.remove();
    this.activeOverlay = null;
  }

  private async startMatch(levelIdx: number): Promise<void> {
    // Tear down any previous match first — Input/HUD/ticker/listeners must
    // never stack across restarts (every retained Input duplicated taps and
    // hit-tested against a stale World).
    this.teardownMatch();
    this.levelIdx = levelIdx;
    const level = LEVELS[levelIdx];

    // Generate the map and assign each planet its texture archetype before
    // loading, so we fetch + alpha-scan only the ≤11 stickers this match
    // actually draws instead of the whole 39-image pool.
    const map = generateMap(level.map);
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
        ...level.aiConfigs.map((_, i) => ({
          id: i + 1,
          isAI: true,
          name: `Rival ${i + 1}`,
        })),
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
          const won = winner === 0;
          this.audio.endSting(won);
          this.endingT = 0;
          this.endingWon = won;
          if (won) {
            recordVictory(this.levelIdx);
            // Cascade of shockwaves across the player's worlds.
            this.renderer.planetLayer.celebrate(0);
          } else {
            // Defeat: the sky slowly loses its color before the overlay.
            this.desat = new ColorMatrixFilter();
            this.app.stage.filters = [this.desat];
          }
        },
      },
    );

    this.renderer = new Renderer(this.app, this.world);

    this.selection = new Selection(this.world, 0);
    this.ais = level.aiConfigs.map((cfg, i) => new BasicAI(this.world, i + 1, cfg));

    this.input = new Input(this.app.canvas as unknown as HTMLCanvasElement, this.renderer, this.world, {
      tapPlanet: (id) => {
        const p = this.world.planets[id];
        const hasPlanets = this.selection.ids.size > 0;
        const hasUnits = this.selection.hasSelectedUnits();
        const isOnlySelected =
          this.selection.ids.size === 1 && this.selection.ids.has(id);

        if (p.owner === 0) {
          // Friendly planet — the Auralux tap cycle:
          //   tap 1 (nothing selected)  → gather HALF this planet's swarm.
          //   tap 2 (sole selection)    → gather the WHOLE swarm.
          //   tap 3 (already full)      → feed the swarm into the planet's
          //                               own rings / hull (upgrade), or
          //                               clear if there's nothing to feed.
          //   tap with others selected  → reinforce: send the selection here
          //                               (auto-absorbing if it has rings).
          if (isOnlySelected) {
            if (this.selection.escalate(id)) {
              this.tutorial?.notify('select-full');
            } else if (p.ringCount > 0 || p.health < p.maxHealth) {
              // Absorb mode pulls the whole swarm to the core AND flushes
              // any garrison overflow, so a triple-tap always feeds
              // everything the planet holds. Auto-cancels when full.
              this.world.triggerAbsorb(id, 0, true);
              this.selection.clear();
              this.tutorial?.notify('feed');
            } else {
              this.selection.clear();
            }
          } else if (hasPlanets || hasUnits) {
            const absorb = p.ringCount > 0 || p.health < p.maxHealth;
            this.selection.routeTo(id, absorb);
            this.selection.clear();
            this.tutorial?.notify(absorb ? 'feed' : 'command');
          } else {
            this.selection.set(id);
            this.tutorial?.notify('select');
          }
        } else if (hasPlanets || hasUnits) {
          // Enemy or neutral planet with a selection → attack, then the
          // selection is spent (Auralux: every send is a committed wave).
          this.selection.routeTo(id);
          this.selection.clear();
          this.tutorial?.notify('command');
        }
      },
      tapEmpty: (wx, wy) => {
        const now = performance.now();
        if (this.selection.ids.size > 0 || this.selection.hasSelectedUnits()) {
          // With units selected, tap-empty sends them to hold that point.
          const sent = this.selection.routeToPoint(wx, wy);
          if (sent === 0) this.selection.clear();
        } else {
          // No selection: single tap clears; a quick second tap in the same
          // spot gathers the entire fleet (Auralux "select all" gesture).
          const dx = wx - this.lastEmptyTap.x;
          const dy = wy - this.lastEmptyTap.y;
          const closeEnough = dx * dx + dy * dy < 80 * 80;
          if (now - this.lastEmptyTap.t < 400 && closeEnough) {
            this.selection.selectAllOwned();
            this.tutorial?.notify('select-full');
          } else {
            this.selection.clear();
          }
        }
        this.lastEmptyTap = { t: now, x: wx, y: wy };
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
        if (this.selection.hasSelectedUnits()) this.tutorial?.notify('lasso');
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
      () => {
        this.speed = this.speed >= 4 ? 1 : this.speed * 2;
        return this.speed;
      },
      this.speed,
    );

    // First-constellation onboarding: teach by doing, once.
    this.tutorial =
      levelIdx === 0 && !tutorialCompleted() ? new Tutorial(this.ui) : null;

    this.accumulator = 0;
    this.paused = false;
    this.endingT = -1;
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
    this.tutorial?.destroy();
    this.tutorial = null;
    this.ais = [];
    this.app.stage.filters = [];
    this.desat = null;
    this.endingT = -1;
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
    const dt = frameMs / 1000;

    if (!this.world.gameOver) {
      // `speed` scales how much sim time each real second buys (1×/2×/4×).
      this.accumulator += dt * this.speed;
      let guard = 8;
      while (this.accumulator >= FIXED_DT && guard-- > 0) {
        this.world.step(FIXED_DT);
        for (const ai of this.ais) ai.update(FIXED_DT);
        this.selection.sync();
        this.accumulator -= FIXED_DT;
      }
      // Drop unpayable sim debt. If a slow device exhausts the step guard,
      // the leftover accumulator would otherwise grow without bound and pin
      // every subsequent frame at max catch-up work — the classic
      // fixed-timestep death spiral. Trading dropped time for a stable
      // frame rate is the right call on mobile.
      if (this.accumulator > FIXED_DT * 4) this.accumulator = FIXED_DT * 4;
    } else if (this.endingT >= 0) {
      // End-of-match dramatization: let the renderer keep breathing while
      // defeat drains the color out of the sky (victory's shockwave cascade
      // runs inside PlanetLayer), then present the overlay.
      this.endingT += dt;
      if (!this.endingWon && this.desat) {
        const k = Math.min(1, this.endingT / 1.6);
        this.desat.reset();
        this.desat.saturate(-0.85 * k, false);
      }
      const revealAfter = this.endingWon ? 2.2 : 1.9;
      if (this.endingT >= revealAfter && !this.activeOverlay) {
        this.showEndScreen(this.endingWon);
      }
    }

    // Shape the ambient-music phase into a smooth 0..1 breath and share it
    // with the layers so halos and unit glows swell with the soundtrack.
    const beat = 0.5 + 0.5 * Math.sin(this.audio.beatPhase01() * Math.PI * 2);
    this.renderer.planetLayer.setBeat(beat);
    this.renderer.shipLayer.setBeat(beat);

    this.renderer.planetLayer.setSelection(this.selection.ids);
    this.renderer.update(dt);
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
    const level = LEVELS[this.levelIdx];
    const next = won ? LEVELS[this.levelIdx + 1] : undefined;
    const buttons = [];
    if (next) {
      const nextIdx = this.levelIdx + 1;
      buttons.push({
        label: `Next: ${next.name}`,
        onClick: () => {
          this.dismissOverlay();
          this.launchLevel(nextIdx);
        },
      });
    }
    buttons.push({
      label: won ? `Replay ${level.name}` : 'Retry',
      onClick: () => {
        this.dismissOverlay();
        this.launchLevel(this.levelIdx);
      },
    });
    buttons.push({
      label: 'Constellations',
      onClick: () => {
        this.teardownMatch();
        this.showLevelSelect();
      },
    });
    this.activeOverlay = showOverlay(
      this.ui,
      won ? 'Victory' : 'Defeat',
      won
        ? next
          ? `${level.name} is yours. ${next.name} awaits.`
          : 'The final sky is yours. Every constellation has fallen to you.'
        : 'Your last star has gone dark. The sky belongs to your rivals — for now.',
      buttons,
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
            this.launchLevel(this.levelIdx);
          },
        },
        {
          label: 'Constellations',
          onClick: () => {
            this.teardownMatch();
            this.showLevelSelect();
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
