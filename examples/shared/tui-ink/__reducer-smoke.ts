/**
 * Reducer smoke test — drives a synthetic event stream through reduce()
 * and asserts the per-agent timeline shape. Not part of the runtime path.
 *
 *   npx tsx examples/shared/tui-ink/__reducer-smoke.ts
 */

import assert from 'node:assert';
import { reduce } from './reducer';
import { initialState } from './state';
import type { WorkflowEvent } from './events';

function drive(events: WorkflowEvent[]) {
  return events.reduce(reduce, initialState);
}

function check(label: string, fn: () => void) {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

check('query → phase=plan', () => {
  const s = drive([{ type: 'query', query: 'hi', warm: false }]);
  assert.equal(s.phase, 'plan');
  assert.equal(s.query, 'hi');
});

check('plan with research intent → phase stays plan', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 't1' }, { description: 't2' }] as never,
      clarifyQuestions: [],
      tokenCount: 42,
      timeMs: 1200,
    },
  ]);
  assert.equal(s.phase, 'plan');
  assert.equal(s.plan?.tasks.length, 2);
});

check('chain agent:spawn opens a timeline with a live think block', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'first task' }, { description: 'second task' }] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'research:start', agentCount: 2, mode: 'deep' },
    { type: 'spine:task', taskIndex: 0, taskCount: 2, description: 'first task' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.taskIndex, 0);
  assert.equal(a.taskDescription, 'first task');
  assert.equal(a.timeline.length, 1);
  assert.equal(a.timeline[0].kind, 'think');
  assert.equal((a.timeline[0] as { live: boolean }).live, true);
  assert.equal(a.currentThinkId, a.timeline[0].id);
  assert.deepEqual(s.researchAgentIds, [1]);
});

check('flat spawn order assigns taskIndex by spawn count', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [
        { description: 'A' },
        { description: 'B' },
        { description: 'C' },
      ] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'research:start', agentCount: 3, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:spawn', agentId: 3, parentAgentId: 0 } as WorkflowEvent,
  ]);
  assert.deepEqual(s.researchAgentIds, [1, 2, 3]);
  assert.deepEqual([
    s.agents.get(1)?.taskIndex,
    s.agents.get(2)?.taskIndex,
    s.agents.get(3)?.taskIndex,
  ], [0, 1, 2]);
  assert.deepEqual([
    s.agents.get(1)?.taskDescription,
    s.agents.get(2)?.taskDescription,
    s.agents.get(3)?.taskDescription,
  ], ['A', 'B', 'C']);
});

check('produce accumulates into the live think item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'Hello ', tokenCount: 1 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'world', tokenCount: 2 } as WorkflowEvent,
  ]);
  const think = s.agents.get(1)!.timeline[0] as { body: string; live: boolean };
  assert.equal(think.body, 'Hello world');
  assert.equal(think.live, true);
});

check('</think> closes the think and transitions agent to content', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'Think header\nmore body', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '</think>\n\nprose', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const think = a.timeline[0] as { body: string; live: boolean; title: string };
  assert.equal(think.live, false);
  assert.equal(think.body, 'Think header\nmore body');
  assert.equal(think.title, 'Think header');
  assert.equal(a.phase, 'content');
  assert.equal(a.currentThinkId, null);
});

check('tool_call appends a tool_call item and force-closes live think', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'partial', tokenCount: 3 } as WorkflowEvent,
    {
      type: 'agent:tool_call',
      agentId: 1,
      tool: 'web_search',
      args: '{"query":"voice latency"}',
    } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.timeline.length, 2);
  assert.equal(a.timeline[0].kind, 'think');
  assert.equal((a.timeline[0] as { live: boolean }).live, false);
  assert.equal(a.timeline[1].kind, 'tool_call');
  assert.equal((a.timeline[1] as { tool: string }).tool, 'web_search');
  assert.equal((a.timeline[1] as { argsSummary: string }).argsSummary, '"voice latency"');
  assert.equal(a.phase, 'tool');
  assert.equal(a.pendingToolCallId, a.timeline[1].id);
});

check('tool_result pairs with last tool_call and increments sourceCount', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{}' } as WorkflowEvent,
    {
      type: 'agent:tool_result',
      agentId: 1,
      tool: 'web_search',
      result: JSON.stringify([
        { url: 'https://livekit.io/voice', title: 'Voice agent' },
        { url: 'https://telnyx.com/ai', title: 'Telnyx AI' },
        { url: 'https://livekit.io/voice-2', title: 'Voice 2' },
      ]),
    } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const tr = a.timeline[a.timeline.length - 1] as {
    kind: string;
    hosts: string[];
    resultCount: number;
    callId: number;
  };
  assert.equal(tr.kind, 'tool_result');
  assert.deepEqual(tr.hosts.sort(), ['livekit.io', 'telnyx.com']);
  assert.equal(tr.resultCount, 3);
  assert.equal(tr.callId, a.timeline[1].id);
  assert.equal(s.sourceCount, 2);
  assert.equal(a.phase, 'idle');
});

check('re-enter thinking after tool_result opens a new think item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'first</think>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{}' } as WorkflowEvent,
    { type: 'agent:tool_result', agentId: 1, tool: 'web_search', result: '[]' } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'second', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const thinks = a.timeline.filter((it) => it.kind === 'think');
  assert.equal(thinks.length, 2);
  assert.equal((thinks[0] as { live: boolean }).live, false);
  assert.equal((thinks[0] as { body: string }).body, 'first');
  assert.equal((thinks[1] as { live: boolean }).live, true);
  assert.equal((thinks[1] as { body: string }).body, 'second');
});

check('report item pushed at agent:report', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'done thinking</think>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:report', agentId: 1, result: 'Final findings paragraph.' } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  const last = a.timeline[a.timeline.length - 1];
  assert.equal(last.kind, 'report');
  assert.equal((last as { body: string }).body, 'Final findings paragraph.');
  assert.equal(a.phase, 'done');
});

check('synth spawn/produce routes into synth.buffer, not an agent timeline', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'research:done', totalTokens: 100, totalToolCalls: 3, timeMs: 2000 },
    { type: 'synthesize:start' },
    { type: 'agent:spawn', agentId: 7, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 7, text: 'The answer is ', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 7, text: 'X.', tokenCount: 5 } as WorkflowEvent,
  ]);
  assert.equal(s.synth.buffer, 'The answer is X.');
  assert.equal(s.agents.get(7)?.timeline.length, 0);
  assert.deepEqual(s.researchAgentIds, []);
});

check('chain dependencyHint set for taskIndex > 0', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'first' }, { description: 'second' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 2, mode: 'deep' },
    { type: 'spine:task', taskIndex: 0, taskCount: 2, description: 'first' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'spine:task', taskIndex: 1, taskCount: 2, description: 'second' },
    { type: 'agent:spawn', agentId: 2, parentAgentId: 0 } as WorkflowEvent,
  ]);
  assert.equal(s.agents.get(1)?.dependencyHint, null);
  assert.equal(s.agents.get(2)?.dependencyHint, 'builds on Task 1');
});

check('post-</think> tokens stream into contentBuffer, cleared by tool_call', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'thinking</think>\n\n<tool_call>', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'web_search({"query":"x"})', tokenCount: 4 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  assert.equal(a.phase, 'content');
  assert.equal(a.contentBuffer.startsWith('\n\n<tool_call>'), true);
  assert.match(a.contentBuffer, /web_search/);

  const s2 = reduce(s, {
    type: 'agent:tool_call',
    agentId: 1,
    tool: 'web_search',
    args: '{"query":"x"}',
  } as WorkflowEvent);
  assert.equal(s2.agents.get(1)?.contentBuffer, '');
  assert.equal(s2.agents.get(1)?.phase, 'tool');
});

check('report path: content streams, then report event clears buffer + pushes structured item', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'decided to report</think>\n\n', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: '<tool_call>\n{"name":"report","arguments":{"result":"The final ', tokenCount: 4 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'answer is X."}}\n</tool_call>', tokenCount: 5 } as WorkflowEvent,
  ]);
  const mid = s.agents.get(1)!;
  assert.ok(mid.contentBuffer.length > 10, 'buffer accumulated');
  assert.match(mid.contentBuffer, /The final/);

  const s2 = reduce(s, {
    type: 'agent:report',
    agentId: 1,
    result: 'The final answer is X.',
  } as WorkflowEvent);
  const a = s2.agents.get(1)!;
  assert.equal(a.contentBuffer, '');
  assert.equal(a.phase, 'done');
  const last = a.timeline[a.timeline.length - 1];
  assert.equal(last.kind, 'report');
  assert.equal((last as { body: string }).body, 'The final answer is X.');
});

check('agent:done sets phase=idle (not done) so recovery produces stream', () => {
  const s = drive([
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 1,
      timeMs: 1,
    },
    { type: 'research:start', agentCount: 1, mode: 'flat' },
    { type: 'agent:spawn', agentId: 1, parentAgentId: 0 } as WorkflowEvent,
    { type: 'agent:produce', agentId: 1, text: 'unfinished thought', tokenCount: 3 } as WorkflowEvent,
    { type: 'agent:done', agentId: 1 } as WorkflowEvent,
    // Recovery streams tokens
    { type: 'agent:produce', agentId: 1, text: 'recovery output', tokenCount: 5 } as WorkflowEvent,
  ]);
  const a = s.agents.get(1)!;
  // The ORIGINAL think closed on agent:done; recovery opened a NEW think.
  const thinks = a.timeline.filter((it) => it.kind === 'think');
  assert.equal(thinks.length, 2);
  assert.equal((thinks[0] as { live: boolean; body: string }).live, false);
  assert.equal((thinks[0] as { body: string }).body, 'unfinished thought');
  assert.equal((thinks[1] as { live: boolean; body: string }).live, true);
  assert.equal((thinks[1] as { body: string }).body, 'recovery output');
  assert.equal(a.phase, 'thinking');
});

check('config:loaded on boot → uiPhase=composer, config set', () => {
  const s = drive([
    {
      type: 'config:loaded',
      config: {
        version: 1,
        sources: { tavilyKey: 'tvly-x' },
        defaults: { reasoningMode: 'deep', verifyCount: 3, maxTurns: 10 },
        model: {},
      },
      origin: {
        tavilyKey: 'file',
        corpusPath: 'unset',
        reasoningMode: 'file',
        modelPath: 'default',
        reranker: 'default',
      },
      path: '/tmp/harness.json',
    } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'composer');
  assert.equal(s.config?.sources.tavilyKey, 'tvly-x');
  assert.equal(s.configOrigin?.tavilyKey, 'file');
});

check('plan:start → uiPhase=planning', () => {
  const s = drive([
    { type: 'plan:start', query: 'hi', mode: 'deep' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'planning');
  assert.equal(s.query, 'hi');
});

check('ui:plan_review → uiPhase=plan_review', () => {
  const s = drive([
    { type: 'plan:start', query: 'hi', mode: 'deep' } as WorkflowEvent,
    { type: 'ui:plan_review' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'plan_review');
});

check('research:start → uiPhase=research; complete → uiPhase=done', () => {
  const s = drive([
    { type: 'research:start', agentCount: 1, mode: 'deep' },
    { type: 'complete', data: {} },
  ]);
  assert.equal(s.uiPhase, 'done');
});

check('ui:composer with prefill sets composerPrefill', () => {
  const s = drive([
    { type: 'ui:composer', prefill: 'last query' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'composer');
  assert.equal(s.composerPrefill, 'last query');
});

check('config:updated produces a toast; skipped fields flagged', () => {
  const cfg = {
    version: 1 as const,
    sources: { corpusPath: '/tmp/c' },
    defaults: { reasoningMode: 'deep' as const, verifyCount: 3, maxTurns: 10 },
    model: {},
  };
  const origin = {
    tavilyKey: 'env' as const,
    corpusPath: 'file' as const,
    reasoningMode: 'file' as const,
    modelPath: 'default' as const,
    reranker: 'default' as const,
  };
  const s = drive([
    {
      type: 'config:updated',
      config: cfg,
      origin,
      savedTo: '/tmp/harness.json',
      gitignored: true,
      skipped: [],
    } as WorkflowEvent,
  ]);
  assert.ok(s.toast);
  assert.match(s.toast!.message, /added to \.gitignore/);
  assert.equal(s.toast!.tone, 'success');

  const s2 = drive([
    {
      type: 'config:updated',
      config: cfg,
      origin,
      savedTo: '/tmp/harness.json',
      gitignored: false,
      skipped: ['sources.tavilyKey'],
    } as WorkflowEvent,
  ]);
  assert.match(s2.toast!.message, /env active/);
  assert.equal(s2.toast!.tone, 'warn');
});

check('mode survives a re-plan round trip (plan:start → query → plan → ui:plan_review)', () => {
  // Simulates pressing T in PlanReview: main sends plan:start with the new
  // mode, runPlanner emits query then plan, main sends ui:plan_review. The
  // query event must preserve mode so PlanReview's useState initializer
  // sees the new choice on remount.
  const s = drive([
    { type: 'plan:start', query: 'q', mode: 'flat' } as WorkflowEvent,
    { type: 'query', query: 'q', warm: false },
    {
      type: 'plan',
      intent: 'research',
      tasks: [{ description: 'A' }] as never,
      clarifyQuestions: [],
      tokenCount: 10,
      timeMs: 100,
    },
    { type: 'ui:plan_review' } as WorkflowEvent,
  ]);
  assert.equal(s.mode, 'flat');
  assert.equal(s.uiPhase, 'plan_review');
});

check('pipeline timer: plan:start starts, plan_review pauses, research:start resumes, complete freezes', () => {
  let s = reduce(initialState, { type: 'ui:composer' } as WorkflowEvent);
  assert.equal(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, 0);

  // Fresh submission from composer — starts timer from zero.
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'deep' } as WorkflowEvent);
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, 0);

  // Plan review → timer pauses, banking whatever ran.
  s = reduce(s, { type: 'ui:plan_review' } as WorkflowEvent);
  assert.equal(s.pipelineResumedAt, null);
  assert.ok(s.pipelineElapsedMs >= 0);
  const pauseSnapshot = s.pipelineElapsedMs;

  // Research accept → timer resumes with accumulator preserved.
  s = reduce(s, { type: 'research:start', agentCount: 1, mode: 'deep' });
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, pauseSnapshot);

  // Complete → freezes accumulator, clears resume.
  s = reduce(s, { type: 'complete', data: {} });
  assert.equal(s.pipelineResumedAt, null);
  assert.ok(s.pipelineElapsedMs >= pauseSnapshot);
});

check('pipeline timer: re-plan from plan_review keeps accumulator', () => {
  let s = reduce(initialState, { type: 'ui:composer' } as WorkflowEvent);
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'deep' } as WorkflowEvent);
  s = reduce(s, { type: 'ui:plan_review' } as WorkflowEvent);
  const afterFirstPlan = s.pipelineElapsedMs;
  // User presses T → main emits plan:start again with new mode.
  s = reduce(s, { type: 'plan:start', query: 'q', mode: 'flat' } as WorkflowEvent);
  // Still running — accumulator preserved (no reset on re-plan).
  assert.notEqual(s.pipelineResumedAt, null);
  assert.equal(s.pipelineElapsedMs, afterFirstPlan);
});

check('ui:error drops to composer with error toast', () => {
  const s = drive([
    { type: 'plan:start', query: 'x', mode: 'deep' } as WorkflowEvent,
    { type: 'ui:error', message: 'planner failed' } as WorkflowEvent,
  ]);
  assert.equal(s.uiPhase, 'composer');
  assert.match(s.toast!.message, /planner failed/);
  assert.equal(s.toast!.tone, 'error');
});

check('agent:tick updates pressure', () => {
  const s = drive([
    { type: 'agent:tick', cellsUsed: 4000, nCtx: 16384 } as WorkflowEvent,
  ]);
  assert.equal(s.pressure?.pct, 24);
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
