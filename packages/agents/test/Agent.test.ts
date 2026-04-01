import { describe, it, expect } from 'vitest';
import { Agent } from '../src/Agent';
import { createMockBranch } from './helpers/mock-branch';

const FMT = {
  format: 0, reasoningFormat: 0, thinkingForcedOpen: false,
  parser: '', grammar: '', grammarLazy: false, grammarTriggers: [],
};

function makeAgent(opts?: { parent?: Agent; id?: number }) {
  const branch = createMockBranch({ handle: opts?.id ?? 1 });
  return new Agent({
    id: opts?.id ?? 1,
    parentId: 0,
    branch: branch as any,
    fmt: FMT,
    parent: opts?.parent ?? null,
  });
}

describe('Agent', () => {
  describe('status transitions', () => {
    it('allows idle → active', () => {
      const a = makeAgent();
      a.transition('active');
      expect(a.status).toBe('active');
    });

    it('allows active → awaiting_tool', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      expect(a.status).toBe('awaiting_tool');
    });

    it('allows active → idle', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('idle');
      expect(a.status).toBe('idle');
    });

    it('allows awaiting_tool → active', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      a.transition('active');
      expect(a.status).toBe('active');
    });

    it('allows awaiting_tool → idle', () => {
      const a = makeAgent();
      a.transition('active');
      a.transition('awaiting_tool');
      a.transition('idle');
      expect(a.status).toBe('idle');
    });

    it('allows idle → disposed', () => {
      const a = makeAgent();
      a.transition('disposed');
      expect(a.status).toBe('disposed');
    });

    it('rejects idle → awaiting_tool', () => {
      const a = makeAgent();
      expect(() => a.transition('awaiting_tool')).toThrow('Invalid agent status transition');
    });

    it('rejects disposed → active', () => {
      const a = makeAgent();
      a.dispose();
      expect(() => a.transition('active')).toThrow('Invalid agent status transition');
    });
  });

  describe('token accounting', () => {
    it('accumulates tokens', () => {
      const a = makeAgent();
      a.accumulateToken('hello');
      a.accumulateToken(' world');
      expect(a.rawOutput).toBe('hello world');
      expect(a.tokenCount).toBe(2);
    });

    it('resets turn output', () => {
      const a = makeAgent();
      a.accumulateToken('hello');
      a.resetTurn();
      expect(a.rawOutput).toBe('');
    });

    it('increments tool calls and turns', () => {
      const a = makeAgent();
      a.incrementToolCalls();
      a.incrementToolCalls();
      a.incrementTurns();
      expect(a.toolCallCount).toBe(2);
      expect(a.turns).toBe(1);
    });

  });

  describe('findings', () => {
    it('reports findings with provenance', () => {
      const a = makeAgent();
      a.reportResult('found something', 'report_tool');
      expect(a.result).toBe('found something');
      expect(a.resultSource).toBe('report_tool');
    });

    it('overwrites on second report', () => {
      const a = makeAgent();
      a.reportResult('first', 'report_tool');
      a.reportResult('second', 'scratchpad');
      expect(a.result).toBe('second');
      expect(a.resultSource).toBe('scratchpad');
    });
  });

  describe('nestedResults', () => {
    it('starts empty', () => {
      const a = makeAgent();
      expect(a.nestedResults).toEqual([]);
    });

    it('accumulates across addNestedResults calls', () => {
      const a = makeAgent();
      a.addNestedResults(['a', 'b']);
      a.addNestedResults(['c']);
      expect([...a.nestedResults]).toEqual(['a', 'b', 'c']);
    });
  });

  describe('tool history', () => {
    it('records tool results', () => {
      const a = makeAgent();
      a.recordToolResult({
        name: 'web_search', args: 'test query',
        resultTokenCount: 100, contextAfterPercent: 80, timestamp: 0,
      });
      expect(a.toolHistory).toHaveLength(1);
      expect(a.toolHistory[0].name).toBe('web_search');
    });
  });

  describe('walkAncestors', () => {
    it('returns own data when no parent', () => {
      const a = makeAgent();
      a.recordToolResult({ name: 'search', args: 'q', resultTokenCount: 0, contextAfterPercent: 100, timestamp: 0 });
      const result = a.walkAncestors((agent) => agent.toolHistory);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('search');
    });

    it('traverses self → parent → grandparent', () => {
      const grandparent = makeAgent({ id: 1 });
      grandparent.recordToolResult({ name: 'gp', args: '', resultTokenCount: 0, contextAfterPercent: 100, timestamp: 0 });

      const parent = makeAgent({ id: 2, parent: grandparent });
      parent.recordToolResult({ name: 'p', args: '', resultTokenCount: 0, contextAfterPercent: 100, timestamp: 0 });

      const child = makeAgent({ id: 3, parent });
      child.recordToolResult({ name: 'c', args: '', resultTokenCount: 0, contextAfterPercent: 100, timestamp: 0 });

      const names = child.walkAncestors((a) => a.toolHistory).map((h) => h.name);
      expect(names).toEqual(['c', 'p', 'gp']);
    });
  });

  describe('branch-derived readings', () => {
    it('exposes position and forkHead', () => {
      const branch = createMockBranch({ position: 500, forkHead: 200 });
      const a = new Agent({ id: 1, parentId: 0, branch: branch as any, fmt: FMT });
      expect(a.position).toBe(500);
      expect(a.forkHead).toBe(200);
      expect(a.uniqueCells).toBe(300);
    });
  });
});
