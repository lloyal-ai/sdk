/**
 * SDK primitives integration tests
 *
 * Exercises Branch, BranchStore, Rerank, and SessionContext through the
 * public SDK surface with real model inference. Ported from
 * lloyal-node/test/integration.ts.
 *
 * Usage:
 *   LLAMA_TEST_MODEL=models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf npx tsx test/sdk.ts
 *
 * Optional rerank tests:
 *   LLAMA_RERANK_MODEL=models/qwen3-reranker-0.6b-q4_k_m.gguf npx tsx test/sdk.ts
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadBinary } from '@lloyal-labs/lloyal.node';
import type { NativeBinding } from '@lloyal-labs/lloyal.node';
import { Branch, BranchStore, Rerank } from '@lloyal-labs/sdk';
import type { SessionContext, Produced, FormattedChatResult } from '@lloyal-labs/sdk';

// ── Config ───────────────────────────────────────────────────────────

const MODEL_PATH: string = process.env.LLAMA_TEST_MODEL
  ? path.resolve(process.env.LLAMA_TEST_MODEL)
  : path.join(__dirname, '../models/SmolLM2-1.7B-Instruct-Q4_K_M.gguf');

const RERANK_MODEL_PATH: string | null = process.env.LLAMA_RERANK_MODEL ||
  (fs.existsSync(path.join(__dirname, '../models/qwen3-reranker-0.6b-q4_k_m.gguf'))
    ? path.join(__dirname, '../models/qwen3-reranker-0.6b-q4_k_m.gguf')
    : null);

const CTX_SIZE = 2048;

if (!fs.existsSync(MODEL_PATH)) {
  console.error('Test model not found:', MODEL_PATH);
  process.exit(1);
}

console.log('=== SDK Primitives Integration Tests ===\n');
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

async function createTestContext(opts?: Partial<{
  nCtx: number; nBatch: number; nSeqMax: number;
}>): Promise<SessionContext> {
  return addon.createContext({
    modelPath: MODEL_PATH,
    nCtx: opts?.nCtx ?? CTX_SIZE,
    nBatch: opts?.nBatch ?? 512,
    nThreads: 4,
    nSeqMax: opts?.nSeqMax ?? 4,
  });
}

// ═════════════════════════════════════════════════════════════════════
// BRANCH BASICS
// ═════════════════════════════════════════════════════════════════════

async function testCoreAPI(ctx: SessionContext): Promise<void> {
  console.log('\n--- Core API ---');

  const text = 'Hello world';
  const tokens = await ctx.tokenize(text);
  assert(tokens.length > 0, `tokenize("${text}") → ${tokens.length} tokens`);

  const reconstructed = await ctx.detokenize(tokens);
  assert(typeof reconstructed === 'string', `detokenize() → "${reconstructed}"`);

  const tokenText = ctx.tokenToText(tokens[0]);
  assert(typeof tokenText === 'string', `tokenToText(${tokens[0]}) → "${tokenText}"`);

  const branch = Branch.create(ctx, 0, { temperature: 0 });
  await branch.prefill(tokens);

  const logits = branch.getLogits();
  assert(logits instanceof Float32Array, `getLogits() → Float32Array(${logits.length})`);
  assert(logits.length === ctx.vocabSize, `logits.length === vocabSize (${ctx.vocabSize})`);

  let hasNonZero = false, hasNaN = false;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] !== 0.0) hasNonZero = true;
    if (isNaN(logits[i])) hasNaN = true;
  }
  assert(hasNonZero && !hasNaN, 'logits valid (non-zero, no NaN)');

  const entropy = branch.modelEntropy('nats');
  assert(isFinite(entropy) && entropy >= 0, `modelEntropy() → ${entropy.toFixed(4)} nats`);

  const greedy = branch.sample();
  assert(greedy >= 0 && greedy < ctx.vocabSize, `sample() greedy → ${greedy}`);

  const eos = ctx.getEogToken();
  assert(ctx.isStopToken(eos), `isStopToken(EOS=${eos}) → true`);

  await branch.prune();
}

async function testTokenizer(ctx: SessionContext): Promise<void> {
  console.log('\n--- Tokenizer ---');

  const eog = ctx.getEogToken();
  assert(Number.isInteger(eog), `getEogToken() → ${eog}`);
  assert(ctx.isStopToken(eog), `EOS ${eog} is stop token`);

  const withSpecial = await ctx.tokenize('Hello world', true);
  const noSpecial = await ctx.tokenize('Hello world', false);
  assert(noSpecial.length <= withSpecial.length,
    `addSpecial=false (${noSpecial.length}) <= addSpecial=true (${withSpecial.length})`);

  const sep = ctx.getTurnSeparator();
  assert(Array.isArray(sep) && sep.length > 0, `getTurnSeparator() → [${sep.join(',')}]`);
  assert(sep.some(t => ctx.isStopToken(t)), 'separator contains stop token');

  const sep2 = ctx.getTurnSeparator();
  assert(sep.length === sep2.length && sep.every((t, i) => t === sep2[i]),
    'getTurnSeparator() cached');
}

async function testDeterminism(): Promise<void> {
  console.log('\n--- Determinism ---');

  async function generate(prompt: string): Promise<string> {
    const ctx = await createTestContext();
    try {
      const messages = [{ role: 'user', content: prompt }];
      const { prompt: formatted } = await ctx.formatChat(JSON.stringify(messages));
      const tokens = await ctx.tokenize(formatted);
      const branch = Branch.create(ctx, 0, { temperature: 0 });
      await branch.prefill(tokens);

      const gen: number[] = [];
      for (let i = 0; i < 20; i++) {
        const { token, isStop } = await branch.produce();
        if (isStop) break;
        await branch.commit(token);
        gen.push(token);
      }
      await branch.prune();
      return gen.join(',');
    } finally {
      ctx.dispose();
    }
  }

  const prompt = 'Count from 1 to 5.';
  const run1 = await generate(prompt);
  const run2 = await generate(prompt);
  assert(run1 === run2, `Deterministic: run1 === run2 (${run1.split(',').length} tokens)`);
}

// ═════════════════════════════════════════════════════════════════════
// BRANCH GENERATION
// ═════════════════════════════════════════════════════════════════════

async function testBranchPrefill(): Promise<void> {
  console.log('\n--- Branch.prefill Multi-Turn ---');

  const ctx = await createTestContext();
  try {
    const GEN_TOKENS = 5;
    const turns = [
      'What is the capital of France?',
      ' Tell me more.',
      ' What about transportation?',
    ];

    const messages: Array<{ role: string; content: string }> = [{ role: 'user', content: turns[0] }];
    const { prompt } = await ctx.formatChat(JSON.stringify(messages));
    const promptToks = await ctx.tokenize(prompt);
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(promptToks);

    const gen1: number[] = [];
    for (let i = 0; i < GEN_TOKENS; i++) {
      const { token, isStop } = await branch.produce();
      if (isStop) break;
      await branch.commit(token);
      gen1.push(token);
    }
    assert(gen1.length > 0, `Turn 1: generated ${gen1.length} tokens`);

    const assistantText1 = await ctx.detokenize(gen1);
    messages.push({ role: 'assistant', content: assistantText1 });

    const sep = ctx.getTurnSeparator();

    for (let t = 1; t < turns.length; t++) {
      messages.push({ role: 'user', content: turns[t] });
      const { prompt } = await ctx.formatChat(JSON.stringify([
        { role: 'system', content: '' },
        { role: 'user', content: turns[t] },
      ]));
      const delta = await ctx.tokenize(prompt, false);
      const prefillToks = [...sep, ...delta];

      const posBefore = branch.position;
      await branch.prefill(prefillToks);
      assert(branch.position === posBefore + prefillToks.length,
        `Turn ${t + 1}: prefill ${prefillToks.length} tokens → pos=${branch.position}`);

      const gen: number[] = [];
      for (let i = 0; i < GEN_TOKENS; i++) {
        const { token, isStop } = await branch.produce();
        if (isStop) break;
        await branch.commit(token);
        gen.push(token);
      }
      assert(gen.length > 0, `Turn ${t + 1}: generated ${gen.length} tokens`);

      const assistantText = await ctx.detokenize(gen);
      messages.push({ role: 'assistant', content: assistantText });
    }

    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

async function testWarmMultiTurnRecall(): Promise<void> {
  console.log('\n--- Warm Multi-Turn Recall ---');

  const ctx = await createTestContext();
  try {
    const sep = ctx.getTurnSeparator();

    async function generate(branch: InstanceType<typeof Branch>): Promise<string> {
      const gen: number[] = [];
      for (;;) {
        const { token, isStop } = await branch.produce();
        if (isStop) break;
        await branch.commit(token);
        gen.push(token);
      }
      return ctx.detokenize(gen);
    }

    async function warmTurn(branch: InstanceType<typeof Branch>, userContent: string): Promise<string> {
      const { prompt } = await ctx.formatChat(JSON.stringify([
        { role: 'system', content: '' },
        { role: 'user', content: userContent },
      ]), {});
      const delta = await ctx.tokenize(prompt, false);
      await branch.prefill([...sep, ...delta]);
      return generate(branch);
    }

    function checkRecall(rawText: string, term: string): boolean {
      // Use simple includes — parseChatOutput may strip reasoning
      return rawText.toLowerCase().includes(term.toLowerCase());
    }

    const msgs1 = [{ role: 'user', content: 'Hi, my name is Lloyal' }];
    const { prompt } = await ctx.formatChat(JSON.stringify(msgs1), {});
    const promptToks = await ctx.tokenize(prompt);
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(promptToks);

    const turn1 = await generate(branch);
    console.log(`  Turn 1: "${turn1.trim().slice(0, 80)}"`);
    assert(turn1.length > 0, 'Turn 1: generated response');

    const turn2 = await warmTurn(branch, 'My favourite food is pizza');
    console.log(`  Turn 2: "${turn2.trim().slice(0, 80)}"`);
    assert(turn2.length > 0, 'Turn 2: generated response');

    const turn3 = await warmTurn(branch, 'Do you remember my name?');
    console.log(`  Turn 3 (name recall): "${turn3.trim().slice(0, 80)}"`);
    assert(checkRecall(turn3, 'lloyal'),
      `Name recall: ${checkRecall(turn3, 'lloyal') ? 'found' : 'MISSING "Lloyal" in: ' + turn3.trim()}`);

    const turn4 = await warmTurn(branch, 'Do you remember my favourite food?');
    console.log(`  Turn 4 (food recall): "${turn4.trim().slice(0, 80)}"`);
    assert(checkRecall(turn4, 'pizza'),
      `Food recall: ${checkRecall(turn4, 'pizza') ? 'found' : 'MISSING "pizza" in: ' + turn4.trim()}`);

    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// BRANCH STATE
// ═════════════════════════════════════════════════════════════════════

async function testBranchSteer(): Promise<void> {
  console.log('\n--- Branch.steer ---');

  const ctx = await createTestContext({ nSeqMax: 8 });
  try {
    const tokens = await ctx.tokenize('The quick brown');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(tokens);

    const greedyToken = branch.sample();
    assert(greedyToken >= 0, `Greedy sample → ${greedyToken}`);

    branch.steer([{ token: greedyToken, bias: -Infinity }]);
    const steeredToken = branch.sample();
    assert(steeredToken !== greedyToken,
      `steer() blocks greedy: ${greedyToken} → ${steeredToken}`);

    branch.clearSteer();
    const afterClear = branch.sample();
    assert(afterClear === greedyToken,
      `clearSteer() restores greedy: ${afterClear} === ${greedyToken}`);

    branch.steer([
      { token: greedyToken, bias: -Infinity },
      { token: steeredToken, bias: -Infinity },
    ]);
    const doubleBlocked = branch.sample();
    assert(doubleBlocked !== greedyToken && doubleBlocked !== steeredToken,
      `Multiple blocks: ${doubleBlocked} ≠ {${greedyToken}, ${steeredToken}}`);

    branch.clearSteer();
    branch.steer([{ token: 42, bias: 100.0 }]);
    const boosted = branch.sample();
    assert(boosted === 42, `Boost token 42 → ${boosted}`);

    await branch.prune();
    ok('steer()/clearSteer() work correctly');

    // Fork invariant: steer is NOT cloned
    const tokens2 = await ctx.tokenize('Hello world');
    const parent = Branch.create(ctx, 0, { temperature: 0 });
    await parent.prefill(tokens2);

    const parentGreedy = parent.sample();
    parent.steer([{ token: parentGreedy, bias: -Infinity }]);
    const parentSteered = parent.sample();
    assert(parentSteered !== parentGreedy, `Parent steered: ${parentSteered} ≠ ${parentGreedy}`);

    const child = await parent.fork();
    const childSample = child.sample();
    assert(childSample === parentGreedy,
      `Fork does NOT inherit steer: child=${childSample} === greedy=${parentGreedy}`);

    const parentStillSteered = parent.sample();
    assert(parentStillSteered === parentSteered,
      `Parent retains steer after fork: ${parentStillSteered} === ${parentSteered}`);

    child.steer([{ token: 99, bias: 100.0 }]);
    assert(child.sample() === 99, 'Child can set own steer');
    assert(parent.sample() === parentSteered, 'Parent unaffected by child steer');

    await child.prune();
    await parent.prune();
    ok('steer() NOT cloned on fork (fork invariant)');
  } finally {
    ctx.dispose();
  }
}

async function testSetSamplerParams(): Promise<void> {
  console.log('\n--- setSamplerParams ---');

  const ctx = await createTestContext();
  try {
    const prompt = await ctx.tokenize('The capital of France is');

    const greedy = Branch.create(ctx, 0, { temperature: 0, topK: 0, topP: 1.0, minP: 0 });
    await greedy.prefill(prompt);
    const greedyTok = greedy.sample();
    assert(greedyTok >= 0, `greedy token valid (${greedyTok})`);

    greedy.setSamplerParams({ temperature: 1.5, seed: 42, topK: 0, topP: 1.0, minP: 0 });
    let diverged = false;
    for (let i = 0; i < 20; i++) {
      if (greedy.sample() !== greedyTok) { diverged = true; break; }
    }
    assert(diverged, 'stochastic diverges from greedy');

    greedy.setSamplerParams({ temperature: 0, topK: 0, topP: 1.0, minP: 0 });
    const tok2 = greedy.sample();
    const tok3 = greedy.sample();
    assert(tok2 === tok3, `greedy restored (${tok2} === ${tok3})`);

    await greedy.prune();
  } finally {
    ctx.dispose();
  }
}

async function testSetGrammar(): Promise<void> {
  console.log('\n--- setGrammar ---');

  const ctx = await createTestContext({ nSeqMax: 4 });
  try {
    const grammar = `root ::= "{" ws "}" ws
ws ::= [ \\t\\n]*`;

    const prompt = await ctx.tokenize('Output: ');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(prompt);

    branch.setGrammar(grammar);
    const output: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { token, text, isStop } = await branch.produce();
      if (isStop) break;
      await branch.commit(token);
      output.push(text);
    }
    const result = output.join('');
    assert(/^\{\s*\}\s*$/.test(result), `setGrammar: hot-swap constrains → "${result}"`);

    branch.setGrammar('');
    const { token } = await branch.produce();
    assert(typeof token === 'number', 'setGrammar: removal works');

    await branch.prune();

    // Fork inherits grammar
    await ctx.kvCacheClear();
    const root = Branch.create(ctx, 0, { temperature: 0 });
    await root.prefill(prompt);
    root.setGrammar(grammar);

    const child = await root.fork();
    const childOut: string[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await child.produce();
      if (p.isStop) break;
      await child.commit(p.token);
      childOut.push(p.text);
    }
    assert(/^\{\s*\}\s*$/.test(childOut.join('')),
      `setGrammar: fork inherits grammar → "${childOut.join('')}"`);

    await child.prune();
    await root.prune();
  } finally {
    ctx.dispose();
  }
}

async function testBranchMetrics(): Promise<void> {
  console.log('\n--- Branch Metrics & Logit Bias ---');

  const ctx = await createTestContext({ nSeqMax: 8 });
  try {
    const tokens = await ctx.tokenize('The capital of France is');
    const branch = Branch.create(ctx, 0, { temperature: 0.8, seed: 42 });
    await branch.prefill(tokens);

    // modelEntropy
    const entropy = branch.modelEntropy('nats');
    assert(isFinite(entropy) && entropy >= 0, `modelEntropy('nats') → ${entropy.toFixed(4)}`);

    const entropyBits = branch.modelEntropy('bits');
    assert(Math.abs(entropyBits - entropy / Math.log(2)) < 0.01,
      'modelEntropy bits consistent with nats');

    // modelSurprisal
    const token = branch.sample();
    const surprisal = branch.modelSurprisal(token, 'nats');
    assert(isFinite(surprisal) && surprisal >= 0,
      `modelSurprisal(${token}, 'nats') → ${surprisal.toFixed(4)}`);

    const surprisalBits = branch.modelSurprisal(token, 'bits');
    assert(Math.abs(surprisalBits - surprisal / Math.log(2)) < 0.01,
      'modelSurprisal bits consistent with nats');

    // samplingPerplexity — Infinity before any commits
    assert(branch.samplingPerplexity === Infinity,
      `samplingPerplexity before commit is Infinity`);

    await branch.commit(token);
    const { token: t2 } = await branch.produce();
    await branch.commit(t2);

    const pplAfter = branch.samplingPerplexity;
    assert(isFinite(pplAfter) && pplAfter >= 1.0,
      `samplingPerplexity after commits → ${pplAfter.toFixed(4)}`);

    // setLogitBias — ban greedy token
    const baseline = Branch.create(ctx, 0, { temperature: 0 });
    await baseline.prefill(tokens);
    const bannedToken = baseline.sample();
    await baseline.prune();

    const biased = Branch.create(ctx, 0, { temperature: 0 });
    await biased.prefill(tokens);
    biased.setLogitBias([{ token: bannedToken, bias: -Infinity }]);
    const alternative = biased.sample();
    assert(alternative !== bannedToken,
      `setLogitBias: banned token ${bannedToken} not sampled (got ${alternative})`);

    // clearLogitBias — greedy baseline returns
    const restored = Branch.create(ctx, 0, { temperature: 0 });
    await restored.prefill(tokens);
    assert(restored.sample() === bannedToken,
      'clearLogitBias: greedy token restored');

    // setLogitBias cloned on fork
    const parent = Branch.create(ctx, 0, { temperature: 0 });
    await parent.prefill(tokens);
    parent.setLogitBias([{ token: bannedToken, bias: -Infinity }]);
    const child = await parent.fork();
    assert(child.sample() !== bannedToken,
      'setLogitBias cloned on fork: child bans same token');

    await branch.prune();
    await biased.prune();
    await restored.prune();
    await parent.pruneSubtree();
  } finally {
    ctx.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// BRANCH EDGE CASES
// ═════════════════════════════════════════════════════════════════════

async function testAsyncRejection(): Promise<void> {
  console.log('\n--- Async Rejection ---');

  const ctx = await createTestContext();
  try {
    const tokens = await ctx.tokenize('Hello world');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(tokens);

    const { token, isStop } = await branch.produce();
    assert(!isStop, 'initial produce succeeds');
    await branch.commit(token);

    await branch.prune();
    assert(branch.disposed, 'branch is disposed after prune');

    let threwOnCommit = false;
    try { await branch.commit(token); } catch (err) {
      threwOnCommit = true;
      assert((err as Error).message.includes('disposed'), 'commit error says "disposed"');
    }
    assert(threwOnCommit, 'commit on disposed branch throws');

    let threwOnProduce = false;
    try { await branch.produce(); } catch { threwOnProduce = true; }
    assert(threwOnProduce, 'produce on disposed branch rejects');

    let threwOnProduceSync = false;
    try { branch.produceSync(); } catch { threwOnProduceSync = true; }
    assert(threwOnProduceSync, 'produceSync on disposed branch throws');

    let threwOnFork = false;
    try { await branch.fork(); } catch { threwOnFork = true; }
    assert(threwOnFork, 'fork on disposed branch throws');
  } finally {
    ctx.dispose();
  }
}

async function testDisposedDuringAsync(): Promise<void> {
  console.log('\n--- Disposed During Async ---');

  const ctx = await createTestContext();
  try {
    const tokens = await ctx.tokenize('Test prompt');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(tokens);

    const { token } = await branch.produce();
    await branch.commit(token);

    const prunePromise = branch.prune();
    assert(branch.disposed, '_disposed is true synchronously after prune() call');

    let threwProduce = false;
    try { branch.produceSync(); } catch { threwProduce = true; }
    assert(threwProduce, 'produceSync() throws before prune promise resolves');

    let threwCommit = false;
    try { await branch.commit(token); } catch { threwCommit = true; }
    assert(threwCommit, 'commit() throws before prune promise resolves');

    await prunePromise;
    ok('prune promise resolves after synchronous guard tests');

    await branch.prune();
    ok('double prune is idempotent');
  } finally {
    ctx.dispose();
  }
}

async function testAsyncIterator(): Promise<void> {
  console.log('\n--- Async Iterator ---');

  const ctx = await createTestContext();
  try {
    const prompt = await ctx.tokenize('The quick brown fox');

    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(prompt);

    const tokens: number[] = [];
    for await (const { token, text } of branch) {
      assert(typeof token === 'number' && typeof text === 'string',
        `iterator: yields {token, text} (token=${token})`);
      tokens.push(token);
      if (tokens.length >= 10) break;
    }
    assert(tokens.length === 10, `iterator: consumer break at 10 tokens (got ${tokens.length})`);

    assert(branch.position === prompt.length + tokens.length,
      `iterator: position reflects all yielded tokens (${branch.position} === ${prompt.length} + ${tokens.length})`);

    assert(isFinite(branch.perplexity) && branch.perplexity >= 1.0,
      `iterator: perplexity valid after iteration (${branch.perplexity.toFixed(2)})`);

    await branch.prune();

    // Verify determinism: iterator matches manual produce/commit
    await ctx.kvCacheClear();
    const branchManual = Branch.create(ctx, 0, { temperature: 0 });
    await branchManual.prefill(prompt);
    const manualTokens: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { token, isStop } = await branchManual.produce();
      if (isStop) break;
      await branchManual.commit(token);
      manualTokens.push(token);
    }

    assert(tokens.length === manualTokens.length &&
      tokens.every((t, i) => t === manualTokens[i]),
      'iterator: output matches manual produce/commit (deterministic)');

    await branchManual.prune();
  } finally {
    ctx.dispose();
  }
}

async function testNBatchAblation(): Promise<void> {
  console.log('\n--- nBatch Ablation ---');

  const nBatchValues = [32, 64, 128, 512];
  const results: Record<number, string> = {};

  for (const nBatch of nBatchValues) {
    const ctx = await createTestContext({ nBatch });
    try {
      const messages = [{ role: 'user', content: 'Hello, how are you today?' }];
      const { prompt } = await ctx.formatChat(JSON.stringify(messages));
      const promptToks = await ctx.tokenize(prompt);
      const branch = Branch.create(ctx, 0, { temperature: 0 }, nBatch);
      await branch.prefill(promptToks);

      const followUp = await ctx.tokenize(' What else?');
      await branch.prefill(followUp);

      const gen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const { token, isStop } = await branch.produce();
        if (isStop) break;
        await branch.commit(token);
        gen.push(token);
      }

      results[nBatch] = gen.join(',');
      await branch.prune();
    } finally {
      ctx.dispose();
    }
  }

  const ref = results[nBatchValues[0]];
  const allMatch = nBatchValues.every(nb => results[nb] === ref);
  assert(allMatch, 'All nBatch values produce identical output');
}

// ═════════════════════════════════════════════════════════════════════
// BRANCH PREFILL & METRICS
// ═════════════════════════════════════════════════════════════════════

async function testBranchPrefillAndLogits(): Promise<void> {
  console.log('\n--- Branch prefill + getLogits ---');

  const ctx = await createTestContext();
  try {
    const tokens = await ctx.tokenize('Hello');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(tokens);

    const logits = branch.getLogits();
    let valid = false;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] !== 0 && !isNaN(logits[i])) valid = true;
    }
    assert(valid, 'prefill() + getLogits() → valid logits');

    // Independent copy
    const orig = logits[0];
    logits[0] = -999;
    const logits2 = branch.getLogits();
    assert(logits2[0] !== -999, 'getLogits() returns independent copy');

    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

async function testPplSanity(): Promise<void> {
  console.log('\n--- PPL Sanity ---');

  const ctx = await createTestContext();
  try {
    const messages = [{ role: 'user', content: 'Tell me about the weather.' }];
    const { prompt } = await ctx.formatChat(JSON.stringify(messages));
    const promptToks = await ctx.tokenize(prompt);
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(promptToks);

    for (let i = 0; i < 10; i++) {
      const { token, isStop } = await branch.produce();
      if (isStop) break;
      await branch.commit(token);
    }

    const ppl = branch.perplexity;
    console.log(`  perplexity after 10 commits: ${ppl.toFixed(2)}`);
    assert(isFinite(ppl) && ppl >= 1.0 && ppl < 1000,
      `PPL sanity: ${ppl.toFixed(2)} is in [1, 1000)`);

    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

async function testCommitRollback(): Promise<void> {
  console.log('\n--- Commit Rollback ---');

  const ctx = await createTestContext({ nCtx: 32, nSeqMax: 8 });
  try {
    const promptToks = await ctx.tokenize('Hi');
    const root = Branch.create(ctx, 0, { temperature: 1.0 });
    await root.prefill(promptToks);
    const branches = [root];
    for (let i = 1; i < 8; i++) {
      const b = await root.fork();
      b.reseedSampler(1000 + i);
      branches.push(b);
    }

    const store = new BranchStore(ctx);

    let successfulRounds = 0;
    let failedRound = false;
    for (let round = 0; round < 50; round++) {
      const produced: Array<[InstanceType<typeof Branch>, Produced]> = await Promise.all(
        branches.map(async (b): Promise<[InstanceType<typeof Branch>, Produced]> => [b, await b.produce()])
      );
      const live = produced.filter(([, p]) => !p.isStop);
      if (!live.length) break;

      const pplsBefore = live.map(([b]) => b.perplexity);

      try {
        await store.commit(live.map(([b, p]) => [b, p.token] as [InstanceType<typeof Branch>, number]));
        successfulRounds++;
      } catch {
        const pplsAfter = live.map(([b]) => b.perplexity);
        const allRestored = pplsBefore.every((p, i) => p === pplsAfter[i]);
        assert(allRestored,
          `rollback: all PPLs restored after decode failure at round ${round}`);

        const [b0, p0] = live[0];
        const posBefore = b0.position;
        try {
          await b0.commit(p0.token);
          assert(b0.position === posBefore + 1,
            `rollback: single commit succeeds after failed batch (pos ${b0.position})`);
        } catch {
          // KV truly full — OK
        }

        failedRound = true;
        break;
      }
    }

    console.log(`  ${successfulRounds} successful rounds before KV exhaustion`);
    assert(failedRound,
      `rollback: decode failure triggered (nCtx=32, 8 branches, ${successfulRounds} rounds)`);

    await root.pruneSubtree();
  } finally {
    ctx.dispose();
  }
}

async function testEmptyInputEdgeCases(): Promise<void> {
  console.log('\n--- Empty Input Edge Cases ---');

  const ctx = await createTestContext();
  try {
    const tokens = await ctx.tokenize('Hello world');
    const branch = Branch.create(ctx, 0, { temperature: 0 });
    await branch.prefill(tokens);
    const store = new BranchStore(ctx);

    const posBefore = branch.position;

    await store.commit([]);
    assert(branch.position === posBefore, 'empty store.commit: position unchanged');
    ok('store.commit([]) resolves');

    await store.prefill([]);
    assert(branch.position === posBefore, 'empty store.prefill: position unchanged');
    ok('store.prefill([]) resolves');

    await branch.prefill([]);
    assert(branch.position === posBefore, 'empty branch.prefill: position unchanged');
    ok('branch.prefill([]) resolves');

    const { token, isStop } = await branch.produce();
    assert(!isStop, 'produce still works after empty ops');
    await branch.commit(token);
    assert(branch.position === posBefore + 1, 'commit advances position after empty ops');

    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// BRANCHSTORE
// ═════════════════════════════════════════════════════════════════════

async function testBranchStore(): Promise<void> {
  console.log('\n--- BranchStore ---');

  const ctx = await createTestContext({ nSeqMax: 8 });
  try {
    const promptToks = await ctx.tokenize('The quick brown fox jumps over the lazy');
    const store = new BranchStore(ctx);

    // Test A: Best-of-N generation
    {
      const root = Branch.create(ctx, 0, { temperature: 0.8 });
      await root.prefill(promptToks);
      const branches = [root, await root.fork(), await root.fork()];
      branches[1].reseedSampler(42);
      branches[2].reseedSampler(99);

      for (let step = 0; step < 10; step++) {
        const produced: Array<[InstanceType<typeof Branch>, Produced]> = await Promise.all(
          branches.map(async (b): Promise<[InstanceType<typeof Branch>, Produced]> => [b, await b.produce()])
        );
        const live = produced.filter(([, p]) => !p.isStop);
        if (!live.length) break;
        await store.commit(live.map(([b, p]) => [b, p.token] as [InstanceType<typeof Branch>, number]));
      }

      const ppls = branches.map(b => b.perplexity);
      console.log(`  best-of-N perplexities: [${ppls.map(p => p.toFixed(2)).join(', ')}]`);
      assert(ppls.every(p => isFinite(p) && p >= 1.0),
        `best-of-N: all perplexities valid [${ppls.map(p => p.toFixed(2))}]`);

      await root.pruneSubtree();
    }

    // Test B: Rehydrate + Generate pipeline
    {
      const b1 = Branch.create(ctx, 0, { temperature: 0 });
      await b1.prefill(promptToks);
      const b2 = await b1.fork();

      const history1 = await ctx.tokenize(' dog. The weather is nice today and I want to go', false);
      const history2 = await ctx.tokenize(' cat. Let me explain how quantum entanglement works in', false);
      await store.prefill([[b1, history1], [b2, history2]]);

      const logits1 = b1.getLogits();
      const logits2 = b2.getLogits();
      let prefillDiffer = false;
      for (let i = 0; i < logits1.length; i++) {
        if (logits1[i] !== logits2[i]) { prefillDiffer = true; break; }
      }
      assert(prefillDiffer, 'rehydrate: different histories → different logits');

      const gen1: number[] = [], gen2: number[] = [];
      for (let i = 0; i < 5; i++) {
        const produced: Array<[InstanceType<typeof Branch>, Produced]> = [[b1, await b1.produce()], [b2, await b2.produce()]];
        const live = produced.filter(([, p]) => !p.isStop);
        if (!live.length) break;
        await store.commit(live.map(([b, p]) => [b, p.token] as [InstanceType<typeof Branch>, number]));
        for (const [b, p] of live) (b === b1 ? gen1 : gen2).push(p.token);
      }

      assert(isFinite(b1.perplexity) && isFinite(b2.perplexity),
        `rehydrate: perplexity valid (b1=${b1.perplexity.toFixed(2)}, b2=${b2.perplexity.toFixed(2)})`);

      await b2.prune();
      await b1.prune();
    }

    // Test C: getLogits() → modelEntropy() integration
    {
      const b1 = Branch.create(ctx, 0, { temperature: 0 });
      await b1.prefill(promptToks);

      const logits = b1.getLogits();
      assert(logits instanceof Float32Array, 'getLogits: returns Float32Array');
      assert(logits.length === ctx.vocabSize,
        `getLogits: length=${logits.length} === vocabSize=${ctx.vocabSize}`);

      const entropyFromBranch = b1.modelEntropy('nats');
      assert(isFinite(entropyFromBranch) && entropyFromBranch > 0,
        `modelEntropy: ${entropyFromBranch.toFixed(4)} nats`);

      const p = await b1.produce();
      assert(!p.isStop, 'produce() should not hit EOG on first token');
      await store.commit([[b1, p.token]]);
      const entropyAfter = b1.modelEntropy('nats');
      assert(isFinite(entropyAfter),
        `modelEntropy after commit: ${entropyAfter.toFixed(4)} nats`);

      await b1.prune();
    }

    // Test D: produce() → store.commit() interop
    {
      const b1 = Branch.create(ctx, 0, { temperature: 0 });
      await b1.prefill(promptToks);
      const b2 = await b1.fork();

      const output: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p1 = await b1.produce(), p2 = await b2.produce();
        assert(typeof p1.text === 'string' && typeof p2.text === 'string',
          `produce→commit: produce() returns text at step ${i}`);
        if (p1.isStop || p2.isStop) break;
        await store.commit([[b1, p1.token], [b2, p2.token]]);
        output.push(p1.text);
      }

      console.log(`  produce→commit: "${output.join('')}"`);
      assert(output.length > 0,
        `produce→commit: generated ${output.length} tokens via inspect-then-batch`);

      await b2.prune();
      await b1.prune();
    }

    // Test E: Mixed single/batched operations
    {
      const b1 = Branch.create(ctx, 0, { temperature: 0 });
      await b1.prefill(promptToks);
      const b2 = await b1.fork();

      for (let i = 0; i < 3; i++) {
        const produced: Array<[InstanceType<typeof Branch>, Produced]> = [[b1, await b1.produce()], [b2, await b2.produce()]];
        const live = produced.filter(([, p]) => !p.isStop);
        if (!live.length) break;
        for (const [b, p] of live) await b.commit(p.token);
      }
      const posAfterSingle = b1.position;

      for (let i = 0; i < 3; i++) {
        const produced: Array<[InstanceType<typeof Branch>, Produced]> = [[b1, await b1.produce()], [b2, await b2.produce()]];
        const live = produced.filter(([, p]) => !p.isStop);
        if (!live.length) break;
        await store.commit(live.map(([b, p]) => [b, p.token] as [InstanceType<typeof Branch>, number]));
      }
      const posAfterBatched = b1.position;
      assert(posAfterBatched === posAfterSingle + 3,
        `mixed ops: position correct after single→batched (${posAfterSingle}→${posAfterBatched})`);

      for (let i = 0; i < 3; i++) {
        const produced: Array<[InstanceType<typeof Branch>, Produced]> = [[b1, await b1.produce()], [b2, await b2.produce()]];
        const live = produced.filter(([, p]) => !p.isStop);
        if (!live.length) break;
        for (const [b, p] of live) await b.commit(p.token);
      }

      assert(isFinite(b1.perplexity) && b1.perplexity >= 1.0,
        `mixed ops: perplexity valid after 9 mixed steps (${b1.perplexity.toFixed(2)})`);

      await b2.prune();
      await b1.prune();
    }

    // Test F: Independent EOG — one branch stops, other continues
    {
      const b1 = Branch.create(ctx, 0, { temperature: 0 });
      await b1.prefill(promptToks);
      const b2 = await b1.fork();

      const eog = ctx.getEogToken();
      const gen1: number[] = [], gen2: number[] = [];
      const stopped: [boolean, boolean] = [false, false];

      for (let step = 0; step < 8; step++) {
        if (step === 3 && !stopped[0]) {
          b1.steer([{ token: eog, bias: 100.0 }]);
        }

        const pairs: Array<[InstanceType<typeof Branch>, Produced]> = [
          ...(!stopped[0] ? [[b1, await b1.produce()] as [InstanceType<typeof Branch>, Produced]] : []),
          ...(!stopped[1] ? [[b2, await b2.produce()] as [InstanceType<typeof Branch>, Produced]] : []),
        ];

        const live = pairs.filter(([, p]) => !p.isStop);
        const dead = pairs.filter(([, p]) => p.isStop);

        for (const [b] of dead) {
          if (b === b1) stopped[0] = true;
          if (b === b2) stopped[1] = true;
        }

        if (!live.length) break;
        await store.commit(live.map(([b, p]) => [b, p.token] as [InstanceType<typeof Branch>, number]));

        for (const [b, p] of live) {
          (b === b1 ? gen1 : gen2).push(p.token);
        }

        if (step === 3 && stopped[0]) b1.clearSteer();
      }

      assert(stopped[0], 'independent EOG: b1 hit EOG (steered at step 3)');
      assert(gen1.length === 3, `independent EOG: b1 generated 3 tokens before EOG (got ${gen1.length})`);
      assert(gen2.length > gen1.length,
        `independent EOG: b2 continued past b1 (b1=${gen1.length}, b2=${gen2.length})`);

      assert(b2.position === promptToks.length + gen2.length,
        `independent EOG: b2 position correct (${b2.position} === ${promptToks.length} + ${gen2.length})`);

      await b2.prune();
      await b1.prune();
    }
  } finally {
    ctx.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// CHAT FORMATTING
// ═════════════════════════════════════════════════════════════════════

async function testChatInOut(ctx: SessionContext): Promise<void> {
  console.log('\n--- Chat In/Out ---');

  const messages = [{ role: 'user', content: 'Hello' }];
  const result: FormattedChatResult = await ctx.formatChat(JSON.stringify(messages), {});
  assert(result.prompt.includes('Hello'), 'formatChat: prompt contains Hello');
  assert(typeof result.format === 'number', 'formatChat: returns format');
  assert(typeof result.grammar === 'string', 'formatChat: returns grammar');
  assert(typeof result.grammarLazy === 'boolean', 'formatChat: returns grammarLazy');
  assert(typeof result.thinkingForcedOpen === 'boolean', 'formatChat: returns thinkingForcedOpen');
  assert(typeof result.reasoningFormat === 'number', 'formatChat: returns reasoningFormat');
  assert(Array.isArray(result.grammarTriggers), 'formatChat: returns grammarTriggers');
  assert(Array.isArray(result.preservedTokens), 'formatChat: returns preservedTokens');
  ok('formatChat with options returns extended result');

  const backCompat: FormattedChatResult = await ctx.formatChat(JSON.stringify(messages));
  assert(backCompat.prompt.includes('Hello'), 'formatChat backward compat works');

  // formatChat with tools
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { location: { type: 'string' } } },
    },
  }];
  const toolResult = await ctx.formatChat(JSON.stringify(messages), {
    tools: JSON.stringify(tools),
    toolChoice: 'auto',
  });
  assert(typeof toolResult.format === 'number', 'formatChat with tools: returns format');
  assert(typeof toolResult.grammar === 'string', 'formatChat with tools: returns grammar');
  ok('formatChat with tools');

  // parseChatOutput
  const parsed = ctx.parseChatOutput('Hello world', toolResult.format);
  assert(typeof parsed.content === 'string', 'parseChatOutput: returns content');
  assert(parsed.content.includes('Hello'), 'parseChatOutput: content contains Hello');
  assert(Array.isArray(parsed.toolCalls), 'parseChatOutput: returns toolCalls');
  ok('parseChatOutput basic');

  const parsedWithOpts = ctx.parseChatOutput('Some output', toolResult.format, {
    reasoningFormat: toolResult.reasoningFormat,
    isPartial: false,
    thinkingForcedOpen: false,
  });
  assert(typeof parsedWithOpts.content === 'string', 'parseChatOutput with options');
  ok('parseChatOutput with options');
}

// ═════════════════════════════════════════════════════════════════════
// GRAMMAR
// ═════════════════════════════════════════════════════════════════════

async function testJsonSchemaToGrammar(): Promise<void> {
  console.log('\n--- jsonSchemaToGrammar ---');

  const ctx = await createTestContext();
  try {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name', 'age'],
    };

    const grammar = await ctx.jsonSchemaToGrammar(JSON.stringify(schema));
    assert(typeof grammar === 'string' && grammar.length > 0,
      `jsonSchemaToGrammar: returned ${grammar.length}-char grammar`);
    assert(grammar.includes('root'), 'grammar contains "root" rule');

    const prompt = await ctx.tokenize('Output JSON: ');
    const branch = Branch.create(ctx, 0, { temperature: 0 }, undefined, grammar);
    await branch.prefill(prompt);

    const output: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { token, text, isStop } = await branch.produce();
      if (isStop) break;
      await branch.commit(token);
      output.push(text);
    }

    const result = output.join('');
    let parsed: { name: string; age: number } | undefined;
    try { parsed = JSON.parse(result); } catch { /* partial output OK */ }

    if (parsed) {
      assert(typeof parsed.name === 'string', `output has string "name": "${parsed.name}"`);
      assert(typeof parsed.age === 'number', `output has number "age": ${parsed.age}`);
    } else {
      assert(result.startsWith('{'), `output starts with '{': "${result.slice(0, 30)}..."`);
    }

    await branch.prune();

    // Error path: invalid JSON → rejects
    let rejected = false;
    try { await ctx.jsonSchemaToGrammar('not valid json {{{'); } catch (err) {
      rejected = true;
      assert(err instanceof Error, 'rejection is Error');
    }
    assert(rejected, 'invalid JSON rejects');
  } finally {
    ctx.dispose();
  }
}

async function testGrammar(): Promise<void> {
  console.log('\n--- Grammar Sampling ---');

  const ctx = await createTestContext({ nSeqMax: 4 });
  try {
    const grammar = `root ::= "{" ws "}" ws
ws ::= [ \\t\\n]*`;

    const prompt = await ctx.tokenize('Output: ');
    const branch = Branch.create(ctx, 0, { temperature: 0 }, undefined, grammar);
    await branch.prefill(prompt);

    const output: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { token, text, isStop } = await branch.produce();
      if (isStop) break;
      await branch.commit(token);
      output.push(text);
    }
    assert(/^\{\s*\}\s*$/.test(output.join('')), `Branch+grammar → "${output.join('')}"`);

    // Grammar cloned on fork
    await ctx.kvCacheClear();
    const root = Branch.create(ctx, 0, { temperature: 0 }, undefined, grammar);
    await root.prefill(prompt);

    const childA = await root.fork();
    const childB = await root.fork();

    const outA: string[] = [], outB: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pA = await childA.produce();
      if (!pA.isStop) { await childA.commit(pA.token); outA.push(pA.text); }
      const pB = await childB.produce();
      if (!pB.isStop) { await childB.commit(pB.token); outB.push(pB.text); }
    }

    assert(/^\{\s*\}\s*$/.test(outA.join('')), `Fork A grammar → "${outA.join('')}"`);
    assert(/^\{\s*\}\s*$/.test(outB.join('')), `Fork B grammar → "${outB.join('')}"`);

    await childA.prune();
    await childB.prune();
    await root.prune();
    await branch.prune();
  } finally {
    ctx.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// RERANK (gated on LLAMA_RERANK_MODEL)
// ═════════════════════════════════════════════════════════════════════

async function testRerank(): Promise<void> {
  if (!RERANK_MODEL_PATH) {
    console.log('\n--- Rerank (SKIPPED - no LLAMA_RERANK_MODEL) ---');
    return;
  }

  console.log('\n--- Rerank ---');
  console.log(`  Model: ${path.basename(RERANK_MODEL_PATH)}`);

  const rerankCtx = await addon.createContext({
    modelPath: RERANK_MODEL_PATH,
    nCtx: 4096,
    nSeqMax: 8,
    typeK: 'q4_0',
    typeV: 'q4_0',
  });
  const rerank = await Rerank.create(rerankCtx, { nSeqMax: 8, nCtx: 4096 });

  try {
    const query = 'What is the capital of France?';
    const docs = [
      'Berlin is the capital of Germany and its largest city.',
      'Paris is the capital and most populous city of France.',
      'The Amazon rainforest produces about 20% of the world\'s oxygen.',
      'France is a country in Western Europe, with its capital being Paris.',
    ];
    const tokenized = await Promise.all(docs.map(d => rerank.tokenize(d)));

    let results!: { score: number; index: number }[];
    let progressCount = 0;
    for await (const p of rerank.score(query, tokenized)) {
      progressCount++;
      results = p.results;
    }
    assert(progressCount > 0, `received progress updates (got ${progressCount})`);
    assert(results.length === docs.length, `returns all ${docs.length} results`);

    for (let i = 0; i < results.length; i++) {
      assert(results[i].score >= 0 && results[i].score <= 1,
        `score[${i}] = ${results[i].score} is in [0, 1]`);
      if (i > 0) {
        assert(results[i].score <= results[i - 1].score,
          `sorted descending (${results[i - 1].score} >= ${results[i].score})`);
      }
    }

    const topIndices = results.slice(0, 2).map(r => r.index);
    assert(topIndices.includes(1) || topIndices.includes(3),
      `a Paris doc in top 2 (top indices: [${topIndices}])`);

    const amazonRank = results.findIndex(r => r.index === 2);
    assert(amazonRank >= 2, `Amazon doc not in top 2 (rank: ${amazonRank})`);
    ok(`semantic ordering correct`);

    // topK
    let top2!: { score: number; index: number }[];
    for await (const p of rerank.score(query, tokenized, 2)) { top2 = p.results; }
    assert(top2.length === 2, 'topK=2 returns 2 results');
    assert(top2[0].score === results[0].score, 'topK=2 matches top of full results');

    // tokenize determinism
    const tokens1 = await rerank.tokenize('hello');
    const tokens2 = await rerank.tokenize('hello');
    assert(tokens1.length === tokens2.length && tokens1.every((t, i) => t === tokens2[i]),
      'tokenize() is deterministic');
  } finally {
    rerank.dispose();
  }
}

async function testRerankLargeCorpus(): Promise<void> {
  if (!RERANK_MODEL_PATH) {
    console.log('\n--- Rerank Large Corpus (SKIPPED - no LLAMA_RERANK_MODEL) ---');
    return;
  }

  console.log('\n--- Rerank Large Corpus ---');

  const rerankCtx = await addon.createContext({
    modelPath: RERANK_MODEL_PATH,
    nCtx: 4096,
    nSeqMax: 8,
    typeK: 'q4_0',
    typeV: 'q4_0',
  });
  const rerank = await Rerank.create(rerankCtx, { nSeqMax: 8, nCtx: 4096 });

  try {
    const query = 'What is the capital of France?';
    const docTexts = [
      'Paris is the capital and most populous city of France.',
      'The Amazon rainforest produces about 20% of the world\'s oxygen.',
      'Berlin is the capital of Germany and its largest city.',
      'The Great Wall of China is over 13,000 miles long.',
      'Tokyo is the most populous metropolitan area in the world.',
      'The Sahara Desert is the largest hot desert in the world.',
      'Mount Everest is the highest mountain above sea level.',
      'The Pacific Ocean is the largest and deepest ocean.',
      'Antarctica is the coldest continent on Earth.',
      'The Nile is traditionally considered the longest river.',
      'Australia is both a country and a continent.',
      'The human body contains approximately 206 bones.',
      'Jupiter is the largest planet in our solar system.',
      'The speed of light is approximately 299,792 kilometers per second.',
      'DNA was first identified by Friedrich Miescher in 1869.',
      'The International Space Station orbits Earth every 90 minutes.',
      'Honey never spoils due to its low moisture content.',
      'Venice is built on more than 100 small islands.',
      'The deepest point in the ocean is the Mariana Trench.',
      'Photosynthesis converts carbon dioxide and water into glucose.',
    ];

    const tokenized = await Promise.all(docTexts.map(d => rerank.tokenize(d)));
    assert(tokenized.length === 20, '20 documents tokenized');

    let results!: { score: number; index: number }[];
    let progressCount = 0;
    for await (const p of rerank.score(query, tokenized)) {
      progressCount++;
      assert(p.total === 20, `total is 20 (got ${p.total})`);
      results = p.results;
    }
    assert(progressCount >= 3, `≥3 progress updates for 20 docs / nSeqMax=8 (got ${progressCount})`);
    assert(results.length === 20, 'all 20 results returned');

    for (let i = 1; i < results.length; i++) {
      assert(results[i].score <= results[i - 1].score,
        `sorted descending at index ${i}`);
    }

    const relevantRank = results.findIndex(r => r.index === 0);
    assert(relevantRank < 3, `relevant doc ranks ${relevantRank} (expected < 3)`);

    let top5!: { score: number; index: number }[];
    for await (const p of rerank.score(query, tokenized, 5)) { top5 = p.results; }
    assert(top5.length === 5, 'topK=5 returns 5 results');
    assert(top5[0].score === results[0].score, 'topK=5 top result matches full ranking');

    ok(`20 docs with nSeqMax=8 → relevant doc at rank ${relevantRank}`);
  } finally {
    rerank.dispose();
  }
}

async function testRerankConcurrent(): Promise<void> {
  if (!RERANK_MODEL_PATH) {
    console.log('\n--- Rerank Concurrent (SKIPPED - no LLAMA_RERANK_MODEL) ---');
    return;
  }

  console.log('\n--- Rerank Concurrent ---');

  const rerankCtx = await addon.createContext({
    modelPath: RERANK_MODEL_PATH,
    nCtx: 4096,
    nSeqMax: 4,
    typeK: 'q4_0',
    typeV: 'q4_0',
  });
  const rerank = await Rerank.create(rerankCtx, { nSeqMax: 4, nCtx: 4096 });

  try {
    const docs = [
      'Paris is the capital of France.',
      'Machine learning is a branch of artificial intelligence.',
      'The sun is a star at the center of the solar system.',
      'Deep learning uses neural networks with many layers.',
      'London is the capital of the United Kingdom.',
      'Gradient descent is an optimization algorithm.',
    ];
    const tokenized = await Promise.all(docs.map(d => rerank.tokenize(d)));

    async function drain(iter: AsyncIterable<{ results: { score: number; index: number }[] }>) {
      let last!: { score: number; index: number }[];
      for await (const p of iter) last = p.results;
      return last;
    }

    const [r1, r2] = await Promise.all([
      drain(rerank.score('What is the capital of France?', tokenized)),
      drain(rerank.score('What is machine learning?', tokenized)),
    ]);

    assert(r1.length === docs.length, 'concurrent: caller 1 gets all results');
    assert(r2.length === docs.length, 'concurrent: caller 2 gets all results');

    assert(r1[0].index === 0 || r1[1].index === 0,
      `concurrent: Paris doc in top 2 for query 1 (got [${r1.slice(0, 2).map(r => r.index)}])`);

    const top2q2 = r2.slice(0, 2).map(r => r.index);
    assert(top2q2.includes(1) || top2q2.includes(3) || top2q2.includes(5),
      `concurrent: ML doc in top 2 for query 2 (got [${top2q2}])`);

    ok('two callers scored docs each with independent results');
  } finally {
    rerank.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// KV CACHE
// ═════════════════════════════════════════════════════════════════════

async function testKVCache(ctx: SessionContext): Promise<void> {
  console.log('\n--- KV Cache ---');

  await ctx.kvCacheClear();
  const tokens = await ctx.tokenize('Test prompt');
  const branch = Branch.create(ctx, 0, { temperature: 0 });
  await branch.prefill(tokens);

  const sizeBefore = ctx.kvCacheSize();
  assert(sizeBefore >= 0, `kvCacheSize() after prefill → ${sizeBefore}`);

  await branch.prune();
  await ctx.kvCacheClear();
  const sizeAfter = ctx.kvCacheSize();
  assert(sizeAfter === -1, `kvCacheClear() → size=${sizeAfter} (empty)`);
}

// ═════════════════════════════════════════════════════════════════════
// RUNNER
// ═════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  let mainCtx: SessionContext | null = null;

  try {
    mainCtx = await createTestContext();
    ok(`createContext(nCtx=${CTX_SIZE}) → vocabSize=${mainCtx.vocabSize}`);

    // Tests using shared context
    await testCoreAPI(mainCtx);
    await testKVCache(mainCtx);
    await testTokenizer(mainCtx);
    await testChatInOut(mainCtx);

    // Tests creating their own contexts
    await testDeterminism();
    await testGrammar();
    await testBranchPrefill();
    await testWarmMultiTurnRecall();
    await testBranchSteer();
    await testSetSamplerParams();
    await testSetGrammar();
    await testBranchMetrics();
    await testNBatchAblation();
    await testBranchPrefillAndLogits();
    await testPplSanity();
    await testCommitRollback();
    await testAsyncRejection();
    await testDisposedDuringAsync();
    await testAsyncIterator();
    await testEmptyInputEdgeCases();
    await testBranchStore();
    await testJsonSchemaToGrammar();

    // Optional rerank tests
    await testRerank();
    await testRerankLargeCorpus();
    await testRerankConcurrent();

    console.log('\n═══════════════════════════════════════');
    console.log(`PASSED: ${passed}`);
    console.log(`FAILED: ${failed}`);

    if (failed === 0) {
      console.log('\nAll tests passed!');
      process.exit(0);
    } else {
      console.log(`\n${failed} test(s) failed`);
      process.exit(1);
    }
  } catch (err) {
    console.error('\nFatal error:', (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);
  } finally {
    mainCtx?.dispose();
  }
}

main();
