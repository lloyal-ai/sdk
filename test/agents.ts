/**
 * Structured concurrency tests for the agent system
 *
 * Verifies Effection v4 SC guarantees: branch cleanup on all exit paths,
 * scope teardown ordering, ensure() lifecycle.
 *
 * Usage:
 *   npm run test:agents
 *   LLAMA_TEST_MODEL=models/SmolLM2-1.7B-Instruct-Q4_K_M.gguf npm run test:agents
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { run, call, spawn, ensure, each } from 'effection';
import { loadBinary } from '@lloyal-labs/lloyal.node';
import type { NativeBinding } from '@lloyal-labs/lloyal.node';
import { Branch } from '@lloyal-labs/sdk';
import type { SessionContext } from '@lloyal-labs/sdk';
import {
  initAgents, runAgents, withSharedRoot, Tool,
} from '@lloyal-labs/lloyal-agents';
import type { AgentPoolResult, JsonSchema } from '@lloyal-labs/lloyal-agents';

const MODEL_PATH: string = process.env.LLAMA_TEST_MODEL
  ? path.resolve(process.env.LLAMA_TEST_MODEL)
  : path.join(__dirname, '../models/SmolLM2-1.7B-Instruct-Q4_K_M.gguf');

const CTX_SIZE = 2048;

if (!fs.existsSync(MODEL_PATH)) {
  console.error('Test model not found:', MODEL_PATH);
  process.exit(1);
}

console.log('=== lloyal.node SC Agent Tests ===\n');
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

class ThrowingTool extends Tool<Record<string, unknown>> {
  readonly name = 'explode';
  readonly description = 'A tool that always throws';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { input: { type: 'string' } },
  };
  async execute(): Promise<unknown> {
    throw new Error('intentional_tool_error');
  }
}

// ── Helpers ────────────────────────────────────────────────────────

async function createTestContext(): Promise<SessionContext> {
  return addon.createContext({
    modelPath: MODEL_PATH,
    nCtx: CTX_SIZE,
    nThreads: 4,
    nSeqMax: 4,
    typeK: 'f16',
    typeV: 'f16',
  });
}

function makeTasks(parent: Branch, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    systemPrompt: 'You are a test agent.',
    content: `Test task ${i}`,
    parent,
  }));
}

/** Bootstrap agent infra via initAgents + drain events to prevent backpressure */
function* setupTest(ctx: SessionContext) {
  const { events } = yield* initAgents(ctx);
  yield* spawn(function*() {
    for (const _ev of yield* each(events)) {
      yield* each.next();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// TEST 1: ensure() cleanup — runs on scope exit regardless of how
// ═══════════════════════════════════════════════════════════════════

async function testEnsureCleanup(): Promise<void> {
  console.log('\n--- ensure() cleanup: runs on normal exit and on error ---');

  // Test A: ensure runs on normal exit
  let cleanupRanNormal = false;
  await run(function*() {
    yield* ensure(() => { cleanupRanNormal = true; });
  });
  assert(cleanupRanNormal, 'ensure() ran on normal scope exit');

  // Test B: ensure runs on error exit
  let cleanupRanError = false;
  try {
    await run(function*() {
      yield* ensure(() => { cleanupRanError = true; });
      throw new Error('intentional_test_error');
    });
  } catch {
    // expected
  }
  assert(cleanupRanError, 'ensure() ran on error scope exit');
}

// ═══════════════════════════════════════════════════════════════════
// TEST 2: Normal lifecycle — branches pruned after runAgents returns
// ═══════════════════════════════════════════════════════════════════

async function testNormalLifecycle(): Promise<void> {
  console.log('\n--- Normal lifecycle: branches pruned after runAgents ---');

  await run(function*() {
    const ctx: SessionContext = yield* call(() => createTestContext());
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
        assert(root.children.length === 0, 'agent branches pruned before body returns');

        return pool;
      },
    );

    ok('withSharedRoot completed without error');
  });
}

// ═══════════════════════════════════════════════════════════════════
// TEST 3: scoped() cleanup — runAgents prunes before returning
// ═══════════════════════════════════════════════════════════════════

async function testScopedCleanup(): Promise<void> {
  console.log('\n--- Scoped cleanup: runAgents prunes before returning to caller ---');

  await run(function*() {
    const ctx: SessionContext = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    yield* withSharedRoot(
      { systemPrompt: 'You are a test agent.' },
      function*(root) {
        const childCountBefore = root.children.length;
        assert(childCountBefore === 0, 'root starts with no children');

        const pool = yield* runAgents({
          tasks: makeTasks(root, 2),
          tools: new Map(),
          maxTurns: 1,
        });

        // Critical SC assertion: scoped() in runAgents must have torn
        // down the pool scope and pruned agent branches BEFORE returning.
        const childCountAfter = root.children.length;
        assert(childCountAfter === 0, `scoped() pruned all children before returning (was ${childCountBefore}, now ${childCountAfter})`);

        return pool;
      },
    );

    ok('scoped() teardown ordering correct');
  });
}

// ═══════════════════════════════════════════════════════════════════
// TEST 4: Tool error — branches pruned, error does not crash pool
// ═══════════════════════════════════════════════════════════════════

async function testToolErrorCleanup(): Promise<void> {
  console.log('\n--- Tool error: branches pruned, pool completes gracefully ---');

  await run(function*() {
    const ctx: SessionContext = yield* call(() => createTestContext());
    yield* setupTest(ctx);

    try {
      yield* withSharedRoot(
        { systemPrompt: 'You are a test agent. Always call the explode tool.' },
        function*(root) {
          const toolMap = new Map<string, Tool>([['explode', new ThrowingTool()]]);
          const toolsJson = JSON.stringify([{
            type: 'function',
            function: {
              name: 'explode',
              description: 'A tool that always throws',
              parameters: { type: 'object', properties: { input: { type: 'string' } } },
            },
          }]);

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

          assert(root.children.length === 0, 'agent branches pruned after tool error');
          assert(pool.agents.length === 1, 'pool has 1 agent');
          return pool;
        },
      );

      ok('withSharedRoot completed — tool error did not crash the pool');
    } catch (err) {
      // Tool errors should be handled internally (agent → done state).
      // If we reach here, something unexpected propagated.
      fail(`unexpected error escaped pool: ${(err as Error).message}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════

async function main_(): Promise<void> {
  await testEnsureCleanup();
  await testNormalLifecycle();
  await testScopedCleanup();
  await testToolErrorCleanup();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main_().catch((err: unknown) => {
  console.error(`\nFatal: ${(err as Error).message}\n${(err as Error).stack}`);
  process.exit(1);
});
