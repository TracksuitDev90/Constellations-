/**
 * Green hostile entities spawned by the per-match `neutralSwarm` hazard. They
 * patrol around an anchor point as a loose wing, chase intruders with lead
 * pursuit (1:1 mutual kill on contact), leash back to their territory, and
 * never capture planets — pure attrition pressure on whoever happens to be
 * flying through.
 *
 * Pooled like ShipPool so that periodic respawn doesn't churn the GC.
 */
export type NeutralState = 'patrol' | 'pursue' | 'return' | 'doomed';

export interface NeutralEnemy {
  active: boolean;
  x: number;
  y: number;
  /** Heading in radians — steering target and renderer rotation. */
  heading: number;
  /** Current velocity — smoothed toward the state's desired direction. */
  vx: number;
  vy: number;
  /** Personal phase offset for the wander oscillator. */
  phase: number;
  /** Index into World.neutralAnchors so the patrol pull picks the right zone. */
  anchorIdx: number;
  /** Behavior state — drives speed, steering, and engine-flare brightness. */
  state: NeutralState;
  /** Ship index being pursued while state === 'pursue'; -1 otherwise. */
  targetIdx: number;
  /** Black hole spiral bookkeeping — only meaningful while state === 'doomed'. */
  doomHoleIdx: number;
  doomAngle: number;
  doomRadius: number;
  doomDir: number;
}

export class NeutralPool {
  private list: NeutralEnemy[] = [];
  private freeList: number[] = [];

  spawn(x: number, y: number, heading: number, anchorIdx: number): number {
    const idx = this.freeList.pop();
    if (idx !== undefined) {
      const n = this.list[idx];
      n.active = true;
      n.x = x;
      n.y = y;
      n.heading = heading;
      n.vx = Math.cos(heading);
      n.vy = Math.sin(heading);
      n.phase = Math.random() * Math.PI * 2;
      n.anchorIdx = anchorIdx;
      n.state = 'patrol';
      n.targetIdx = -1;
      n.doomHoleIdx = -1;
      n.doomAngle = 0;
      n.doomRadius = 0;
      n.doomDir = 1;
      return idx;
    }
    const n: NeutralEnemy = {
      active: true,
      x,
      y,
      heading,
      vx: Math.cos(heading),
      vy: Math.sin(heading),
      phase: Math.random() * Math.PI * 2,
      anchorIdx,
      state: 'patrol',
      targetIdx: -1,
      doomHoleIdx: -1,
      doomAngle: 0,
      doomRadius: 0,
      doomDir: 1,
    };
    this.list.push(n);
    return this.list.length - 1;
  }

  kill(idx: number): void {
    const n = this.list[idx];
    if (!n || !n.active) return;
    n.active = false;
    n.state = 'patrol';
    n.targetIdx = -1;
    n.doomHoleIdx = -1;
    this.freeList.push(idx);
  }

  get all(): readonly NeutralEnemy[] {
    return this.list;
  }

  activeCount(): number {
    let n = 0;
    for (const x of this.list) if (x.active) n++;
    return n;
  }

  countAtAnchor(anchorIdx: number): number {
    let n = 0;
    for (const x of this.list) if (x.active && x.anchorIdx === anchorIdx) n++;
    return n;
  }
}
