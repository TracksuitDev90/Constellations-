/**
 * Green hostile entities spawned by the per-match `neutralSwarm` hazard. They
 * patrol around an anchor point, attack the nearest in-range ship of any
 * owner (1:1 mutual kill), and never capture planets — pure attrition pressure
 * on whoever happens to be flying through their territory.
 *
 * Pooled like ShipPool so that periodic respawn doesn't churn the GC.
 */
export interface NeutralEnemy {
  active: boolean;
  x: number;
  y: number;
  /** Heading in radians — used for the gentle wander steering each tick. */
  heading: number;
  /** Personal phase offset for the wander oscillator. */
  phase: number;
  /** Index into World.neutralAnchors so the patrol pull picks the right zone. */
  anchorIdx: number;
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
      n.phase = Math.random() * Math.PI * 2;
      n.anchorIdx = anchorIdx;
      return idx;
    }
    const n: NeutralEnemy = {
      active: true,
      x,
      y,
      heading,
      phase: Math.random() * Math.PI * 2,
      anchorIdx,
    };
    this.list.push(n);
    return this.list.length - 1;
  }

  kill(idx: number): void {
    const n = this.list[idx];
    if (!n || !n.active) return;
    n.active = false;
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
