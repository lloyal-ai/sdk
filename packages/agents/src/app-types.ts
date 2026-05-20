/**
 * App contract types — what a third-party app developer declares + what
 * the framework consumes when registering and rendering apps.
 *
 * Three groups of types live here:
 *
 * 1. **Declarative manifest** ({@link AppManifest}, {@link AppContract},
 *    {@link AppHints}). Authored in `app.json` and imported into the
 *    factory; describes what the app *is* without any runtime values.
 *
 * 2. **Runtime App object** ({@link App}, {@link AgentTemplateFn},
 *    {@link ExamplesTemplateFn}). Constructed by `defineApp(...)` inside
 *    the app's factory; bundles the manifest with the live `Source`,
 *    `Tool[]`, and template renderers.
 *
 * 3. **Per-spawn render context** ({@link AgentRenderCtx},
 *    {@link ExamplesRenderCtx}). Passed by the framework to template
 *    renderers when constructing a per-spawn preamble.
 *
 * Plus {@link AppFactory} (what the registry runs to construct an App)
 * and {@link ConfigFlow} for the optional credential handoff.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';
import type { Source } from './source';
import type { Tool } from './Tool';
import type { JsonSchema } from './types';

// ── Manifest (declarative — what app.json declares) ──────────────

/**
 * The model-facing identity of an app — three fields under
 * `manifest.contract` in `app.json`. The framework renders these into
 * the boundary marker (RFC §1.1), the spine catalog entry (RFC §1.2),
 * and the scope-guard allowed-tools set (RFC §5.3c).
 *
 * Constraints (enforced synchronously by `defineApp` per RFC §3.2 M3):
 * - `name` matches `[a-z][a-z0-9_-]{1,63}`.
 * - `tools` is a non-empty array of tool-name strings, each matching the
 *   same regex as `name`. Must cover exactly the keys of the app's
 *   `tools` map supplied to `defineApp`.
 * - `useWhen` is a single sentence of printable characters, bounded in
 *   length, with no chat-role markers (`SYSTEM:`/`USER:`/etc.), no
 *   markdown code fences, and no newlines.
 */
export interface AppContract {
  /** Model-facing contract identifier (e.g., `"web_research"`). */
  readonly name: string;
  /** Single-sentence routing hint rendered into the catalog `Use when:` line. */
  readonly useWhen: string;
  /** Tool names exposed by this contract; must match the app's `tools` map keys. */
  readonly tools: readonly string[];
}

/**
 * Optional UX/marketplace metadata. Not part of the model-facing surface;
 * surfaced to harness UI, marketplace listings, and capability disclosure
 * at install time (RFC §3.2 M4).
 */
export interface AppHints {
  /** Short display name for chips/tabs (e.g., `"web"`, `"jira"`). */
  readonly shortName?: string;
  /** Long-form description for marketplace listings. */
  readonly description?: string;
  /** URL to an icon (svg/png) the harness may display. */
  readonly iconUrl?: string;
  /** Coarse capability disclosure for install-time review. */
  readonly authKind?: 'oauth' | 'apikey' | 'path' | 'token' | 'none';
}

/**
 * The declarative app manifest — content of `app.json` plus the
 * `modelContractVersion` declaration. Imported into the app's factory
 * and passed to `defineApp(...)`.
 *
 * `manifest.name` is the **app identifier** used in code paths
 * (`SpawnSpec.assignedApp`, `registry.byName(...)`, the AppConfigStore
 * key, filesystem paths). The model never sees this — it only sees
 * `manifest.contract.name`. One app, one contract.
 */
export interface AppManifest {
  /** App identifier used for routing, config storage, and registry lookup. */
  readonly name: string;
  /** Semver version of the app package. */
  readonly version?: string;
  /**
   * Which codified model contract version this app targets. The framework
   * refuses to register apps whose declared version is not in
   * `SUPPORTED_MODEL_CONTRACT_VERSIONS` (currently `['3.0']`). Per RFC §1.6.
   */
  readonly modelContractVersion?: string;
  /** The model-facing identity. */
  readonly contract: AppContract;
  /** Optional UX/marketplace metadata (RFC §4.2 / §3.2 M4). */
  readonly hints?: AppHints;
  /**
   * JSON Schema declaring what config the app needs. The framework
   * validates the app's stored config against it at enable time (when the
   * factory's constructed manifest is available). The `x-secret: true`
   * field annotation signals sensitive values (harness UX masks them, may
   * prefer secure storage backend). Per RFC §7.1.
   */
  readonly configSchema?: JsonSchema;
}

// ── Per-spawn render context ─────────────────────────────────────

/**
 * Variables the framework provides to `agent.eta` template renderers
 * at per-spawn render time. Apps reference these as `it.agentCount`,
 * `it.maxTurns`, etc. inside their Eta templates.
 *
 * App-specific additional variables (e.g., corpus apps' TOC) can be
 * supplied by extending the render context inside the App's factory —
 * the framework spreads `params` into the Eta template's render data.
 */
export interface AgentRenderCtx {
  /** Total number of agents spawned in the current fan-out. */
  readonly agentCount: number;
  /** Task descriptions of the *other* agents in this fan-out. */
  readonly siblingTasks: readonly string[];
  /** Tool-call budget for this spawn. */
  readonly maxTurns: number;
  /** Today's date in ISO format. */
  readonly date: string;
  /** Position in a chain orchestrator (0-indexed); 0 for parallel fan-outs. */
  readonly taskIndex: number;
}

/**
 * Variables provided to `examples.eta` renderers in addition to all
 * fields of {@link AgentRenderCtx}. Apps can reference `it.name`
 * (contract name) and `it.tools` (the contract's tool-name list) when
 * authoring discipline content.
 */
export interface ExamplesRenderCtx extends AgentRenderCtx {
  /** The contract's name (same as `app.manifest.contract.name`). */
  readonly name: string;
  /** The contract's tool-name list (same as `app.manifest.contract.tools`). */
  readonly tools: readonly string[];
}

/**
 * Function alternative to a string `agent.eta` template — for apps whose
 * per-spawn prompt needs runtime parameterization beyond what Eta covers.
 *
 * The returned string is the per-spawn body; the framework prepends
 * `BOUNDARY_MARKER(contract.name)` and (optionally) appends the rendered
 * `examples.eta`. The function MUST NOT return content containing the
 * literal `Apply the **` substring (the framework prepends it and
 * `defineApp` cannot statically validate function outputs — the first-render
 * check on canonical apps catches it, per RFC §4.7).
 */
export type AgentTemplateFn = (params: AgentRenderCtx) => string;

/**
 * Function alternative to a string `examples.eta` template.
 *
 * Per-spawn only (per RFC §3.2 M1) — examples are rendered into the
 * preamble of agents assigned to *this* app, never into the shared spine.
 */
export type ExamplesTemplateFn = (params: ExamplesRenderCtx) => string;

// ── Config flow ───────────────────────────────────────────────────

/**
 * Interactive config-acquisition flow for OAuth-like protocols the app
 * drives. This is credential **acquisition**, not lifecycle: it obtains
 * config (tokens) and the harness writes the result to `AppConfigStore`.
 * It is unrelated to enable/disable — the actual authentication happens
 * at the provider, not in the framework.
 *
 * Harness calls `initiate` → app returns a handoff URL + optional
 * callback param validator → harness opens the URL → user completes auth
 * → harness captures callback params → harness validates via
 * `callbackValidator` (if provided) → harness calls `complete` → app
 * returns the full config object → framework validates against
 * `manifest.configSchema` → harness writes the whole-replace config to
 * `AppConfigStore`. Per RFC §7.2.
 *
 * Both steps run inside the harness's Effection scope; if a flow needs
 * to read existing config it does `yield* AppConfigStoreCtx.expect()`
 * directly — there is no separate context parameter.
 */
export interface ConfigFlow {
  /** Initiates the auth flow; returns a handoff URL the harness opens. */
  initiate(): Operation<{
    handoffUrl?: string;
    callbackValidator?: (params: unknown) => boolean;
  }>;
  /** Receives callback params from the harness; returns the full config. */
  complete(callbackParams: unknown): Operation<Record<string, unknown>>;
}

// ── Runtime App object ────────────────────────────────────────────

/**
 * The runtime artifact returned by `defineApp(...)` inside an app's
 * factory. Combines the declarative {@link AppManifest} with the live
 * `Source`, `Tool[]`, and prompt templates the framework needs at
 * spawn time.
 *
 * Apps are constructed inside zero-arg `Operation<App>` factories
 * (typically `createWebApp`, `createJiraApp`, etc.) that read config
 * from `AppConfigStoreCtx` and the shared reranker from `RerankerCtx`.
 * Both npm-distributed apps and signed-bundle apps use the identical
 * factory signature (RFC §4.5).
 */
export interface App {
  /** Same as `manifest.name` — routing key. */
  readonly name: string;
  /** Same as `manifest.version`. */
  readonly version?: string;
  /** The declarative manifest. */
  readonly manifest: AppManifest;
  /** The app's Source (provides per-domain chunking + tools). */
  readonly source: Source;
  /**
   * The tool instances exposed by this app. Their names must match
   * `manifest.contract.tools` exactly. The framework concatenates all
   * registered apps' `tools` into the spine prefill (one shared decode
   * of all schemas, amortized across every spawn in the pool).
   */
  readonly tools: readonly Tool[];
  /**
   * The per-spawn `agent.eta` template (string) or function. The
   * framework prepends the boundary marker; `agent.eta` MUST NOT
   * contain the literal `Apply the **` substring.
   */
  readonly agent: string | AgentTemplateFn;
  /**
   * Optional discipline content (GOOD/BAD examples, anti-patterns)
   * rendered into the per-spawn preamble of agents assigned to this
   * app. Per RFC §4.4. Not surfaced in the shared spine.
   */
  readonly examples?: string | ExamplesTemplateFn;
  /** Optional config schema (same as `manifest.configSchema`). */
  readonly configSchema?: JsonSchema;
  /** Optional UX hints (same as `manifest.hints`). */
  readonly hints?: AppHints;
  /** Optional interactive config flow. */
  readonly configFlow?: ConfigFlow;
}

/**
 * A zero-arg Operation that constructs an {@link App}. This — not a
 * constructed `App` — is what the registry consumes (`createAppRegistry({
 * apps })` at boot, or `registry.enable(factory)` dynamically): the
 * registry runs the factory inside a per-app **detached** Effection scope
 * that it seeds with `AppConfigStoreCtx` / `AppRegistryCtx` / `RerankerCtx`,
 * so the factory reads its config and reranker, does any setup, and returns
 * the App.
 *
 * **Setup and teardown are structured, not hooks.** The factory body *is*
 * the setup. For resources that need teardown (a connection, a watcher),
 * the factory is a `resource()` that allocates, registers cleanup with
 * `ensure(...)`, and `provide(...)`s the App — the cleanup fires when the
 * app's detached scope is torn down (`registry.disable(name)`, or registry
 * scope exit). Apps with no external resources are a plain
 * `function* () { return defineApp(...) }`. There are no
 * `install`/`uninstall`/`enable`/`disable` hooks (RFC §6).
 *
 * Both build-time-included and signed-bundle apps produce a factory of
 * this exact shape; `loadBundle` returns one, and `createXxxApp` is one.
 */
export type AppFactory = () => Operation<App>;

/**
 * The framework-tracked runtime state of an app: `'enabled'` once its
 * factory has run and it sits in the registry, `'disabled'` otherwise.
 * Binary by design — richer states (configured, authenticated, ready) are
 * harness UX rollups or app-internal runtime concerns, not framework
 * state (RFC §6).
 */
export type AppState = 'enabled' | 'disabled';

// ── App registry ─────────────────────────────────────────────────

/**
 * The harness-owned registry of installed apps. Lives behind
 * `AppRegistryCtx`; the scope-guard (RFC §5.3c) consults it at
 * tool-dispatch time to resolve the allowed-tools set for an
 * App-assigned spawn (`SpawnSpec.assignedApp`). The concrete factory
 * `createAppRegistry(...)` lives in `@lloyal-labs/rig`; dynamic
 * enable/disable are methods on this interface.
 *
 * Registry state is the single source of truth for which apps are
 * enabled within a harness scope. The harness declares its boot set
 * via `createAppRegistry({ apps })`; each app runs in its own detached
 * Effection scope. `disable` (or registry scope-exit) tears that scope
 * down, firing the app factory's `ensure(...)` teardown. There are no
 * install/uninstall hooks (RFC §6).
 */
export interface AppRegistry {
  /**
   * Look up an enabled app by `manifest.name` (the routing key —
   * **not** `manifest.contract.name`). Returns `undefined` if no app
   * with that name is enabled.
   */
  byName(name: string): App | undefined;
  /**
   * Snapshot of currently-enabled apps in registration order. The
   * spine renderer (RFC §1.2) walks this list to compose the catalog;
   * order is observable to the model.
   */
  installed(): readonly App[];
  /**
   * Binary state of an app: `'enabled'` if it's in the registry,
   * `'disabled'` otherwise (RFC §6). Convenience over `byName(name) !==
   * undefined` for harness UX.
   */
  stateOf(name: string): AppState;
  /**
   * Enable an app dynamically (the mid-session `/install` path). Runs
   * the factory in a fresh per-app detached scope (seeded with `App*Ctx`),
   * validates the manifest, and adds it. Returns the constructed App.
   * Throws — and tears down the partial scope — if the factory
   * throws, validation fails, or the name is already enabled. The boot
   * set is enabled the same way via `createAppRegistry({ apps })`.
   */
  enable(factory: AppFactory): Operation<App>;
  /**
   * Disable an app dynamically: remove it and tear down its detached
   * scope, firing the factory's `ensure(...)` teardown. A throwing
   * teardown is logged but the app is removed regardless. No-op for an
   * unknown name.
   */
  disable(name: string): Operation<void>;
}
