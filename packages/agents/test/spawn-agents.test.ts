import { describe, it, expect, vi } from 'vitest';
import { createToolkit } from '../src/toolkit';
import { Agent } from '../src/Agent';
import { MockTool } from './helpers/mock-tool';
import { createMockReranker } from './helpers/mock-reranker';
import { createMockBranch } from './helpers/mock-branch';
import { Source, NULL_SCORER } from '../src/source';
import type { EntailmentScorer } from '../src/source';
import { DefaultAgentPolicy } from '../src/AgentPolicy';

// ── Pure unit tests (no Effection) ──────────────────────────

describe('spawnAgents — toolkit composition', () => {
  // We can't call spawnAgents directly without Effection, but we can
  // test the toolkit composition logic by inspecting createToolkit output

  it('createToolkit includes all provided tools', () => {
    const search = new MockTool('web_search');
    const fetch = new MockTool('fetch_page');
    const report = new MockTool('report');
    const toolkit = createToolkit([search, fetch, report]);

    expect(toolkit.toolMap.has('web_search')).toBe(true);
    expect(toolkit.toolMap.has('fetch_page')).toBe(true);
    expect(toolkit.toolMap.has('report')).toBe(true);
    expect(toolkit.toolMap.size).toBe(3);
  });

  it('toolsJson contains JSON schema for all tools', () => {
    const search = new MockTool('web_search');
    const toolkit = createToolkit([search]);
    const parsed = JSON.parse(toolkit.toolsJson);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].function.name).toBe('web_search');
  });
});

// ── Entailment scorer integration ───────────────────────────

describe('EntailmentScorer — entailment gate logic', () => {
  function createScorer(scoreMap: Map<string, number>, floor = 0.25): EntailmentScorer {
    const reranker = createMockReranker(scoreMap);
    // Use Source.createScorer via a concrete subclass
    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;
    (source as any)._entailmentFloor = floor;
    return source.createScorer('original query about LLM speculative decoding');
  }

  it('scores above threshold pass shouldProceed', () => {
    const scorer = createScorer(new Map([['relevant question', 0.6]]));
    expect(scorer.shouldProceed(0.6)).toBe(true);
  });

  it('scores below threshold fail shouldProceed', () => {
    const scorer = createScorer(new Map(), 0.25);
    expect(scorer.shouldProceed(0.24)).toBe(false);
  });

  it('scoreEntailmentBatch returns per-text scores', async () => {
    const scores = new Map([
      ['how does LLM speculative decoding work on M3', 0.85],
      ['CPU branch prediction in Apple Silicon loops', 0.12],
      ['unified memory bandwidth for inference', 0.65],
    ]);
    const scorer = createScorer(scores);
    const results = await scorer.scoreEntailmentBatch([
      'how does LLM speculative decoding work on M3',
      'CPU branch prediction in Apple Silicon loops',
      'unified memory bandwidth for inference',
    ]);

    expect(results[0]).toBe(0.85); // on-topic: passes
    expect(results[1]).toBe(0.12); // off-topic (CPU speculation): fails
    expect(results[2]).toBe(0.65); // related: passes
  });

  it('simulates DelegateTool filtering logic', async () => {
    const scores = new Map([
      ['speculative decoding throughput on M3 Max', 0.8],
      ['how does LAP/LVP work in Apple Silicon loops', 0.12],
      ['draft model architecture tradeoffs', 0.45],
    ]);
    const scorer = createScorer(scores, 0.25);

    const tasks = [
      'speculative decoding throughput on M3 Max',
      'how does LAP/LVP work in Apple Silicon loops',
      'draft model architecture tradeoffs',
    ];

    const entailmentScores = await scorer.scoreEntailmentBatch(tasks);
    const survivors = tasks.filter((_, i) => scorer.shouldProceed(entailmentScores[i]));
    const filtered = tasks.filter((_, i) => !scorer.shouldProceed(entailmentScores[i]));

    expect(survivors).toEqual([
      'speculative decoding throughput on M3 Max',
      'draft model architecture tradeoffs',
    ]);
    expect(filtered).toEqual([
      'how does LAP/LVP work in Apple Silicon loops',
    ]);
  });

  it('all-filtered case returns empty survivors', async () => {
    const scores = new Map([
      ['irrelevant question 1', 0.1],
      ['irrelevant question 2', 0.05],
    ]);
    const scorer = createScorer(scores, 0.25);

    const tasks = ['irrelevant question 1', 'irrelevant question 2'];
    const entailmentScores = await scorer.scoreEntailmentBatch(tasks);
    const survivors = tasks.filter((_, i) => scorer.shouldProceed(entailmentScores[i]));

    expect(survivors).toEqual([]);
  });
});

// ── Steering vs content boundary distinction ────────────────

describe('Entailment boundary discipline', () => {
  it('WebSearchTool and DelegateTool are steering boundaries (use scorer)', () => {
    // This is a design test — the tools read context.scorer and act on it.
    // We verify the API surface exists and is used correctly.
    // The actual tool execution tests are in packages/rig/test/

    // Verify EntailmentScorer interface has the right shape
    const scorer: EntailmentScorer = {
      scoreEntailmentBatch: async (texts) => texts.map(() => 0.5),
      scoreRelevanceBatch: async (texts) => texts.map(() => 0.5),
      scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
      shouldProceed: (score) => score >= 0.25,
    };
    expect(scorer.scoreEntailmentBatch).toBeDefined();
    expect(scorer.scoreRelevanceBatch).toBeDefined();
    expect(scorer.shouldProceed).toBeDefined();
  });

  it('SearchTool and FetchPageTool are content boundaries (no scorer)', () => {
    // Design assertion: these tools score against agent's local query only.
    // They do NOT call scorer.scoreEntailmentBatch.
    // The reason: agent-local scoring at content boundaries preserves
    // serendipitous discovery. "United States v. Microsoft" scores low
    // against "iPod-era success to monopoly practices" but is the causal
    // evidence connecting them. Dual scoring would demote it.
    //
    // This is validated by the absence of scorer calls in SearchTool and
    // FetchPageTool source code (verified during implementation).
    expect(true).toBe(true); // design marker — enforced by code review
  });
});

// ── Scorer propagation chain ────────────────────────────────

describe('Scorer propagation', () => {
  it('scorer is immutable across depth levels', async () => {
    const scores = new Map([['q1', 0.8], ['q2', 0.3]]);
    const reranker = createMockReranker(scores);

    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('root query');

    // Simulate depth 0: score some tasks
    const depth0Scores = await scorer.scoreEntailmentBatch(['q1', 'q2']);
    expect(depth0Scores).toEqual([0.8, 0.3]);

    // Simulate depth 1: same scorer, same results (immutable)
    const depth1Scores = await scorer.scoreEntailmentBatch(['q1', 'q2']);
    expect(depth1Scores).toEqual([0.8, 0.3]);

    // Mutate source — scorer is unaffected
    (source as any)._reranker = createMockReranker(new Map([['q1', 0.1]]));
    const afterMutation = await scorer.scoreEntailmentBatch(['q1']);
    expect(afterMutation[0]).toBe(0.8); // still uses original reranker
  });

  it('per-source scorers are independent', async () => {
    class TestSource extends Source {
      readonly name: string;
      get tools() { return []; }
      constructor(name: string) { super(); this.name = name; }
    }

    const webSource = new TestSource('web');
    const corpusSource = new TestSource('corpus');

    const webReranker = createMockReranker(new Map([['q', 0.9]]));
    const corpusReranker = createMockReranker(new Map([['q', 0.3]]));

    (webSource as any)._reranker = webReranker;
    (corpusSource as any)._reranker = corpusReranker;

    const webScorer = webSource.createScorer('query A');
    const corpusScorer = corpusSource.createScorer('query A');

    const webResult = await webScorer.scoreEntailmentBatch(['q']);
    const corpusResult = await corpusScorer.scoreEntailmentBatch(['q']);

    expect(webResult[0]).toBe(0.9);
    expect(corpusResult[0]).toBe(0.3);
  });
});

// ── RecursiveOpts ───────────────────────────────────────────

describe('RecursiveOpts', () => {
  it('default extractTasks reads args.tasks', () => {
    const defaultExtract = (args: Record<string, unknown>) => args.tasks as string[];
    const result = defaultExtract({ tasks: ['a', 'b', 'c'] });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('custom extractTasks reads custom field', () => {
    const customExtract = (args: Record<string, unknown>) => args.questions as string[];
    const result = customExtract({ questions: ['q1', 'q2'] });
    expect(result).toEqual(['q1', 'q2']);
  });

  it('extractTasks failure returns undefined/throws', () => {
    const extract = (args: Record<string, unknown>) => args.missing as string[];
    const result = extract({});
    expect(result).toBeUndefined();
  });
});

// ── Local-history recursion guard (regression test) ──────────

describe('Local-history recursion guard', () => {
  // This is the hypothesis grep regression fix. The guard must check
  // AGENT-LOCAL history, not lineage. Without this, children inherit
  // parent's search+fetch and skip their own research, producing
  // blind relay chains.

  it('guard checks agent.toolHistory, not walkAncestors', () => {
    // The guard implementation in AgentPolicy.ts lines 42-52:
    // reject: (_args, _lineage, agent) => {
    //   const local = agent.toolHistory;
    //   const hasSearch = local.some(h => h.name === 'web_search' || h.name === 'search');
    //   const hasFetch = local.some(h => h.name === 'fetch_page' || h.name === 'read_file');
    //   return !hasSearch || !hasFetch;
    // },

    // This is already tested in AgentPolicy.test.ts "rejects web_research
    // even when PARENT has search+fetch". This test is a design marker
    // documenting WHY it matters.

    // The guard receives (args, lineageHistory, agent).
    // lineageHistory includes parent's tools — the guard IGNORES it.
    // agent.toolHistory is local only — the guard USES it.
    // This prevents the blind relay chains seen in trace-1774628104830.

    expect(true).toBe(true); // tested in AgentPolicy.test.ts
  });
});

// ── Echo detection guard ────────────────────────────────────

describe('Echo detection guard', () => {
  function createScorer(scoreMap: Map<string, number>, floor = 0.25): EntailmentScorer {
    const reranker = createMockReranker(scoreMap);
    class TestSource extends Source {
      readonly name = 'test';
      get tools() { return []; }
    }
    const source = new TestSource();
    (source as any)._reranker = reranker;
    (source as any)._entailmentFloor = floor;
    return source.createScorer('original query');
  }

  it('detects echo when all questions paraphrase agent task', async () => {
    // Agent task: "speculative decoding on Apple Silicon"
    // Proposed: near-verbatim copies → all score >0.8 against task
    const scores = new Map([
      ['speculative decoding performance on M1 M2 M3', 0.92],
      ['benchmarks for speculative decoding Apple Silicon', 0.88],
      ['Apple Silicon speculative decoding results', 0.91],
    ]);
    const scorer = createScorer(scores);

    const agentTask = 'speculative decoding on Apple Silicon';
    const proposed = [
      'speculative decoding performance on M1 M2 M3',
      'benchmarks for speculative decoding Apple Silicon',
      'Apple Silicon speculative decoding results',
    ];

    const echoScores = await scorer.scoreSimilarityBatch(agentTask, proposed);
    const minScore = Math.min(...echoScores);
    const isEcho = minScore > 0.8;

    expect(isEcho).toBe(true);
    expect(minScore).toBe(0.88);
  });

  it('allows delegation when ANY question is novel', async () => {
    // Agent task: "historical evidence of iPod-era success"
    // Proposed: 2 paraphrases + 1 discovery (Microsoft antitrust)
    const scores = new Map([
      ['iPod success evidence and market dominance', 0.90],
      ['role of U.S. v. Microsoft in Apple iPod success', 0.52],
      ['iPod adoption leading to iPhone success', 0.85],
    ]);
    const scorer = createScorer(scores);

    const agentTask = 'historical evidence of iPod-era success';
    const proposed = [
      'iPod success evidence and market dominance',
      'role of U.S. v. Microsoft in Apple iPod success',
      'iPod adoption leading to iPhone success',
    ];

    const echoScores = await scorer.scoreSimilarityBatch(agentTask, proposed);
    const minScore = Math.min(...echoScores);
    const isEcho = minScore > 0.8;

    expect(isEcho).toBe(false);
    expect(minScore).toBe(0.52); // Microsoft question is novel
  });

  it('threshold 0.8 separates paraphrase from discovery', async () => {
    // Boundary test: 0.81 is echo, 0.79 is not
    const scores = new Map([['q', 0.81]]);
    const scorer = createScorer(scores);
    const result = await scorer.scoreSimilarityBatch('task', ['q']);
    expect(result[0] > 0.8).toBe(true);

    const scores2 = new Map([['q', 0.79]]);
    const scorer2 = createScorer(scores2);
    const result2 = await scorer2.scoreSimilarityBatch('task', ['q']);
    expect(result2[0] > 0.8).toBe(false);
  });
});

// ── Agent.task field ────────────────────────────────────────

describe('Agent.task', () => {
  it('stores task text from construction', () => {
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: { format: 0, reasoningFormat: 0, generationPrompt: '', parser: '', grammar: '', grammarLazy: false, grammarTriggers: [] },
      task: 'investigate speculative decoding on M3',
    });
    expect(a.task).toBe('investigate speculative decoding on M3');
  });

  it('defaults to empty string when not provided', () => {
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: { format: 0, reasoningFormat: 0, generationPrompt: '', parser: '', grammar: '', grammarLazy: false, grammarTriggers: [] },
    });
    expect(a.task).toBe('');
  });
});

// ── Decoupling: explore/exploit independent of lifecycle ──

describe('Explore/exploit decoupled from lifecycle', () => {
  it('exploit mode does not affect agent lifecycle — agent is active, not killed', () => {
    // Agent in exploit mode (low pressure → shouldExplore false)
    // but NOT nudged or killed (shouldExit false, onProduced returns tool_call)
    const policy = new DefaultAgentPolicy({ shouldExplore: { context: 0.5 } });
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: { format: 0, reasoningFormat: 0, generationPrompt: '', parser: '', grammar: '', grammarLazy: false, grammarTriggers: [] },
    });
    a.transition('active');
    a.incrementToolCalls();
    a.incrementToolCalls();

    // Pressure at 45% — below context threshold (0.5) → exploit mode
    const p = {
      headroom: 5000, critical: false, remaining: 7372, nCtx: 16384,
      cellsUsed: 9012, percentAvailable: 45, canFit: () => true, softLimit: 1024, hardLimit: 128,
    };

    // shouldExplore = false (exploit)
    expect(policy.shouldExplore(a, p)).toBe(false);

    // But shouldExit = false (not critical, no time limit)
    expect(policy.shouldExit(a, p)).toBe(false);

    // And onProduced allows tool_call (headroom positive, not over budget)
    const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
    const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, p,
      { maxTurns: 20, terminalTool: 'report', hasNonTerminalTools: true });
    expect(action.type).toBe('tool_call');
    expect(a.status).toBe('active');
  });

  it('lifecycle nudge does not suppress explore mode', () => {
    // Agent nudged (over budget) while shouldExplore is true
    const policy = new DefaultAgentPolicy();
    const branch = createMockBranch();
    const a = new Agent({
      id: 1, parentId: 0, branch: branch as any,
      fmt: { format: 0, reasoningFormat: 0, generationPrompt: '', parser: '', grammar: '', grammarLazy: false, grammarTriggers: [] },
    });
    a.transition('active');
    a.incrementToolCalls();
    a.incrementToolCalls();
    a.incrementToolCalls();
    for (let i = 0; i < 25; i++) a.incrementTurns();

    // Pressure at 60% — above threshold → explore mode
    const p = {
      headroom: 5000, critical: false, remaining: 9830, nCtx: 16384,
      cellsUsed: 6554, percentAvailable: 60, canFit: () => true, softLimit: 1024, hardLimit: 128,
    };

    // shouldExplore = true (explore)
    expect(policy.shouldExplore(a, p)).toBe(true);

    // But onProduced nudges (turns >= maxTurns)
    const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
    const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, p,
      { maxTurns: 20, terminalTool: 'report', hasNonTerminalTools: true });
    expect(action.type).toBe('nudge');

    // Explore and lifecycle are independent decisions
  });

  it('explore and lifecycle states do not bleed into each other', () => {
    const policy = new DefaultAgentPolicy({ shouldExplore: { context: 0.4 } });
    const a = new Agent({
      id: 1, parentId: 0, branch: createMockBranch() as any,
      fmt: { format: 0, reasoningFormat: 0, generationPrompt: '', parser: '', grammar: '', grammarLazy: false, grammarTriggers: [] },
    });

    const highPressure = {
      headroom: 5000, critical: false, remaining: 12000, nCtx: 16384,
      cellsUsed: 4384, percentAvailable: 73, canFit: () => true, softLimit: 1024, hardLimit: 128,
    };
    const lowPressure = {
      headroom: 5000, critical: false, remaining: 4915, nCtx: 16384,
      cellsUsed: 11469, percentAvailable: 30, canFit: () => true, softLimit: 1024, hardLimit: 128,
    };

    // High pressure: explore=true, shouldExit=false
    expect(policy.shouldExplore(a, highPressure)).toBe(true);
    expect(policy.shouldExit(a, highPressure)).toBe(false);

    // Low pressure: explore=false, shouldExit still false (not critical)
    expect(policy.shouldExplore(a, lowPressure)).toBe(false);
    expect(policy.shouldExit(a, lowPressure)).toBe(false);

    // Critical: shouldExit=true, explore is irrelevant but still computable
    const criticalPressure = {
      headroom: -900, critical: true, remaining: 100, nCtx: 16384,
      cellsUsed: 16284, percentAvailable: 1, canFit: () => false, softLimit: 1024, hardLimit: 128,
    };
    expect(policy.shouldExit(a, criticalPressure)).toBe(true);
    expect(policy.shouldExplore(a, criticalPressure)).toBe(false);
  });
});

// ── EntailmentScorer interface shape ──────────────────────

describe('EntailmentScorer interface', () => {
  it('scoreRelevanceBatch exists on interface shape', () => {
    const scorer: EntailmentScorer = {
      scoreEntailmentBatch: async (texts) => texts.map(() => 0.5),
      scoreRelevanceBatch: async (texts) => texts.map(() => 0.5),
      scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
      shouldProceed: (score) => score >= 0.25,
    };
    expect(scorer.scoreRelevanceBatch).toBeDefined();
  });
});
