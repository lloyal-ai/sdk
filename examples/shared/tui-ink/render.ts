/**
 * Ink render entry — mounts the <App/> against an Effection events channel
 * and a commands Signal.
 *
 *   main.ts: const instance = render(events, (cmd) => commands.send(cmd));
 *
 * The caller owns the Signal; Ink just dispatches into the provided
 * callback via the CommandContext.
 */

import React from 'react';
import { render as inkRender, type Instance } from 'ink';
import type { Channel } from 'effection';
import type { WorkflowEvent } from './events';
import type { CommandDispatch } from './hooks/useCommand';
import { App } from './components/App';

/**
 * Mount the Ink app.
 *
 * `bootstrap` is a list of events the reducer replays synchronously
 * before the first render — use it to seed state (e.g. config) that
 * would otherwise race with React's commit-then-effect ordering and
 * be missed by the useEffect subscription to the channel.
 */
export function render(
  channel: Channel<WorkflowEvent, void>,
  dispatch: CommandDispatch,
  bootstrap: WorkflowEvent[] = [],
): Instance {
  return inkRender(React.createElement(App, { channel, dispatch, bootstrap }));
}
