import { paletteFor } from '../util/color.js';
import type { World } from '../game/sim/World.js';

export class Hud {
  private root: HTMLElement;
  private bars: HTMLDivElement[] = [];
  private muteBtn: HTMLButtonElement;
  private onToggleMute: () => boolean;

  constructor(container: HTMLElement, world: World, onToggleMute: () => boolean) {
    this.onToggleMute = onToggleMute;
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

    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = '♪';
    Object.assign(this.muteBtn.style, {
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.12)',
      color: '#cfd6e4',
      width: '36px',
      height: '28px',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
    });
    this.muteBtn.addEventListener('click', () => {
      const muted = this.onToggleMute();
      this.muteBtn.textContent = muted ? '♪\u0338' : '♪';
      this.muteBtn.style.opacity = muted ? '0.4' : '1';
    });
    this.root.appendChild(this.muteBtn);

    container.appendChild(this.root);
    this.update(world);
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
  }
}
