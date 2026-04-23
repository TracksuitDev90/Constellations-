import { paletteFor } from '../util/color.js';
import type { World } from '../game/sim/World.js';

const btnStyle: Partial<CSSStyleDeclaration> = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#cfd6e4',
  width: '36px',
  height: '28px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '16px',
  lineHeight: '1',
  padding: '0',
};

export class Hud {
  private root: HTMLElement;
  private bars: HTMLDivElement[] = [];
  private muteBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private pauseOverlay: HTMLDivElement;
  private onToggleMute: () => boolean;
  private onTogglePause: () => boolean;

  constructor(
    container: HTMLElement,
    world: World,
    onToggleMute: () => boolean,
    onTogglePause: () => boolean,
  ) {
    this.onToggleMute = onToggleMute;
    this.onTogglePause = onTogglePause;
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      top: '12px',
      left: '12px',
      right: '12px',
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
      fontSize: '14px',
      color: '#cfd6e4',
    });

    // Two bars (player 0, player 1)
    for (let i = 0; i < 2; i++) {
      const pal = paletteFor(i);
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
    const t0 = world.totalGarrison(0);
    const t1 = world.totalGarrison(1);
    const total = Math.max(1, t0 + t1);
    this.bars[0].style.width = `${(t0 / total) * 100}%`;
    this.bars[1].style.width = `${(t1 / total) * 100}%`;
  }

  destroy(): void {
    this.root.remove();
    this.pauseOverlay.remove();
  }
}
