import * as fc from 'fast-check';
import type { AgentScript } from './harness';

const STOP = 999;

/**
 * Agent emits one tool call and then stops. Used for property tests that
 * want deterministic "one tool call per agent" behavior.
 */
export const arbOneToolAgent = (toolName: string) => fc.record<AgentScript>({
  tokens: fc.constant([1, STOP]),
  toolCall: fc.record({
    name: fc.constant(toolName),
    arguments: fc.constant('{"query":"q"}'),
    id: fc.constant('c1'),
  }),
});

/**
 * Fixed-size parallel orchestration scripts — N identical agents, each
 * emitting a single tool call.
 */
export const arbParallelAgents = (toolName: string, minCount = 1, maxCount = 5) =>
  fc.integer({ min: minCount, max: maxCount })
    .chain(n => fc.array(arbOneToolAgent(toolName), { minLength: n, maxLength: n }));

/**
 * Tool-result token count: small, borderline-headroom, oversized.
 * Parameters chosen relative to harness default nCtx=16384, cellsUsed
 * configured per-test.
 */
export const arbResultSize = fc.oneof(
  fc.integer({ min: 10, max: 100 }),      // small — always fits
  fc.integer({ min: 800, max: 1200 }),    // borderline
  fc.integer({ min: 5000, max: 8000 }),   // oversized
);

/**
 * Initial cellsUsed knob for pressure scenarios. Paired with a fixed nCtx
 * (default 16384 in harness) to cover low / middle / high pressure.
 */
export const arbInitialPressure = fc.oneof(
  fc.integer({ min: 100, max: 2000 }),     // low pressure
  fc.integer({ min: 8000, max: 12000 }),   // middle pressure
  fc.integer({ min: 14000, max: 16000 }),  // high pressure (near full)
);
