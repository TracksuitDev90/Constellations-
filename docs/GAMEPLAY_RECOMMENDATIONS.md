# Gameplay Recommendations — Getting Closer to Auralux

An audit-driven list of design changes that would move Constellations from
"inspired by Auralux" to "plays like Auralux," ordered roughly by impact.
Each item names the code it touches so it can be picked up as a standalone
task. Nothing here is implemented yet — this is the design backlog.

## 1. Commit to one movement model (highest impact)

Auralux has **no routing graph**: swarms fly straight where you send them,
and the tension comes from open space being dangerous. Today the game has
two conflicting models:

- `World.openStream` routes waves hop-by-hop along the edge graph (BFS in
  `findPath`), used by planet-tap orders and the AI.
- `World.commandSelectedTo` flies units directly with boids, used whenever
  actual units are selected.

The same tap can behave completely differently depending on whether a
selection happens to contain live units. Pick one:

- **Auralux-faithful**: drop the graph for movement entirely; the edge
  graph still routes stream waves but the constellation lines are no
  longer drawn. `openStream` becomes "launch garrison as a direct wave."
- **Identity-preserving**: keep graph routing for everything, including
  `commandSelectedTo` — lanes become the game's signature. Then hostile
  chokepoints (hazards on edges) become real strategy.

Either is fine; the current mix is the worst of both.

## 2. Fractional commitment (the core Auralux skill)

Auralux's depth comes from deciding *how much* to send. Today every order
commits 100% of the selection. Add:

- Double-tap a planet → select all owned planets (already `A` on keyboard,
  `Selection.selectAllOwned`).
- A send-fraction control: tap target sends 50%, double-tap sends 100%
  (Auralux 1 model), or a radial drag on the source planet to dial 25/50/100.
- `World.openStream` already accepts a `count` — the UI just never uses it.

## 3. Make the upgrade economy legible

Ring fill (15/25/35 units, `RING_CAPACITY_FOR_SIZE`) mirrors Auralux's
"feed the planet to level it up," but the player can't see cost or progress
numerically:

- Show "n / cap" pips or a number near the ring while absorb is active
  (`PlanetLayer.drawProceduralRing` already knows `fill / cap`).
- Show a subtle "+absorb" affordance on ringed planets when they're the sole
  selection, since tap-to-absorb is invisible until discovered (`Game.ts`
  `tapPlanet` branch (c)).
- Auralux plays a rising arpeggio as the planet approaches upgrade — the
  ladder already exists in `Audio.shipArrival(fillProgress)`; wire absorb
  ticks to climb it more obviously.

## 4. AI parity with the player's toolkit

`BasicAI` never absorbs, never evolves a planet, ignores hover armies, and
acts once per 5 s (`NORMAL_AI.tickInterval`). Cheap wins:

- Absorb logic: when safe (no incoming threat), park surplus on a ringed
  planet and trigger absorb — the AI gets the same exponential curve the
  player has, which is what makes late-game Auralux tense.
- Difficulty profiles: expose `AIConfig` presets (Chill / Normal / Fierce)
  on the main menu; `tickInterval` 6.5 / 5 / 3, `aggression` scaling.
- React to hovering player fleets near AI planets (treat as `incomingThreat`
  — currently only ships with `targetPlanet` set are counted).

## 5. Pacing: shorter early game, scarier late game

Auralux matches resolve in 5–10 minutes because production deltas per tier
are steep (roughly 2× per level). Current curve (`BASE_PRODUCTION`
0.8 / 1.3 / 1.9 / 2.6) is too flat — an evolved planet doesn't feel twice as
dangerous. Suggested: 0.8 / 1.6 / 3.0 / 5.0 with `BASE_UNIT_CAPACITY`
tightened at the top so the win comes from tempo, not stockpiles. Raise
starting garrison (12 → 20) so the first minute has decisions, not waiting.

## 6. Free-for-all matches

The sim, palettes (4 in `PLAYER_PALETTES`), and `checkGameOver` all already
generalize past 2 players. Add a 3–4 player map spec + one `BasicAI` per
rival, and the mode exists. This is Auralux: Constellations' bread and
butter — most of its levels are FFAs where you let rivals grind each other.

## 7. Game-speed toggle

Auralux ships 1×/2×/4×. Trivial here: multiply the sim time fed into the
fixed-step accumulator in `Game.loop` (`this.accumulator += frameMs / 1000 *
speed`). Put the toggle next to pause in the HUD.

## 8. Progression shell

- Level select with named constellations (Orion exists; Ursa Major, Lyra,
  Cassiopeia as fixed `MapSpec`s with hand-placed hazards).
- Persist wins in `localStorage`; unlock the next constellation on victory.
- Per-level hazard identity ("the drifting one", "the swarm one") instead of
  a random roll — Auralux levels are memorable *because* they're authored.

## 9. Feel / juice

- Pulse ship glow and planet halos on the ambient pad's slow LFO beat so the
  whole board breathes with the soundtrack (Auralux's defining trick). The
  LFO rates live in `Audio.startAmbient`; export a phase getter and read it
  in `ShipLayer`/`PlanetLayer`.
- Defeat: desaturate the board and slow the sim over ~2 s before the overlay.
- Victory: chain evolve-style shockwaves across owned planets.

## 10. Onboarding

Replace the wall-of-text main menu with a guided first match: three timed
tooltips (tap planet → tap target; drag to lasso; tap own ringed planet to
absorb), each dismissed by the player performing the action. The overlay
plumbing in `ui/Overlay.ts` is sufficient — no new UI framework needed.
