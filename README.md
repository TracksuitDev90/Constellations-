# Constellations

A minimalist, real-time strategy game for the browser — played on mouse + keyboard or touch (iPad / phone). Inspired by the flow-based gameplay of *Auralux: Constellations*.

Every planet you own continuously produces ships. Route those streams from planet to planet along the constellation's edges to overwhelm your rival and capture every star.

## Controls

**Touch (iPad / phone):**
- Tap a planet you own → select (glowing ring). Tap more to add to your group.
- Tap an empty region → clear selection.
- Tap any other planet → route all selected sources to it.
- Or: drag from one of your planets directly to any target.
- Pinch to zoom, two-finger drag to pan.

**Mouse + keyboard:**
- Click to select / route (same rules as touch).
- Drag from an owned planet to a target as a shortcut.
- `A` — select all owned planets. `Esc` — clear selection. `Space` — pause.
- Scroll wheel — zoom. Middle-drag (or two-finger trackpad) — pan.

## Running locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173 in a browser.

## Build

```bash
npm run build       # type-check + bundle into dist/
npm run preview     # serve the built bundle locally
npm test            # simulation unit tests
```

## Deployment

Pushes to `main` are built by `.github/workflows/deploy.yml` and published to GitHub Pages. Enable Pages for the repo with **Source: GitHub Actions** (Settings → Pages) once.

## Tech

- **TypeScript** (strict)
- **PixiJS v8** — WebGL 2D renderer with HiDPI / Retina support
- **Vite** — dev server and bundler
- **Vitest** — simulation tests
- All audio is synthesized live in the Web Audio API; all graphics are drawn procedurally. No external assets, no licensing concerns.

## Project layout

```
src/
  main.ts                 # Pixi bootstrap
  game/
    Game.ts               # scene lifecycle, main loop
    sim/                  # pure game logic (World, Planet, Ship, Stream)
    ai/                   # heuristic opponent
    render/               # Pixi layers (background, links, planets, ships)
    input/                # unified pointer handling + selection
    audio/                # synthesized music + SFX
    maps/                 # map definitions (starts with Orion)
  ui/                     # HTML overlay (HUD, menus, end screen)
  util/                   # math + color helpers
```

## Roadmap (post-v1)

- More constellation maps (Ursa Major, Cassiopeia, Lyra, …)
- Free-for-all with multiple AI opponents
- Difficulty selector
- Level select + progress save
- Gamepad support
- Online multiplayer
