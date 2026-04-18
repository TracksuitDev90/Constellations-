export interface ShipStream {
  id: number;
  owner: number;
  source: number;
  target: number;
  emitInterval: number;
  emitAcc: number;
  /** Remaining ships this stream will emit. Stream is removed when this hits 0. */
  remaining: number;
}

let nextStreamId = 1;
export const createStream = (
  owner: number,
  source: number,
  target: number,
  emitInterval: number,
  remaining: number,
): ShipStream => ({
  id: nextStreamId++,
  owner,
  source,
  target,
  emitInterval,
  emitAcc: 0,
  remaining,
});
