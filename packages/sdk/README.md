# @lloyal-labs/sdk

Backend-agnostic inference primitives for the [lloyal HDK](https://github.com/lloyal-ai/hdk).

Composable inference primitives for forkable decode state, shared-prefix KV branching, and continuous tree batching. Branches share a KV prefix while keeping independent machinery — sampler chain, grammar, logits snapshot, perplexity tracker — for controlled divergence at decode time. `BranchStore` packs tokens from N branches (each at a different position, different seq_id, each needing independent logits captured) into a single `llama_batch` and dispatches once.

```bash
npm i @lloyal-labs/sdk
```

The SDK exports the `SessionContext` contract and the primitives that operate on it. A backend binding (e.g. [`@lloyal-labs/lloyal.node`](https://github.com/lloyal-ai/lloyal.node) for Node) provides `createContext()` — the SDK takes it from there. Underneath, [liblloyal](https://github.com/lloyal-ai/liblloyal) is the C++ core; the Node binding is one front-end on top of it.

## The Branch API

```typescript
import { createContext } from '@lloyal-labs/lloyal.node';
import { Branch, BranchStore } from '@lloyal-labs/sdk';

const ctx = await createContext({ modelPath: './model.gguf', nSeqMax: 6 });
const store = new BranchStore(ctx);

// Shared prompt: "Explain quantum entanglement"
const prompt = await ctx.tokenize('Explain quantum entanglement');

const root = Branch.create(ctx, 0, { temperature: 0.8 });
await root.prefill(prompt);

// Fork 4 branches — each gets a different reasoning prefix
const analogy  = await root.fork();
const formal   = await root.fork();
const socratic = await root.fork();
const visual   = await root.fork();

// Scatter-prefill: inject divergent prefixes in one batched dispatch
// 4 branches × variable lengths → auto bin-packed into minimal GPU calls
await store.prefill([
  [analogy,  await ctx.tokenize('Think of it like two coins...')],    // 12 tokens
  [formal,   await ctx.tokenize('In quantum mechanics, the...')],     // 8 tokens
  [socratic, await ctx.tokenize('What happens when you measure...')], // 10 tokens
  [visual,   await ctx.tokenize('Imagine two particles...')],         // 7 tokens
]);

// Generate — all 4 in lockstep, 1 GPU call per step
const branches = [analogy, formal, socratic, visual];
for (;;) {
  const live = branches.filter(b => !b.disposed);
  if (!live.length) break;

  const entries: [Branch, number][] = [];
  for (const b of live) {
    const { token, text, isStop } = b.produceSync();
    if (isStop) { b.pruneSync(); continue; }
    entries.push([b, token]);
  }
  if (!entries.length) break;
  await store.commit(entries);
}

// Winner takes all — one seq_keep pass, losers vaporized
const winner = branches
  .filter(b => !b.disposed)
  .reduce((a, b) => (a.perplexity < b.perplexity ? a : b));
await store.retainOnly(winner);
```

Or for single-branch generation, Branch is an async iterable — generate until EOG:

```typescript
for await (const { token, text } of branch) {
  process.stdout.write(text);
}
```

## Continuous Tree Batching

Tree search with N branches means N calls to `llama_decode()` — each paying GPU dispatch overhead, memory barriers, and PCIe round-trips. `BranchStore` eliminates this: tokens from N branches are packed into a single `llama_batch` and dispatched once. N branches, 1 GPU call.

Two packing strategies for different access patterns:

```typescript
// commit: 1 token per branch — one GPU dispatch for N branches
await store.commit([[branch1, tok1], [branch2, tok2], [branch3, tok3]]);

// prefill: variable tokens per branch — asymmetric injection
await store.prefill([
  [branchA, systemTokens],  // 200 tokens
  [branchB, queryTokens],   //  12 tokens
  [branchC, docTokens],     // 800 tokens
]);
// Greedy bin-packed into ceil(total / nBatch) dispatches
```

## Topology

Parent/child edges are always-on. Simple chat to best-of-N to deep search is one continuum.

```typescript
branch.parent;       // handle or null if root
branch.children;     // child handles
branch.isLeaf;       // no children?
```

| Method | Behavior |
|--------|----------|
| `pruneSync()` | Throws if children exist |
| `pruneSubtreeSync()` | Iterative post-order traversal |

## Per-Token Metrics

Every branch exposes runtime-accessible information-theoretic measures on every step:

```typescript
branch.modelEntropy();        // Shannon entropy of full vocab distribution (bits)
branch.modelSurprisal(token); // -log2(p) for a specific token
branch.perplexity;            // model-level PPL (exp of mean NLL from raw logits)
branch.samplingPerplexity;    // sampling-level PPL (from filtered distribution)
```

## Session

`Session` manages the conversation trunk — the single promoted branch that accumulates verified context across queries.

```typescript
const session = new Session({ ctx, store });

// High-level: extend the trunk with a new query–answer pair
await session.commitTurn('What is quantum entanglement?', answer);

// Lower-level building blocks (for harnesses that orchestrate trunk lifecycle directly)
await session.prefillUser('What is quantum entanglement?');
await session.promote(verifiedBranch);

// Next query starts from the promoted trunk's KV state
session.trunk;  // the live branch
```

`commitTurn` is the recommended high-level helper. Future queries fork from `session.trunk` and read prior conversation through KV attention — no prompt-history injection.

## Rerank

Backend-agnostic reranker. The caller provides a `SessionContext` — how it was created (local, remote, quantized) is not the SDK's concern.

```typescript
import { Rerank } from '@lloyal-labs/sdk';

const reranker = await Rerank.create(ctx, { nSeqMax: 8 });
const scores = await reranker.rank(query, documents);
```

## Exports

```typescript
// Classes
export { Branch, BranchStore, Session, Rerank };

// Delta builders (for tool result injection)
export { buildUserDelta, buildToolResultDelta };

// Types
export type { SessionContext, SamplingParams, Produced, ContextOptions, ... };
```

## License

Apache-2.0
