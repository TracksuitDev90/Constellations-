import { paletteFor } from '../util/color.js';
import type { World } from '../game/sim/World.js';

const btnStyle: Partial<CSSStyleDeclaration> = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#cfd6e4',
  // 44×44 is the minimum comfortable touch target on phones.
  width: '44px',
  height: '44px',
  borderRadius: '8px',
  cursor: 'pointer',
  fontSize: '18px',
  lineHeight: '1',
  padding: '0',
  touchAction: 'manipulation',
};

export class Hud {
  private root: HTMLElement;
  private bars: HTMLDivElement[] = [];
  private muteBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private pauseOverlay: HTMLDivElement;
  private onToggleMute: () => boolean;
  private onTogglePause: () => boolean;
  private onCycleSpeed: () => number;

  constructor(
    container: HTMLElement,
    world: World,
    onToggleMute: () => boolean,
    onTogglePause: () => boolean,
    onCycleSpeed: () => number,
    initialSpeed = 1,
  ) {
    this.onToggleMute = onToggleMute;
    this.onTogglePause = onTogglePause;
    this.onCycleSpeed = onCycleSpeed;
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      // Respect notches / rounded corners — viewport-fit=cover means content
      // otherwise slides under the safe-area cutouts on phones.
      top: 'max(12px, env(safe-area-inset-top))',
      left: 'max(12px, env(safe-area-inset-left))',
      right: 'max(12px, env(safe-area-inset-right))',
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      fontSize: '14px',
      color: '#cfd6e4',
    });

    // One strength bar per player, in player order (human first).
    for (const player of world.players) {
      const pal = paletteFor(player.id);
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        flex: '1',
        height: '10px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '6px',
        overflow: 'hidden',
        boxShadow: `0 0 12px #${pal.glow.toString(16).padStart(6, '0')}66`,
      });
      const fill = document.createElement('div');
      Object.assign(fill.style, {
        height: '100%',
        width: '50%',
        background: `#${pal.core.toString(16).padStart(6, '0')}`,
        transition: 'width 0.25s ease-out',
      });
      bar.appendChild(fill);
      this.bars.push(fill);
      this.root.appendChild(bar);
    }

    // Sim-speed cycle (1× → 2× → 4×), an Auralux staple for the slow
    // opening minutes of a match.
    this.speedBtn = document.createElement('button');
    this.speedBtn.textContent = `${initialSpeed}×`;
    this.speedBtn.title = 'Game speed';
    Object.assign(this.speedBtn.style, btnStyle, { fontSize: '15px' });
    this.speedBtn.addEventListener('click', () => {
      const speed = this.onCycleSpeed();
      this.speedBtn.textContent = `${speed}×`;
    });
    this.root.appendChild(this.speedBtn);

    this.pauseBtn = document.createElement('button');
    this.pauseBtn.textContent = '❙❙';
    this.pauseBtn.title = 'Pause (Space)';
    Object.assign(this.pauseBtn.style, btnStyle);
    this.pauseBtn.addEventListener('click', () => {
      const paused = this.onTogglePause();
      this.setPausedUI(paused);
    });
    this.root.appendChild(this.pauseBtn);

    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = '♪';
    Object.assign(this.muteBtn.style, btnStyle);
    this.muteBtn.addEventListener('click', () => {
      const muted = this.onToggleMute();
      this.muteBtn.textContent = muted ? '♪̸' : '♪';
      this.muteBtn.style.opacity = muted ? '0.4' : '1';
    });
    this.root.appendChild(this.muteBtn);

    // Fullscreen "Paused" overlay — visible when the game is paused so the
    // player has an unambiguous signal that time has stopped.
    this.pauseOverlay = document.createElement('div');
    Object.assign(this.pauseOverlay.style, {
      position: 'absolute',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
      background: 'rgba(4, 8, 18, 0.28)',
      color: '#eaf0ff',
      fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
      fontSize: '54px',
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      textShadow: '0 0 18px rgba(120,180,255,0.45)',
      zIndex: '10',
    });
    this.pauseOverlay.textContent = 'Paused';
    container.appendChild(this.pauseOverlay);

    container.appendChild(this.root);
    this.update(world);
  }

  /** Sync the button + overlay to match the game's paused state. */
  setPausedUI(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '▶' : '❙❙';
    this.pauseBtn.style.opacity = paused ? '0.7' : '1';
    this.pauseBtn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
    this.pauseOverlay.style.display = paused ? 'flex' : 'none';
  }

  update(world: World): void {
    const strengths = world.players.map((p) => world.totalGarrison(p.id));
    const total = Math.max(1, strengths.reduce((a, b) => a + b, 0));
    for (let i = 0; i < this.bars.length; i++) {
      this.bars[i].style.width = `${((strengths[i] ?? 0) / total) * 100}%`;
    }
  }

  destroy(): void {
    this.root.remove();
    this.pauseOverlay.remove();
  }
}
