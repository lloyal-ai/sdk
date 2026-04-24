import React from 'react';
import { Box } from 'ink';
import type { WorkflowEvent } from '../events';
import { useEventStream } from '../hooks/useEventStream';
import { CommandContext, type CommandDispatch } from '../hooks/useCommand';
import type { EventBus } from '../event-bus';
import { Header } from './Header';
import { Narrative } from './Narrative';
import { Synth } from './Synth';
import { Verify } from './Verify';
import { Eval } from './Eval';
import { Answer } from './Answer';
import { Footer } from './Footer';
import { Composer } from './Composer';
import { PlanReview } from './PlanReview';
import { PlanningSpinner } from './PlanningSpinner';
import { ClarifyPanel } from './ClarifyPanel';
import { BootStatus } from './BootStatus';

export interface AppProps {
  bus: EventBus<WorkflowEvent>;
  dispatch: CommandDispatch;
  /** Pre-render events — applied through the reducer before the first
   *  paint so the tree never renders with stale state. The bus buffers
   *  sends that happen before useEffect subscribes, so late events don't
   *  need bootstrapping. */
  bootstrap?: WorkflowEvent[];
}

export function App({ bus, dispatch, bootstrap }: AppProps): React.ReactElement {
  const state = useEventStream(bus, bootstrap);
  const showHeader =
    state.uiPhase !== 'composer' &&
    state.uiPhase !== 'boot' &&
    state.uiPhase !== 'downloading' &&
    state.uiPhase !== 'loading' &&
    state.uiPhase !== 'planning' &&
    state.uiPhase !== 'plan_review' &&
    state.uiPhase !== 'clarifying';  // components below render their own header

  const showResults = state.uiPhase === 'research' || state.uiPhase === 'done';
  const showComposer =
    state.uiPhase === 'composer' ||
    state.uiPhase === 'done' ||
    state.uiPhase === 'clarifying';

  return (
    <CommandContext.Provider value={dispatch}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {showHeader && <Header query={state.query} warm={state.warm} />}
        {(state.uiPhase === 'downloading' || state.uiPhase === 'loading') && (
          <BootStatus state={state} />
        )}
        {state.uiPhase === 'planning' && <PlanningSpinner state={state} />}
        {state.uiPhase === 'plan_review' && <PlanReview state={state} />}
        {state.uiPhase === 'clarifying' && <ClarifyPanel state={state} />}
        {showResults && <Narrative state={state} />}
        {showResults && <Synth state={state} />}
        {state.uiPhase === 'done' && <Verify state={state} />}
        {state.uiPhase === 'done' && <Eval state={state} />}
        {state.uiPhase === 'done' && <Answer state={state} />}
        {showComposer && <Composer state={state} />}
        <Footer state={state} />
      </Box>
    </CommandContext.Provider>
  );
}
