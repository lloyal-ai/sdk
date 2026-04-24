/**
 * UI → main.ts command boundary.
 *
 * The Ink component tree dispatches commands through the `useCommand`
 * hook; main.ts drains them from an Effection Signal and runs the
 * corresponding Operation (runPlanner, runResearch, saveConfig, ...).
 *
 * Keep the union small and explicit. No generic "send arbitrary event"
 * escape hatch — that's what makes the UI <-> harness boundary auditable.
 */

export type Command =
  | { type: 'submit_query'; query: string; mode: 'flat' | 'deep' }
  | { type: 'submit_clarification'; answer: string }
  | { type: 'accept_plan' }
  | { type: 'cancel_plan' }
  | { type: 'edit_plan'; query: string }
  | { type: 'change_mode'; mode: 'flat' | 'deep' }
  | { type: 'set_tavily_key'; key: string }
  | { type: 'set_corpus_path'; path: string }
  | { type: 'quit' };
