import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { AgentRuntime, TimelineItem } from '../state';
import { colorForLabel } from '../colors';

export interface ColumnProps {
  agent: AgentRuntime;
  /** Column header prefix, e.g. "Task 1" for chain or null for flat. */
  headerPrefix: string | null;
  /** Visible body height (rows). Older content scrolls off the top via
   *  Ink's overflow:hidden + justifyContent:flex-end on the body box. */
  bodyHeight: number;
  /** Explicit column width (chars) for flat mode; undefined = fill parent (chain). */
  width?: number;
}

const STATUS_ACTIVE: AgentRuntime['phase'][] = ['thinking', 'content', 'tool'];

function isActive(agent: AgentRuntime): boolean {
  return STATUS_ACTIVE.includes(agent.phase);
}

// ── Per-item renderers ─────────────────────────────────────────

const ThinkItem = memo(function ThinkItem({
  item,
  color,
}: {
  item: Extract<TimelineItem, { kind: 'think' }>;
  color: string;
}): React.ReactElement {
  const title = item.live
    ? item.body.includes('\n')
      ? titleFromBody(item.body)
      : 'Thinking…'
    : item.title;
  const body = item.live
    ? stripFirstLineIfTitle(item.body)
    : stripFirstLineIfTitle(item.body).trim();
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box>
        <Text color={color}>✦ </Text>
        <Text bold>{title}</Text>
      </Box>
      {body ? (
        <Box paddingLeft={2}>
          <Text>
            {body}
            {item.live ? '▎' : ''}
          </Text>
        </Box>
      ) : item.live ? (
        <Box paddingLeft={2}>
          <Text dimColor>▎</Text>
        </Box>
      ) : null}
    </Box>
  );
});

function titleFromBody(body: string): string {
  const nl = body.indexOf('\n');
  if (nl <= 0) return 'Thinking…';
  const first = body.slice(0, nl).trim();
  if (!first) return 'Thinking…';
  return first.length > 72 ? first.slice(0, 72).trimEnd() + '…' : first;
}

function stripFirstLineIfTitle(body: string): string {
  const nl = body.indexOf('\n');
  if (nl <= 0) return '';
  return body.slice(nl + 1).trimStart();
}

const ToolCallItem = memo(function ToolCallItem({
  item,
}: {
  item: Extract<TimelineItem, { kind: 'tool_call' }>;
}): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <Text dimColor>› </Text>
      <Text color="cyan">{item.tool}</Text>
      {item.argsSummary ? <Text dimColor>  {item.argsSummary}</Text> : null}
    </Box>
  );
});

const ToolResultItem = memo(function ToolResultItem({
  item,
}: {
  item: Extract<TimelineItem, { kind: 'tool_result' }>;
}): React.ReactElement {
  const hostChips = item.hosts.length > 0 ? item.hosts.join(' · ') : null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingLeft={2}>
        <Text color="green">✓ </Text>
        <Text>{item.resultCount ?? item.byteLength + 'b'}</Text>
        {typeof item.resultCount === 'number' ? <Text> results</Text> : null}
      </Box>
      {hostChips ? (
        <Box paddingLeft={4}>
          <Text dimColor>{hostChips}</Text>
        </Box>
      ) : item.preview ? (
        <Box paddingLeft={4}>
          <Text dimColor>{item.preview.length > 60 ? item.preview.slice(0, 60) + '…' : item.preview}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

const ReportItem = memo(function ReportItem({
  item,
  color,
}: {
  item: Extract<TimelineItem, { kind: 'report' }>;
  color: string;
}): React.ReactElement {
  const body = item.body.trim();
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box>
        <Text color={color}>✓ </Text>
        <Text bold>report</Text>
        <Text dimColor> · {item.tokenCount} tok</Text>
      </Box>
      {body ? (
        <Box paddingLeft={2}>
          <Text>{body}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

/** Live post-</think> tokens — the model is writing tool-call JSON, which
 *  for the terminal `report` tool contains the report body. Shown raw so
 *  the user sees the text streaming rather than waiting for the final
 *  parsed blob. Cleared by the reducer on tool_call / report. */
const ContentStream = memo(function ContentStream({
  buffer,
  color,
}: {
  buffer: string;
  color: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box>
        <Text color={color}>▸ </Text>
        <Text dimColor bold>streaming</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>{buffer}▎</Text>
      </Box>
    </Box>
  );
});

// ── Column ─────────────────────────────────────────────────────

/** Rows of chrome inside the column box: header row(s) + optional
 *  description + optional dependency hint. Reserved so the body area
 *  gets the rest of the column's budget. */
const HEADER_ROWS = 3;

export const Column = memo(function Column({
  agent,
  headerPrefix,
  bodyHeight,
  width,
}: ColumnProps): React.ReactElement {
  const color = colorForLabel(agent.label);
  const active = isActive(agent);

  const descText = agent.taskDescription
    ? (agent.taskDescription.length > 80
        ? agent.taskDescription.slice(0, 80) + '…'
        : agent.taskDescription)
    : null;

  // Outer column: fixed total height so the narrative row doesn't jitter
  // as content streams. overflow="hidden" honors the measured height via
  // Yoga + Ink's renderer.
  const totalHeight = bodyHeight + HEADER_ROWS + 2; // +2 for borders

  return (
    <Box
      flexDirection="column"
      width={width}
      height={totalHeight}
      borderStyle="round"
      borderColor={active ? color : 'gray'}
      paddingX={1}
      marginRight={1}
      flexShrink={0}
      overflow="hidden"
    >
      {/* Header */}
      <Box flexShrink={0}>
        {headerPrefix ? <Text dimColor>{headerPrefix} · </Text> : null}
        <Text color={color} bold>{agent.label}</Text>
        <Box flexGrow={1} />
        <Text color={active ? color : 'green'}>{active ? '●' : '✓'}</Text>
      </Box>
      {descText ? (
        <Text dimColor>{descText}</Text>
      ) : null}
      {agent.dependencyHint ? (
        <Text dimColor>↑ {agent.dependencyHint}</Text>
      ) : null}

      {/* Body — grows to fill remaining column height; newest content pinned
        to the bottom via justifyContent="flex-end"; older content overflows
        at the top and is clipped by the outer overflow="hidden". */}
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        overflow="hidden"
      >
        {agent.timeline.map((item) => {
          if (item.kind === 'think') {
            return <ThinkItem key={item.id} item={item} color={color} />;
          }
          if (item.kind === 'tool_call') {
            return <ToolCallItem key={item.id} item={item} />;
          }
          if (item.kind === 'tool_result') {
            return <ToolResultItem key={item.id} item={item} />;
          }
          if (item.kind === 'report') {
            return <ReportItem key={item.id} item={item} color={color} />;
          }
          return null;
        })}
        {agent.contentBuffer ? (
          <ContentStream buffer={agent.contentBuffer} color={color} />
        ) : null}
      </Box>
    </Box>
  );
});
