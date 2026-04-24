/**
 * PlanReview — center dialog shown after the planner returns a research
 * plan and before research starts. Lets the user accept, edit (back to
 * composer with query pre-filled), cancel (back to composer, query
 * cleared), or change mode (re-runs planner).
 *
 * Clarify intent reuses this component but shows questions instead of a
 * task list — Enter returns to composer with a "clarify →" prefix.
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../state';
import { useCommand } from '../hooks/useCommand';

export interface PlanReviewProps {
  state: AppState;
}

export const PlanReview = memo(function PlanReview({ state }: PlanReviewProps): React.ReactElement | null {
  const dispatch = useCommand();
  const plan = state.plan;
  const [mode, setMode] = useState<'flat' | 'deep'>(state.mode ?? 'deep');

  // Keep local mode in sync when main re-plans (plan:start fires with the
  // new mode, reducer updates state.mode, this effect mirrors it locally
  // so the picker glyphs update on remount).
  useEffect(() => {
    if (state.mode && state.mode !== mode) setMode(state.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode]);

  useInput((input, key) => {
    if (!plan) return;
    if (key.return) {
      if (plan.intent === 'clarify') {
        // Route user back to composer to type clarification.
        dispatch({ type: 'edit_plan', query: state.query });
        return;
      }
      dispatch({ type: 'accept_plan' });
      return;
    }
    if (key.escape) {
      dispatch({ type: 'cancel_plan' });
      return;
    }
    if (input === 'e' || input === 'E') {
      dispatch({ type: 'edit_plan', query: state.query });
      return;
    }
    if (input === 't' || input === 'T') {
      const next = mode === 'deep' ? 'flat' : 'deep';
      setMode(next);
      dispatch({ type: 'change_mode', mode: next });
      return;
    }
    if (key.ctrl && input === 'c') {
      dispatch({ type: 'quit' });
    }
  });

  if (!plan) return null;

  if (plan.intent === 'clarify') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold>{state.query}</Text>
        </Box>
        <Text dimColor>A few questions to narrow this down.</Text>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginTop={1}
        >
          {plan.clarifyQuestions.map((q, i) => (
            <Text key={i}>
              <Text dimColor>({i + 1})</Text> {q}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>⏎ answer · Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (plan.intent === 'passthrough') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{state.query}</Text>
        <Text dimColor>Answering directly — no research needed.</Text>
      </Box>
    );
  }

  const shape = mode === 'flat'
    ? `${plan.tasks.length} parallel tasks`
    : `${plan.tasks.length} chained tasks`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold>{state.query}</Text>
      </Box>
      <Text dimColor>Here&apos;s my plan.</Text>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        marginTop={1}
      >
        <Box>
          <Text bold>Research</Text>
          <Text dimColor> · {shape}</Text>
        </Box>
        {plan.tasks.map((t, i) => (
          <Text key={i}>
            <Text dimColor>  ({i + 1})</Text> {t.description}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={mode === 'deep' ? 'cyan' : undefined} bold={mode === 'deep'}>
          {mode === 'deep' ? '◆' : '○'} Deep
        </Text>
        <Text>  </Text>
        <Text color={mode === 'flat' ? 'cyan' : undefined} bold={mode === 'flat'}>
          {mode === 'flat' ? '◆' : '○'} Fast
        </Text>
        <Text dimColor>     (T to toggle — re-plans)</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[E] Edit plan · [Esc] Cancel · </Text>
        <Text color="cyan" bold>[⏎] Start research</Text>
      </Box>
    </Box>
  );
});
