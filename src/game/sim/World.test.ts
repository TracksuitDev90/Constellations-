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
