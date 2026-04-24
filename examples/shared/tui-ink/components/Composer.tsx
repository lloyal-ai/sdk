/**
 * Composer — Gemini-style bottom-docked query input + mode toggle +
 * source chips. Also hosts inline editors for Tavily key and corpus path
 * that replace the main query input when active.
 *
 * Keybindings when the query input is focused:
 *   Enter   → dispatch submit_query (blocked if no source configured)
 *   Tab     → toggle reasoning mode (deep ↔ flat)
 *   W       → open Tavily key editor (blocked if TAVILY_API_KEY env set)
 *   C       → open corpus path editor
 *   Ctrl-C  → dispatch quit
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppState } from '../state';
import { useCommand } from '../hooks/useCommand';
import { TextInput } from './TextInput';

type Field = 'query' | 'menu' | 'tavily' | 'corpus';

export interface ComposerProps {
  state: AppState;
}

export const Composer = memo(function Composer({ state }: ComposerProps): React.ReactElement {
  const dispatch = useCommand();
  const defaultMode = state.config?.defaults.reasoningMode ?? 'deep';
  const [mode, setMode] = useState<'flat' | 'deep'>(defaultMode);
  const [field, setField] = useState<Field>('query');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');

  // Apply a prefill from "edit plan" when the composer regains focus.
  useEffect(() => {
    if (state.composerPrefill && state.composerPrefill !== query) {
      setQuery(state.composerPrefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.composerPrefill]);

  // Keep mode in sync if config default changes externally.
  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);

  const tavilyOrigin = state.configOrigin?.tavilyKey ?? 'unset';
  const corpusOrigin = state.configOrigin?.corpusPath ?? 'unset';
  const hasTavily = tavilyOrigin !== 'unset';
  const hasCorpus = corpusOrigin !== 'unset';
  const hasSource = hasTavily || hasCorpus;
  const envLocked = tavilyOrigin === 'env';

  // Vim-style modal input. Query field = "insert" mode: all letters type
  // freely. Press Esc to enter "menu" mode where W/C/T act as chip hotkeys;
  // Esc or any unrecognized key drops back to the query with no character
  // consumed. Tab toggles mode in both modes (non-printable, safe).
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
        return;
      }
      if (key.tab) {
        setMode((m) => (m === 'deep' ? 'flat' : 'deep'));
        return;
      }
      if (key.escape) {
        if (clarifying) {
          // Bail out of clarifying mode — back to normal composer.
          dispatch({ type: 'cancel_plan' });
          setQuery('');
          return;
        }
        setField('menu');
        return;
      }
    },
    { isActive: field === 'query' },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'quit' });
        return;
      }
      if (key.escape) {
        setField('query');
        return;
      }
      if (key.tab || input === 'T' || input === 't') {
        const next = mode === 'deep' ? 'flat' : 'deep';
        setMode(next);
        return;
      }
      if (input === 'W' || input === 'w') {
        if (envLocked) {
          // No editor, no-op. Stay in menu so hint explains why.
          return;
        }
        setField('tavily');
        setDraft(state.config?.sources.tavilyKey ?? '');
        return;
      }
      if (input === 'C' || input === 'c') {
        setField('corpus');
        setDraft(state.config?.sources.corpusPath ?? '');
        return;
      }
      // Any other key: drop back to query, swallowing the key (intentional —
      // users pressed Esc to enter menu, so unrelated keys shouldn't leak
      // into the query text).
      setField('query');
    },
    { isActive: field === 'menu' },
  );

  const clarifying = state.clarifyContext !== null;

  const submitQuery = (q: string): void => {
    if (!q.trim()) return;
    if (clarifying) {
      // Don't gate clarify answers on hasSource — the user is narrowing an
      // already-submitted query; sources were validated at submit time.
      dispatch({ type: 'submit_clarification', answer: q.trim() });
      setQuery('');
      return;
    }
    if (!hasSource) return;
    dispatch({ type: 'submit_query', query: q.trim(), mode });
    setQuery('');
  };

  const commitTavily = (): void => {
    if (draft.trim()) {
      dispatch({ type: 'set_tavily_key', key: draft.trim() });
    }
    setField('query');
    setDraft('');
  };

  const commitCorpus = (): void => {
    if (draft.trim()) {
      dispatch({ type: 'set_corpus_path', path: draft.trim() });
    }
    setField('query');
    setDraft('');
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {/* Main row: query input, menu mode, or inline editor */}
      {field === 'query' || field === 'menu' ? (
        <Box>
          <Text dimColor={field === 'menu'}>› </Text>
          <TextInput
            value={query}
            onChange={setQuery}
            onSubmit={submitQuery}
            focused={field === 'query'}
            placeholder={
              clarifying
                ? 'Answer the questions above, or Esc to cancel…'
                : hasSource
                  ? 'Ask a research question…'
                  : 'Press Esc for menu, then W or C to add a source'
            }
          />
        </Box>
      ) : field === 'tavily' ? (
        <Box>
          <Text color="yellow">Tavily key › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitTavily}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            mask
            placeholder="tvly-..."
          />
        </Box>
      ) : (
        <Box>
          <Text color="yellow">Corpus path › </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitCorpus}
            onCancel={() => { setField('query'); setDraft(''); }}
            focused
            placeholder="/path/to/docs"
          />
        </Box>
      )}

      {/* Chips row */}
      <Box marginTop={0}>
        <ModeChip mode={mode} />
        <Text>  </Text>
        <SourceChip
          label="Tavily"
          hotkey="W"
          origin={tavilyOrigin}
          value={hasTavily ? 'set' : null}
          disabled={envLocked}
        />
        <Text>  </Text>
        <SourceChip
          label="Corpus"
          hotkey="C"
          origin={corpusOrigin}
          value={state.config?.sources.corpusPath ?? null}
        />
        <Box flexGrow={1} />
        <HintRow
          field={field}
          hasSource={hasSource}
          envLocked={envLocked && field === 'query'}
          queryEmpty={query.length === 0}
        />
      </Box>

      {/* Toast (transient) */}
      {state.toast ? (
        <Box marginTop={0}>
          <Text
            color={
              state.toast.tone === 'error'
                ? 'red'
                : state.toast.tone === 'warn'
                  ? 'yellow'
                  : 'green'
            }
          >
            {state.toast.message}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

const ModeChip = memo(function ModeChip({ mode }: { mode: 'flat' | 'deep' }): React.ReactElement {
  return (
    <Text>
      <Text color={mode === 'deep' ? 'cyan' : undefined} bold={mode === 'deep'}>
        {mode === 'deep' ? '◆' : '○'} Deep
      </Text>
      <Text dimColor>  </Text>
      <Text color={mode === 'flat' ? 'cyan' : undefined} bold={mode === 'flat'}>
        {mode === 'flat' ? '◆' : '○'} Fast
      </Text>
    </Text>
  );
});

const SourceChip = memo(function SourceChip({
  label,
  hotkey,
  origin,
  value,
  disabled = false,
}: {
  label: string;
  hotkey: string;
  origin: string;
  value: string | null;
  disabled?: boolean;
}): React.ReactElement {
  const configured = origin !== 'unset';
  const color = configured ? 'green' : 'gray';
  const tag =
    origin === 'env' ? ' (env)'
      : origin === 'cli' ? ' (cli)'
      : '';
  const suffix =
    !configured ? '—'
      : label === 'Corpus' && value
        ? truncHome(value)
        : '✓';
  return (
    <Text>
      <Text dimColor={disabled}>
        [<Text color="yellow" dimColor={disabled}>{hotkey}</Text>]{' '}
      </Text>
      <Text color={color} dimColor={disabled}>
        {label} {suffix}
      </Text>
      <Text dimColor>{tag}</Text>
    </Text>
  );
});

function truncHome(p: string): string {
  const home = process.env.HOME;
  const short = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  return short.length > 24 ? '…' + short.slice(-22) : short;
}

const HintRow = memo(function HintRow({
  field,
  hasSource,
  envLocked,
}: {
  field: Field;
  hasSource: boolean;
  envLocked: boolean;
  /** unused now that hotkeys live in menu mode; kept for future reuse. */
  queryEmpty: boolean;
}): React.ReactElement {
  if (field === 'tavily' || field === 'corpus') {
    return <Text dimColor>⏎ save · Esc cancel</Text>;
  }
  if (field === 'menu') {
    if (envLocked) {
      return (
        <Text color="cyan">
          MENU · [C] corpus · [T] toggle mode · TAVILY env active · [Esc] back
        </Text>
      );
    }
    return (
      <Text color="cyan">
        MENU · [W] tavily · [C] corpus · [T] toggle mode · [Esc] back
      </Text>
    );
  }
  if (!hasSource) {
    return <Text color="yellow">⚠ Add a source · [Esc] for menu</Text>;
  }
  return <Text dimColor>Tab mode · Esc menu · ⏎ submit</Text>;
});
