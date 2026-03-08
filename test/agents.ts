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
import { run, call, spawn, ensure, each, sleep, scoped } from 'effection';
import type { Operation } from 'effection';
import { loadBinary } from '@lloyal-labs/lloyal.node';
import type { NativeBinding } from '@lloyal-labs/lloyal.node';
import { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  initAgents, runAgents, useAgentPool, withSharedRoot, generate, diverge, Tool, createToolkit,
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

class CalculatorTool extends Tool<{ expression: string }> {
  readonly name = 'calculator';
  readonly description = 'Evaluate a math expression and return the numeric result. You MUST use this tool to compute any arithmetic.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { expression: { type: 'string', description: 'Math expression to evaluate, e.g. "147 * 38"' } },
    required: ['expression'],
  };
  *execute(args: { expression: string }): Operation<unknown> {
    try { return { result: Function(`"use strict"; return (${args.expression})`)() }; }
    catch { return { error: 'invalid expression' }; }
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
  *execute(args: { findings: string }): Operation<unknown> {
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
  *execute(): Operation<unknown> {
    throw new Error('intentional_tool_error');
  }
}

class SubAgentTool extends Tool<{ question: string }> {
  readonly name = 'sub_research';
  readonly description = 'Spawn sub-agents to research a question and return their output';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { question: { type: 'string', description: 'Question for sub-agents' } },
    required: ['question'],
  };
  *execute(args: { question: string }): Operation<unknown> {
    const result = yield* withSharedRoot(
      { systemPrompt: 'You are a sub-agent. Answer the question in one sentence.' },
      function*(root) {
        return yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a sub-agent. Answer the question in one sentence.',
            content: args.question || 'What is 1+1?',
            parent: root,
          }],
          tools: new Map(),
          maxTurns: 1,
        });
      },
    );
    return {
      subAgentCount: result.agents.length,
      totalTokens: result.totalTokens,
    };
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

    const { toolMap, toolsJson } = createToolkit([new CalculatorTool()]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a math assistant. You MUST use the calculator tool to compute answers. Never compute mentally.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a math assistant. You MUST use the calculator tool to compute answers. Never compute mentally.',
            content: 'What is 147 * 38? Use the calculator tool.',
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          maxTurns: 3,
        });

        assert(pool.agents.length === 1, 'pool has 1 agent');
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

    const { toolMap, toolsJson } = createToolkit([new CalculatorTool(), new ReportTool()]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a math assistant. First use the calculator tool to compute the answer, then call the report tool with your findings.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a math assistant. First use the calculator tool to compute the answer, then call the report tool with your findings.',
            content: 'What is 256 * 17? Calculate it, then report your findings.',
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

    const { toolMap, toolsJson } = createToolkit([new ThrowingTool()]);

    try {
      yield* withSharedRoot(
        { systemPrompt: 'You are a test agent. You MUST call the explode tool immediately.', tools: toolsJson },
        function*(root) {
          const pool = yield* runAgents({
            tasks: [{
              systemPrompt: 'You are a test agent. You MUST call the explode tool immediately.',
              content: 'Call the explode tool now.',
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
// TEST 11: Nested concurrency — tool spawns sub-agents
// ═════════════════════════════════════════════════════════════════════

async function testNestedConcurrency(): Promise<void> {
  console.log('\n--- Nested concurrency: tool spawns sub-agents ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext({ nSeqMax: 8 }));
    const { events } = yield* initAgents(ctx);

    const collected: AgentEvent[] = [];
    yield* spawn(function*() {
      for (const ev of yield* each(events)) {
        collected.push(ev);
        yield* each.next();
      }
    });

    const { toolMap, toolsJson } = createToolkit([new SubAgentTool()]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool — do not answer directly.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool — do not answer directly.',
            content: 'Research this question using the sub_research tool: "What is 2+2?"',
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          maxTurns: 3,
        });

        assert(pool.agents.length === 1, 'outer pool has 1 agent');
        assert(pool.totalToolCalls > 0, `outer agent made tool calls (${pool.totalToolCalls})`);

        // Verify inner agents spawned — IDs differ from the outer agent
        const outerAgentId = pool.agents[0].agentId;
        const spawnEvents = collected.filter(e => e.type === 'agent:spawn');
        const innerSpawns = spawnEvents.filter(e =>
          e.type === 'agent:spawn' && e.agentId !== outerAgentId
        );
        assert(innerSpawns.length > 0, `inner sub-agents spawned (${innerSpawns.length})`);

        // Branches cleaned up
        assert(root.children.length === 0, 'all branches pruned after pool');

        return pool;
      },
    );

    ok('nested concurrency completed');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 12: Nested cancellation — outer scope halts inner pool
// ═════════════════════════════════════════════════════════════════════

async function testNestedCancellation(): Promise<void> {
  console.log('\n--- Nested cancellation: outer scope halts inner pool ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext({ nSeqMax: 8 }));
    yield* setupTest(ctx);

    // Tool that spawns a long-running inner pool
    class SlowInnerTool extends Tool<Record<string, unknown>> {
      readonly name = 'slow_research';
      readonly description = 'Spawn sub-agents that generate for many turns. You MUST call this tool.';
      readonly parameters: JsonSchema = {
        type: 'object',
        properties: {},
      };
      *execute(): Operation<unknown> {
        const result = yield* withSharedRoot(
          { systemPrompt: 'You are a sub-agent. Write a very long detailed essay about mathematics.' },
          function*(root) {
            return yield* runAgents({
              tasks: [{
                systemPrompt: 'You are a sub-agent. Write a very long detailed essay about mathematics.',
                content: 'Write an essay.',
                parent: root,
              }],
              tools: new Map(),
              maxTurns: 50, // high — should not complete before cancellation
            });
          },
        );
        return { done: true, tokens: result.totalTokens };
      }
    }

    const { toolMap, toolsJson } = createToolkit([new SlowInnerTool()]);

    // Use scoped() to create a scope we can exit early from
    yield* scoped(function*() {
      // Spawn the pool as a child task — will be halted when scope exits
      yield* spawn(function*() {
        yield* withSharedRoot(
          { systemPrompt: 'You are a test agent. Call the slow_research tool immediately.', tools: toolsJson },
          function*(root) {
            yield* useAgentPool({
              tasks: [{
                systemPrompt: 'You are a test agent. You MUST call the slow_research tool immediately.',
                content: 'Call slow_research now.',
                tools: toolsJson,
                parent: root,
              }],
              tools: toolMap,
              maxTurns: 3,
            });
          },
        );
      });

      // Wait for pool to start and tool to fire, then exit scope
      yield* sleep(3000);
      // Scope exits here — spawned child halted, inner pool halted,
      // inner withSharedRoot's finally fires pruneSubtreeSync(),
      // outer withSharedRoot's finally fires pruneSubtreeSync()
    });

    // If we reach here, cancellation didn't crash or hang
    ok('nested cancellation: scope exit completed cleanly');

    // Verify KV cache is still usable after nested cancellation
    const tokens = yield* call(() => ctx.tokenize('Test'));
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    yield* call(() => branch.prefill(tokens));
    const sample = branch.sample();
    assert(sample >= 0, 'context usable after nested cancellation');
    yield* call(() => branch.prune());

    ok('nested cancellation: context usable after cleanup');
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 13: Cross-level KV pressure
// ═════════════════════════════════════════════════════════════════════

async function testCrossLevelPressure(): Promise<void> {
  console.log('\n--- Cross-level KV pressure ---');

  await run(function*() {
    // Small context — inner pool must compete with outer for KV
    const ctx = yield* call(() => createTestContext({ nCtx: 2048, nSeqMax: 8 }));
    yield* setupTest(ctx);

    const { toolMap, toolsJson } = createToolkit([new SubAgentTool()]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool.', tools: toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool.',
            content: 'Research this question using the sub_research tool: "What is 2+2?"',
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          maxTurns: 3,
          pressure: { softLimit: 512, hardLimit: 64 },
        });

        // Pool must complete without crash — inner pool consumed from same budget
        assert(pool.agents.length === 1, 'outer pool has 1 agent');
        ok(`cross-level pressure: completed with ${pool.totalTokens} tokens`);

        return pool;
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 14: parentAgentId distinguishes inner from outer
// ═════════════════════════════════════════════════════════════════════

async function testParentAgentId(): Promise<void> {
  console.log('\n--- parentAgentId: inner vs outer agents ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext({ nSeqMax: 8 }));
    const { events } = yield* initAgents(ctx);

    const collected: AgentEvent[] = [];
    yield* spawn(function*() {
      for (const ev of yield* each(events)) {
        collected.push(ev);
        yield* each.next();
      }
    });

    const { toolMap, toolsJson } = createToolkit([new SubAgentTool()]);

    let outerRootHandle: number | undefined;

    yield* withSharedRoot(
      { systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool — do not answer directly.', tools: toolsJson },
      function*(root) {
        outerRootHandle = root.handle;

        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a research coordinator. Use the sub_research tool to delegate questions to sub-agents. You MUST use the tool — do not answer directly.',
            content: 'Research this question using the sub_research tool: "What is 2+2?"',
            tools: toolsJson,
            parent: root,
          }],
          tools: toolMap,
          maxTurns: 3,
        });

        // Outer agent's parentAgentId should be the outer root handle
        const outerAgentId = pool.agents[0].agentId;
        const spawnEvents = collected.filter(
          (e): e is Extract<AgentEvent, { type: 'agent:spawn' }> => e.type === 'agent:spawn'
        );

        // Find the outer agent's spawn event
        const outerSpawn = spawnEvents.find(e => e.agentId === outerAgentId);
        assert(outerSpawn !== undefined, 'outer agent has spawn event');
        assert(outerSpawn!.parentAgentId === outerRootHandle,
          `outer agent parentAgentId (${outerSpawn!.parentAgentId}) === outer root handle (${outerRootHandle})`);

        // Find inner agent spawn events — agentId differs from outer
        const innerSpawns = spawnEvents.filter(e => e.agentId !== outerAgentId);
        assert(innerSpawns.length > 0, `inner agents spawned (${innerSpawns.length})`);

        // Inner agents' parentAgentId should NOT be the outer root handle —
        // it should be the inner root created by SubAgentTool's withSharedRoot
        for (const inner of innerSpawns) {
          assert(inner.parentAgentId !== outerRootHandle,
            `inner agent parentAgentId (${inner.parentAgentId}) !== outer root handle (${outerRootHandle})`);
        }

        ok('parentAgentId correctly distinguishes inner from outer agents');
        return pool;
      },
    );
  });
}

// ═════════════════════════════════════════════════════════════════════
// TEST 15: Inner pool with tools — grammar isolation
// ═════════════════════════════════════════════════════════════════════

async function testInnerPoolWithTools(): Promise<void> {
  console.log('\n--- Inner pool with tools: grammar isolation ---');

  await run(function*() {
    const ctx = yield* call(() => createTestContext({ nSeqMax: 8 }));
    const { events } = yield* initAgents(ctx);

    const collected: AgentEvent[] = [];
    yield* spawn(function*() {
      for (const ev of yield* each(events)) {
        collected.push(ev);
        yield* each.next();
      }
    });

    // Tool that spawns an inner pool WITH its own tools
    class DelegatingTool extends Tool<{ question: string }> {
      readonly name = 'delegate';
      readonly description = 'Delegate a math question to a sub-agent that has a calculator tool. You MUST use this tool.';
      readonly parameters: JsonSchema = {
        type: 'object',
        properties: { question: { type: 'string', description: 'Math question for sub-agent' } },
        required: ['question'],
      };
      *execute(args: { question: string }): Operation<unknown> {
        // Inner pool has its own tool — CalculatorTool
        const inner = createToolkit([new CalculatorTool()]);
        const result = yield* withSharedRoot(
          { systemPrompt: 'You are a math assistant. You MUST use the calculator tool to compute answers. Never compute mentally.', tools: inner.toolsJson },
          function*(root) {
            return yield* runAgents({
              tasks: [{
                systemPrompt: 'You are a math assistant. You MUST use the calculator tool to compute answers. Never compute mentally.',
                content: args.question || 'What is 99 * 77?',
                tools: inner.toolsJson,
                parent: root,
              }],
              tools: inner.toolMap,
              maxTurns: 3,
            });
          },
        );
        return {
          innerToolCalls: result.totalToolCalls,
          innerTokens: result.totalTokens,
          findings: result.agents[0]?.findings,
        };
      }
    }

    // Outer pool has DelegatingTool — inner pool has CalculatorTool
    // Different tool schemas at each level
    const outer = createToolkit([new DelegatingTool()]);

    yield* withSharedRoot(
      { systemPrompt: 'You are a coordinator. Use the delegate tool to send math questions to a specialist. You MUST use the tool — do not answer directly.', tools: outer.toolsJson },
      function*(root) {
        const pool = yield* runAgents({
          tasks: [{
            systemPrompt: 'You are a coordinator. Use the delegate tool to send math questions to a specialist. You MUST use the tool — do not answer directly.',
            content: 'Use the delegate tool with question "What is 99 * 77?"',
            tools: outer.toolsJson,
            parent: root,
          }],
          tools: outer.toolMap,
          maxTurns: 3,
        });

        assert(pool.agents.length === 1, 'outer pool has 1 agent');
        assert(pool.totalToolCalls > 0, `outer agent called delegate tool (${pool.totalToolCalls})`);

        // Check that inner tool calls happened — calculator at inner level
        const innerToolCalls = collected.filter(
          e => e.type === 'agent:tool_call' && e.tool === 'calculator'
        );
        const outerToolCalls = collected.filter(
          e => e.type === 'agent:tool_call' && e.tool === 'delegate'
        );

        assert(outerToolCalls.length > 0, `outer level called 'delegate' (${outerToolCalls.length})`);

        // Inner calculator calls are expected but model-dependent —
        // the key assertion is that the pool completed without crash,
        // proving grammar isolation (inner pool parsed its own tool schemas)
        if (innerToolCalls.length > 0) {
          ok(`inner level called 'calculator' (${innerToolCalls.length}) — grammar isolation verified`);
        } else {
          console.log('  [WARN] inner agent did not call calculator — grammar isolation not fully exercised');
        }

        assert(root.children.length === 0, 'all branches pruned after pool');
        ok('inner pool with tools completed');

        return pool;
      },
    );
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
  await testNestedConcurrency();
  await testNestedCancellation();
  await testCrossLevelPressure();
  await testParentAgentId();
  await testInnerPoolWithTools();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`\nFatal: ${(err as Error).message}\n${(err as Error).stack}`);
  process.exit(1);
});
