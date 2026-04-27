/**
 * Ink mount entry for the compare TUI.
 *
 *   const instance = render(bus, { x, y, sourceLabels });
 *
 * The bus MUST be a buffering EventBus (./event-bus.ts) so events sent
 * between `render()` returning and React's useEffect firing aren't lost.
 * `bootstrap` is an optional list of events replayed through the reducer
 * BEFORE the first paint.
 */

import React from 'react';
import { render as inkRender, type Instance } from 'ink';
import { App, type AppProps } from './App';
import type { EventBus } from './event-bus';
import type { WorkflowEvent } from './events';

export interface RenderOpts {
  x: string;
  y: string;
  sourceLabels?: Record<string, string>;
  bootstrap?: WorkflowEvent[];
}

export function render(
  bus: EventBus<WorkflowEvent>,
  opts: RenderOpts,
): Instance {
  const props: AppProps = {
    bus,
    bootstrap: opts.bootstrap,
    x: opts.x,
    y: opts.y,
    sourceLabels: opts.sourceLabels,
  };
  return inkRender(React.createElement(App, props));
}
