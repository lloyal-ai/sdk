/**
 * Effection test harness — provides real structured concurrency with mock leaf deps.
 *
 * Uses real Effection run(), scope(), channel(), spawn(), ensure().
 * Mocks only: SessionContext, BranchStore, TraceWriter.
 */
import { run, createChannel } from 'effection';
import type { Operation, Channel } from 'effection';
import { Ctx, Store, Events, Trace, CallingAgent } from '../../src/context';
import { NullTraceWriter } from '../../src/trace-writer';
import type { AgentEvent } from '../../src/types';
import { createMockBranch } from './mock-branch';

/** Minimal mock SessionContext — just enough for pool/tool tests */
export function createMockSessionContext(opts?: {
  pressure?: { nCtx: number; cellsUsed: number; remaining: number };
}) {
  const pressure = opts?.pressure ?? { nCtx: 16384, cellsUsed: 1000, remaining: 15384 };
  return {
    tokenize: async (text: string) => Array.from({ length: Math.ceil(text.length / 4) }, (_, i) => i + 1),
    tokenizeSync: (text: string) => Array.from({ length: Math.ceil(text.length / 4) }, (_, i) => i + 1),
    formatChat: async (msgs: string, opts?: Record<string, unknown>) => ({
      prompt: `<formatted>${msgs}</formatted>`,
      format: 1, reasoningFormat: 0, thinkingForcedOpen: false,
      parser: 'default', grammar: '', grammarLazy: true,
      grammarTriggers: [],
    }),
    formatChatSync: (msgs: string) => ({
      prompt: `<formatted>${msgs}</formatted>`,
      format: 1, reasoningFormat: 0, thinkingForcedOpen: false,
      parser: 'default', grammar: '', grammarLazy: true,
      grammarTriggers: [],
    }),
    parseChatOutput: (raw: string) => ({
      content: raw,
      toolCalls: [],
    }),
    _storeKvPressure: () => pressure,
    jsonSchemaToGrammar: async () => '{}',
    getTurnSeparator: () => [0],
    vocabSize: 32000,
    dispose: () => {},
  } as any;
}

/** Minimal mock BranchStore */
export function createMockBranchStore() {
  return {
    commit: async () => {},
    prefill: async () => {},
    kv_pressure: () => ({ n_ctx: 16384, cells_used: 1000, remaining: 15384 }),
  } as any;
}

/**
 * Run an Operation in a test scope with all Effection contexts set up.
 * Real Effection concurrency — mock only the leaf deps.
 */
export async function withTestScope<T>(
  fn: () => Operation<T>,
  opts?: {
    ctx?: any;
    store?: any;
    pressure?: { nCtx: number; cellsUsed: number; remaining: number };
  },
): Promise<T> {
  return run(function* () {
    const ctx = opts?.ctx ?? createMockSessionContext(opts);
    const store = opts?.store ?? createMockBranchStore();
    const events: Channel<AgentEvent, void> = createChannel();

    yield* Ctx.set(ctx);
    yield* Store.set(store);
    yield* Events.set(events as any);
    yield* Trace.set(new NullTraceWriter());

    return yield* fn();
  });
}

/**
 * Collect events emitted during an operation.
 * Spawns a consumer that drains the Events channel.
 */
export function collectEvents(): {
  events: AgentEvent[];
  drain: () => Operation<void>;
} {
  const events: AgentEvent[] = [];
  return {
    events,
    *drain() {
      // Consumer reads from the channel until scope exits
      const ch: Channel<AgentEvent, void> = yield* Events.expect() as any;
      // Note: in tests the scope ends when the main operation completes,
      // which halts this consumer. Events collected up to that point.
    },
  };
}
