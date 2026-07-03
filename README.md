# Constellations

A minimalist, real-time strategy game for the browser — played on mouse + keyboard or touch (iPad / phone). Built to play like *Auralux: Constellations*.

Every star you own continuously produces ships. Gather your swarm, send it across open space to overwhelm rivals, feed your own ringed stars to evolve them, and capture every star in the constellation. An eight-level campaign ramps from a sleepy first opponent to fierce four-way free-for-alls.

## How it plays

- **Movement is free-flight.** Waves fly straight where you send them and fight 1-for-1 wherever enemy swarms cross. The constellation lines are the map's skeleton, not lanes.
- **Commitment is the skill.** Tap your star once to gather **half** its swarm, again for **all** of it — deciding how much to risk is the whole game.
- **Feeding is growth.** Send units into your own ringed star (or tap it a third time) to fill its rings; a full set of rings evolves it into a bigger, faster star. The `n / cap` readout under your ringed stars shows exactly what the next evolution costs.
- **Hazards change each sky.** Drifting planets, asteroid belts that slow crossings, and hostile green swarms that attack everyone.

## Controls

**Touch (iPad / phone):**
- Tap a star you own → gather half its swarm. Tap it again → gather all of it.
- Tap a third time on a ringed star → feed the swarm into its rings.
- Tap any other star → send the gathered swarm (reinforces friends, attacks everyone else).
- Tap empty space with a swarm gathered → send it there to hold position.
- Double-tap empty space → gather your entire fleet.
- Drag across empty space → lasso any of your units, anywhere.
- Drag from one of your stars to a target → quick full-garrison wave.
- Pinch to zoom, two-finger drag to pan.

**Mouse + keyboard:**
- Click follows the same rules as tap.
- `A` — select your whole fleet. `Esc` — clear selection / stop absorbing. `F` — toggle absorb on selected stars. `Space` — pause.
- Scroll wheel — zoom.

**HUD:** per-player strength bars, game speed (1× / 2× / 4×), pause, mute.

## The campaign

Eight constellations, unlocked in order (progress saves locally). The first two are deliberately gentle; every level after adds one new pressure:

| # | Constellation | What's waiting |
|---|---------------|----------------|
| 1 | Orion | A sleepy rival. Learn to gather and send. |
| 2 | Lyra | Learn to feed a ringed star and evolve it. |
| 3 | Cassiopeia | An asteroid belt slows every crossing. |
| 4 | Perseus | Random hazards; the rival is awake now. |
| 5 | Ursa Major | Three-way free-for-all. |
| 6 | Draco | Three-way, with hazards and a fierce rival. |
| 7 | Cygnus | Four armies under one sky. |
| 8 | Andromeda | Every rival fierce, every hazard possible. |

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
- All audio is synthesized live in the Web Audio API. Planet art from the sticker set in `public/textures` (see CREDITS.md); everything else is drawn procedurally.

## Project layout

```
src/
  main.ts                 # Pixi bootstrap
  game/
    Game.ts               # scene lifecycle, campaign flow, main loop
    campaign.ts           # level definitions + local progress
    sim/                  # pure game logic (World, Planet, Ship, Stream)
    ai/                   # heuristic opponents (Chill / Normal / Fierce)
    render/               # Pixi layers (background, links, planets, ships)
    input/                # unified pointer handling + swarm selection
    audio/                # synthesized music + SFX
    maps/                 # procedural constellation generator
  ui/                     # HTML overlay (HUD, menus, tutorial, end screen)
  util/                   # math + color helpers
```

## Roadmap (post-campaign)

- Gamepad support
- Online multiplayer
- Authored (non-procedural) constellation layouts for the campaign skies
