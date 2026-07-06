import { describe, it, expect } from 'vitest';
import { World, type MapSpec } from '../sim/World.js';
import { BasicAI, NORMAL_AI, AGGRESSOR, ECONOMIST } from './BasicAI.js';

const players = [
  { id: 0, isAI: false, name: 'P' },
  { id: 1, isAI: true, name: 'A' },
];

describe('escalation', () => {
  it('sharpens the effective config over match time without exceeding the ramp', () => {
    const map: MapSpec = {
      width: 400,
      height: 200,
      planets: [
        { pos: { x: 40, y: 100 }, radius: 16, owner: 0, garrison: 10 },
        { pos: { x: 360, y: 100 }, radius: 16, owner: 1, garrison: 10 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, players);
    const ai = new BasicAI(w, 1, NORMAL_AI);
    const fresh = ai.effectiveConfig();
    expect(fresh.tickInterval).toBeCloseTo(NORMAL_AI.tickInterval, 3);
    expect(fresh.aggression).toBeCloseTo(NORMAL_AI.aggression, 3);
    expect(fresh.maxWaves).toBe(NORMAL_AI.maxWaves);

    // Advance well past the ramp; the config must land exactly on the caps.
    const esc = NORMAL_AI.escalation!;
    for (let t = 0; t < esc.rampSeconds + 60; t += 1) ai.update(1);
    const ramped = ai.effectiveConfig();
    expect(ramped.tickInterval).toBeCloseTo(
      NORMAL_AI.tickInterval * esc.tickIntervalMult,
      3,
    );
    expect(ramped.aggression).toBeCloseTo(
      NORMAL_AI.aggression * esc.aggressionMult,
      3,
    );
    expect(ramped.reserveFrac).toBeCloseTo(NORMAL_AI.reserveFrac + esc.reserveDelta, 3);
    expect(ramped.maxWaves).toBe(NORMAL_AI.maxWaves + esc.extraWaves);
  });

  it('personalities skew the same base config in opposite directions', () => {
    const map: MapSpec = {
      width: 400,
      height: 200,
      planets: [
        { pos: { x: 40, y: 100 }, radius: 16, owner: 1, garrison: 10 },
        { pos: { x: 360, y: 100 }, radius: 16, owner: 0, garrison: 10 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, players);
    const bully = new BasicAI(w, 1, NORMAL_AI, AGGRESSOR).effectiveConfig();
    const turtle = new BasicAI(w, 1, NORMAL_AI, ECONOMIST).effectiveConfig();
    expect(bully.aggression).toBeGreaterThan(turtle.aggression);
    expect(bully.reserveFrac).toBeLessThan(turtle.reserveFrac);
  });
});

describe('hazard-aware targeting', () => {
  it('prefers the clear route over an equal target buried in an asteroid field', () => {
    // Source at the left; two identical neutral targets equidistant to the
    // right, but the upper one sits inside a heavy asteroid field. The AI
    // should overwhelmingly choose the clear southern target.
    const map: MapSpec = {
      width: 900,
      height: 600,
      planets: [
        { pos: { x: 250, y: 300 }, radius: 16, owner: 1, garrison: 60 },
        { pos: { x: 600, y: 120 }, radius: 16, owner: null, garrison: 5 },
        { pos: { x: 600, y: 480 }, radius: 16, owner: null, garrison: 5 },
      ],
      edges: [
        [0, 1],
        [0, 2],
      ],
      hazards: [
        {
          type: 'asteroidField',
          pos: { x: 600, y: 120 },
          radius: 200,
          slowdown: 0.32,
          seed: 3,
        },
      ],
    };
    let clearPicks = 0;
    const trials = 60;
    for (let t = 0; t < trials; t++) {
      const w = new World(map, players);
      for (const p of w.planets) p.productionRate = 0;
      const ai = new BasicAI(w, 1, NORMAL_AI);
      // Force a decision tick immediately.
      ai.update(NORMAL_AI.tickInterval + 1);
      const stream = w.streams.find((s) => s.owner === 1);
      expect(stream).toBeDefined();
      if (stream!.target === 2) clearPicks++;
    }
    // Soft-max keeps a sliver of variety (expected clear-route rate ~0.8),
    // so assert dominance with statistical headroom, not near the mean.
    expect(clearPicks / trials).toBeGreaterThan(0.55);
  });

  it('two planets coordinate on a target neither clears alone', () => {
    // Each AI planet has ~27 surplus at the minimum reserve — the
    // 40-garrison target needs both. With maxWaves 2 the AI should open a
    // joint strike.
    const map: MapSpec = {
      width: 900,
      height: 300,
      planets: [
        { pos: { x: 100, y: 100 }, radius: 16, owner: 1, garrison: 30 },
        { pos: { x: 100, y: 220 }, radius: 16, owner: 1, garrison: 30 },
        { pos: { x: 700, y: 160 }, radius: 22, owner: null, garrison: 40 },
      ],
      edges: [
        [0, 2],
        [1, 2],
      ],
    };
    const w = new World(map, players);
    for (const p of w.planets) p.productionRate = 0;
    const ai = new BasicAI(w, 1, {
      ...NORMAL_AI,
      maxWaves: 2,
      reserveFrac: 0,
      escalation: undefined,
    });
    ai.update(NORMAL_AI.tickInterval + 1);
    const streams = w.streams.filter((s) => s.owner === 1 && s.target === 2);
    expect(streams.length).toBe(2);
    const committed = streams.reduce((sum, s) => sum + s.remaining, 0);
    expect(committed).toBeGreaterThan(40);
  });
});
