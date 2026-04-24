import { describe, it, expect } from 'vitest';
import { World, type MapSpec } from './World.js';

const twoPlanetMap: MapSpec = {
  width: 200,
  height: 100,
  planets: [
    { pos: { x: 20, y: 50 }, radius: 16, owner: 0, garrison: 50 },
    { pos: { x: 180, y: 50 }, radius: 16, owner: null, garrison: 5 },
  ],
  edges: [[0, 1]],
};

const linearMap: MapSpec = {
  width: 300,
  height: 100,
  planets: [
    { pos: { x: 20, y: 50 }, radius: 14, owner: 0, garrison: 100 },
    { pos: { x: 150, y: 50 }, radius: 14, owner: 1, garrison: 5 },
    { pos: { x: 280, y: 50 }, radius: 14, owner: 1, garrison: 3 },
  ],
  edges: [
    [0, 1],
    [1, 2],
  ],
};

describe('World.findPath', () => {
  it('returns shortest path along edges', () => {
    const w = new World(linearMap, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    expect(w.findPath(0, 2)).toEqual([0, 1, 2]);
  });

  it('returns empty when disconnected', () => {
    const w = new World(
      {
        width: 100,
        height: 100,
        planets: [
          { pos: { x: 10, y: 50 }, radius: 10, owner: 0, garrison: 1 },
          { pos: { x: 90, y: 50 }, radius: 10, owner: 1, garrison: 1 },
        ],
        edges: [],
      },
      [
        { id: 0, isAI: false, name: 'P' },
        { id: 1, isAI: true, name: 'A' },
      ],
    );
    expect(w.findPath(0, 1)).toEqual([]);
  });
});

describe('World capture', () => {
  it('flips neutral planet when garrison drops below zero', () => {
    const w = new World(twoPlanetMap, [{ id: 0, isAI: false, name: 'P' }]);
    // Force 6 ships to travel to neutral planet 1 and arrive
    w.openStream(0, 0, 1);
    // Simulate until garrison of planet 1 is captured
    for (let i = 0; i < 2000; i++) {
      w.step(0.05);
      if (w.planets[1].owner === 0) break;
    }
    expect(w.planets[1].owner).toBe(0);
    expect(w.planets[1].garrison).toBeGreaterThanOrEqual(1);
  });

  it('stream stops emitting when source garrison hits 0', () => {
    const map: MapSpec = {
      width: 200,
      height: 100,
      planets: [
        { pos: { x: 20, y: 50 }, radius: 12, owner: 0, garrison: 3 },
        { pos: { x: 180, y: 50 }, radius: 12, owner: 1, garrison: 100 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    // Freeze production so source can't replenish
    w.planets[0].productionRate = 0;
    w.openStream(0, 0, 1);
    for (let i = 0; i < 200; i++) w.step(0.05);
    expect(w.planets[0].garrison).toBe(0);
    // Only 3 ships could ever have been launched
    const launched = w.ships.all.filter((s) => s.owner === 0).length;
    expect(launched).toBeLessThanOrEqual(3);
  });
});

describe('commandSelectedTo drains source planet', () => {
  it('depletes garrison to zero when all orbit units are commanded away', () => {
    const map: MapSpec = {
      width: 400,
      height: 100,
      planets: [
        { pos: { x: 50, y: 50 }, radius: 16, owner: 0, garrison: 0 },
        { pos: { x: 350, y: 50 }, radius: 16, owner: null, garrison: 2 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    // Let production spawn several live orbiters around planet 0.
    w.planets[0].productionRate = 4;
    for (let i = 0; i < 80; i++) w.step(0.05);
    expect(w.planets[0].garrison).toBeGreaterThan(3);
    // Freeze production so we only observe the effect of the command.
    w.planets[0].productionRate = 0;
    for (const s of w.ships.all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === 0) {
        s.isSelected = true;
      }
    }
    const n = w.commandSelectedTo(0, { planetId: 1 });
    expect(n).toBeGreaterThan(0);
    expect(w.planets[0].garrison).toBe(0);
  });

  it('drains residual garrison even when it exceeds the live-orbit cap', () => {
    const map: MapSpec = {
      width: 400,
      height: 100,
      planets: [
        { pos: { x: 50, y: 50 }, radius: 16, owner: 0, garrison: 0 },
        { pos: { x: 350, y: 50 }, radius: 16, owner: null, garrison: 2 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    w.planets[0].productionRate = 4;
    for (let i = 0; i < 80; i++) w.step(0.05);
    w.planets[0].productionRate = 0;
    // Simulate a production overflow — garrison beyond live-orbit count.
    w.planets[0].garrison += 7;
    for (const s of w.ships.all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === 0) {
        s.isSelected = true;
      }
    }
    const n = w.commandSelectedTo(0, { planetId: 1 });
    expect(n).toBeGreaterThan(0);
    expect(w.planets[0].garrison).toBe(0);
  });
});

describe('absorb ring filling', () => {
  const ringedMap: MapSpec = {
    width: 200,
    height: 100,
    planets: [
      {
        pos: { x: 100, y: 50 },
        radius: 20,
        owner: 0,
        garrison: 0,
        type: 0,
        ringCount: 1,
      },
    ],
    edges: [],
  };

  it('no-ops triggerAbsorb when there is nothing to fill', () => {
    const map: MapSpec = {
      width: 200,
      height: 100,
      planets: [
        { pos: { x: 100, y: 50 }, radius: 20, owner: 0, garrison: 5, type: 0, ringCount: 0 },
      ],
      edges: [],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    // Plain planet with no rings and full health → toggle should be rejected.
    w.triggerAbsorb(0, 0, true);
    expect(w.planets[0].absorbing).toBe(false);
  });

  it('flushes phantom garrison into ring fill during absorb', () => {
    const w = new World(ringedMap, [{ id: 0, isAI: false, name: 'P' }]);
    // Freeze production so the test observes only the flush behavior.
    w.planets[0].productionRate = 0;
    // Inject a big phantom garrison — uncounted production overflow waiting
    // for the orbiter cap to free up. With absorb on, every one of these
    // must end up consumed as a ring-fill tick (previously they would stall).
    w.planets[0].garrison = 12;
    w.triggerAbsorb(0, 0, true);
    expect(w.planets[0].absorbing).toBe(true);
    // Run long enough for the flush pass and the pull-to-center to complete.
    for (let i = 0; i < 200; i++) w.step(0.05);
    expect(w.planets[0].garrison).toBe(0);
    // Planet evolves when ring fills fully — either it grew (ringCount reset)
    // or ringFillProgress ticked up meaningfully. Both are valid end states.
    const p = w.planets[0];
    const totalFill = p.ringFillProgress.reduce((a, b) => a + b, 0);
    expect(p.type > 0 || totalFill > 0).toBe(true);
  });
});

describe('reinforcement stacking', () => {
  it('accepts arrivals past the native maxUnitCapacity so swarms thicken', () => {
    const map: MapSpec = {
      width: 400,
      height: 100,
      planets: [
        // Source with lots of units ready to send.
        { pos: { x: 50, y: 50 }, radius: 16, owner: 0, garrison: 0, type: 0 },
        // Target already at its small-planet capacity (40).
        { pos: { x: 350, y: 50 }, radius: 16, owner: 0, garrison: 40, type: 0 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    w.planets[0].productionRate = 40;
    w.planets[0].garrison = 0;
    for (let i = 0; i < 80; i++) w.step(0.05);
    // Stop production so the test only observes arrivals at the target.
    w.planets[0].productionRate = 0;
    // Send everything from planet 0 to planet 1.
    w.openStream(0, 0, 1);
    for (let i = 0; i < 2000; i++) w.step(0.05);
    const orbiters = w.ships.all.filter(
      (s) => s.active && s.state === 'orbiting' && s.parentPlanet === 1,
    ).length;
    // Target should be carrying strictly more live orbiters than its native
    // cap — previously arrivals past 40 were silently killed on landing.
    expect(orbiters).toBeGreaterThan(40);
  });
});

describe('World game over', () => {
  it('declares winner when only one owner remains', () => {
    let winner: number | null = -1;
    const map: MapSpec = {
      width: 200,
      height: 100,
      planets: [
        { pos: { x: 20, y: 50 }, radius: 16, owner: 0, garrison: 100 },
        { pos: { x: 180, y: 50 }, radius: 16, owner: 1, garrison: 3 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(
      map,
      [
        { id: 0, isAI: false, name: 'P' },
        { id: 1, isAI: true, name: 'A' },
      ],
      {
        onGameOver: (win) => {
          winner = win;
        },
      },
    );
    w.openStream(0, 0, 1);
    for (let i = 0; i < 6000 && !w.gameOver; i++) w.step(0.05);
    expect(w.gameOver).toBe(true);
    expect(winner).toBe(0);
  });
});
