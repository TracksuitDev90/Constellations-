import { describe, it, expect } from 'vitest';
import { World, SLINGSHOT_PEAK_BOOST, type MapSpec } from './World.js';

const players = [
  { id: 0, isAI: false, name: 'P' },
  { id: 1, isAI: true, name: 'A' },
];

describe('black hole slingshot', () => {
  const holeMap: MapSpec = {
    width: 800,
    height: 400,
    planets: [
      { pos: { x: 60, y: 200 }, radius: 16, owner: 0, garrison: 30 },
      { pos: { x: 740, y: 200 }, radius: 16, owner: null, garrison: 5 },
    ],
    edges: [[0, 1]],
    hazards: [
      {
        type: 'blackHole',
        pos: { x: 400, y: 200 },
        horizonRadius: 18,
        gravityRadius: 160,
        seed: 1,
      },
    ],
  };

  it('lifts the speed cap mid-band and leaves both edges untouched', () => {
    const w = new World(holeMap, players);
    const bh = w.blackHoles[0];
    const inner = bh.captureRadius * 1.15;
    const mid = (inner + bh.gravityRadius) / 2;
    // Mid-band: full slingshot boost.
    expect(w.blackHoleSpeedLift(bh.pos.x + mid, bh.pos.y)).toBeCloseTo(
      SLINGSHOT_PEAK_BOOST,
      5,
    );
    // Outside the well and inside the doomed zone: no lift.
    expect(w.blackHoleSpeedLift(bh.pos.x + bh.gravityRadius + 5, bh.pos.y)).toBe(1);
    expect(w.blackHoleSpeedLift(bh.pos.x + inner - 5, bh.pos.y)).toBe(1);
  });

  it('still consumes ships that fly through the capture zone', () => {
    let consumed = 0;
    const w = new World(holeMap, players, {
      onShipConsumed: () => consumed++,
    });
    for (const p of w.planets) p.productionRate = 0;
    // A straight line from planet 0 to planet 1 passes dead through the hole.
    w.openStream(0, 0, 1, 20);
    for (let i = 0; i < 900; i++) w.step(1 / 30);
    expect(consumed).toBeGreaterThan(0);
    // The hole ate the wave — the target must not have flipped.
    expect(w.planets[1].owner).toBeNull();
  });
});

describe('flare star', () => {
  const flareMap: MapSpec = {
    width: 800,
    height: 400,
    planets: [
      { pos: { x: 60, y: 200 }, radius: 16, owner: 0, garrison: 30 },
      { pos: { x: 740, y: 200 }, radius: 16, owner: null, garrison: 5 },
    ],
    edges: [[0, 1]],
    hazards: [
      {
        type: 'flareStar',
        pos: { x: 400, y: 200 },
        period: 2,
        waveSpeed: 220,
        maxRadius: 160,
        seed: 7,
      },
    ],
  };

  it('sweeps free-flying ships crossing the blast zone', () => {
    let deaths = 0;
    const w = new World(flareMap, players, {
      onShipDeath: () => deaths++,
    });
    for (const p of w.planets) p.productionRate = 0;
    // The direct line from planet 0 to 1 runs straight through the star; the
    // crossing takes far longer than one period, so every ship eats a pulse.
    w.openStream(0, 0, 1, 20);
    for (let i = 0; i < 900; i++) w.step(1 / 30);
    expect(deaths).toBeGreaterThan(0);
    expect(w.planets[1].owner).toBeNull();
  });

  it('never touches orbiting garrisons', () => {
    const shelteredMap: MapSpec = {
      ...flareMap,
      // Planet parked INSIDE the blast radius — orbiters must survive.
      planets: [{ pos: { x: 470, y: 200 }, radius: 16, owner: 0, garrison: 5 }],
      edges: [],
    };
    const w = new World(shelteredMap, players);
    for (const p of w.planets) p.productionRate = 0;
    expect(w.ships.activeCount()).toBe(5);
    for (let i = 0; i < 10 * 30; i++) w.step(1 / 30);
    expect(w.ships.activeCount()).toBe(5);
  });
});

describe('wormholes', () => {
  const gateMap: MapSpec = {
    width: 1300,
    height: 400,
    planets: [
      { pos: { x: 60, y: 200 }, radius: 16, owner: 0, garrison: 30 },
      { pos: { x: 1240, y: 200 }, radius: 16, owner: null, garrison: 3 },
    ],
    edges: [[0, 1]],
    hazards: [
      {
        type: 'wormhole',
        a: { x: 200, y: 200 },
        b: { x: 1100, y: 200 },
        radius: 28,
        seed: 11,
      },
    ],
  };

  it('warps transit ships through the gate and fires onShipWarp', () => {
    let warps = 0;
    const w = new World(gateMap, players, {
      onShipWarp: () => warps++,
    });
    for (const p of w.planets) p.productionRate = 0;
    w.openStream(0, 0, 1, 10);
    for (let i = 0; i < 10 * 30; i++) w.step(1 / 30);
    expect(warps).toBeGreaterThan(0);
  });

  it('lets a wave capture a far target much faster than direct flight', () => {
    const w = new World(gateMap, players);
    for (const p of w.planets) p.productionRate = 0;
    // Direct flight is ~1180px ≈ 24.5s at SHIP_SPEED; via the gate it's
    // under 300px of real flying. 12 seconds is only enough with the warp.
    w.openStream(0, 0, 1, 20);
    for (let i = 0; i < 12 * 30; i++) w.step(1 / 30);
    expect(w.planets[1].owner).toBe(0);
  });
});

describe('guardian swarms', () => {
  const guardedMap: MapSpec = {
    width: 600,
    height: 400,
    planets: [
      { pos: { x: 60, y: 200 }, radius: 16, owner: 0, garrison: 10 },
      { pos: { x: 450, y: 200 }, radius: 22, owner: null, garrison: 8, ringCount: 1 },
    ],
    edges: [[0, 1]],
    hazards: [
      {
        type: 'neutralSwarm',
        pos: { x: 450, y: 200 },
        count: 3,
        patrolRadius: 90,
        seed: 2,
        guardPlanetId: 1,
      },
    ],
  };

  it('respawns while the guarded planet is unclaimed', () => {
    const w = new World(guardedMap, players);
    for (const p of w.planets) p.productionRate = 0;
    expect(w.neutrals.activeCount()).toBe(3);
    // Thin the pack by one, then wait out the respawn interval.
    w.neutrals.kill(0);
    expect(w.neutrals.activeCount()).toBe(2);
    for (let i = 0; i < 8 * 30; i++) w.step(1 / 30);
    expect(w.neutrals.activeCount()).toBe(3);
  });

  it('stops respawning once the guarded planet is captured', () => {
    const w = new World(guardedMap, players);
    for (const p of w.planets) p.productionRate = 0;
    w.planets[1].owner = 0;
    w.neutrals.kill(0);
    for (let i = 0; i < 20 * 30; i++) w.step(1 / 30);
    expect(w.neutrals.activeCount()).toBe(2);
  });

  it('exposes only zones that still have live hostiles', () => {
    const w = new World(guardedMap, players);
    expect(w.swarmZones()).toHaveLength(1);
    const all = w.neutrals.all;
    for (let i = 0; i < all.length; i++) w.neutrals.kill(i);
    // Guarded planet captured → no respawn → the zone stops pricing routes.
    w.planets[1].owner = 0;
    w.step(1 / 30);
    expect(w.swarmZones()).toHaveLength(0);
  });
});
