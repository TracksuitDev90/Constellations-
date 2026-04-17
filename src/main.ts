import { Application } from 'pixi.js';
import { Game } from './game/Game.js';

const bootstrap = async (): Promise<void> => {
  const app = new Application();
  await app.init({
    background: '#050810',
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    preference: 'webgl',
  });

  const appEl = document.getElementById('app') as HTMLElement;
  const uiEl = document.getElementById('ui') as HTMLElement;
  appEl.appendChild(app.canvas);

  const game = new Game(app, uiEl);
  game.start();
};

void bootstrap();
