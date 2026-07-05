import { CHILL_AI, FIERCE_AI, NORMAL_AI, type AIConfig } from './ai/BasicAI.js';
import type { MapGenConfig } from './maps/generator.js';

/**
 * The campaign: eight named constellations with a deliberate difficulty
 * ramp. The first two are gentle on purpose — a passive AI, mostly-calm
 * skies, a garrison head start — so new players learn the swarm loop
 * before the game starts hitting back. From there each level adds one
 * pressure at a time: hazards, a sharper AI, then free-for-alls, then
 * fierce free-for-alls with everything turned on. Every level's hazard
 * pool is non-empty so drifting planets and asteroid belts have a chance
 * of appearing anywhere in the campaign; only the odds ramp.
 */
export interface LevelDef {
  id: string;
  name: string;
  /** One-line flavor + what's new, shown on the level select. */
  blurb: string;
  map: MapGenConfig;
  /** One config per AI rival; length = map.playerCount - 1. */
  aiConfigs: AIConfig[];
}

export const LEVELS: LevelDef[] = [
  {
    id: 'orion',
    name: 'Orion',
    blurb: 'The hunter sleeps. Learn to gather and send your swarm.',
    map: {
      playerCount: 2,
      totalPlanets: [5, 6],
      // Even the tutorial sky occasionally shows an asteroid belt — mostly
      // calm, but the hazard elements should have a chance to appear anywhere.
      hazardPool: ['asteroidField'],
      calmChance: 0.7,
      playerGarrison: 25,
      enemyGarrison: 10,
      playerRing: true,
    },
    aiConfigs: [CHILL_AI],
  },
  {
    id: 'lyra',
    name: 'Lyra',
    blurb: 'A quiet harp. Feed a ringed star and evolve it.',
    map: {
      playerCount: 2,
      totalPlanets: [6, 7],
      hazardPool: ['asteroidField', 'driftingPlanet'],
      calmChance: 0.55,
      playerGarrison: 22,
      enemyGarrison: 12,
      playerRing: true,
    },
    aiConfigs: [CHILL_AI],
  },
  {
    id: 'cassiopeia',
    name: 'Cassiopeia',
    blurb: 'An asteroid belt slows every crossing. Pick your lanes.',
    map: {
      playerCount: 2,
      totalPlanets: [6, 8],
      hazardPool: ['asteroidField'],
      calmChance: 0,
      playerGarrison: 20,
      enemyGarrison: 14,
      playerRing: true,
    },
    aiConfigs: [NORMAL_AI],
  },
  {
    id: 'perseus',
    name: 'Perseus',
    blurb: 'Anything can happen out here — and the rival is awake now.',
    map: {
      playerCount: 2,
      totalPlanets: [7, 9],
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm'],
      calmChance: 0.25,
      playerGarrison: 20,
      enemyGarrison: 16,
      playerRing: true,
    },
    aiConfigs: [NORMAL_AI],
  },
  {
    id: 'ursa-major',
    name: 'Ursa Major',
    blurb: 'Three armies, one sky. Let your rivals bleed each other.',
    map: {
      playerCount: 3,
      totalPlanets: [8, 9],
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm'],
      calmChance: 0.45,
      playerGarrison: 20,
      enemyGarrison: 16,
      playerRing: true,
    },
    aiConfigs: [NORMAL_AI, NORMAL_AI],
  },
  {
    id: 'draco',
    name: 'Draco',
    blurb: 'The dragon coils: three armies, a hostile sky — and a dark star.',
    map: {
      playerCount: 3,
      totalPlanets: [8, 10],
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm', 'blackHole'],
      calmChance: 0.2,
      playerGarrison: 20,
      enemyGarrison: 18,
      playerRing: true,
    },
    aiConfigs: [NORMAL_AI, FIERCE_AI],
  },
  {
    id: 'cygnus',
    name: 'Cygnus',
    blurb: 'Four armies under the swan. Expansion is survival.',
    map: {
      playerCount: 4,
      totalPlanets: [9, 10],
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm', 'blackHole'],
      calmChance: 0.2,
      playerGarrison: 20,
      enemyGarrison: 18,
      playerRing: true,
    },
    aiConfigs: [NORMAL_AI, NORMAL_AI, FIERCE_AI],
  },
  {
    id: 'andromeda',
    name: 'Andromeda',
    blurb: 'The final sky. Every rival is fierce. Every star counts.',
    map: {
      playerCount: 4,
      totalPlanets: [10, 11],
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm', 'blackHole'],
      calmChance: 0.1,
      playerGarrison: 20,
      enemyGarrison: 20,
      playerRing: true,
    },
    aiConfigs: [FIERCE_AI, FIERCE_AI, FIERCE_AI],
  },
];

const PROGRESS_KEY = 'constellations.unlocked';

/** Number of unlocked levels (1..LEVELS.length). At least 1. */
export const loadUnlockedCount = (): number => {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const n = raw === null ? 1 : parseInt(raw, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(LEVELS.length, n));
  } catch {
    return LEVELS.length; // storage unavailable → everything open, no walls
  }
};

/** Record that `levelIdx` was beaten, unlocking the level after it. */
export const recordVictory = (levelIdx: number): void => {
  try {
    const unlocked = Math.max(loadUnlockedCount(), Math.min(LEVELS.length, levelIdx + 2));
    localStorage.setItem(PROGRESS_KEY, String(unlocked));
  } catch {
    // Private-mode storage failure: progress just doesn't persist.
  }
};
