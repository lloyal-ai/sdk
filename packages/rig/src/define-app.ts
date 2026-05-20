/**
 * `defineApp(spec): App` — sync wiring helper called inside every app's
 * factory after constructing its `Source` and `Tool[]` instances.
 *
 * Performs all framework-side validations of the app's declared shape
 * before the App enters the registry:
 *
 * - **Manifest schema.** `name` and `contract.name` match
 *   `[a-z][a-z0-9_-]{1,63}`; `contract.tools` is a non-empty unique array
 *   of names matching the same regex; `contract.useWhen` is a single
 *   bounded sentence with no chat-role markers, code fences, or newlines
 *   (RFC §3.2 M3 metadata sanitization).
 * - **Model contract version.** `manifest.modelContractVersion` is in
 *   `SUPPORTED_MODEL_CONTRACT_VERSIONS` (RFC §1.6). Absence is permitted
 *   (treated as `"3.0"`).
 * - **Tool map coverage.** The keys of the supplied `tools` object equal
 *   `manifest.contract.tools[]` as a set — every declared tool has an
 *   implementation, no extras.
 * - **Boundary-marker double-emission.** `agent` (when string-typed) MUST
 *   NOT contain the literal `Apply the **` substring — the framework
 *   prepends the marker via `BOUNDARY_MARKER`, so an `agent.eta` that
 *   includes the line would emit it twice (RFC §1.1).
 *
 * Validation errors throw synchronously with a clear message naming the
 * failing field and the violated rule. App factories should call
 * `defineApp` last (after `yield*`ing tool factories) so a malformed
 * manifest fails at construction time, not later at registration.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';
import type {
  Tool,
  Source,
  App,
  AppManifest,
  AgentTemplateFn,
  ExamplesTemplateFn,
  ConfigFlow,
  AppHints,
} from '@lloyal-labs/lloyal-agents';
import { SUPPORTED_MODEL_CONTRACT_VERSIONS } from './contract';

/**
 * Argument to {@link defineApp}. The fields that survive into the
 * returned {@link App} are surfaced here with the same names. There are
 * no lifecycle hooks — setup is the factory body, teardown is `ensure(...)`
 * (RFC §6.6).
 */
export interface DefineAppSpec {
  /** The declarative app manifest, imported from `app.json`. */
  manifest: AppManifest;
  /** The app's Source. */
  source: Source;
  /**
   * Map of tool-name → Tool instance. Keys MUST equal
   * `manifest.contract.tools[]` as a set (exact membership match — no
   * missing tools, no extras). Each value's `.name` property must match
   * its key (otherwise the catalog's `Tools:` line and the agent's
   * dispatched tool call would disagree).
   */
  tools: Readonly<Record<string, Tool>>;
  /**
   * The per-spawn template body. String → rendered via Eta with the
   * `AgentRenderCtx` fields available as `it.*`. Function → invoked
   * directly with the render context.
   *
   * MUST NOT contain the literal `Apply the **` substring when given as
   * a string — the framework prepends the boundary marker.
   */
  agent: string | AgentTemplateFn;
  /**
   * Optional discipline content rendered into the per-spawn preamble of
   * agents assigned to this app. Per RFC §4.4 — never enters the shared
   * spine.
   */
  examples?: string | ExamplesTemplateFn;
  /** Optional UX/marketplace hints (overrides `manifest.hints` if both present). */
  hints?: AppHints;
  /** Optional interactive config flow (RFC §7.2). */
  configFlow?: ConfigFlow;
}

// ── Validation regexes / constants ───────────────────────────────

/**
 * Identifier shape for app names and contract names. Lowercase ASCII
 * start, lowercase alphanumeric / underscore / hyphen rest, length 2-64.
 * This grammar is the M3 sanitization on shared-spine metadata — it
 * ensures app-supplied strings can't break the markdown bold in the
 * boundary marker (no `*`) and can't inject newlines, code fences, or
 * chat-role markers.
 */
const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * Maximum length of `contract.useWhen`. Bounded so the rendered catalog
 * stays compact and to limit the residual semantic-injection surface
 * available within the grammar's allowed character set (RFC §3.3 row 2).
 */
const USE_WHEN_MAX_LEN = 280;

/**
 * Patterns forbidden anywhere in `contract.useWhen` — chat-role markers
 * (would confuse the model into treating the catalog text as a fake
 * conversation) and markdown code fences (would let an attacker break
 * out of the catalog block into structured content). RFC §3.2 M3.
 */
const USE_WHEN_FORBIDDEN: readonly RegExp[] = [
  /\bSYSTEM:/i,
  /\bUSER:/i,
  /\bASSISTANT\s+calls?:/i,
  /\bASSISTANT:/i,
  /```/,
  /\r/,
  /\n/,
];

/** Substring whose presence in `agent` (string form) would cause double-emission. */
const BOUNDARY_MARKER_PREFIX = 'Apply the **';

// ── Validation helpers ───────────────────────────────────────────

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`defineApp: ${field} must be a string, got ${typeof value}`);
  }
  if (!ID_RE.test(value)) {
    throw new Error(
      `defineApp: ${field} ${JSON.stringify(value)} does not match the required ` +
        `identifier grammar ${ID_RE.toString()} (lowercase alphanumeric + _-, length 2-64). ` +
        `This is a model-contract metadata invariant — names appear in the boundary ` +
        `marker and shared spine catalog where injection-prone characters must be excluded.`,
    );
  }
}

function assertUseWhen(value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`defineApp: manifest.contract.useWhen must be a string, got ${typeof value}`);
  }
  if (value.length === 0 || value.length > USE_WHEN_MAX_LEN) {
    throw new Error(
      `defineApp: manifest.contract.useWhen length ${value.length} out of bounds ` +
        `[1, ${USE_WHEN_MAX_LEN}]. Keep it to a single short sentence.`,
    );
  }
  for (const pattern of USE_WHEN_FORBIDDEN) {
    if (pattern.test(value)) {
      throw new Error(
        `defineApp: manifest.contract.useWhen contains forbidden pattern ${pattern.toString()}. ` +
          `useWhen renders into the shared spine catalog; chat-role markers, code fences, and ` +
          `line breaks are excluded to prevent injection at the catalog-text layer (RFC §3.2 M3).`,
      );
    }
  }
}

function assertContractTools(tools: readonly string[]): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(
      `defineApp: manifest.contract.tools must be a non-empty array of tool-name strings`,
    );
  }
  const seen = new Set<string>();
  for (const name of tools) {
    assertIdentifier(name, `manifest.contract.tools[*] (${JSON.stringify(name)})`);
    if (seen.has(name)) {
      throw new Error(`defineApp: manifest.contract.tools contains duplicate ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
}

function assertModelContractVersion(version: string | undefined): void {
  // Undefined is permitted — apps that don't declare a version are
  // assumed to target the framework's default ("3.0"). The registry
  // (enable-time) may tighten this if needed.
  if (version === undefined) return;
  if (!SUPPORTED_MODEL_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `defineApp: manifest.modelContractVersion ${JSON.stringify(version)} is not in the ` +
        `supported set ${JSON.stringify(SUPPORTED_MODEL_CONTRACT_VERSIONS)}. ` +
        `This build of @lloyal-labs/rig only validates apps targeting one of those versions.`,
    );
  }
}

function assertToolMapCoverage(
  contractTools: readonly string[],
  toolsMap: Readonly<Record<string, Tool>>,
): void {
  const declared = new Set(contractTools);
  const provided = new Set(Object.keys(toolsMap));

  // Missing — tools declared in the contract but not supplied as instances.
  const missing: string[] = [];
  for (const name of declared) {
    if (!provided.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `defineApp: tools map is missing implementations for contract.tools: ` +
        `${JSON.stringify(missing)}. Every declared tool must have a corresponding ` +
        `entry in the \`tools\` map passed to defineApp.`,
    );
  }

  // Extras — tools supplied as instances but not declared in the contract.
  const extras: string[] = [];
  for (const name of provided) {
    if (!declared.has(name)) extras.push(name);
  }
  if (extras.length > 0) {
    throw new Error(
      `defineApp: tools map contains entries not declared in manifest.contract.tools: ` +
        `${JSON.stringify(extras)}. Add them to contract.tools or remove from the tools map ` +
        `— the catalog Tools: line is rendered from contract.tools and the scope-guard's ` +
        `allowed-tools set is derived from the same array, so extras would never be callable.`,
    );
  }

  // Name agreement — each Tool instance's .name must match its key.
  for (const [key, tool] of Object.entries(toolsMap)) {
    if (tool.name !== key) {
      throw new Error(
        `defineApp: tools[${JSON.stringify(key)}].name = ${JSON.stringify(tool.name)} ` +
          `does not match its map key. The map key is what the framework dispatches against; ` +
          `the Tool's name is what the model sees in the schema. They must agree.`,
      );
    }
  }
}

function assertAgentTemplate(agent: string | AgentTemplateFn): void {
  if (typeof agent === 'function') {
    // Function-typed templates can't be statically validated here. The
    // framework's first-render check (RFC §4.7) catches double-emission
    // at the first preamble render, not at defineApp time.
    return;
  }
  if (typeof agent !== 'string') {
    throw new Error(`defineApp: spec.agent must be a string or AgentTemplateFn, got ${typeof agent}`);
  }
  if (agent.includes(BOUNDARY_MARKER_PREFIX)) {
    throw new Error(
      `defineApp: agent template contains the literal ${JSON.stringify(BOUNDARY_MARKER_PREFIX)} substring. ` +
        `The framework prepends \`Apply the **<name>** contract.\\n\\n\` via BOUNDARY_MARKER at ` +
        `render time; including it in the template would emit it twice. Strip the ` +
        `\`Apply the **...** contract.\` line (and its trailing blank line) from agent.eta — ` +
        `see RFC §1.1 / §4.3.`,
    );
  }
}

// ── defineApp ─────────────────────────────────────────────────────

/**
 * Validate an app's declared shape and return the runtime {@link App}
 * object the framework will register and render against.
 *
 * Throws synchronously on the first validation failure with a message
 * naming the failing field and the violated rule.
 *
 * @example
 * ```ts
 * export function* createJiraApp(): Operation<App> {
 *   const cfgStore = yield* AppConfigStoreCtx.expect();
 *   const cfg = yield* cfgStore.get(manifest.name);
 *   if (!cfg) throw new Error('jira app requires config');
 *
 *   const source = new JiraSource(cfg);
 *   const searchTool = yield* createJiraSearchTool(cfg);
 *   const readTool = yield* createJiraReadTool(cfg);
 *
 *   return defineApp({
 *     manifest,
 *     source,
 *     tools: { jira_search: searchTool, jira_read: readTool },
 *     agent: agentTemplate,
 *   });
 * }
 * ```
 */
export function defineApp(spec: DefineAppSpec): App {
  // 1. Manifest top-level identifier.
  assertIdentifier(spec.manifest.name, 'manifest.name');

  // 2. Model contract version (if declared).
  assertModelContractVersion(spec.manifest.modelContractVersion);

  // 3. Contract substructure: name, useWhen, tools.
  assertIdentifier(spec.manifest.contract.name, 'manifest.contract.name');
  assertUseWhen(spec.manifest.contract.useWhen);
  assertContractTools(spec.manifest.contract.tools);

  // 4. Tools map coverage and name agreement.
  assertToolMapCoverage(spec.manifest.contract.tools, spec.tools);

  // 5. Agent template double-emission guard.
  assertAgentTemplate(spec.agent);

  // Preserve `contract.tools` insertion order in the runtime tools array
  // — that's the order the catalog renders and the order the spine
  // prefill receives schemas in. The framework relies on stable ordering
  // for the §10.1 snapshot gate.
  const tools = spec.manifest.contract.tools.map((name) => spec.tools[name]);

  return {
    name: spec.manifest.name,
    version: spec.manifest.version,
    manifest: spec.manifest,
    source: spec.source,
    tools,
    agent: spec.agent,
    examples: spec.examples,
    configSchema: spec.manifest.configSchema,
    hints: spec.hints ?? spec.manifest.hints,
    configFlow: spec.configFlow,
  };
}
