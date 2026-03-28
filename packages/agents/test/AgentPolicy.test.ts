import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, defaultToolGuards } from '../src/AgentPolicy';
import type { PolicyConfig } from '../src/AgentPolicy';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

const FMT = {
  format: 0, reasoningFormat: 0, thinkingForcedOpen: false,
  parser: '', grammar: '', grammarLazy: false, grammarTriggers: [],
};

const BASE_CONFIG: PolicyConfig = { maxTurns: 20, terminalTool: 'report', hasNonTerminalTools: true };

function makeAgent(overrides?: { toolCallCount?: number; turns?: number; nudged?: boolean; toolHistory?: Array<{ name: string; args: string }> }) {
  const branch = createMockBranch();
  const a = new Agent({ id: 1, parentId: 0, branch: branch as any, fmt: FMT });
  a.transition('active');
  for (let i = 0; i < (overrides?.toolCallCount ?? 0); i++) a.incrementToolCalls();
  for (let i = 0; i < (overrides?.turns ?? 0); i++) a.incrementTurns();
  if (overrides?.nudged) a.markNudged();
  for (const h of overrides?.toolHistory ?? []) {
    a.recordToolResult({ name: h.name, args: h.args, resultTokenCount: 100, contextAfterPercent: 80, timestamp: 0 });
  }
  return a;
}

function pressure(remaining = 5000, nCtx = 16384) {
  return { headroom: remaining - 1024, critical: remaining < 128, remaining, nCtx, cellsUsed: nCtx - remaining };
}

describe('DefaultAgentPolicy', () => {
  const policy = new DefaultAgentPolicy();

  describe('onProduced — no tool call', () => {
    it('returns free_text_report when agent has findings-worthy output', () => {
      const a = makeAgent({ toolCallCount: 2 });
      const action = policy.onProduced(a, { content: 'some text', toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('free_text_report');
    });

    it('returns idle when nothing to capture', () => {
      const a = makeAgent();
      const action = policy.onProduced(a, { content: null, toolCalls: [] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('idle');
    });
  });

  describe('onProduced — terminal tool', () => {
    it('extracts findings from report', () => {
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'my result' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action).toEqual({ type: 'report', result: 'my result' });
    });

    it('nudges premature report (< 2 tool calls)', () => {
      const a = makeAgent({ toolCallCount: 1 });
      const tc = { name: 'report', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('bypasses nudge for previously nudged agents', () => {
      const a = makeAgent({ toolCallCount: 1, nudged: true });
      const tc = { name: 'report', arguments: JSON.stringify({ result: 'r' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('report');
    });
  });

  describe('onProduced — over budget', () => {
    it('nudges on first offense', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 25 });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('kills on second offense (already nudged)', () => {
      const a = makeAgent({ toolCallCount: 3, turns: 25, nudged: true });
      const tc = { name: 'web_search', arguments: '{}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('idle');
    });
  });

  describe('tool guards', () => {
    it('rejects fetch_page with duplicate URL in lineage', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: 'https://example.com' }],
      });
      const tc = { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://example.com' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('allows fetch_page with new URL', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: 'https://other.com' }],
      });
      const tc = { name: 'fetch_page', arguments: JSON.stringify({ url: 'https://example.com' }), id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });

    it('rejects web_research when agent has no local search', () => {
      const a = makeAgent({
        toolCallCount: 2,
        toolHistory: [{ name: 'fetch_page', args: 'url' }],
      });
      const tc = { name: 'web_research', arguments: '{"questions":["q"]}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('allows web_research when agent has local search AND fetch', () => {
      const a = makeAgent({
        toolCallCount: 3,
        toolHistory: [
          { name: 'web_search', args: 'query' },
          { name: 'fetch_page', args: 'url' },
        ],
      });
      const tc = { name: 'web_research', arguments: '{"questions":["q"]}', id: 'c1' };
      const action = policy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('tool_call');
    });

    it('rejects web_research even when PARENT has search+fetch (local history only)', () => {
      const parent = makeAgent({
        toolCallCount: 3,
        toolHistory: [
          { name: 'web_search', args: 'parent query' },
          { name: 'fetch_page', args: 'parent url' },
        ],
      });
      const child = new Agent({
        id: 2, parentId: 1,
        branch: createMockBranch({ handle: 2 }) as any,
        fmt: FMT,
        parent,
      });
      child.transition('active');
      child.incrementToolCalls();
      child.incrementToolCalls();

      const tc = { name: 'web_research', arguments: '{"questions":["q"]}', id: 'c1' };
      const action = policy.onProduced(child, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toContain('fetch_page');
    });
  });

  describe('custom opts', () => {
    it('respects custom minToolCallsBeforeReport', () => {
      const customPolicy = new DefaultAgentPolicy({ minToolCallsBeforeReport: 5 });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'report', arguments: '{"findings":"f"}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
    });

    it('replaces guards with custom guards', () => {
      const customGuard = {
        tools: ['any_tool'],
        reject: () => true,
        message: 'custom rejection',
      };
      const customPolicy = new DefaultAgentPolicy({ guards: [customGuard] });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'any_tool', arguments: '{}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toBe('custom rejection');
    });

    it('appends extraGuards to defaults', () => {
      const extra = {
        tools: ['custom_tool'],
        reject: () => true,
        message: 'extra guard fired',
      };
      const customPolicy = new DefaultAgentPolicy({ extraGuards: [extra] });
      const a = makeAgent({ toolCallCount: 3 });
      const tc = { name: 'custom_tool', arguments: '{}', id: 'c1' };
      const action = customPolicy.onProduced(a, { content: null, toolCalls: [tc] }, pressure(), BASE_CONFIG);
      expect(action.type).toBe('nudge');
      expect((action as any).message).toBe('extra guard fired');
    });
  });
});
