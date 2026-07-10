import { describe, it, expect } from 'vitest';
import { generateMap, type LayoutKind, type MapGenConfig } from './generator.js';
import { MAX_RING_COUNT } from '../sim/Planet.js';
import type { PlanetType } from '../sim/Planet.js';

const baseCfg = (overrides: Partial<MapGenConfig> = {}): MapGenConfig => ({
  playerCount: 2,
  totalPlanets: [8, 10],
  hazardPool: [],
  calmChance: 1,
  playerGarrison: 20,
  enemyGarrison: 15,
  playerRing: true,
  ...overrides,
});

/** BFS connectivity over the generated edge list. */
const isConnected = (n: number, edges: Array<[number, number]>): boolean => {
  const adj = new Map<number, number[]>();
  for (let i = 0; i < n; i++) adj.set(i, []);
  for (const [a, b] of edges) {
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!)!) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return seen.size === n;
};

describe('layout archetypes', () => {
  const layouts: LayoutKind[] = ['scatter', 'lanes', 'ringworld', 'clusters'];
  for (const layout of layouts) {
    it(`${layout}: planets in bounds, sane rings, connected constellation`, () => {
      for (let run = 0; run < 25; run++) {
        const map = generateMap(baseCfg({ layouts: [layout] }));
        expect(map.planets.length).toBeGreaterThanOrEqual(8);
        expect(map.planets.length).toBeLessThanOrEqual(10);
        for (const p of map.planets) {
          expect(p.pos.x).toBeGreaterThan(0);
          expect(p.pos.x).toBeLessThan(map.width);
          expect(p.pos.y).toBeGreaterThan(0);
          expect(p.pos.y).toBeLessThan(map.height);
          const type = (p.type ?? 0) as PlanetType;
          expect(p.ringCount ?? 0).toBeLessThanOrEqual(MAX_RING_COUNT[type]);
          expect(p.garrison).toBeGreaterThan(0);
        }
        // Start worlds owned in player order.
        expect(map.planets[0].owner).toBe(0);
        expect(map.planets[1].owner).toBe(1);
        expect(isConnected(map.planets.length, map.edges)).toBe(true);
      }
    });
  }

  it('ringworld always rolls a rich two-ring center prize', () => {
    for (let run = 0; run < 15; run++) {
      const map = generateMap(baseCfg({ layouts: ['ringworld'] }));
      const rich = map.planets.filter(
        (p) => p.owner === null && p.type === 2 && (p.ringCount ?? 0) === 2,
      );
      expect(rich.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('star patterns (zodiac maps)', () => {
  // A recognizable little figure — five stars in an arc.
  const pattern: Array<[number, number]> = [
    [0.14, 0.52],
    [0.38, 0.34],
    [0.6, 0.3],
    [0.8, 0.42],
    [0.9, 0.62],
  ];

  it('places one neutral near each authored star, in bounds and connected', () => {
    for (let run = 0; run < 25; run++) {
      const map = generateMap(
        baseCfg({ totalPlanets: [7, 7], starPattern: pattern }),
      );
      expect(map.planets.length).toBe(7);
      const neutrals = map.planets.slice(2);
      expect(neutrals.length).toBe(pattern.length);
      // Every star of the figure has a planet within jitter + de-clump slack.
      for (const [nx, ny] of pattern) {
        const sx = 300 + nx * 1000;
        const sy = 200 + ny * 630;
        const nearest = Math.min(
          ...neutrals.map((p) => Math.hypot(p.pos.x - sx, p.pos.y - sy)),
        );
        expect(nearest).toBeLessThan(150);
      }
      for (const p of map.planets) {
        expect(p.pos.x).toBeGreaterThan(0);
        expect(p.pos.x).toBeLessThan(map.width);
        expect(p.pos.y).toBeGreaterThan(0);
        expect(p.pos.y).toBeLessThan(map.height);
      }
      expect(isConnected(map.planets.length, map.edges)).toBe(true);
    }
  });

  it('keeps every pair of planets a readable distance apart', () => {
    for (let run = 0; run < 25; run++) {
      const map = generateMap(
        baseCfg({ totalPlanets: [7, 7], starPattern: pattern }),
      );
      for (let a = 0; a < map.planets.length; a++) {
        for (let b = a + 1; b < map.planets.length; b++) {
          const d = Math.hypot(
            map.planets[a].pos.x - map.planets[b].pos.x,
            map.planets[a].pos.y - map.planets[b].pos.y,
          );
          expect(d).toBeGreaterThan(100);
        }
      }
    }
  });
});

describe('placement fairness', () => {
  it('every start world has expansion food within reach on standard layouts', () => {
    const layouts: LayoutKind[] = ['scatter', 'lanes', 'ringworld', 'clusters'];
    for (const layout of layouts) {
      for (let run = 0; run < 30; run++) {
        const map = generateMap(
          baseCfg({ playerCount: 3, totalPlanets: [8, 10], layouts: [layout] }),
        );
        const starts = map.planets.slice(0, 3);
        const neutrals = map.planets.slice(3);
        for (const s of starts) {
          const nearest = Math.min(
            ...neutrals.map((p) =>
              Math.hypot(p.pos.x - s.pos.x, p.pos.y - s.pos.y),
            ),
          );
          expect(nearest).toBeLessThanOrEqual(430);
        }
      }
    }
  });

  it('no two planets end up clumped on top of each other', () => {
    const layouts: LayoutKind[] = ['scatter', 'lanes', 'ringworld', 'clusters'];
    for (const layout of layouts) {
      for (let run = 0; run < 30; run++) {
        const map = generateMap(baseCfg({ layouts: [layout] }));
        for (let a = 0; a < map.planets.length; a++) {
          for (let b = a + 1; b < map.planets.length; b++) {
            const d = Math.hypot(
              map.planets[a].pos.x - map.planets[b].pos.x,
              map.planets[a].pos.y - map.planets[b].pos.y,
            );
            expect(d).toBeGreaterThan(130);
          }
        }
      }
    }
  });
});

describe('value gradient', () => {
  it('contested-space neutrals are richer than doorstep neutrals on average', () => {
    let nearSum = 0;
    let farSum = 0;
    const runs = 80;
    for (let run = 0; run < runs; run++) {
      const map = generateMap(baseCfg({ layouts: ['scatter'] }));
      const starts = map.planets.slice(0, 2);
      const neutrals = map.planets.slice(2);
      const byDist = neutrals
        .map((p) => ({
          p,
          d: Math.min(
            ...starts.map((s) => Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y)),
          ),
        }))
        .sort((a, b) => a.d - b.d);
      const worth = (p: (typeof neutrals)[number]): number =>
        p.garrison + (p.ringCount ?? 0) * 8 + ((p.type ?? 0) as number) * 6;
      nearSum += worth(byDist[0].p);
      farSum += worth(byDist[byDist.length - 1].p);
    }
    expect(farSum / runs).toBeGreaterThan(nearSum / runs);
  });
});

describe('hazard–reward coupling', () => {
  it('guardian swarms always guard a ringed neutral prize', () => {
    let sawGuardian = false;
    for (let run = 0; run < 60 && !sawGuardian; run++) {
      const map = generateMap(
        baseCfg({ hazardPool: ['neutralSwarm'], calmChance: 0 }),
      );
      for (const h of map.hazards ?? []) {
        if (h.type !== 'neutralSwarm' || h.guardPlanetId === undefined) continue;
        sawGuardian = true;
        const guarded = map.planets[h.guardPlanetId];
        expect(guarded).toBeDefined();
        expect(guarded.owner).toBeNull();
        expect(guarded.ringCount ?? 0).toBeGreaterThanOrEqual(1);
        // The swarm patrols right on top of its prize.
        expect(Math.hypot(h.pos.x - guarded.pos.x, h.pos.y - guarded.pos.y)).toBeLessThan(1);
      }
    }
    expect(sawGuardian).toBe(true);
  });

  it('treasure asteroid fields wrap the planet they sweeten', () => {
    let sawTreasure = false;
    for (let run = 0; run < 80 && !sawTreasure; run++) {
      const map = generateMap(
        baseCfg({ hazardPool: ['asteroidField'], calmChance: 0 }),
      );
      for (const h of map.hazards ?? []) {
        if (h.type !== 'asteroidField') continue;
        const wrapped = map.planets.find(
          (p) =>
            p.owner === null &&
            Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) < 1,
        );
        if (!wrapped) continue; // free-floating fallback roll
        sawTreasure = true;
        // Field must fully cover its treasure with approach margin.
        expect(h.radius).toBeGreaterThan(50);
      }
    }
    expect(sawTreasure).toBe(true);
  });

  it('flare stars land in contested space, clear of every planet', () => {
    let sawFlare = false;
    for (let run = 0; run < 60 && !sawFlare; run++) {
      const map = generateMap(baseCfg({ hazardPool: ['flareStar'], calmChance: 0 }));
      for (const h of map.hazards ?? []) {
        if (h.type !== 'flareStar') continue;
        sawFlare = true;
        expect(h.period).toBeGreaterThan(0);
        expect(h.waveSpeed).toBeGreaterThan(0);
        expect(h.maxRadius).toBeGreaterThan(100);
        for (const p of map.planets) {
          expect(
            Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y),
          ).toBeGreaterThan(100);
        }
      }
    }
    expect(sawFlare).toBe(true);
  });

  it('wormhole gates span a long diagonal with both mouths clear of planets', () => {
    let sawGate = false;
    for (let run = 0; run < 60 && !sawGate; run++) {
      const map = generateMap(baseCfg({ hazardPool: ['wormhole'], calmChance: 0 }));
      for (const h of map.hazards ?? []) {
        if (h.type !== 'wormhole') continue;
        sawGate = true;
        const span = Math.hypot(h.a.x - h.b.x, h.a.y - h.b.y);
        expect(span).toBeGreaterThanOrEqual(550);
        expect(span).toBeLessThanOrEqual(950);
        for (const mouth of [h.a, h.b]) {
          for (const p of map.planets) {
            expect(
              Math.hypot(mouth.x - p.pos.x, mouth.y - p.pos.y),
            ).toBeGreaterThan(100);
          }
        }
      }
    }
    expect(sawGate).toBe(true);
  });

  it('drifting planets are always worth chasing (ringed)', () => {
    for (let run = 0; run < 40; run++) {
      const map = generateMap(
        baseCfg({ hazardPool: ['driftingPlanet'], calmChance: 0 }),
      );
      for (const h of map.hazards ?? []) {
        if (h.type !== 'driftingPlanet') continue;
        const drifter = map.planets[h.planetId];
        expect(drifter.owner).toBeNull();
        expect(drifter.ringCount ?? 0).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
