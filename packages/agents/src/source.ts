import type { Operation } from 'effection';
import type { Tool } from './Tool';

/**
 * Entailment scorer — scores texts against an original query to
 * maintain semantic coherence across recursive agent pipelines.
 *
 * Created per invocation via {@link Source.createScorer}.
 * Immutable once created — safe to share across concurrent pools.
 *
 * ## Three queries in play
 *
 * | Concept            | Scope                    | Field name in code                        |
 * |--------------------|--------------------------|-------------------------------------------|
 * | **Tool query**     | Per tool call            | `localQuery` param of scoreRelevanceBatch |
 * | **Agent task**     | Per agent lifetime       | `reference` param of scoreSimilarityBatch |
 * | **Original query** | Per research invocation  | Captured in closure by createScorer       |
 *
 * - `scoreEntailmentBatch` scores against the **original query** (steering boundaries)
 * - `scoreRelevanceBatch` combines **tool query** + **original query** via min() (exploit mode)
 * - `scoreSimilarityBatch` scores against an arbitrary **reference** (echo detection uses agent task)
 *
 * Conflating these produces wrong scores. When adding new scoring
 * methods or trace events, use the field names from this table.
 *
 * @category Agents
 */
export interface EntailmentScorer {
  /** Score texts against the original query. Returns 0–1 per text. */
  scoreEntailmentBatch(texts: string[]): Promise<number[]>;
  /**
   * Dual scoring: min(tool query score, original query score) per text.
   * Used in exploit mode at content boundaries to tighten focus.
   * @param texts - Content chunks to score
   * @param localQuery - The tool call's query argument (NOT the agent task)
   */
  scoreRelevanceBatch(texts: string[], localQuery: string): Promise<number[]>;
  /** Score texts against an arbitrary reference string. Returns 0–1 per text. */
  scoreSimilarityBatch(reference: string, texts: string[]): Promise<number[]>;
  /** Threshold gate — returns true if the score is high enough to proceed. */
  shouldProceed(score: number): boolean;
}

/** No-op scorer — all scores 1.0, all proceed. Used when no reranker is available. */
export const NULL_SCORER: EntailmentScorer = {
  scoreEntailmentBatch: async (texts) => texts.map(() => 1),
  scoreRelevanceBatch: async (texts) => texts.map(() => 1),
  scoreSimilarityBatch: async (_ref, texts) => texts.map(() => 0),
  shouldProceed: () => true,
};

/**
 * Reranker interface required by {@link Source.createScorer}.
 *
 * Duplicated here to avoid a circular dependency between agents and rig.
 * Any object with a `scoreBatch` method satisfies this contract.
 */
export interface ScorerReranker {
  scoreBatch(query: string, texts: string[]): Promise<number[]>;
}

/**
 * Abstract base class for data sources
 *
 * A source is a named collection of data access tools with a bind
 * lifecycle and an entailment scoring factory. It does not orchestrate
 * agents — that is the harness's job via {@link spawnAgents}.
 *
 * @typeParam TCtx - Runtime context passed to {@link bind} (e.g. reranker)
 * @typeParam TChunk - Chunk type returned by {@link getChunks} for post-use reranking
 *
 * @category Agents
 */
export abstract class Source<TCtx = unknown, TChunk = unknown> {
  /** Human-readable source name (e.g. 'web', 'corpus') for labeling output */
  abstract readonly name: string;
  /** Data access tools provided by this source */
  abstract get tools(): Tool[];

  /** Reranker instance, set during {@link bind}. Used by {@link createScorer}. */
  protected _reranker: ScorerReranker | null = null;
  /** Minimum entailment score for delegation to proceed. */
  protected _entailmentFloor: number = 0.25;

  /**
   * Create an immutable entailment scorer scoped to one invocation.
   *
   * The returned scorer captures `originalQuery` in a closure — no mutable
   * state on Source. Safe to use across concurrent pools within the same
   * research run.
   *
   * @param originalQuery - The root query from the harness
   */
  createScorer(originalQuery: string): EntailmentScorer {
    const reranker = this._reranker;
    if (!reranker || !originalQuery) return NULL_SCORER;

    const floor = this._entailmentFloor;
    const combine = (local: number, orig: number) => Math.min(local, orig);

    return {
      async scoreEntailmentBatch(texts: string[]): Promise<number[]> {
        return reranker.scoreBatch(originalQuery, texts);
      },
      async scoreRelevanceBatch(texts: string[], localQuery: string): Promise<number[]> {
        // SEQUENTIAL — single llama_context, no concurrent scoreBatch calls
        const origScores = await reranker.scoreBatch(originalQuery, texts);
        const localScores = await reranker.scoreBatch(localQuery, texts);
        return texts.map((_, i) => combine(localScores[i], origScores[i]));
      },
      async scoreSimilarityBatch(reference: string, texts: string[]): Promise<number[]> {
        return reranker.scoreBatch(reference, texts);
      },
      shouldProceed(score: number): boolean {
        return score >= floor;
      },
    };
  }

  /** Late-bind runtime deps not available at construction. Called before tools are used. */
  *bind(_ctx: TCtx): Operation<void> {}
  /** Post-use chunks for reranking. Called after agents have used the tools. */
  getChunks(): TChunk[] { return []; }
}
