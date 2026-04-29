import React, { memo } from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  query: string;
  warm: boolean;
}

export const Header = memo(function Header({ query, warm }: HeaderProps): React.ReactElement | null {
  if (!query) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{query}</Text>
      {warm ? <Text dimColor>follow-up · warm session</Text> : null}
    </Box>
  );
});
