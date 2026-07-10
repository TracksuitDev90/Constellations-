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

describe('free-flight streaming', () => {
  it('reaches a distant planet directly, ignoring the edge graph', () => {
    // Auralux-style movement: no routing — planet 2 is not edge-connected to
    // planet 0 at all, and the wave still flies straight to it.
    const w = new World(linearMap, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    for (const p of w.planets) p.productionRate = 0;
    w.openStream(0, 0, 2, 20);
    for (let i = 0; i < 600; i++) w.step(0.05);
    // Wave went straight for planet 2 — the intermediate planet 1 keeps its
    // owner and full garrison because nothing routed through it.
    expect(w.planets[1].garrison).toBe(5);
    expect(w.planets[2].owner).toBe(0);
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

describe('drifting planet hazard', () => {
  it('moves the planet along its drift velocity and bounces off bounds', () => {
    const map: MapSpec = {
      width: 800,
      height: 600,
      planets: [
        { pos: { x: 100, y: 100 }, radius: 16, owner: 0, garrison: 1 },
        { pos: { x: 700, y: 500 }, radius: 16, owner: null, garrison: 1 },
      ],
      edges: [[0, 1]],
      hazards: [{ type: 'driftingPlanet', planetId: 1, vx: 200, vy: 0 }],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    const startX = w.planets[1].pos.x;
    // After one tick, planet should have moved right.
    w.step(0.5);
    expect(w.planets[1].pos.x).toBeGreaterThan(startX);
    // Drive forward and watch for a sign flip on vx — proves the bounce
    // logic engaged at least once. Also assert the planet never escaped.
    let bounced = false;
    let lastSign = Math.sign(w.planets[1].vx);
    for (let i = 0; i < 60; i++) {
      w.step(0.1);
      const s = Math.sign(w.planets[1].vx);
      if (s !== 0 && s !== lastSign) {
        bounced = true;
        lastSign = s;
      }
      expect(w.planets[1].pos.x).toBeGreaterThanOrEqual(w.planets[1].radius - 0.001);
      expect(w.planets[1].pos.x).toBeLessThanOrEqual(w.width - w.planets[1].radius + 0.001);
    }
    expect(bounced).toBe(true);
  });
});

describe('asteroid field hazard', () => {
  it('slows transit ships passing through the field', () => {
    const baseMap: MapSpec = {
      width: 1000,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 200 },
        { pos: { x: 950, y: 100 }, radius: 16, owner: 1, garrison: 200 },
      ],
      edges: [[0, 1]],
    };
    const noField = new World(baseMap, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    const withField = new World(
      {
        ...baseMap,
        hazards: [
          {
            type: 'asteroidField',
            pos: { x: 500, y: 100 },
            radius: 200,
            slowdown: 0.25,
            seed: 1,
          },
        ],
      },
      [
        { id: 0, isAI: false, name: 'P' },
        { id: 1, isAI: true, name: 'A' },
      ],
    );
    // Freeze production so we observe pure transit steering.
    for (const w of [noField, withField]) {
      for (const p of w.planets) p.productionRate = 0;
      w.openStream(0, 0, 1, 5);
    }
    // Run both worlds for a comparable wall-clock and inspect how far the
    // lead ship has traveled. The field world should be measurably behind.
    for (let i = 0; i < 300; i++) {
      noField.step(0.05);
      withField.step(0.05);
    }
    const farthest = (w: World): number => {
      let x = 0;
      for (const s of w.ships.all) {
        if (s.active && s.owner === 0 && s.state === 'transit' && s.x > x) x = s.x;
      }
      return x;
    };
    expect(farthest(withField)).toBeLessThan(farthest(noField) - 30);
  });
});

describe('neutral swarm hazard', () => {
  it('kills nearby in-flight ships and dies in the exchange', () => {
    const map: MapSpec = {
      width: 600,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 30 },
        { pos: { x: 550, y: 100 }, radius: 16, owner: 1, garrison: 5 },
      ],
      edges: [[0, 1]],
      hazards: [
        {
          type: 'neutralSwarm',
          pos: { x: 300, y: 100 },
          count: 3,
          patrolRadius: 30,
          seed: 1,
        },
      ],
    };
    let shipDeaths = 0;
    let neutralDeaths = 0;
    const w = new World(
      map,
      [
        { id: 0, isAI: false, name: 'P' },
        { id: 1, isAI: true, name: 'A' },
      ],
      {
        onShipDeath: () => shipDeaths++,
        onNeutralDeath: () => neutralDeaths++,
      },
    );
    expect(w.neutrals.activeCount()).toBe(3);
    // Send a wave through the swarm; expect ships and neutrals to trade.
    for (const p of w.planets) p.productionRate = 0;
    w.openStream(0, 0, 1, 10);
    for (let i = 0; i < 600; i++) w.step(0.05);
    // Contact must have happened: the swarm shoots down passing ships and
    // dies 1:1 in the exchange (respawn may have refilled the count, so we
    // assert on the death events, not the final population).
    expect(shipDeaths).toBeGreaterThan(0);
    expect(neutralDeaths).toBeGreaterThan(0);
  });
});

describe('black hole hazard', () => {
  // Target is neutral so a successful capture can't trigger game-over (a
  // frozen post-victory sim would mask the assertions we care about here).
  const holeMap = (holeY: number): MapSpec => ({
    width: 1000,
    height: 800,
    planets: [
      { pos: { x: 50, y: 400 }, radius: 16, owner: 0, garrison: 30 },
      { pos: { x: 950, y: 400 }, radius: 16, owner: null, garrison: 5 },
    ],
    edges: [[0, 1]],
    hazards: [
      {
        type: 'blackHole',
        pos: { x: 500, y: holeY },
        horizonRadius: 18,
        gravityRadius: 160,
        seed: 7,
      },
    ],
  });
  const players = [
    { id: 0, isAI: false, name: 'P' },
    { id: 1, isAI: true, name: 'A' },
  ];

  it('consumes a wave sent straight through the well', () => {
    let consumed = 0;
    // Hole dead-center on the flight line between the two planets.
    const w = new World(holeMap(400), players, {
      onShipConsumed: () => consumed++,
    });
    for (const p of w.planets) p.productionRate = 0;
    w.openStream(0, 0, 1, 12);
    for (let i = 0; i < 800; i++) w.step(0.05);
    // The lazy straight-line send dies in the hole; the target holds.
    expect(consumed).toBeGreaterThanOrEqual(8);
    expect(w.planets[1].owner).toBe(null);
  });

  it('spares a route that stays outside the gravity radius', () => {
    let consumed = 0;
    // Same well, moved 300px off the flight line — a planned route around.
    const w = new World(holeMap(100), players, {
      onShipConsumed: () => consumed++,
    });
    for (const p of w.planets) p.productionRate = 0;
    w.openStream(0, 0, 1, 12);
    for (let i = 0; i < 800; i++) w.step(0.05);
    expect(consumed).toBe(0);
    expect(w.planets[1].owner).toBe(0);
  });

  it('capture is terminal but the infall spiral is visibly slow', () => {
    let consumedAt = -1;
    const w = new World(holeMap(400), players, {
      onShipConsumed: () => {
        if (consumedAt < 0) consumedAt = w.time;
      },
    });
    for (const p of w.planets) p.productionRate = 0;
    // Park a hover ship just inside the capture threshold (18 * 2.6 ≈ 47).
    const idx = w.ships.spawn(0, { x: 500 + 42, y: 400 }, -1, 48, {
      vx: 0,
      vy: 0,
      turnRate: 2,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'hovering',
    });
    const s = w.ships.get(idx);
    s.targetX = 500 + 42;
    s.targetY = 400;
    for (let i = 0; i < 300 && consumedAt < 0; i++) w.step(1 / 30);
    // It died — no immortal spirals — but took a readable moment to fall.
    expect(consumedAt).toBeGreaterThan(0.8);
    expect(consumedAt).toBeLessThan(6);
  });

  it('swallows neutral swarm ships that stray inside', () => {
    let neutralDeaths = 0;
    const map: MapSpec = {
      ...holeMap(400),
      hazards: [
        ...(holeMap(400).hazards ?? []),
        // Swarm anchored right on the hole — every spawn is inside capture.
        { type: 'neutralSwarm', pos: { x: 500, y: 400 }, count: 3, patrolRadius: 30, seed: 3 },
      ],
    };
    const w = new World(map, players, {
      onNeutralDeath: () => neutralDeaths++,
    });
    for (const p of w.planets) p.productionRate = 0;
    for (let i = 0; i < 200; i++) w.step(1 / 30);
    // No player ships anywhere near — the hole itself did the killing.
    expect(neutralDeaths).toBeGreaterThan(0);
  });

  it('excludes doomed ships from totalGarrison', () => {
    const w = new World(holeMap(400), players);
    for (const p of w.planets) p.productionRate = 0;
    const base = w.totalGarrison(0);
    const idx = w.ships.spawn(0, { x: 500 + 40, y: 400 }, -1, 48, {
      vx: 0,
      vy: 0,
      turnRate: 2,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'hovering',
    });
    const s = w.ships.get(idx);
    s.targetX = 500 + 40;
    s.targetY = 400;
    expect(w.totalGarrison(0)).toBe(base + 1);
    w.step(1 / 30);
    // One tick inside the capture zone flips it to 'doomed' — the HUD
    // strength bar must drop it immediately even though it's still visible.
    expect(s.state).toBe('doomed');
    expect(s.active).toBe(true);
    expect(w.totalGarrison(0)).toBe(base);
  });
});

describe('neutral swarm behavior', () => {
  it('hunts down ships loitering well outside the old point-blank radius', () => {
    let shipDeaths = 0;
    const map: MapSpec = {
      width: 600,
      height: 300,
      planets: [
        { pos: { x: 50, y: 250 }, radius: 16, owner: 0, garrison: 5 },
        { pos: { x: 550, y: 250 }, radius: 16, owner: 1, garrison: 5 },
      ],
      edges: [[0, 1]],
      hazards: [
        { type: 'neutralSwarm', pos: { x: 300, y: 100 }, count: 4, patrolRadius: 10, seed: 5 },
      ],
    };
    const w = new World(
      map,
      [
        { id: 0, isAI: false, name: 'P' },
        { id: 1, isAI: true, name: 'A' },
      ],
      { onShipDeath: () => shipDeaths++ },
    );
    for (const p of w.planets) p.productionRate = 0;
    // A fleet parked 80px from the anchor — 70px clear of the patrol band.
    // The old 22px point-blank snipe could never touch it; the pursue state
    // must detect it (90px ring), close in, and trade kills.
    for (let k = 0; k < 3; k++) {
      const idx = w.ships.spawn(0, { x: 380, y: 100 + k * 6 }, -1, 48, {
        vx: 0,
        vy: 0,
        turnRate: 2,
        wobbleAmp: 0,
        wobblePhase: 0,
        state: 'hovering',
      });
      const s = w.ships.get(idx);
      s.targetX = 380;
      s.targetY = 100 + k * 6;
    }
    for (let i = 0; i < 900; i++) w.step(1 / 30);
    expect(shipDeaths).toBeGreaterThan(0);
  });

  it('leashes back to its anchor instead of chasing across the map', () => {
    const anchor = { x: 300, y: 100 };
    const patrolRadius = 40;
    const map: MapSpec = {
      width: 600,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 5 },
        { pos: { x: 550, y: 100 }, radius: 16, owner: 1, garrison: 5 },
      ],
      edges: [[0, 1]],
      hazards: [{ type: 'neutralSwarm', pos: anchor, count: 4, patrolRadius, seed: 9 }],
    };
    const w = new World(map, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    for (const p of w.planets) p.productionRate = 0;
    // Dangle bait at the detection edge, then let the swarm chase, kill, and
    // (crucially) come home.
    const idx = w.ships.spawn(0, { x: 380, y: 100 }, -1, 48, {
      vx: 0,
      vy: 0,
      turnRate: 2,
      wobbleAmp: 0,
      wobblePhase: 0,
      state: 'hovering',
    });
    const bait = w.ships.get(idx);
    bait.targetX = 380;
    bait.targetY = 100;
    for (let i = 0; i < 900; i++) w.step(1 / 30);
    const leash = patrolRadius + 90 * 1.2; // patrol band + chase margin
    for (const n of w.neutrals.all) {
      if (!n.active) continue;
      const d = Math.hypot(n.x - anchor.x, n.y - anchor.y);
      expect(d).toBeLessThanOrEqual(leash + 20);
    }
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

describe('human elimination in free-for-all', () => {
  it('ends the match as soon as the human is out, even with AIs alive', () => {
    const map: MapSpec = {
      width: 600,
      height: 100,
      planets: [
        { pos: { x: 50, y: 50 }, radius: 14, owner: 0, garrison: 1, type: 0 },
        { pos: { x: 300, y: 50 }, radius: 14, owner: 1, garrison: 30, type: 0 },
        { pos: { x: 550, y: 50 }, radius: 14, owner: 2, garrison: 30, type: 0 },
      ],
      edges: [],
    };
    const w = new World(map, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
      { id: 2, isAI: true, name: 'B' },
    ]);
    for (const p of w.planets) p.productionRate = 0;
    // Let a step register all three owners as "seen", then wipe the human.
    w.step(1 / 30);
    expect(w.gameOver).toBe(false);
    w.planets[0].owner = null;
    w.planets[0].garrison = 0;
    for (const s of w.ships.all) if (s.owner === 0) s.active = false;
    w.step(1 / 30);
    expect(w.gameOver).toBe(true);
    // Two AIs still stand — the "winner" is a rival, never the human.
    expect(w.winner).not.toBe(0);
    expect(w.winner).not.toBeNull();
  });
});

describe('moving planet capture', () => {
  it('lands a wave on a planet drifting away from the source', () => {
    const map: MapSpec = {
      width: 1600,
      height: 1000,
      planets: [
        { pos: { x: 200, y: 500 }, radius: 14, owner: 0, garrison: 40, type: 0 },
        { pos: { x: 800, y: 500 }, radius: 14, owner: null, garrison: 5, type: 0 },
      ],
      edges: [[0, 1]],
      hazards: [{ type: 'driftingPlanet', planetId: 1, vx: 26, vy: 0 }],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    w.planets[0].productionRate = 0;
    w.openStream(0, 0, 1);
    for (let i = 0; i < 4000 && w.planets[1].owner !== 0; i++) w.step(1 / 30);
    expect(w.planets[1].owner).toBe(0);
  });
});

describe('totalGarrison', () => {
  it('counts hovering units so parked fleets stay on the HUD bar', () => {
    const map: MapSpec = {
      width: 400,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 0 },
        { pos: { x: 350, y: 100 }, radius: 16, owner: 1, garrison: 5 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    w.planets[0].productionRate = 4;
    for (let i = 0; i < 80; i++) w.step(0.05);
    w.planets[0].productionRate = 0;
    const before = w.totalGarrison(0);
    expect(before).toBeGreaterThan(3);
    // Send everything to a free-space hold point and let it settle to hover.
    for (const s of w.ships.all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === 0) s.isSelected = true;
    }
    const n = w.commandSelectedTo(0, { x: 200, y: 100 });
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) w.step(1 / 30);
    const hovering = w.ships.all.filter((s) => s.active && s.state === 'hovering').length;
    expect(hovering).toBeGreaterThan(0);
    // The parked fleet must still count toward the player's total strength.
    expect(w.totalGarrison(0)).toBe(before);
  });
});

describe('ship combat at negative coordinates', () => {
  it('mutually destroys opposing hover fleets even off the map origin', () => {
    // Two enemy units hovering around adjacent negative-coordinate points —
    // the old spatial-hash key packing corrupted negative cells, so pairs
    // straddling a cell boundary there never collided.
    const map: MapSpec = {
      width: 400,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 5 },
        { pos: { x: 350, y: 100 }, radius: 16, owner: 1, garrison: 5 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [
      { id: 0, isAI: false, name: 'P' },
      { id: 1, isAI: true, name: 'A' },
    ]);
    w.planets[0].productionRate = 0;
    w.planets[1].productionRate = 0;
    // Place one hovering combatant of each owner within collide range but on
    // opposite sides of a negative grid-cell boundary (cell size 38 puts one
    // at x = -38), exercising the cross-cell neighbor lookup that the
    // corrupted key decode used to miss.
    const spots: Array<[number, number, number]> = [
      [0, -40, -40],
      [1, -36.5, -40],
    ];
    for (const [owner, sx, sy] of spots) {
      const idx = w.ships.spawn(owner, { x: sx, y: sy }, -1, 48, {
        vx: 0,
        vy: 0,
        turnRate: 2,
        wobbleAmp: 0,
        wobblePhase: 0,
        state: 'hovering',
      });
      const s = w.ships.get(idx);
      s.targetX = sx;
      s.targetY = sy;
    }
    for (let i = 0; i < 150; i++) w.step(1 / 30);
    // Only the two hover combatants matter — seeded starting orbiters far
    // away at the planets stay alive by design.
    const hoverSurvivors = w.ships.all.filter(
      (s) => s.active && s.state === 'hovering',
    ).length;
    expect(hoverSurvivors).toBe(0);
  });
});

describe('fractional sends', () => {
  it('half-selection keeps the unselected half of the swarm at home', () => {
    const map: MapSpec = {
      width: 400,
      height: 200,
      planets: [
        { pos: { x: 50, y: 100 }, radius: 16, owner: 0, garrison: 0 },
        { pos: { x: 350, y: 100 }, radius: 16, owner: null, garrison: 30 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    // Build up a live swarm, then freeze production.
    w.planets[0].productionRate = 6;
    for (let i = 0; i < 120; i++) w.step(0.05);
    w.planets[0].productionRate = 0;
    const before = w.planets[0].garrison;
    expect(before).toBeGreaterThanOrEqual(10);
    // Select every other orbiter — exactly what Selection's half-stage does.
    let i = 0;
    for (const s of w.ships.all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === 0) {
        if (i % 2 === 0) s.isSelected = true;
        i++;
      }
    }
    const sent = w.commandSelectedTo(0, { planetId: 1 });
    // Roughly half went; the rest — including any production overflow —
    // stayed garrisoned instead of being force-drained.
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(before);
    expect(w.planets[0].garrison).toBe(before - sent);
    expect(w.planets[0].garrison).toBeGreaterThan(0);
  });
});

describe('reinforce / reabsorb reliability', () => {
  const soloMap: MapSpec = {
    width: 200,
    height: 100,
    planets: [{ pos: { x: 100, y: 50 }, radius: 16, owner: 0, garrison: 20 }],
    edges: [],
  };

  it('absorb heals a damaged ringless planet exactly to full, then releases the rest', () => {
    const w = new World(soloMap, [{ id: 0, isAI: false, name: 'P' }]);
    const p = w.planets[0];
    p.productionRate = 0;
    p.health = p.maxHealth - 3;
    w.triggerAbsorb(0, 0, true);
    for (let i = 0; i < 400; i++) w.step(0.05);
    expect(p.health).toBe(p.maxHealth);
    // Absorb auto-cancelled once there was nothing left to feed.
    expect(p.absorbing).toBe(false);
    // Exactly 3 units were consumed to heal 3 damage — nobody else was
    // wasted feeding a full planet.
    expect(p.garrison).toBe(17);
    const orbiters = w.ships.all.filter(
      (s) => s.active && s.state === 'orbiting' && s.parentPlanet === 0,
    );
    expect(orbiters.length).toBe(17);
    // No unit left stuck mid-pull.
    expect(
      w.ships.all.filter((s) => s.active && s.state === 'absorbing').length,
    ).toBe(0);
  });

  it('re-selecting the local swarm and sending it home heals the planet', () => {
    const w = new World(soloMap, [{ id: 0, isAI: false, name: 'P' }]);
    const p = w.planets[0];
    p.productionRate = 0;
    p.health = p.maxHealth - 2;
    // The player taps the planet / lassoes the swarm, then taps the planet:
    // Selection.routeTo(planet, absorb=true) → commandSelectedTo on itself.
    for (const s of w.ships.all) {
      if (s.active && s.state === 'orbiting' && s.parentPlanet === 0) {
        s.isSelected = true;
      }
    }
    const sent = w.commandSelectedTo(0, { planetId: 0 }, { absorbOnArrive: true });
    expect(sent).toBe(20);
    for (let i = 0; i < 600; i++) w.step(0.05);
    expect(p.health).toBe(p.maxHealth);
    // 2 consumed to heal; the other 18 are back home in orbit, not lost.
    expect(p.garrison).toBe(18);
    const orbiters = w.ships.all.filter(
      (s) => s.active && s.state === 'orbiting' && s.parentPlanet === 0,
    );
    expect(orbiters.length).toBe(18);
  });

  it('tagged reinforcements arriving after the heal completes join orbit instead of vanishing', () => {
    const map: MapSpec = {
      width: 400,
      height: 100,
      planets: [
        { pos: { x: 40, y: 50 }, radius: 16, owner: 0, garrison: 20 },
        { pos: { x: 360, y: 50 }, radius: 16, owner: 0, garrison: 15 },
      ],
      edges: [[0, 1]],
    };
    const w = new World(map, [{ id: 0, isAI: false, name: 'P' }]);
    for (const p of w.planets) p.productionRate = 0;
    const target = w.planets[0];
    target.health = target.maxHealth - 1;
    // Reinforce the damaged planet with a tagged absorb wave far bigger
    // than the 1 HP it needs.
    w.openStream(0, 1, 0, 10, { absorbOnArrive: true });
    for (let i = 0; i < 800; i++) w.step(0.05);
    expect(target.health).toBe(target.maxHealth);
    // 10 arrived (+10), exactly 1 was consumed healing (−1).
    expect(target.garrison).toBe(29);
    expect(
      w.ships.all.filter((s) => s.active && s.state === 'absorbing').length,
    ).toBe(0);
  });
});
