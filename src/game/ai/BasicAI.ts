import { clamp, dist, segCircleIntersectionLength, type Vec2 } from '../../util/math.js';
import {
  pointToSegmentDist,
  SLINGSHOT_INNER_MULT,
  type World,
} from '../sim/World.js';

/**
 * How the AI sharpens over a match. All fields describe the END state of a
 * smoothstep ramp from the base config, reached at `rampSeconds` into the
 * game. The intent is a rival that visibly "wakes up" — reacting faster,
 * committing deeper, opening extra fronts — without ever cliff-jumping the
 * difficulty: the end state is tuned to stay beatable at every tier.
 */
export interface EscalationConfig {
  /** Seconds of match time to reach the fully escalated state. */
  rampSeconds: number;
  /** Final tickInterval = base * this (lower = faster thinking). */
  tickIntervalMult: number;
  /** Final aggression = base * this. */
  aggressionMult: number;
  /** Added to reserveFrac at full ramp (negative = commits deeper). */
  reserveDelta: number;
  /** Extra simultaneous waves unlocked at full ramp. */
  extraWaves: number;
}

/**
 * A rival's temperament, layered multiplicatively on top of the difficulty
 * config (after escalation). Personalities make free-for-all rivals read as
 * different minds: the economist turtles and evolves, the aggressor applies
 * early pressure, the opportunist waits for you to overextend.
 */
export interface Personality {
  name: string;
  aggressionMult: number;
  reserveDelta: number;
  /** Scales the bonus for striking under-defended (freshly drained) planets. */
  opportunismWeight: number;
  /** Scales the garrison threshold to start absorbing (lower = grows sooner). */
  absorbBias: number;
}

export const BALANCED: Personality = {
  name: 'balanced',
  aggressionMult: 1,
  reserveDelta: 0,
  opportunismWeight: 1,
  absorbBias: 1,
};

export const ECONOMIST: Personality = {
  name: 'economist',
  aggressionMult: 0.85,
  reserveDelta: 0.05,
  opportunismWeight: 0.8,
  absorbBias: 0.6,
};

export const AGGRESSOR: Personality = {
  name: 'aggressor',
  aggressionMult: 1.35,
  reserveDelta: -0.12,
  opportunismWeight: 1,
  absorbBias: 1.4,
};

export const OPPORTUNIST: Personality = {
  name: 'opportunist',
  aggressionMult: 1.05,
  reserveDelta: -0.03,
  opportunismWeight: 2.2,
  absorbBias: 1,
};

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
  /** In-match ramp. Omit for a rival that plays the same all game. */
  escalation?: EscalationConfig;
}

/**
 * Difficulty ladder. Chill is deliberately passive — long pauses, deep
 * reserves, no upgrades — so the first constellations teach the ropes.
 * Fierce reacts three times as fast, commits deeper, opens second fronts,
 * and grows its worlds. Every tier now also ramps *within* a match (see
 * `EscalationConfig`): even Chill stops napping ten minutes in.
 */
export const CHILL_AI: AIConfig = {
  tickInterval: 6.5,
  aggression: 0.12,
  reserveFrac: 0.85,
  maxWaves: 1,
  usesAbsorb: false,
  escalation: {
    rampSeconds: 300,
    tickIntervalMult: 0.75,
    aggressionMult: 1.3,
    reserveDelta: -0.08,
    extraWaves: 0,
  },
};

export const NORMAL_AI: AIConfig = {
  tickInterval: 5.0,
  aggression: 0.18,
  reserveFrac: 0.75,
  maxWaves: 1,
  usesAbsorb: true,
  escalation: {
    rampSeconds: 240,
    tickIntervalMult: 0.65,
    aggressionMult: 1.5,
    reserveDelta: -0.12,
    extraWaves: 1,
  },
};

export const FIERCE_AI: AIConfig = {
  tickInterval: 3.2,
  aggression: 0.3,
  reserveFrac: 0.6,
  maxWaves: 2,
  usesAbsorb: true,
  escalation: {
    rampSeconds: 180,
    tickIntervalMult: 0.7,
    aggressionMult: 1.4,
    reserveDelta: -0.1,
    extraWaves: 1,
  },
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
/**
 * Detection margin added to a swarm's patrol radius when pricing a route —
 * matches the sim's DETECT_RADIUS reach past the patrol band.
 */
const SWARM_ROUTE_MARGIN = 60;
/**
 * Logistics: rear planets holding at least this fraction of capacity ship
 * surplus toward the front instead of letting it idle out of the fight.
 */
const LOGISTICS_SURPLUS_FRAC = 0.7;

/** Smoothstep — gentle start and finish for the escalation ramp. */
const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** The mutable snapshot of the config the AI is actually playing this tick. */
interface EffectiveConfig {
  tickInterval: number;
  aggression: number;
  reserveFrac: number;
  maxWaves: number;
  usesAbsorb: boolean;
}

export class BasicAI {
  private world: World;
  private playerId: number;
  private acc: number;
  private cfg: AIConfig;
  private personality: Personality;
  /** Match-time clock driving the escalation ramp. */
  private elapsed = 0;

  constructor(
    world: World,
    playerId: number,
    cfg: AIConfig = NORMAL_AI,
    personality: Personality = BALANCED,
  ) {
    this.world = world;
    this.playerId = playerId;
    this.cfg = cfg;
    this.personality = personality;
    // Stagger first thoughts so multiple AIs in a free-for-all don't all
    // act on the same frame every tick.
    this.acc = Math.random() * cfg.tickInterval * 0.5;
  }

  /**
   * Config as played *right now*: base difficulty, escalated by match time,
   * flavored by personality. Exposed for tests and tuning.
   */
  effectiveConfig(): EffectiveConfig {
    const base = this.cfg;
    const esc = base.escalation;
    const k = esc ? smoothstep(this.elapsed / esc.rampSeconds) : 0;
    const tickInterval = esc
      ? base.tickInterval * (1 + (esc.tickIntervalMult - 1) * k)
      : base.tickInterval;
    const aggression =
      (esc ? base.aggression * (1 + (esc.aggressionMult - 1) * k) : base.aggression) *
      this.personality.aggressionMult;
    const reserveFrac = clamp(
      base.reserveFrac + (esc ? esc.reserveDelta * k : 0) + this.personality.reserveDelta,
      0.1,
      0.95,
    );
    const maxWaves = base.maxWaves + (esc ? Math.round(esc.extraWaves * k) : 0);
    return {
      tickInterval,
      aggression,
      reserveFrac,
      maxWaves,
      usesAbsorb: base.usesAbsorb,
    };
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.acc += dt;
    if (this.acc < this.effectiveConfig().tickInterval) return;
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
    // A line through a flare star's blast zone loses whatever slice of the
    // wave the next pulse catches — discounted, not banned, because timing
    // through between pulses genuinely works.
    for (const fs of this.world.flareStars) {
      const d = pointToSegmentDist(fs.pos.x, fs.pos.y, from.x, from.y, to.x, to.y);
      if (d < fs.maxRadius) penalty *= 0.75;
    }
    return penalty;
  }

  /**
   * Distance-equivalent cost of flying `from` → `to` with a wave of
   * `waveSize` ships — the same tradeoffs a player eyeballs:
   *
   *   - asteroid fields: the chord through the rocks is repriced by the
   *     slowdown, so a short line through a belt can genuinely lose to the
   *     long way around;
   *   - swarm patrol bands: crossing predicted-kill territory adds cost,
   *     softened for big committed waves (they outrun the pack, and losing
   *     three ships out of forty is noise — out of twelve it's a fifth);
   *   - black-hole slingshot: a line riding the safe band gets a small
   *     discount — the AI shaves past the well exactly like a bold player.
   */
  private effectiveTravelCost(from: Vec2, to: Vec2, waveSize: number): number {
    let cost = dist(from, to);
    for (const f of this.world.asteroidFields) {
      const inside = segCircleIntersectionLength(
        from.x, from.y, to.x, to.y, f.pos.x, f.pos.y, f.radius,
      );
      if (inside > 0) cost += inside * (1 / f.slowdown - 1);
    }
    for (const z of this.world.swarmZones()) {
      const reach = z.patrolRadius + SWARM_ROUTE_MARGIN;
      const inside = segCircleIntersectionLength(
        from.x, from.y, to.x, to.y, z.pos.x, z.pos.y, reach,
      );
      if (inside > 0) {
        cost += inside * 2.4 * clamp(8 / Math.max(1, waveSize), 0.25, 2);
      }
    }
    for (const bh of this.world.blackHoles) {
      const d = pointToSegmentDist(bh.pos.x, bh.pos.y, from.x, from.y, to.x, to.y);
      if (d > bh.captureRadius * (SLINGSHOT_INNER_MULT + 0.1) && d < bh.gravityRadius) {
        cost *= 0.92;
      }
    }
    // Flare stars: a chord through the blast zone risks eating a pulse, so
    // reprice it like hostile territory — expensive but crossable.
    for (const fs of this.world.flareStars) {
      const inside = segCircleIntersectionLength(
        from.x, from.y, to.x, to.y, fs.pos.x, fs.pos.y, fs.maxRadius,
      );
      if (inside > 0) cost += inside * 1.5;
    }
    // Wormholes: ships auto-route through a gate when it's shorter, so the
    // AI prices the gate path too (entry leg + exit leg + a small transit
    // tax) and takes whichever is cheaper — distant targets behind a gate
    // suddenly read as neighbors, exactly as they do for the player.
    for (const wh of this.world.wormholes) {
      const via =
        Math.min(
          dist(from, wh.a) + dist(wh.b, to),
          dist(from, wh.b) + dist(wh.a, to),
        ) + 60;
      if (via < cost) cost = via;
    }
    return cost;
  }

  private think(): void {
    const me = this.playerId;
    const cfg = this.effectiveConfig();
    const myPlanets = this.world.planets.filter((p) => p.owner === me);
    if (myPlanets.length === 0) return;

    // Drop own stale streams so we can rebuild decisions this tick.
    this.world.cancelAllStreamsOf(me);
    /** Planets that opened a stream this tick — one order per planet per tick. */
    const usedSources = new Set<number>();

    // Threat assessment once per planet, reused by defense + absorb + offense.
    const threats = new Map<number, number>();
    for (const p of myPlanets) threats.set(p.id, this.incomingThreat(p.id));

    // Defensive: reinforce any own planet whose threat exceeds garrison.
    // Source pick is by travel cost, not raw distance — help that has to
    // crawl through an asteroid belt usually isn't help.
    for (const p of myPlanets) {
      const threat = threats.get(p.id) ?? 0;
      const friendly = this.incomingFriendly(p.id);
      const deficit = threat - friendly - p.garrison;
      if (deficit <= 0) continue;
      let best: { id: number; cost: number } | null = null;
      for (const q of myPlanets) {
        if (q.id === p.id || usedSources.has(q.id)) continue;
        if (q.garrison < 4) continue;
        const cost = this.effectiveTravelCost(q.pos, p.pos, q.garrison);
        if (!best || cost < best.cost) best = { id: q.id, cost };
      }
      if (best) {
        const src = this.world.planets[best.id];
        const count = Math.min(src.garrison - 1, deficit + 2);
        if (count > 0) {
          this.world.openStream(me, best.id, p.id, count);
          usedSources.add(best.id);
        }
      }
    }

    // Growth: on safe planets with rings (or damage), pull surplus into
    // absorb so the AI evolves its worlds like the player does. Under
    // threat, absorb stops immediately — defenders matter more than rings.
    // The personality's absorbBias shifts the threshold: an economist grows
    // on a thinner surplus, an aggressor keeps its swarm battle-ready.
    if (cfg.usesAbsorb) {
      const absorbFrac = clamp(ABSORB_SURPLUS_FRAC * this.personality.absorbBias, 0.2, 0.9);
      for (const p of myPlanets) {
        const threatened = (threats.get(p.id) ?? 0) > 0;
        const wantsAbsorb =
          !threatened &&
          (p.ringCount > 0 || p.health < p.maxHealth) &&
          p.garrison > p.maxUnitCapacity * absorbFrac;
        if (p.absorbing && threatened) {
          this.world.triggerAbsorb(p.id, me, false);
        } else if (!p.absorbing && wantsAbsorb) {
          this.world.triggerAbsorb(p.id, me, true);
        }
      }
    }

    // Offense: up to `maxWaves` attack waves this tick, strongest planets
    // first. `planned` tracks force already committed at each target this
    // tick, which buys two smart-looking behaviors for free: two planets can
    // COORDINATE on a target neither clears alone, and they never waste
    // double force flattening the same world twice.
    const sortedByGarrison = [...myPlanets]
      .filter((p) => !usedSources.has(p.id))
      .sort((a, b) => b.garrison - a.garrison);
    const availableOf = (p: (typeof myPlanets)[number]): number =>
      p.absorbing ? 0 : p.garrison - Math.ceil(p.garrison * cfg.reserveFrac);
    let wavesLeft = cfg.maxWaves;
    const planned = new Map<number, number>();

    for (let si = 0; si < sortedByGarrison.length; si++) {
      if (wavesLeft <= 0) break;
      const p = sortedByGarrison[si];
      const available = availableOf(p);
      if (available < MIN_ATTACK_FORCE) continue;
      // Strongest surplus among the OTHER planets still free to act —
      // determines whether a joint strike is worth opening.
      let partnerAvailable = 0;
      for (let sj = si + 1; sj < sortedByGarrison.length; sj++) {
        if (usedSources.has(sortedByGarrison[sj].id)) continue;
        partnerAvailable = Math.max(partnerAvailable, availableOf(sortedByGarrison[sj]));
      }

      interface Candidate {
        id: number;
        score: number;
        needed: number;
        joint: boolean;
      }
      const candidates: Candidate[] = [];
      for (const tgt of this.world.planets) {
        if (tgt.owner === me) continue;
        const committed = planned.get(tgt.id) ?? 0;
        const needed =
          tgt.garrison - this.incomingFriendly(tgt.id) - committed + ATTACK_MARGIN;
        // Already fully covered by this tick's earlier waves — don't pile on.
        if (needed <= 0) continue;
        const soloOk = available >= needed;
        // Joint strike: this planet can't clear it alone, but together with
        // the best remaining partner it can — and it contributes a real
        // share, not a token escort.
        const jointOk =
          !soloOk &&
          wavesLeft >= 2 &&
          available + partnerAvailable >= needed &&
          available >= needed * 0.4;
        if (!soloOk && !jointOk) continue;
        const cost = Math.max(60, this.effectiveTravelCost(p.pos, tgt.pos, available));
        // Prefer neutral targets early; neighbours over long-range gambles.
        const neutralBonus = tgt.owner === null ? 1.2 : 0.85;
        // Ringed worlds are worth more — the AI hunts the same treasure the
        // map dangles in front of the player.
        const worth = tgt.radius * (1 + 0.35 * tgt.ringCount) * neutralBonus;
        let score =
          (worth / (Math.max(1, needed) * cost)) *
          cfg.aggression *
          this.routeHazardPenalty(p.pos, tgt.pos);
        // Opportunism: an owned planet sitting far under its capacity was
        // probably just drained — punish the overextension.
        if (tgt.owner !== null && tgt.garrison < tgt.maxUnitCapacity * 0.25) {
          score *= 1 + 0.6 * this.personality.opportunismWeight;
        }
        candidates.push({ id: tgt.id, score, needed, joint: jointOk });
      }
      if (candidates.length === 0) continue;

      // Soft-max pick among the top three so matches don't play out on
      // rails — the AI usually takes the best fight, sometimes the second.
      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 3);
      let total = 0;
      for (const c of top) total += c.score * c.score;
      let roll = Math.random() * total;
      let chosen = top[0];
      for (const c of top) {
        roll -= c.score * c.score;
        if (roll <= 0) {
          chosen = c;
          break;
        }
      }

      // Commit just enough to clear with a cushion — not the whole surplus —
      // unless this is the leading half of a joint strike, which goes all in
      // and relies on the partner to finish the arithmetic.
      const commit = chosen.joint
        ? available
        : Math.min(available, Math.max(MIN_ATTACK_FORCE, Math.ceil(chosen.needed * 1.15)));
      this.world.openStream(me, p.id, chosen.id, commit);
      usedSources.add(p.id);
      planned.set(chosen.id, (planned.get(chosen.id) ?? 0) + commit);
      wavesLeft--;
    }

    // Logistics: rear worlds far from the fighting shouldn't hoard idle
    // swarms. Any safe, full-ish planet that didn't act this tick ships part
    // of its surplus to the friendliest frontline world — the AI visibly
    // runs an economy in the back and a war at the front. (Chill skips
    // this: its whole character is that it lets garrisons pool.)
    if (cfg.usesAbsorb && myPlanets.length >= 2) {
      const enemyPlanets = this.world.planets.filter(
        (q) => q.owner !== null && q.owner !== me,
      );
      if (enemyPlanets.length > 0) {
        const frontDist = new Map<number, number>();
        for (const p of myPlanets) {
          let d = Infinity;
          for (const e of enemyPlanets) d = Math.min(d, dist(p.pos, e.pos));
          frontDist.set(p.id, d);
        }
        const dists = [...frontDist.values()].sort((a, b) => a - b);
        const median = dists[Math.floor(dists.length / 2)];
        for (const p of myPlanets) {
          if (usedSources.has(p.id) || p.absorbing) continue;
          if ((threats.get(p.id) ?? 0) > 0) continue;
          if ((frontDist.get(p.id) ?? 0) <= median) continue; // frontline holds
          if (p.garrison < p.maxUnitCapacity * LOGISTICS_SURPLUS_FRAC) continue;
          let front: { id: number; d: number } | null = null;
          for (const q of myPlanets) {
            if (q.id === p.id) continue;
            const d = frontDist.get(q.id) ?? Infinity;
            if (!front || d < front.d) front = { id: q.id, d };
          }
          if (front && front.d < (frontDist.get(p.id) ?? 0)) {
            const count = Math.floor(p.garrison * 0.4);
            if (count > 0) {
              this.world.openStream(me, p.id, front.id, count);
              usedSources.add(p.id);
            }
          }
        }
      }
    }
  }
}
