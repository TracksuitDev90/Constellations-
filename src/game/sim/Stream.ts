export interface ShipStream {
  id: number;
  owner: number;
  source: number;
  target: number;
  emitInterval: number;
  emitAcc: number;
  /** Remaining ships this stream will emit. Stream is removed when this hits 0. */
  remaining: number;
  /**
   * Tags emitted ships so they auto-absorb into the destination planet instead
   * of joining orbit. Used when the player reinforces a friendly ringed world.
   */
  absorbOnArrive: boolean;
}

let nextStreamId = 1;
export const createStream = (
  owner: number,
  source: number,
  target: number,
  emitInterval: number,
  remaining: number,
  absorbOnArrive = false,
): ShipStream => ({
  id: nextStreamId++,
  owner,
  source,
  target,
  emitInterval,
  emitAcc: 0,
  remaining,
  absorbOnArrive,
});
