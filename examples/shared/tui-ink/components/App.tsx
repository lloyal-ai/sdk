import React from 'react';
import { Box } from 'ink';
import type { Channel } from 'effection';
import type { WorkflowEvent } from '../events';
import { useEventStream } from '../hooks/useEventStream';
import { CommandContext, type CommandDispatch } from '../hooks/useCommand';
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

export interface AppProps {
  channel: Channel<WorkflowEvent, void>;
  dispatch: CommandDispatch;
  /** Pre-render events — applied through the reducer before the first paint
   *  so the tree never renders with a stale initial state (e.g. uiPhase=boot
   *  despite a config already being loaded). The Effection channel is
   *  attached in useEffect AFTER the first commit; events sent before that
   *  would otherwise be dropped. */
  bootstrap?: WorkflowEvent[];
}

export function App({ channel, dispatch, bootstrap }: AppProps): React.ReactElement {
  const state = useEventStream(channel, bootstrap);
  const showHeader =
    state.uiPhase !== 'composer' &&
    state.uiPhase !== 'boot' &&
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
