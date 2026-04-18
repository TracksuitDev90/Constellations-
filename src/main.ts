import { Application } from 'pixi.js';
import { Game } from './game/Game.js';

const showFatal = (message: string): void => {
  const div = document.createElement('div');
  Object.assign(div.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: '#050810',
    color: '#ff9e9e',
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, monospace',
    fontSize: '14px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    textAlign: 'center',
    zIndex: '9999',
  } as CSSStyleDeclaration);
  div.textContent =
    'Constellations failed to start.\n\n' +
    message +
    '\n\nOpen the browser devtools console for the full error.';
  document.body.appendChild(div);
};

const bootstrap = async (): Promise<void> => {
  const app = new Application();
  await app.init({
    background: '#050810',
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  const appEl = document.getElementById('app');
  const uiEl = document.getElementById('ui');
  if (!appEl || !uiEl) throw new Error('Missing #app or #ui element');
  appEl.appendChild(app.canvas);

  const game = new Game(app, uiEl);
  game.start();
};

window.addEventListener('error', (e) => showFatal(String(e.error ?? e.message)));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason)));

bootstrap().catch((err) => {
  console.error(err);
  showFatal(String(err?.stack ?? err));
});
