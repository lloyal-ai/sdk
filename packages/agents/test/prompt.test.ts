import { describe, it, expect } from 'vitest';
import { composePrompt, renderPrompt, renderTemplate } from '../src/prompt';
import type { PromptState, PromptStep } from '../src/prompt';
import { MockTool } from './helpers/mock-tool';

describe('composePrompt', () => {
  const base: PromptState = {
    clauses: ['You are a helper.'],
    sections: [{ heading: 'Notes', content: 'note 1' }],
    tools: [],
  };

  it('returns base unchanged with empty steps', () => {
    const result = composePrompt(base, []);
    expect(result).toEqual(base);
  });

  it('applies steps that add clauses', () => {
    const step: PromptStep = (s) => ({
      ...s,
      clauses: [...s.clauses, 'Be concise.'],
    });
    const result = composePrompt(base, [step]);
    expect(result.clauses).toEqual(['You are a helper.', 'Be concise.']);
  });

  it('applies conditional steps (no-op when condition false)', () => {
    const hasConflicts = false;
    const step: PromptStep = (s) => hasConflicts
      ? { ...s, clauses: [...s.clauses, 'Resolve conflicts.'] }
      : s;
    const result = composePrompt(base, [step]);
    expect(result.clauses).toEqual(['You are a helper.']);
  });

  it('composes multiple steps left-to-right', () => {
    const steps: PromptStep[] = [
      (s) => ({ ...s, clauses: [...s.clauses, 'step 1'] }),
      (s) => ({ ...s, clauses: [...s.clauses, 'step 2'] }),
      (s) => ({ ...s, sections: [...s.sections, { heading: 'Extra', content: 'data' }] }),
    ];
    const result = composePrompt(base, steps);
    expect(result.clauses).toEqual(['You are a helper.', 'step 1', 'step 2']);
    expect(result.sections).toHaveLength(2);
  });

  it('accumulates tools across steps', () => {
    const tool = new MockTool('search');
    const step: PromptStep = (s) => ({ ...s, tools: [...s.tools, tool] });
    const result = composePrompt(base, [step]);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('search');
  });
});

describe('renderPrompt', () => {
  it('joins clauses with double newline', () => {
    const state: PromptState = {
      clauses: ['Line 1', 'Line 2'],
      sections: [],
      tools: [],
    };
    const { system } = renderPrompt(state, 'Query?');
    expect(system).toBe('Line 1\n\nLine 2');
  });

  it('renders sections as heading + content', () => {
    const state: PromptState = {
      clauses: ['sys'],
      sections: [{ heading: 'Notes', content: 'my notes' }],
      tools: [],
    };
    const { content } = renderPrompt(state, 'Query?');
    expect(content).toContain('Notes:\n\nmy notes');
    expect(content).toContain('Query?');
  });

  it('separates sections with ---', () => {
    const state: PromptState = {
      clauses: ['sys'],
      sections: [
        { heading: 'A', content: 'a' },
        { heading: 'B', content: 'b' },
      ],
      tools: [],
    };
    const { content } = renderPrompt(state, 'Q');
    expect(content).toContain('---');
  });
});

describe('renderTemplate', () => {
  it('interpolates variables', () => {
    const result = renderTemplate('Hello <%= it.name %>', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('handles conditionals', () => {
    const tpl = '<% if (it.show) { %>visible<% } %>';
    expect(renderTemplate(tpl, { show: true })).toContain('visible');
    expect(renderTemplate(tpl, { show: false })).not.toContain('visible');
  });

  it('handles loops', () => {
    const tpl = '<% it.items.forEach(function(x) { %><%= x %> <% }) %>';
    const result = renderTemplate(tpl, { items: ['a', 'b', 'c'] });
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('does not auto-escape HTML', () => {
    const result = renderTemplate('<%= it.html %>', { html: '<b>bold</b>' });
    expect(result).toBe('<b>bold</b>');
  });
});
