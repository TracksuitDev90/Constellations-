export interface ShipStream {
  id: number;
  owner: number;
  source: number;
  target: number;
  emitInterval: number;
  emitAcc: number;
}

let nextStreamId = 1;
export const createStream = (
  owner: number,
  source: number,
  target: number,
  emitInterval: number,
): ShipStream => ({
  id: nextStreamId++,
  owner,
  source,
  target,
  emitInterval,
  emitAcc: 0,
});
