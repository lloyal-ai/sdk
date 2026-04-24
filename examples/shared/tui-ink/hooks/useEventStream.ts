/**
 * Bridge an EventBus to a React-rendered AppState.
 *
 * `bootstrap` seeds initial state synchronously before the first render.
 * The EventBus handles the between-render-and-useEffect gap via buffering —
 * any `send()` that happens before our useEffect subscribes is replayed
 * to us on subscription. No timing hacks, no `sleep`.
 */

import { useEffect, useReducer } from 'react';
import type { WorkflowEvent } from '../events';
import { initialState, type AppState } from '../state';
import { reduce } from '../reducer';
import type { EventBus } from '../event-bus';

export function useEventStream(
  bus: EventBus<WorkflowEvent>,
  bootstrap: WorkflowEvent[] = [],
): AppState {
  const [state, dispatch] = useReducer(reduce, bootstrap, (events) =>
    events.reduce(reduce, initialState),
  );

  useEffect(() => {
    return bus.subscribe(dispatch);
  }, [bus]);

  return state;
}
