import type { ViewHandler } from './types';

export interface GaugeState {
  cellsUsed: number;
  nCtx: number;
}

export function createGaugeState(): GaugeState {
  return { cellsUsed: 0, nCtx: 0 };
}

export function gaugeHandler(state: GaugeState): ViewHandler {
  return (ev) => {
    if (ev.type === 'agent:tick') {
      state.cellsUsed = ev.cellsUsed;
      state.nCtx = ev.nCtx;
    }
  };
}
