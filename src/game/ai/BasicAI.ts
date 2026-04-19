import { dist } from '../../util/math.js';
import type { World } from '../sim/World.js';

export interface AIConfig {
  tickInterval: number;
  aggression: number;
  reserveFrac: number;
}

/**
 * Toned-down defaults: the previous profile (2.8s tick, 0.45 aggression,
 * 0.55 reserve) rushed hard enough that the player rarely had breathing room.
 * This profile waits longer between decisions, commits smaller fractions of
 * its garrison, and only attacks when it has a meaningful numerical edge.
 */
export const NORMAL_AI: AIConfig = {
  tickInterval: 5.0,
  aggression: 0.18,
  reserveFrac: 0.75,
};

/** Minimum surplus garrison before the AI will even consider attacking. */
const MIN_ATTACK_FORCE = 12;
/** Extra buffer on top of the target's effective garrison, so the AI doesn't
 * throw away a nearly-even attack. */
const ATTACK_MARGIN = 4;

export class BasicAI {
  private world: World;
  private playerId: number;
  private acc = 0;
  private cfg: AIConfig;

  constructor(world: World, playerId: number, cfg: AIConfig = NORMAL_AI) {
    this.world = world;
    this.playerId = playerId;
    this.cfg = cfg;
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < this.cfg.tickInterval) return;
    this.acc = 0;
    this.think();
  }

  private incomingThreat(planetId: number): number {
    let n = 0;
    for (const s of this.world.ships.all) {
      if (!s.active) continue;
      if (s.targetPlanet !== planetId) continue;
      if (s.owner === this.playerId) continue;
      n++;
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

  private think(): void {
    const me = this.playerId;
    const myPlanets = this.world.planets.filter((p) => p.owner === me);
    if (myPlanets.length === 0) return;

    // Drop own stale streams so we can rebuild decisions this tick.
    this.world.cancelAllStreamsOf(me);

    // Defensive: reinforce any own planet whose threat exceeds garrison.
    for (const p of myPlanets) {
      const threat = this.incomingThreat(p.id);
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

    // Offense: send at most ONE attack wave this tick, from the strongest planet.
    // Require a comfortable surplus plus an ATTACK_MARGIN over the target so
    // the AI doesn't throw bodies at coin-flip fights.
    const reserve = this.cfg.reserveFrac;
    const sortedByGarrison = [...myPlanets].sort((a, b) => b.garrison - a.garrison);
    for (const p of sortedByGarrison) {
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
          this.cfg.aggression;
        if (!best || score > best.score) best = { id: tgt.id, score };
      }
      if (best) {
        // Commit a fraction of `available` instead of the full surplus — keeps
        // the AI from emptying a planet on one gamble.
        const commit = Math.max(MIN_ATTACK_FORCE, Math.floor(available * 0.75));
        this.world.openStream(me, p.id, best.id, commit);
        break; // one wave per think tick keeps the AI measured.
      }
    }
  }
}
