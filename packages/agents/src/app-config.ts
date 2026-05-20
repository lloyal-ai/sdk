/**
 * `AppConfigStore` — pluggable per-app config storage.
 *
 * The interface lives in `@lloyal-labs/lloyal-agents` so the framework
 * context (`AppConfigStoreCtx`) and app factories (in `@lloyal-labs/rig`,
 * `@lloyal-labs/web-app`, `@lloyal-labs/corpus-app`) share a common type
 * without a dependency cycle. The concrete in-memory implementation
 * (`createInMemoryConfigStore`) and harness-supplied backends live in
 * rig and harness packages.
 *
 * **Semantics:**
 *
 * - **Whole-replace `set`.** The second arg replaces existing config
 *   wholesale; apps that need merge do read-modify-write themselves.
 * - **Last-write-wins on concurrent writes.** Two parallel
 *   `set(appName, ...)` calls race; whichever lands second overwrites.
 * - **Framework validates stored config against `app.manifest.configSchema`**
 *   when the app is enabled (`createAppRegistry({ apps })` /
 *   `registry.enable`), after the factory constructs the manifest. The
 *   store interface is pure storage — it does not know about the manifest.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';

/**
 * Pluggable per-app config storage interface.
 *
 * All methods return `Operation<...>` (Effection generators) so concrete
 * implementations can perform async IO (file reads, remote KV calls)
 * inside the framework's scope.
 */
export interface AppConfigStore {
  /**
   * Read the current config for an app. Returns `undefined` if no
   * config has been set for this app name.
   */
  get(appName: string): Operation<Record<string, unknown> | undefined>;
  /**
   * Whole-replace the config for an app. Concurrent writes are
   * last-write-wins.
   */
  set(appName: string, config: Record<string, unknown>): Operation<void>;
  /**
   * Remove the config for an app entirely (sets back to `undefined`
   * state). Idempotent — clearing a never-set app is a no-op.
   */
  clear(appName: string): Operation<void>;
}
