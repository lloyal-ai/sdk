import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface PlanProps {
  plan: AppState['plan'];
  mode: AppState['mode'];
}

export const Plan = memo(function Plan({ plan, mode }: PlanProps): React.ReactElement | null {
  if (!plan) return null;

  if (plan.intent === 'clarify') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">Clarify</Text>
        {plan.clarifyQuestions.map((q, i) => (
          <Text key={i}>  {i + 1}. {q}</Text>
        ))}
      </Box>
    );
  }

  if (plan.intent === 'passthrough') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>Direct answer from session context</Text>
      </Box>
    );
  }

  // intent === 'research'
  const shape = mode === 'flat' ? `${plan.tasks.length} parallel tasks` : `${plan.tasks.length} chained tasks`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold>Plan <Text dimColor>· {shape}</Text></Text>
      {plan.tasks.map((t, i) => (
        <Text key={i}>
          <Text dimColor>  ({i + 1})</Text> {t.description}
        </Text>
      ))}
    </Box>
  );
});
