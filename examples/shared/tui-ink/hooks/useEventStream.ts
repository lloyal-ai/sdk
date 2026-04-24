/**
 * Bridge Effection Channel → React state via a pure reducer.
 *
 * On mount, spawns an Effection task that iterates each incoming event
 * and dispatches into the reducer. Unmount tears the task down via the
 * cleanup returned from the effect.
 */

import { useEffect, useReducer } from 'react';
import { each, run, type Channel } from 'effection';
import type { WorkflowEvent } from '../events';
import { initialState, type AppState } from '../state';
import { reduce } from '../reducer';

/**
 * Bridge an Effection Channel to a React-rendered AppState.
 *
 * `bootstrap` lets callers SEED the initial state before any events flow.
 * Effection channels don't buffer — events sent before the useEffect below
 * attaches a subscriber are lost. For config loaded at boot, we'd otherwise
 * race with React's commit-then-effect ordering and the reducer would
 * never see `config:loaded`. Seeding through useReducer's lazy init avoids
 * the race entirely.
 */
export function useEventStream(
  channel: Channel<WorkflowEvent, void>,
  bootstrap: WorkflowEvent[] = [],
): AppState {
  const [state, dispatch] = useReducer(reduce, bootstrap, (events) =>
    events.reduce(reduce, initialState),
  );

  useEffect(() => {
    const task = run(function* () {
      for (const ev of yield* each(channel)) {
        dispatch(ev);
        yield* each.next();
      }
    });
    return () => { task.halt(); };
  }, [channel]);

  return state;
}
