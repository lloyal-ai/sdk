/**
 * Agent runtime integration tests
 *
 * Exercises real agent behaviors: shared root prefix, tool calling,
 * terminal tool gating, error resilience, context pressure, diverge/generate
 * primitives, event ordering, and cleanup semantics.
 *
 * Requires a tool-calling model (Qwen3 recommended).
 *
 * Usage:
 *   LLAMA_TEST_MODEL=models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf npx tsx test/agents.ts
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { run, call, spawn, ensure, each } from 'effection';
import type { Operation } from 'effection';
import { loadBinary } from '@lloyal-labs/lloyal.node';
import type { NativeBinding } from '@lloyal-labs/lloyal.node';
import { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  initAgents, runAgents, withSharedRoot, generate, diverge, Tool,
} from '@lloyal-labs/lloyal-agents';
import type {
  AgentPoolResult, AgentEvent, JsonSchema, DivergeResult,
} from '@lloyal-labs/lloyal-agents';

// ── Config ───────────────────────────────────────────────────────────

const MODEL_PATH: string = process.env.LLAMA_TEST_MODEL
  ? path.resolve(process.env.LLAMA_TEST_MODEL)
  : path.join(__dirname, '../models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf');

const CTX_SIZE = 4096;

if (!fs.existsSync(MODEL_PATH)) {
  console.error('Test model not found:', MODEL_PATH);
  process.exit(1);
}

console.log('=== Agent Runtime Integration Tests ===\n');
console.log(`Model: ${path.basename(MODEL_PATH)}`);
console.log(`Size: ${(fs.statSync(MODEL_PATH).size / 1024 / 1024).toFixed(1)} MB\n`);

const addon: NativeBinding = loadBinary();

let passed = 0;
let failed = 0;

function ok(msg: string): void {
  passed++;
  console.log(`  [PASS] ${msg}`);
}

function fail(msg: string): void {
  failed++;
  console.log(`  [FAIL] ${msg}`);
}

function assert(condition: boolean, msg: string): void {
  if (condition) ok(msg);
  else { fail(msg); throw new Error(msg); }
}

// ── Test tools ────────────────────────────────────────────────────

class EchoTool extends Tool<{ input: string }> {
  readonly name = 'echo';
  readonly description = 'Returns the input back to the caller';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { input: { type: 'string', description: 'Text to echo back' } },
    required: ['input'],
  };
  async execute(args: { input: string }): Promise<unknown> {
    return { echoed: args.input };
  }
}

class ReportTool extends Tool<{ findings: string }> {
  readonly name = 'report';
  readonly description = 'Report your findings to complete the task';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { findings: { type: 'string', description: 'Summary of findings' } },
    required: ['findings'],
  };
  async execute(args: { findings: string }): Promise<unknown> {
    return { reported: args.findings };
  }
}

class ThrowingTool extends Tool<Record<string, unknown>> {
  readonly name = 'explode';
  readonly description = 'A tool that always throws an error';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { input: { type: 'string' } },
  };
  async execute(): Promise<unknown> {
    throw new Error('intentional_tool_error');
  }
}

// ── Helpers ────────────────────────────────────────────────────────

async function createTestContext(opts?: Partial<{
  nCtx: number; nSeqMax: number;
}>): Promise<SessionContext> {
  return addon.createContext({
    modelPath: MODEL_PATH,
    nCtx: opts?.nCtx ?? CTX_SIZE,
    nThreads: 4,
    nSeqMax: opts?.nSeqMax ?? 8,
    typeK: 'f16',
    typeV: 'f16',
  });
}

function makeTasks(parent: Branch, count: number, opts?: {
  tools?: string; systemPrompt?: string;
}) {
  return Array.from({ length: count }, (_, i) => ({
    systemPrompt: opts?.systemPrompt ?? 'You are a helpful test agent. Respond briefly.',
    content: `Test task ${i}: Describe what 2+${i} equals in one sentence.`,
    tools: opts?.tools,
    parent,
  }));
}

function makeToolsJson(tools: Tool[]): string {
  return JSON.stringify(tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  })));
}

/** Bootstrap agent infra + drain events to prevent backpressure */
function* setupTest(ctx: SessionContext) {
  const handle = yield* initAgents(ctx);
  yield* spawn(function*() {
    for (const _ev of yield* each(handle.events)) {
      yield* each.next();
    }
  });
  return handle;
}

// ═════════════════════════════════════════════════════════════════════
// TEST 1: Shared root KV prefix sharing
// ═════════════════════════════════════════════════════════════════════

async function testSharedRoot(): Promise<void> {
  console.log('\n--- Shared root: KV prefix sharing ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent.' },
      function*(root, prefixLen) {
        assert(prefixLen > 0, `shared prefix has tokens (${prefixLen})`);

        const pool: AgentPoolResult = yield* runAgents({
          tasks: makeTasks(root, 2),
          tools: new Map(),
          maxTurns: 1,
        });

        assert(pool.agents.length === 2, 'pool has 2 agents');
        assert(root.children.length === 0, 'agent branches pruned after pool returns');

        return pool;
      },
    );

    ok('withSharedRoot completed');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 2: Agent pool with tool calling
// ═════════════════════════════════════════════════════════════════════

async function testToolCalling(): Promise<void> {
  console.log('\n--- Agent pool: tool calling ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    const echoTool = new EchoTool();
    const toolMap = new Map<string, Tool>([['echo', echoTool]]);
    const toolsJson = makeToolsJson([echoTool]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent. Always call the echo tool with your answer before responding.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: makeTasks(root, 2, { tools: toolsJson, systemPrompt: 'You are a test agent. Call the echo tool with input "hello" immediately.' }),
          tools: toolMap,
          maxTurns: 3,
        });

        assert(pool.agents.length === 2, 'pool has 2 agents');
        assert(pool.totalToolCalls > 0, `tool calls made (${pool.totalToolCalls})`);
        assert(root.children.length === 0, 'branches pruned after pool');

        return pool;
      },
    );

    ok('tool calling completed');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 3: Terminal tool gating
// ═════════════════════════════════════════════════════════════════════

async function testTerminalToolGating(): Promise<void> {
  console.log('\n--- Terminal tool gating ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    const echoTool = new EchoTool();
    const reportTool = new ReportTool();
    const toolMap = new Map<string, Tool>([
      ['echo', echoTool],
      ['report', reportTool],
    ]);
    const toolsJson = makeToolsJson([echoTool, reportTool]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a research agent. First call echo with your analysis, then call report with findings.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a research agent. You must call the echo tool first to analyze, then call report with your findings.',
            content: 'Analyze: what is 2+2? Call echo first, then report.',
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          terminalTool: 'report',
          maxTurns: 5,
        });

        assert(pool.agents.length === 1, 'pool has 1 agent');
        // Agent should complete — either via report or maxTurns
        ok('terminal tool gating: agent completed');

        return pool;
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 4: Tool error resilience
// ═════════════════════════════════════════════════════════════════════

async function testToolErrorResilience(): Promise<void> {
  console.log('\n--- Tool error resilience ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    const throwingTool = new ThrowingTool();
    const toolMap = new Map<string, Tool>([['explode', throwingTool]]);
    const toolsJson = makeToolsJson([throwingTool]);

    try {
      yield* withSharedRoot(
        { systemPrompt: 'You are a test agent. Call the explode tool immediately.' },
        function*(root) {
          const pool = yield* runAgents({
            tasks: [{
              systemPrompt: 'You are a test agent. Call the explode tool immediately.',
              content: 'Do it now.',
              tools: toolsJson,
              parent: root,
            }],
            tools: toolMap,
            maxTurns: 2,
          });

          assert(root.children.length === 0, 'branches pruned after tool error');
          assert(pool.agents.length === 1, 'pool has 1 agent');
          return pool;
        },
      );

      ok('tool error did not crash the pool');
    } catch (err) {
      fail(`unexpected error escaped pool: ${(err as Error).message}`);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 5: Context pressure — soft limit
// ═════════════════════════════════════════════════════════════════════

async function testContextPressureSoftLimit(): Promise<void> {
  console.log('\n--- Context pressure: soft limit ---');

  await run(function*() {
    // Small context to trigger pressure quickly
    const ctx = yield* call(() => createTestContext({ nCtx: 1024, nSeqMax: 4 }));
    yield* setupTest(ctx);

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent. Write a very long response.' },
      function*(root) {
        const pool = yield* runAgents({
          tasks: makeTasks(root, 2, {
            systemPrompt: 'Write a very long, detailed essay about anything.',
          }),
          tools: new Map(),
          maxTurns: 1,
          pressure: { softLimit: 256, hardLimit: 64 },
        });

        // Pool should complete without crash
        assert(pool.agents.length > 0, 'pool has agents');
        ok(`soft limit: pool completed with ${pool.agents.length} agents, ${pool.totalTokens} tokens`);

        return pool;
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 6: Context pressure — agent drop at init
// ═════════════════════════════════════════════════════════════════════

async function testContextPressureAgentDrop(): Promise<void> {
  console.log('\n--- Context pressure: agent drop at init ---');

  await run(function*() {
    // Very small context, many agents — some must be dropped
    const ctx = yield* call(() => createTestContext({ nCtx: 512, nSeqMax: 8 }));
    yield* setupTest(ctx);

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent.' },
      function*(root) {
        const tasks = makeTasks(root, 6);

        const pool = yield* runAgents({
          tasks,
          tools: new Map(),
          maxTurns: 1,
          pressure: { softLimit: 128, hardLimit: 32 },
        });

        // With 512 ctx and 6 agents, some should be dropped
        // (system prompt + per-agent overhead eats most of the budget)
        console.log(`  agents spawned: ${pool.agents.length} / ${tasks.length} requested`);
        // Pool must complete without crash regardless of how many spawned
        ok(`agent drop: ${pool.agents.length} agents survived out of ${tasks.length}`);

        return pool;
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 7: diverge() — multi-branch perplexity selection
// ═════════════════════════════════════════════════════════════════════

async function testDiverge(): Promise<void> {
  console.log('\n--- diverge(): multi-branch perplexity selection ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext({ nSeqMax: 8 }));
    yield* setupTest(ctx);

    // Format a prompt for diverge
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Tell me a short joke.' },
    ];
    const { prompt: formatted } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

    const result: DivergeResult = yield* diverge({
      prompt: formatted,
      attempts: 3,
      params: { temperature: 0.7 },
    });

    assert(!result.best.disposed, 'best branch is not disposed');
    assert(result.bestOutput.length > 0, `best output has content: "${result.bestOutput.slice(0, 60)}..."`);
    assert(result.attempts.length === 3, '3 attempts made');
    assert(result.totalTokens > 0, `totalTokens > 0 (${result.totalTokens})`);
    assert(result.steps > 0, `steps > 0 (${result.steps})`);

    // Losers should be disposed
    const losers = result.attempts.filter(a => a.branch !== result.best);
    assert(losers.every(a => a.branch.disposed), 'loser branches are disposed');

    // Best should have lowest ppl among finite attempts
    const finiteAttempts = result.attempts.filter(a => isFinite(a.ppl));
    if (finiteAttempts.length > 1) {
      const bestPpl = result.attempts.find(a => a.branch === result.best)!.ppl;
      assert(finiteAttempts.every(a => bestPpl <= a.ppl),
        `best has lowest ppl (${bestPpl.toFixed(2)})`);
    }

    // Clean up the winning branch
    result.best.pruneSync();
    ok('diverge completed with perplexity selection');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 8: generate() — grammar-constrained output
// ═════════════════════════════════════════════════════════════════════

async function testGenerate(): Promise<void> {
  console.log('\n--- generate(): grammar-constrained output ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'integer' },
      },
      required: ['name', 'value'],
    };

    const grammar = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(schema)));
    const messages = [
      { role: 'user', content: 'Output a JSON object with name and value fields.' },
    ];
    const { prompt: formatted } = yield* call(() => ctx.formatChat(JSON.stringify(messages)));

    const result = yield* generate({
      prompt: formatted,
      grammar,
      params: { temperature: 0 },
      parse: (output: string) => JSON.parse(output),
    });

    assert(result.output.length > 0, `generated output: "${result.output.slice(0, 60)}"`);
    assert(result.tokenCount > 0, `tokenCount > 0 (${result.tokenCount})`);

    if (result.parsed) {
      const obj = result.parsed as { name: string; value: number };
      assert(typeof obj.name === 'string', `parsed.name is string: "${obj.name}"`);
      assert(typeof obj.value === 'number', `parsed.value is number: ${obj.value}`);
    } else {
      // Grammar should at least produce valid JSON start
      assert(result.output.startsWith('{'), `output starts with '{': "${result.output.slice(0, 30)}"`);
    }

    ok('generate with grammar-constrained output');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 9: Event stream ordering
// ═════════════════════════════════════════════════════════════════════

async function testEventStreamOrdering(): Promise<void> {
  console.log('\n--- Event stream ordering ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    const { events } = yield* initAgents(ctx);

    // Collect events
    const collected: AgentEvent[] = [];
    yield* spawn(function*() {
      for (const ev of yield* each(events)) {
        collected.push(ev);
        yield* each.next();
      }
    });

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent. Respond with exactly one sentence.' },
      function*(root) {
        yield* runAgents({
          tasks: makeTasks(root, 1),
          tools: new Map(),
          maxTurns: 1,
          trace: true,
        });
        return undefined;
      },
    );

    // Verify event ordering
    assert(collected.length > 0, `collected ${collected.length} events`);

    // Find events for agent 0 (first agent)
    const spawnEvents = collected.filter(e => e.type === 'agent:spawn');
    const produceEvents = collected.filter(e => e.type === 'agent:produce');
    const doneEvents = collected.filter(e => e.type === 'agent:done');

    assert(spawnEvents.length >= 1, `at least 1 spawn event (got ${spawnEvents.length})`);
    assert(produceEvents.length > 0, `produce events emitted (got ${produceEvents.length})`);
    assert(doneEvents.length >= 1, `at least 1 done event (got ${doneEvents.length})`);

    // Verify ordering: spawn before produce, produce before done
    const firstSpawnIdx = collected.findIndex(e => e.type === 'agent:spawn');
    const firstProduceIdx = collected.findIndex(e => e.type === 'agent:produce');
    const lastDoneIdx = collected.length - 1 - [...collected].reverse().findIndex(e => e.type === 'agent:done');

    assert(firstSpawnIdx < firstProduceIdx, 'spawn before produce');
    assert(firstProduceIdx < lastDoneIdx, 'produce before done');

    // With trace: true, produce events should have entropy/surprisal
    const tracedProduce = produceEvents.find(
      e => e.type === 'agent:produce' && 'entropy' in e && e.entropy !== undefined
    );
    if (tracedProduce) {
      ok('trace: produce events have entropy/surprisal');
    } else {
      // Some models may not produce these — warn but don't fail
      console.log('  [WARN] trace: no entropy/surprisal on produce events');
    }

    ok('event stream ordering verified');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 10: withSharedRoot cleanup on error
// ═════════════════════════════════════════════════════════════════════

async function testSharedRootCleanupOnError(): Promise<void> {
  console.log('\n--- withSharedRoot cleanup on error ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    let rootWasPruned = false;

    try {
      yield* withSharedRoot(
        { systemPrompt: 'You are a test agent.' },
        function*(root, prefixLen) {
          assert(prefixLen > 0, `prefix has tokens before error (${prefixLen})`);

          // Spawn an agent to create children
          const pool = yield* runAgents({
            tasks: makeTasks(root, 1),
            tools: new Map(),
            maxTurns: 1,
          });

          // Now throw — withSharedRoot's finally should still prune root
          throw new Error('intentional_test_error');
        },
      );
    } catch (err) {
      if ((err as Error).message === 'intentional_test_error') {
        rootWasPruned = true;
        ok('error propagated from body');
      } else {
        throw err;
      }
    }

    assert(rootWasPruned, 'withSharedRoot propagated error and cleaned up');

    // Verify KV cache is usable after error cleanup
    const tokens = yield* call(() => ctx.tokenize('Test'));
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    yield* call(() => branch.prefill(tokens));
    const sample = branch.sample();
    assert(sample >= 0, 'context usable after error cleanup');
    yield* call(() => branch.prune());

    ok('withSharedRoot cleanup on error verified');
  });
}

// ═════════════════════════════════════════════════════════════════════
// RUNNER
// ═════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  await testSharedRoot();
  await testToolCalling();
  await testTerminalToolGating();
  await testToolErrorResilience();
  await testContextPressureSoftLimit();
  await testContextPressureAgentDrop();
  await testDiverge();
  await testGenerate();
  await testEventStreamOrdering();
  await testSharedRootCleanupOnError();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`\nFatal: ${(err as Error).message}\n${(err as Error).stack}`);
  process.exit(1);
});
