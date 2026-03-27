import { Eta } from 'eta';
import type { Tool } from './Tool';

const eta = new Eta({ autoEscape: false });

/**
 * A named content section in a composed prompt.
 *
 * @category Agents
 */
export interface PromptSection {
  heading: string;
  content: string;
}

/**
 * Accumulated prompt state built by composing {@link PromptStep}s.
 *
 * - `clauses` — system prompt fragments (joined with double newline)
 * - `sections` — user content sections (each rendered as `heading:\n\ncontent`)
 * - `tools` — tools available to the agent (fed to {@link createToolkit})
 *
 * @category Agents
 */
export interface PromptState {
  clauses: string[];
  sections: PromptSection[];
  tools: Tool[];
}

/**
 * A pure function that transforms prompt state. Return the state
 * unchanged to skip, or return a new state with additional clauses,
 * sections, or tools. Steps are composed left-to-right via
 * {@link composePrompt}.
 *
 * @category Agents
 */
export type PromptStep = (state: PromptState) => PromptState;

/**
 * Reduce an array of {@link PromptStep}s over a base {@link PromptState}.
 *
 * Each step can conditionally add system clauses, user content sections,
 * or tools based on inference state. Steps that return the state unchanged
 * are no-ops.
 *
 * @category Agents
 */
export const composePrompt = (
  base: PromptState,
  steps: PromptStep[],
): PromptState => steps.reduce((s, fn) => fn(s), base);

/**
 * Render a {@link PromptState} into system and user content strings
 * suitable for `formatChatSync()`.
 *
 * @category Agents
 */
export const renderPrompt = (
  state: PromptState,
  query: string,
): { system: string; content: string } => ({
  system: state.clauses.join('\n\n'),
  content: [
    ...state.sections.map((s) => `${s.heading}:\n\n${s.content}`),
    query,
  ].join('\n\n---\n\n'),
});

/**
 * Render a template string with Eta. Templates use standard Eta/EJS
 * syntax: `<%= it.var %>` for interpolation, `<% if (it.x) { %>` for
 * conditionals, `<% it.arr.forEach(...) %>` for loops.
 *
 * Auto-escaping is disabled — templates produce prompt text, not HTML.
 *
 * @param template - Eta template string
 * @param data - Variables available as `it.*` in the template
 * @returns Rendered string
 *
 * @example
 * ```typescript
 * const result = renderTemplate(
 *   'Hello <%= it.name %><% if (it.age) { %>, age <%= it.age %><% } %>',
 *   { name: 'Alice', age: 30 },
 * );
 * // => "Hello Alice, age 30"
 * ```
 *
 * @category Agents
 */
export const renderTemplate = (
  template: string,
  data: Record<string, unknown>,
): string => eta.renderString(template, data);
