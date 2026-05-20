/**
 * Spine + per-spawn preamble assembly — RFC §5.3 / §5.3b.
 *
 * Two pure render functions. Both pull bytes from `contract.ts`
 * constants rather than inlining literals — the codified contract
 * (RFC §1.1–§1.4) has exactly one source of truth.
 *
 * ## `renderSpine`
 *
 * Assembles the Level-1 shared-prefix system prompt. **Carries no
 * free-form prose surface**: framework-owned literal strings +
 * grammar-sanitized app catalog metadata. No `supplementaryContent`
 * parameter, no per-app prose argument (RFC §3.2 M1, §5.3).
 *
 * Output structure (RFC §5.3):
 *
 * ```
 * <FRAMEWORK_INTRO>
 *
 * # Contracts
 *
 * <CATALOG_ENTRY for each app, in registration order>
 *
 * <TOOL_SELECTION_RULE>
 * ```
 *
 * App `examples.eta` content goes through `renderAgentPreamble` into
 * per-spawn preambles, never into this output (RFC §3.2 M1).
 *
 * ## `renderAgentPreamble`
 *
 * The *only* place the framework emits the boundary marker (RFC §1.1).
 * Called once per spawn with the assigned app's templates only — no
 * other app's `agent.eta` / `examples.eta` enters this rendering, which
 * is what makes per-spawn isolation a framework invariant rather than
 * a convention (RFC §3.2 M1).
 *
 * @packageDocumentation
 * @category Contract
 */

import { renderTemplate } from '@lloyal-labs/lloyal-agents';
import type {
  App,
  AgentRenderCtx,
  AgentTemplateFn,
  ExamplesRenderCtx,
  ExamplesTemplateFn,
} from '@lloyal-labs/lloyal-agents';
import {
  BOUNDARY_MARKER,
  CATALOG_ENTRY,
  FRAMEWORK_INTRO,
  TOOL_SELECTION_RULE,
} from './contract';

/**
 * Arguments for {@link renderSpine}. `apps` order is observable to
 * the model — catalog entries emit in registration order; harness
 * registration order is the input order here.
 */
export interface RenderSpineOptions {
  /**
   * Registered apps to compose into the catalog. Pass
   * `registry.installed()` from {@link AppRegistryCtx}, or any
   * subset/ordering the harness wants reflected in the spine.
   */
  apps: readonly App[];
}

/**
 * Render the shared-spine system prompt.
 *
 * The output has a fixed shape across pool sizes and pool composition
 * — the only variability is the per-app catalog block, sourced from
 * each app's `manifest.contract`. No app prose; no harness prose
 * (RFC §3.2 M1, §5.3).
 *
 * The returned string is intended for `SpineOptions.systemPrompt` in
 * `withSpine(...)`; tool schemas pass through `SpineOptions.tools =
 * apps.flatMap(a => a.tools)` separately and are decoded into KV at
 * spine prefill (RFC §2.1, §5.3 closing paragraph).
 */
export function renderSpine(opts: RenderSpineOptions): string {
  const catalogBlocks = opts.apps
    .map((app) =>
      CATALOG_ENTRY(
        app.manifest.contract.name,
        [...app.manifest.contract.tools],
        app.manifest.contract.useWhen,
      ),
    )
    .join('\n');

  return (
    FRAMEWORK_INTRO +
    '\n\n# Contracts\n\n' +
    catalogBlocks +
    '\n' +
    TOOL_SELECTION_RULE
  );
}

/**
 * Render the per-spawn preamble for a single agent assigned to
 * `app`. The framework calls this when constructing a spawn's
 * user-role message; the output is the *only* place the boundary
 * marker bytes (RFC §1.1) appear at runtime.
 *
 * Output (RFC §5.3b):
 *
 * ```
 * <BOUNDARY_MARKER(app.manifest.contract.name)>
 * <renderTemplate(app.agent, params)>
 *
 * <renderTemplate(app.examples, examplesParams)>   // if app.examples is defined
 * ```
 *
 * `app.manifest.contract.name` is grammar-restricted at `defineApp`
 * time (RFC §3.2 M3): matches `[a-z][a-z0-9_-]{1,63}`, so it cannot
 * break the markdown bold or inject newlines into the marker bytes.
 *
 * `app.examples` (if present) receives an extended render context
 * carrying the contract `name` and `tools[]` in addition to the
 * standard {@link AgentRenderCtx} fields, allowing discipline content
 * to reference the contract identity directly.
 */
export function renderAgentPreamble(app: App, params: AgentRenderCtx): string {
  const marker = BOUNDARY_MARKER(app.manifest.contract.name);
  const body = renderAgentBody(app.agent, params);

  if (!app.examples) {
    return marker + body;
  }

  const examplesParams: ExamplesRenderCtx = {
    ...params,
    name: app.manifest.contract.name,
    tools: app.manifest.contract.tools,
  };
  const examples = renderExamples(app.examples, examplesParams);
  return marker + body + '\n\n' + examples;
}

function renderAgentBody(
  agent: string | AgentTemplateFn,
  params: AgentRenderCtx,
): string {
  return typeof agent === 'function'
    ? agent(params)
    : renderTemplate(agent, params as unknown as Record<string, unknown>);
}

function renderExamples(
  examples: string | ExamplesTemplateFn,
  params: ExamplesRenderCtx,
): string {
  return typeof examples === 'function'
    ? examples(params)
    : renderTemplate(examples, params as unknown as Record<string, unknown>);
}
