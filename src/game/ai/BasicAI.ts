import { dist } from '../../util/math.js';
import { pointToSegmentDist, type World } from '../sim/World.js';

export interface AIConfig {
  /** Seconds between decision ticks. Lower = faster reactions. */
  tickInterval: number;
  /** Scales target scoring; higher = more willing to take fights. */
  aggression: number;
  /** Fraction of each planet's garrison held back from offense. */
  reserveFrac: number;
  /** Max simultaneous attack waves per decision tick. */
  maxWaves: number;
  /**
   * Whether the AI invests surplus into absorb (ring fill → evolution).
   * This is what lets higher difficulties keep pace with a player who
   * upgrades — an AI that never evolves falls off a cliff late game.
   */
  usesAbsorb: boolean;
}

/**
 * Difficulty ladder. Chill is deliberately passive — long pauses, deep
 * reserves, no upgrades — so the first constellations teach the ropes.
 * Fierce reacts three times as fast, commits deeper, opens second fronts,
 * and grows its worlds.
 */
export const CHILL_AI: AIConfig = {
  tickInterval: 6.5,
  aggression: 0.12,
  reserveFrac: 0.85,
  maxWaves: 1,
  usesAbsorb: false,
};

export const NORMAL_AI: AIConfig = {
  tickInterval: 5.0,
  aggression: 0.18,
  reserveFrac: 0.75,
  maxWaves: 1,
  usesAbsorb: true,
};

export const FIERCE_AI: AIConfig = {
  tickInterval: 3.2,
  aggression: 0.3,
  reserveFrac: 0.6,
  maxWaves: 2,
  usesAbsorb: true,
};

/** Minimum surplus garrison before the AI will even consider attacking. */
const MIN_ATTACK_FORCE = 12;
/** Extra buffer on top of the target's effective garrison, so the AI doesn't
 * throw away a nearly-even attack. */
const ATTACK_MARGIN = 4;
/** Radius within which an enemy hover fleet counts as a threat to a planet. */
const HOVER_THREAT_RADIUS = 240;
/**
 * Garrison fraction above which a safe ringed planet starts absorbing.
 * Below this the AI keeps its units in orbit as defenders.
 */
const ABSORB_SURPLUS_FRAC = 0.55;

export class BasicAI {
  private world: World;
  private playerId: number;
  private acc: number;
  private cfg: AIConfig;

  constructor(world: World, playerId: number, cfg: AIConfig = NORMAL_AI) {
    this.world = world;
    this.playerId = playerId;
    this.cfg = cfg;
    // Stagger first thoughts so multiple AIs in a free-for-all don't all
    // act on the same frame every tick.
    this.acc = Math.random() * cfg.tickInterval * 0.5;
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < this.cfg.tickInterval) return;
    this.acc = 0;
    this.think();
  }

  /**
   * Enemy pressure on a planet: ships flying at it, plus enemy fleets
   * parked (hovering) close enough to strike — a player staging a swarm
   * next door is a threat even before they commit it.
   */
  private incomingThreat(planetId: number): number {
    const planet = this.world.planets[planetId];
    let n = 0;
    for (const s of this.world.ships.all) {
      if (!s.active || s.owner === this.playerId) continue;
      if (s.targetPlanet === planetId) {
        n++;
        continue;
      }
      if (s.state === 'hovering' && dist({ x: s.x, y: s.y }, planet.pos) < HOVER_THREAT_RADIUS) {
        n++;
      }
    }
    return n;
  }

  private incomingFriendly(planetId: number): number {
    let n = 0;
    for (const s of this.world.ships.all) {
      if (!s.active) continue;
      if (s.targetPlanet !== planetId) continue;
      if (s.owner === this.playerId) n++;
    }
    return n;
  }

  /**
   * Penalty multiplier for a wave flying `from` → `to` past black holes.
   * A line through the capture zone means most of the wave dies (heavily
   * discouraged); merely clipping the gravity well costs some fringe ships,
   * so it's discounted rather than banned — the AI takes the same measured
   * risks a player does.
   */
  private routeHazardPenalty(from: { x: number; y: number }, to: { x: number; y: number }): number {
    let penalty = 1;
    for (const bh of this.world.blackHoles) {
      const d = pointToSegmentDist(bh.pos.x, bh.pos.y, from.x, from.y, to.x, to.y);
      if (d < bh.captureRadius + 30) penalty *= 0.25;
      else if (d < bh.gravityRadius) penalty *= 0.7;
    }
    return penalty;
  }

  private think(): void {
    const me = this.playerId;
    const myPlanets = this.world.planets.filter((p) => p.owner === me);
    if (myPlanets.length === 0) return;

    // Drop own stale streams so we can rebuild decisions this tick.
    this.world.cancelAllStreamsOf(me);

    // Threat assessment once per planet, reused by defense + absorb + offense.
    const threats = new Map<number, number>();
    for (const p of myPlanets) threats.set(p.id, this.incomingThreat(p.id));

    // Defensive: reinforce any own planet whose threat exceeds garrison.
    for (const p of myPlanets) {
      const threat = threats.get(p.id) ?? 0;
      const friendly = this.incomingFriendly(p.id);
      const deficit = threat - friendly - p.garrison;
      if (deficit <= 0) continue;
      let best: { id: number; d: number } | null = null;
      for (const q of myPlanets) {
        if (q.id === p.id) continue;
        if (q.garrison < 4) continue;
        const d = dist(q.pos, p.pos);
        if (!best || d < best.d) best = { id: q.id, d };
      }
      if (best) {
        const src = this.world.planets[best.id];
        const count = Math.min(src.garrison - 1, deficit + 2);
        if (count > 0) this.world.openStream(me, best.id, p.id, count);
      }
    }

    // Growth: on safe planets with rings (or damage), pull surplus into
    // absorb so the AI evolves its worlds like the player does. Under
    // threat, absorb stops immediately — defenders matter more than rings.
    if (this.cfg.usesAbsorb) {
      for (const p of myPlanets) {
        const threatened = (threats.get(p.id) ?? 0) > 0;
        const wantsAbsorb =
          !threatened &&
          (p.ringCount > 0 || p.health < p.maxHealth) &&
          p.garrison > p.maxUnitCapacity * ABSORB_SURPLUS_FRAC;
        if (p.absorbing && threatened) {
          this.world.triggerAbsorb(p.id, me, false);
        } else if (!p.absorbing && wantsAbsorb) {
          this.world.triggerAbsorb(p.id, me, true);
        }
      }
    }

    // Offense: up to `maxWaves` attack waves this tick, from the strongest
    // planets first. Require a comfortable surplus plus ATTACK_MARGIN over
    // the target so the AI doesn't throw bodies at coin-flip fights.
    const reserve = this.cfg.reserveFrac;
    const sortedByGarrison = [...myPlanets].sort((a, b) => b.garrison - a.garrison);
    let wavesLeft = this.cfg.maxWaves;
    for (const p of sortedByGarrison) {
      if (wavesLeft <= 0) break;
      if (p.absorbing) continue; // this planet is busy growing
      const available = p.garrison - Math.ceil(p.garrison * reserve);
      if (available < MIN_ATTACK_FORCE) continue;
      let best: { id: number; score: number } | null = null;
      for (const tgt of this.world.planets) {
        if (tgt.owner === me) continue;
        const incomingMine = this.incomingFriendly(tgt.id);
        const effective = tgt.garrison - incomingMine;
        // Only attack if our wave clears the garrison with a safety margin.
        if (available < effective + ATTACK_MARGIN) continue;
        const d = Math.max(60, dist(p.pos, tgt.pos));
        // Prefer neutral targets early; neighbours over long-range gambles.
        const neutralBonus = tgt.owner === null ? 1.2 : 0.85;
        const score =
          ((tgt.radius * neutralBonus) / (Math.max(1, effective + 1) * d)) *
          this.cfg.aggression *
          this.routeHazardPenalty(p.pos, tgt.pos);
        if (!best || score > best.score) best = { id: tgt.id, score };
      }
      if (best) {
        // Commit a fraction of `available` instead of the full surplus — keeps
        // the AI from emptying a planet on one gamble.
        const commit = Math.max(MIN_ATTACK_FORCE, Math.floor(available * 0.75));
        this.world.openStream(me, p.id, best.id, commit);
        wavesLeft--;
      }
    }
  }
}
