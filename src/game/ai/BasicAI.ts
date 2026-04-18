import { dist } from '../../util/math.js';
import type { World } from '../sim/World.js';

export interface AIConfig {
  tickInterval: number;
  aggression: number;
  reserveFrac: number;
}

export const NORMAL_AI: AIConfig = {
  tickInterval: 2.8,
  aggression: 0.45,
  reserveFrac: 0.55,
};

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
    const reserve = this.cfg.reserveFrac;
    const sortedByGarrison = [...myPlanets].sort((a, b) => b.garrison - a.garrison);
    for (const p of sortedByGarrison) {
      const available = p.garrison - Math.ceil(p.garrison * reserve);
      if (available < 6) continue;
      let best: { id: number; score: number } | null = null;
      for (const tgt of this.world.planets) {
        if (tgt.owner === me) continue;
        const incomingMine = this.incomingFriendly(tgt.id);
        const effective = tgt.garrison - incomingMine;
        // Only attack if our wave can plausibly take it.
        if (available <= effective) continue;
        const d = Math.max(60, dist(p.pos, tgt.pos));
        const neutralBonus = tgt.owner === null ? 1.3 : 1.0;
        const score =
          ((tgt.radius * neutralBonus) / (Math.max(1, effective + 1) * d)) *
          this.cfg.aggression;
        if (!best || score > best.score) best = { id: tgt.id, score };
      }
      if (best) {
        this.world.openStream(me, p.id, best.id, available);
        break; // one wave per think tick keeps the AI measured.
      }
    }
  }
}
