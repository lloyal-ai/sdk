/**
 * In-memory implementation of {@link AppConfigStore} — RFC §5.6.
 *
 * The `AppConfigStore` interface itself lives in
 * `@lloyal-labs/lloyal-agents` (so the framework context
 * `AppConfigStoreCtx` and app factories can share it without a
 * dependency cycle). This module supplies the reference impl that dev
 * harnesses, examples, and tests use; harnesses needing durable
 * storage implement the interface themselves.
 *
 * @packageDocumentation
 * @category Contract
 */

import type { Operation } from 'effection';
import type { AppConfigStore } from '@lloyal-labs/lloyal-agents';

/**
 * Create an in-memory `AppConfigStore` backed by a `Map`.
 *
 * Intended for development, tests, and single-process harnesses that
 * don't need cross-restart persistence. Harnesses needing durable
 * storage implement the interface themselves against their preferred
 * backend (file system, encrypted secret store, remote KV, etc.).
 *
 * Configs are stored as-is (no deep clone on set/get). If the caller
 * mutates a returned config object, those mutations are visible to
 * subsequent reads — which would violate the whole-replace semantics.
 * Callers should treat returned configs as immutable and re-`set` to
 * update.
 */
export function createInMemoryConfigStore(): AppConfigStore {
  const store = new Map<string, Record<string, unknown>>();
  return {
    *get(appName: string): Operation<Record<string, unknown> | undefined> {
      return store.get(appName);
    },
    *set(appName: string, config: Record<string, unknown>): Operation<void> {
      store.set(appName, config);
    },
    *clear(appName: string): Operation<void> {
      store.delete(appName);
    },
  };
}
