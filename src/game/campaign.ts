import {
  AGGRESSOR,
  CHILL_AI,
  ECONOMIST,
  FIERCE_AI,
  NORMAL_AI,
  OPPORTUNIST,
  type AIConfig,
  type Personality,
} from './ai/BasicAI.js';
import type { MapGenConfig } from './maps/generator.js';

/**
 * The campaign: eight named constellations with a deliberate difficulty
 * ramp. The first two are gentle on purpose — a passive AI, mostly-calm
 * skies, a garrison head start — so new players learn the swarm loop
 * before the game starts hitting back. From there each level adds one
 * pressure at a time: hazards, a sharper AI, then free-for-alls, then
 * fierce free-for-alls with everything turned on. Every level's hazard
 * pool is non-empty so drifting planets and asteroid belts have a chance
 * of appearing anywhere in the campaign; only the odds ramp. Map layout
 * archetypes widen the same way: early skies are open scatter, later ones
 * roll lanes, ringworlds, and clusters so the geography itself becomes a
 * strategic variable.
 */
export interface LevelDef {
  id: string;
  name: string;
  /** One-line flavor + what's new, shown on the level select. */
  blurb: string;
  map: MapGenConfig;
  /** One config per AI rival; length = map.playerCount - 1. */
  aiConfigs: AIConfig[];
  /**
   * Optional temperament per rival, parallel to `aiConfigs`. Free-for-all
   * levels mix distinct personalities so the rivals read as different minds;
   * omitted entries play the balanced default.
   */
  personalities?: Personality[];
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
      layouts: ['scatter', 'lanes'],
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
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm', 'wormhole'],
      calmChance: 0.25,
      playerGarrison: 20,
      enemyGarrison: 16,
      playerRing: true,
      layouts: ['scatter', 'lanes', 'ringworld'],
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
      hazardPool: ['driftingPlanet', 'asteroidField', 'neutralSwarm', 'wormhole'],
      calmChance: 0.45,
      playerGarrison: 20,
      enemyGarrison: 16,
      playerRing: true,
      layouts: ['scatter', 'ringworld', 'clusters'],
    },
    aiConfigs: [NORMAL_AI, NORMAL_AI],
    // A hoarder and a bully — the free-for-all reads as two different minds.
    personalities: [ECONOMIST, AGGRESSOR],
  },
  {
    id: 'draco',
    name: 'Draco',
    blurb: 'The dragon coils: three armies, a hostile sky — and a dark star.',
    map: {
      playerCount: 3,
      totalPlanets: [8, 10],
      hazardPool: [
        'driftingPlanet',
        'asteroidField',
        'neutralSwarm',
        'blackHole',
        'flareStar',
      ],
      calmChance: 0.2,
      playerGarrison: 20,
      enemyGarrison: 18,
      playerRing: true,
      layouts: ['scatter', 'lanes', 'ringworld', 'clusters'],
    },
    aiConfigs: [NORMAL_AI, FIERCE_AI],
    personalities: [OPPORTUNIST, AGGRESSOR],
  },
  {
    id: 'cygnus',
    name: 'Cygnus',
    blurb: 'Four armies under the swan. Expansion is survival.',
    map: {
      playerCount: 4,
      totalPlanets: [9, 10],
      hazardPool: [
        'driftingPlanet',
        'asteroidField',
        'neutralSwarm',
        'blackHole',
        'flareStar',
        'wormhole',
      ],
      calmChance: 0.2,
      playerGarrison: 20,
      enemyGarrison: 18,
      playerRing: true,
      layouts: ['scatter', 'lanes', 'ringworld', 'clusters'],
    },
    aiConfigs: [NORMAL_AI, NORMAL_AI, FIERCE_AI],
    personalities: [ECONOMIST, OPPORTUNIST, AGGRESSOR],
  },
  {
    id: 'andromeda',
    name: 'Andromeda',
    blurb: 'The final sky. Every rival is fierce. Every star counts.',
    map: {
      playerCount: 4,
      totalPlanets: [10, 11],
      hazardPool: [
        'driftingPlanet',
        'asteroidField',
        'neutralSwarm',
        'blackHole',
        'flareStar',
        'wormhole',
      ],
      calmChance: 0.1,
      playerGarrison: 20,
      enemyGarrison: 20,
      playerRing: true,
      layouts: ['scatter', 'lanes', 'ringworld', 'clusters'],
    },
    aiConfigs: [FIERCE_AI, FIERCE_AI, FIERCE_AI],
    personalities: [ECONOMIST, OPPORTUNIST, AGGRESSOR],
  },

  // ── The Zodiac ──────────────────────────────────────────────────────────
  // A second arc after the main campaign: each sky IS a real zodiac sign —
  // the neutral planets trace the constellation's principal stars (see
  // `starPattern` in the map generator), so the figure you fight over is the
  // figure in the night sky. Difficulty deliberately mixes easy, medium and
  // hard, driven by hazards and by AI intelligence/aggression, so the arc
  // reads as a tour of the ecliptic rather than one long final exam.
  {
    id: 'aries',
    name: 'Aries',
    blurb: 'The Ram — an easy sky. A drowsy rival grazes along the horns.',
    map: {
      playerCount: 2,
      totalPlanets: [7, 7],
      hazardPool: ['asteroidField', 'driftingPlanet'],
      calmChance: 0.6,
      playerGarrison: 24,
      enemyGarrison: 11,
      playerRing: true,
      // Hamal–Sheratan–Mesarthim arc with the fainter flank stars.
      starPattern: [
        [0.14, 0.52],
        [0.38, 0.34],
        [0.6, 0.3],
        [0.8, 0.42],
        [0.9, 0.62],
      ],
    },
    aiConfigs: [CHILL_AI],
  },
  {
    id: 'taurus',
    name: 'Taurus',
    blurb: 'The Bull — easy, but stubborn: a hoarder digs in among the Hyades.',
    map: {
      playerCount: 2,
      totalPlanets: [9, 9],
      hazardPool: ['asteroidField', 'neutralSwarm', 'driftingPlanet'],
      calmChance: 0.35,
      playerGarrison: 22,
      enemyGarrison: 14,
      playerRing: true,
      // The V of the Hyades opening into the long horns (β Tau / ζ Tau).
      starPattern: [
        [0.9, 0.08],
        [0.94, 0.6],
        [0.68, 0.22],
        [0.72, 0.5],
        [0.5, 0.36],
        [0.3, 0.34],
        [0.1, 0.4],
      ],
    },
    aiConfigs: [NORMAL_AI],
    personalities: [ECONOMIST],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    blurb: 'The Twins — medium. Two matched minds, and twin gates that fold the sky.',
    map: {
      playerCount: 3,
      totalPlanets: [11, 11],
      hazardPool: ['wormhole', 'driftingPlanet', 'asteroidField'],
      calmChance: 0.2,
      playerGarrison: 20,
      enemyGarrison: 15,
      playerRing: true,
      // Castor's and Pollux's stick figures, shoulder to shoulder.
      starPattern: [
        [0.3, 0.1],
        [0.52, 0.16],
        [0.34, 0.34],
        [0.56, 0.4],
        [0.38, 0.58],
        [0.6, 0.64],
        [0.44, 0.84],
        [0.68, 0.88],
      ],
    },
    aiConfigs: [NORMAL_AI, NORMAL_AI],
    // Identical temperaments — the whole point of the Twins.
    personalities: [OPPORTUNIST, OPPORTUNIST],
  },
  {
    id: 'leo',
    name: 'Leo',
    blurb: 'The Lion — medium-hard. A fierce aggressor prowls the Sickle, and Regulus flares.',
    map: {
      playerCount: 2,
      totalPlanets: [11, 11],
      hazardPool: ['flareStar', 'neutralSwarm', 'asteroidField'],
      calmChance: 0.12,
      playerGarrison: 20,
      enemyGarrison: 17,
      playerRing: true,
      // The Sickle (head/mane, Regulus at its foot) plus the hindquarter
      // triangle out to Denebola.
      starPattern: [
        [0.78, 0.72],
        [0.76, 0.52],
        [0.84, 0.36],
        [0.74, 0.2],
        [0.58, 0.12],
        [0.48, 0.26],
        [0.38, 0.44],
        [0.3, 0.68],
        [0.08, 0.56],
      ],
    },
    aiConfigs: [FIERCE_AI],
    personalities: [AGGRESSOR],
  },
  {
    id: 'scorpius',
    name: 'Scorpius',
    blurb: 'The Scorpion — hard. A dark star burns in the claws; the sting is live.',
    map: {
      playerCount: 3,
      totalPlanets: [12, 12],
      hazardPool: ['blackHole', 'flareStar', 'neutralSwarm', 'wormhole'],
      calmChance: 0.08,
      playerGarrison: 20,
      enemyGarrison: 18,
      playerRing: true,
      // Head and claws top-right, the long body curving down into the
      // hooked stinger — Antares glowing a third of the way along.
      starPattern: [
        [0.86, 0.14],
        [0.94, 0.28],
        [0.8, 0.3],
        [0.68, 0.36],
        [0.58, 0.46],
        [0.5, 0.62],
        [0.48, 0.8],
        [0.6, 0.92],
        [0.74, 0.86],
      ],
    },
    aiConfigs: [NORMAL_AI, FIERCE_AI],
    personalities: [OPPORTUNIST, AGGRESSOR],
  },
  {
    id: 'sagittarius',
    name: 'Sagittarius',
    blurb: 'The Archer — hard. Four armies fight over the Teapot with everything turned on.',
    map: {
      playerCount: 4,
      totalPlanets: [12, 12],
      hazardPool: [
        'driftingPlanet',
        'asteroidField',
        'neutralSwarm',
        'blackHole',
        'flareStar',
        'wormhole',
      ],
      calmChance: 0.05,
      playerGarrison: 20,
      enemyGarrison: 19,
      playerRing: true,
      // The Teapot: lid, body, spout tip and handle.
      starPattern: [
        [0.48, 0.16],
        [0.34, 0.38],
        [0.62, 0.34],
        [0.3, 0.62],
        [0.66, 0.6],
        [0.1, 0.46],
        [0.84, 0.42],
        [0.8, 0.66],
      ],
    },
    aiConfigs: [FIERCE_AI, FIERCE_AI, FIERCE_AI],
    personalities: [ECONOMIST, OPPORTUNIST, AGGRESSOR],
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
