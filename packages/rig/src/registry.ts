/**
 * `createAppRegistry` — harness-wide app registry with a **declarative**
 * app set and structured, **isolated** per-app lifecycle (RFC §5.4, §6).
 *
 * The harness declares its apps as factories; the registry owns the rest:
 *
 * - `createAppRegistry({ configStore, apps })` runs each factory in its own
 *   **detached** Effection scope, seeded with the app-facing framework
 *   contexts (`AppConfigStoreCtx`, `RerankerCtx` — RFC §6.3) so the factory
 *   reads config + reranker. The factory body is setup; a `resource()`
 *   factory's `ensure(...)` is teardown. The registry tears the scopes
 *   down on its own scope exit, reverse register-order, **best-effort** —
 *   a throwing teardown is logged but never strands a sibling, and never
 *   crashes the harness. The harness does **not** call a per-app register
 *   verb at boot.
 * - `registry.enable(factory)` / `registry.disable(name)` handle the
 *   genuine dynamic case (mid-session install/uninstall). `enable` →
 *   `'enabled'`, `disable` → `'disabled'` (matching {@link AppState}).
 *   `disable` swallows + logs a throwing teardown, so a mid-session
 *   uninstall can't crash the session — possible only because each app
 *   owns a detached scope whose teardown errors don't propagate to a
 *   parent.
 *
 * There are no install/uninstall/enable/disable hooks on the App. A
 * factory that throws (or whose manifest fails validation) tears down its
 * partial scope and propagates; the app never enters the registry.
 * Per-app independent — one app's failure can't roll back another.
 *
 * @packageDocumentation
 * @category Contract
 */

import { call, createScope, ensure, suspend } from 'effection';
import type { Operation } from 'effection';
import {
  AppRegistryCtx,
  AppConfigStoreCtx,
  RerankerCtx,
} from '@lloyal-labs/lloyal-agents';
import type {
  App,
  AppFactory,
  AppRegistry,
  AppConfigStore,
  Reranker,
} from '@lloyal-labs/lloyal-agents';
import { SUPPORTED_MODEL_CONTRACT_VERSIONS } from './contract';

/**
 * Options for {@link createAppRegistry}.
 */
export interface CreateAppRegistryOpts {
  /**
   * The harness-supplied per-app config store. The registry sets it on
   * `AppConfigStoreCtx` and seeds it into each app's scope so factories
   * read config at construction.
   */
  configStore: AppConfigStore;
  /**
   * App factories to enable at construction (the boot set). Each runs in
   * its own detached scope and is torn down on registry scope exit. The
   * harness assembles this list — build-time imports plus factories from
   * `loadBundle(...)` for channel apps. **Set `RerankerCtx` before
   * calling** if any factory reads the shared reranker.
   */
  apps?: readonly AppFactory[];
}

interface RegistryEntry {
  app: App;
  /** Halts the app's detached scope, firing its factory `ensure`s. */
  destroy: () => Promise<void>;
}

/**
 * Create the harness-wide app registry.
 *
 * Sets `AppRegistryCtx` and `AppConfigStoreCtx` in the caller's scope (the
 * `initAgents` pattern), enables each factory in `opts.apps`, and tears
 * every enabled app's scope down on the caller's scope exit (reverse
 * order, best-effort).
 *
 * @example
 * ```ts
 * yield* RerankerCtx.set(reranker);          // before, if factories read it
 * const registry = yield* createAppRegistry({
 *   configStore,
 *   apps: [
 *     createWebApp,                           // build-time factory
 *     createCorpusApp,
 *     yield* loadBundle(url, manifest, { trustRoots }),  // channel factory
 *   ],
 * });
 * // ... pool dispatch ...
 * // registry scope exit tears down every app (factory ensures fire)
 * ```
 */
export function* createAppRegistry(
  opts: CreateAppRegistryOpts,
): Operation<AppRegistry> {
  const { configStore, apps } = opts;
  const entries = new Map<string, RegistryEntry>();
  const order: string[] = [];

  const registry: AppRegistry = {
    byName(name: string): App | undefined {
      return entries.get(name)?.app;
    },
    installed(): readonly App[] {
      return order.map((n) => entries.get(n)!.app).filter(Boolean);
    },
    stateOf(name: string): 'enabled' | 'disabled' {
      return entries.has(name) ? 'enabled' : 'disabled';
    },
    *enable(factory: AppFactory): Operation<App> {
      // Read the app-facing framework contexts to seed into the app's
      // detached scope (RFC §6.3: factories read config + reranker).
      let reranker: Reranker | undefined;
      try {
        reranker = yield* RerankerCtx.expect();
      } catch {
        reranker = undefined;
      }

      const [scope, destroy] = createScope();
      let added = false;
      try {
        // Run the factory in a DETACHED scope (so its teardown errors stay
        // isolated and swallowable), seeded with the framework contexts.
        // It resolves the App out, then suspends — keeping the App and its
        // ensure() teardown alive until `destroy()`.
        const app = yield* call(
          () =>
            new Promise<App>((resolve, reject) => {
              scope
                .run(function* () {
                  try {
                    yield* AppConfigStoreCtx.set(configStore);
                    yield* AppRegistryCtx.set(registry);
                    if (reranker !== undefined) yield* RerankerCtx.set(reranker);
                    const constructed = yield* factory();
                    resolve(constructed);
                    yield* suspend();
                  } catch (err) {
                    reject(err as Error);
                  }
                })
                .catch(() => {
                  /* halt-after-resolve rejection — expected, ignore */
                });
            }),
        );

        const declared = app.manifest.modelContractVersion ?? '3.0';
        if (!SUPPORTED_MODEL_CONTRACT_VERSIONS.includes(declared)) {
          throw new Error(
            `App "${app.manifest.name}" declares modelContractVersion="${declared}", ` +
              `but the framework supports [${SUPPORTED_MODEL_CONTRACT_VERSIONS.map((v) => `"${v}"`).join(', ')}]. ` +
              `Upgrade the app or use a framework version that supports this contract.`,
          );
        }

        const existingConfig = yield* configStore.get(app.manifest.name);
        if (existingConfig !== undefined && app.manifest.configSchema) {
          validateConfigShape(app.manifest.name, existingConfig, app.manifest.configSchema);
        }

        if (entries.has(app.manifest.name)) {
          throw new Error(
            `App "${app.manifest.name}" is already enabled. ` +
              `Call registry.disable("${app.manifest.name}") first to replace it.`,
          );
        }

        entries.set(app.manifest.name, { app, destroy });
        order.push(app.manifest.name);
        added = true;
        return app;
      } finally {
        // Factory threw, validation failed, or the caller was halted before
        // the app entered the registry → tear down its detached scope
        // (best-effort; don't mask the original error).
        if (!added) {
          try {
            yield* call(() => destroy());
          } catch {
            /* teardown error on the failure path — original error wins */
          }
        }
      }
    },
    *disable(name: string): Operation<void> {
      const entry = entries.get(name);
      if (!entry) return;
      entries.delete(name);
      const idx = order.indexOf(name);
      if (idx >= 0) order.splice(idx, 1);
      try {
        yield* call(() => entry.destroy());
      } catch (err) {
        console.error(
          `[lloyal-rig] teardown for app "${name}" threw during disable — app removed regardless:`,
          err,
        );
      }
    },
  };

  yield* AppRegistryCtx.set(registry);
  yield* AppConfigStoreCtx.set(configStore);

  // Tear down every still-enabled app on registry scope exit, reverse
  // register-order, best-effort (a throwing teardown is logged, never
  // strands a sibling, never crashes the harness). Registered before the
  // boot set so a mid-boot failure still cleans up the apps that enabled.
  yield* ensure(function* () {
    for (let i = order.length - 1; i >= 0; i--) {
      const name = order[i];
      const entry = entries.get(name);
      if (!entry) continue;
      try {
        yield* call(() => entry.destroy());
      } catch (err) {
        console.error(
          `[lloyal-rig] teardown for app "${name}" threw — continuing teardown:`,
          err,
        );
      }
    }
    entries.clear();
    order.length = 0;
  });

  if (apps) {
    for (const factory of apps) {
      yield* registry.enable(factory);
    }
  }

  return registry;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Minimal structural schema check. Validates that every property in
 * `schema.required` exists on `config` with a type compatible with
 * `schema.properties[name].type`. This is a guardrail — the framework
 * does not ship a full JSON Schema validator. Apps requiring richer
 * validation should run their own check in the factory body.
 */
function validateConfigShape(
  appName: string,
  config: Record<string, unknown>,
  schema: { type?: string; required?: readonly string[] | string[]; properties?: Record<string, unknown> },
): void {
  if (schema.type && schema.type !== 'object') {
    return; // non-object schemas are out of scope for the guardrail
  }
  for (const key of schema.required ?? []) {
    if (!(key in config)) {
      throw new Error(
        `App "${appName}" stored config is missing required key "${key}" ` +
          `declared in manifest.configSchema. Re-run the app's config flow or clear stale config.`,
      );
    }
  }
  for (const [key, rawPropSchema] of Object.entries(schema.properties ?? {})) {
    if (!(key in config)) continue;
    const propSchema = rawPropSchema as { type?: unknown } | null | undefined;
    if (!propSchema || typeof propSchema.type !== 'string') continue;
    const value = config[key];
    if (!matchesPrimitiveType(value, propSchema.type)) {
      throw new Error(
        `App "${appName}" stored config key "${key}" has type "${typeof value}" ` +
          `but manifest.configSchema declares "${propSchema.type}". ` +
          `Re-run the app's config flow or clear stale config.`,
      );
    }
  }
}

function matchesPrimitiveType(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}
