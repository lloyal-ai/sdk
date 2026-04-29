/**
 * Ink render entry — mounts the <App/> against an EventBus and a
 * command-dispatch callback.
 *
 *   main.ts: const instance = render(bus, (cmd) => commands.send(cmd));
 *
 * The bus MUST be a buffering EventBus (see `./event-bus.ts`) so events
 * sent between `render()` returning and React's useEffect firing aren't
 * lost. `bootstrap` is an optional list of events replayed through the
 * reducer BEFORE the first paint — use for state that must be correct
 * at first-render (e.g. config).
 */

import React from 'react';
import { render as inkRender, type Instance } from 'ink';
import type { WorkflowEvent } from './events';
import type { CommandDispatch } from './hooks/useCommand';
import type { EventBus } from './event-bus';
import { App } from './components/App';

export function render(
  bus: EventBus<WorkflowEvent>,
  dispatch: CommandDispatch,
  bootstrap: WorkflowEvent[] = [],
): Instance {
  return inkRender(React.createElement(App, { bus, dispatch, bootstrap }));
}
