---
name: verify
description: Launch and drive Constellations in a headless browser to verify rendering/gameplay changes with screenshots.
---

# Verifying Constellations changes

Vite + Pixi.js browser game. No test harness for visuals — drive the real app.

## Launch

```bash
npx vite --port 5199 --strictPort &   # dev server, from repo root
```

Playwright (install in a scratch dir, NOT the repo) with the pre-installed
Chromium — do not run `playwright install`:

```js
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

## Drive

- Wait for `window.__game` (dev-only handle exposed by src/main.ts).
- Enter a match through the real UI: `page.click('text=1. Orion')`.
- Hazards roll randomly per match. Level 0 (Orion) pool is asteroidField only.
  To re-roll: `__game.dismissOverlay(); __game.launchLevel(0)` then check
  `__game.world.asteroidFields.length` (also `.blackHoles`, `.flareStars`,
  `.wormholes`).
- Camera: `const r = __game.renderer; r.viewScale = s; r.viewX = cx - wx*s;
  r.viewY = cy - wy*s; r.applyCamera();` (TS-private but reachable at runtime),
  or `r.fitToScreen()`.
- Speed up the sim for buildup shots: `__game.speed = 4`.
- HUD strength bars are the DOM divs whose inline style transitions `width`.

## Gotchas

- `launchLevel` called directly leaves the home overlay up — either click the
  level button or call `dismissOverlay()` first.
- Planet textures bake async at match start; wait ~2s after launch.
- Listen for `pageerror` — src/main.ts also paints fatal errors full-screen.
