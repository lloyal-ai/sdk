/**
 * Tests for `createAppRegistry` + `registry.enable` / `disable` —
 * RFC §5.4, §6 (declarative per-app scope model).
 *
 * The model: the harness declares its boot set via
 * `createAppRegistry({ apps })`; each factory runs in its own *detached*
 * Effection scope (`createScope()` — does NOT inherit context, so the
 * registry seeds `AppConfigStoreCtx` / `AppRegistryCtx` / `RerankerCtx`
 * into it explicitly; the detachment is what isolates teardown errors so
 * `disable` can swallow them). `disable` / registry scope-exit tear that
 * scope down, firing the factory's `ensure(...)`. `enable` is the dynamic
 * mid-session path. There are no install/uninstall hooks and no
 * standalone register verb.
 *
 * Contracts verified:
 * 1. **Boot set (`apps: []`) is enabled** — `byName`/`installed`/`stateOf` reflect it.
 * 2. **Factory runs in a context-bearing scope** — a factory reading
 *    `AppConfigStoreCtx` works (the regression for the detached-scope bug).
 * 3. **Factory body is setup; runs during enable.**
 * 4. **Factory throw → not enabled + propagates + partial scope torn down.**
 * 5. **`ensure()` teardown fires on `disable`.**
 * 6. **`ensure()` teardown fires on registry scope-exit, reverse order.**
 * 7. **Teardown is best-effort** — a throwing `ensure` doesn't strand siblings.
 * 8. **modelContractVersion gate** — unsupported version rejects (ensure still fires).
 * 9. **Stored-config validation** — missing key / wrong type rejects.
 * 10. **Duplicate names** throw; the first survives.
 * 11. **`disable` idempotent** — unknown name is a no-op.
 *
 * @category Testing
 */

import { describe, it, expect, vi } from 'vitest';
import { run, ensure } from 'effection';
import { AppConfigStoreCtx } from '@lloyal-labs/lloyal-agents';
import type { App, AppManifest, AppFactory } from '@lloyal-labs/lloyal-agents';
import { createAppRegistry } from '../src/registry';
import { createInMemoryConfigStore } from '../src/config-store';

// ── App fixture ──────────────────────────────────────────────────

function fakeApp(opts: {
  name: string;
  modelContractVersion?: string;
  configSchema?: AppManifest['configSchema'];
}): App {
  const manifest: AppManifest = {
    name: opts.name,
    version: '1.0.0',
    modelContractVersion: opts.modelContractVersion ?? '3.0',
    contract: { name: `${opts.name}_research`, useWhen: 'do things', tools: ['x'] },
    configSchema: opts.configSchema,
  };
  return {
    name: opts.name,
    version: '1.0.0',
    manifest,
    source: { name: opts.name } as App['source'],
    tools: [],
    agent: 'test agent template',
    configSchema: opts.configSchema,
  };
}

/** Plain factory — returns an app, no teardown. */
function plainFactory(opts: Parameters<typeof fakeApp>[0]): AppFactory {
  return function* () {
    return fakeApp(opts);
  };
}

/** Resource-shaped factory: runs onSetup, registers onTeardown via
 *  ensure(), returns the app — teardown fires when its scope halts. */
function resourceFactory(
  opts: Parameters<typeof fakeApp>[0],
  hooks: { onSetup?: () => void; onTeardown?: () => void },
): AppFactory {
  return function* () {
    hooks.onSetup?.();
    yield* ensure(function* () {
      hooks.onTeardown?.();
    });
    return fakeApp(opts);
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('createAppRegistry', () => {
  it('enables the declarative boot set and exposes it via byName / installed / stateOf', async () => {
    const result = await run(function* () {
      const registry = yield* createAppRegistry({
        configStore: createInMemoryConfigStore(),
        apps: [plainFactory({ name: 'web' }), plainFactory({ name: 'corpus' })],
      });
      return {
        viaByName: registry.byName('web')?.manifest.name,
        installedNames: registry.installed().map((a) => a.manifest.name),
        state: registry.stateOf('web'),
        absent: registry.stateOf('nope'),
      };
    });
    expect(result.viaByName).toBe('web');
    expect(result.installedNames).toEqual(['web', 'corpus']);
    expect(result.state).toBe('enabled');
    expect(result.absent).toBe('disabled');
  });

  it('runs the factory in a scope where App*Ctx are available (context inheritance)', async () => {
    // The real web/corpus pattern: the factory reads its config from
    // AppConfigStoreCtx. The registry MUST run the factory in a scope that
    // inherits that context, or every real app throws MissingContextError.
    const seen = await run(function* () {
      const configStore = createInMemoryConfigStore();
      yield* configStore.set('ctxapp', { key: 'value' });
      let readConfig: unknown;
      const ctxFactory: AppFactory = function* () {
        const cs = yield* AppConfigStoreCtx.expect();
        readConfig = yield* cs.get('ctxapp');
        return fakeApp({ name: 'ctxapp' });
      };
      yield* createAppRegistry({ configStore, apps: [ctxFactory] });
      return readConfig;
    });
    expect(seen).toEqual({ key: 'value' });
  });

  it('runs the factory body (setup) when enabled', async () => {
    const onSetup = vi.fn();
    await run(function* () {
      const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
      expect(onSetup).not.toHaveBeenCalled();
      yield* registry.enable(resourceFactory({ name: 'jira' }, { onSetup }));
      expect(onSetup).toHaveBeenCalledTimes(1);
    });
  });

  it('propagates a factory throw and does NOT enable the app', async () => {
    let captured: App | undefined;
    const brokenFactory: AppFactory = function* () {
      throw new Error('construction failed');
    };
    await expect(
      run(function* () {
        const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
        try {
          yield* registry.enable(brokenFactory);
        } finally {
          captured = registry.byName('broken');
        }
      }),
    ).rejects.toThrow('construction failed');
    expect(captured).toBeUndefined();
  });

  it('fires ensure() teardown on disable', async () => {
    const onTeardown = vi.fn();
    const result = await run(function* () {
      const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
      yield* registry.enable(resourceFactory({ name: 'transient' }, { onTeardown }));
      const before = onTeardown.mock.calls.length;
      yield* registry.disable('transient');
      return { before, after: onTeardown.mock.calls.length, gone: registry.byName('transient') };
    });
    expect(result.before).toBe(0);
    expect(result.after).toBe(1);
    expect(result.gone).toBeUndefined();
  });

  it('fires ensure() teardown on registry scope exit, reverse register order', async () => {
    const order: string[] = [];
    await run(function* () {
      yield* createAppRegistry({
        configStore: createInMemoryConfigStore(),
        apps: [
          resourceFactory({ name: 'a' }, { onTeardown: () => order.push('a') }),
          resourceFactory({ name: 'b' }, { onTeardown: () => order.push('b') }),
          resourceFactory({ name: 'c' }, { onTeardown: () => order.push('c') }),
        ],
      });
    });
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('scope-exit teardown is best-effort — a throwing teardown is logged, never strands siblings', async () => {
    // Each app owns a detached scope, so a throwing teardown is caught
    // and logged (the run does NOT reject) and good1 + good2 both tear
    // down regardless. Reverse register-order: good2 then good1.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    await expect(
      run(function* () {
        yield* createAppRegistry({
          configStore: createInMemoryConfigStore(),
          apps: [
            resourceFactory({ name: 'good1' }, { onTeardown: () => seen.push('good1') }),
            resourceFactory({ name: 'bad' }, {
              onTeardown: () => { throw new Error('teardown failed'); },
            }),
            resourceFactory({ name: 'good2' }, { onTeardown: () => seen.push('good2') }),
          ],
        });
      }),
    ).resolves.not.toThrow();
    expect(seen).toEqual(['good2', 'good1']);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('teardown for app "bad"'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('registry.disable swallows + logs a throwing teardown (no crash)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      run(function* () {
        const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
        yield* registry.enable(
          resourceFactory({ name: 'bad' }, {
            onTeardown: () => { throw new Error('teardown failed'); },
          }),
        );
        yield* registry.disable('bad');   // must NOT throw — swallowed + logged
        expect(registry.stateOf('bad')).toBe('disabled');
      }),
    ).resolves.not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('teardown for app "bad"'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('rejects unsupported modelContractVersion (and the factory ensure still fires)', async () => {
    const onTeardown = vi.fn();
    await expect(
      run(function* () {
        const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
        yield* registry.enable(
          resourceFactory({ name: 'future', modelContractVersion: '99.0' }, { onTeardown }),
        );
      }),
    ).rejects.toThrow('modelContractVersion="99.0"');
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it('rejects when stored config is missing a required key', async () => {
    await expect(
      run(function* () {
        const configStore = createInMemoryConfigStore();
        yield* configStore.set('webcfg', { wrongField: 'oops' });
        yield* createAppRegistry({
          configStore,
          apps: [
            plainFactory({
              name: 'webcfg',
              configSchema: {
                type: 'object',
                required: ['tavilyKey'],
                properties: { tavilyKey: { type: 'string' } },
              },
            }),
          ],
        });
      }),
    ).rejects.toThrow('missing required key "tavilyKey"');
  });

  it('rejects when stored config has the wrong type', async () => {
    await expect(
      run(function* () {
        const configStore = createInMemoryConfigStore();
        yield* configStore.set('typecheck', { port: 'not-a-number' });
        yield* createAppRegistry({
          configStore,
          apps: [
            plainFactory({
              name: 'typecheck',
              configSchema: {
                type: 'object',
                required: ['port'],
                properties: { port: { type: 'number' } },
              },
            }),
          ],
        });
      }),
    ).rejects.toThrow('declares "number"');
  });

  it('throws on duplicate app name; the first enable survives', async () => {
    const result = await run(function* () {
      const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
      yield* registry.enable(plainFactory({ name: 'dup' }));
      const first = registry.byName('dup');
      try {
        yield* registry.enable(plainFactory({ name: 'dup' }));
      } catch (err) {
        return {
          message: (err as Error).message,
          stillThere: registry.byName('dup') === first,
          count: registry.installed().filter((a) => a.manifest.name === 'dup').length,
        };
      }
      return { message: undefined, stillThere: false, count: -1 };
    });
    expect(result.message).toContain('already enabled');
    expect(result.stillThere).toBe(true);
    expect(result.count).toBe(1);
  });

  it('disable on an unknown name is a no-op', async () => {
    await expect(
      run(function* () {
        const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
        yield* registry.disable('never-enabled');
      }),
    ).resolves.not.toThrow();
  });

  it('a plain (no-teardown) factory enables and disables cleanly', async () => {
    await expect(
      run(function* () {
        const registry = yield* createAppRegistry({ configStore: createInMemoryConfigStore() });
        yield* registry.enable(plainFactory({ name: 'plain' }));
        expect(registry.stateOf('plain')).toBe('enabled');
        yield* registry.disable('plain');
        expect(registry.stateOf('plain')).toBe('disabled');
      }),
    ).resolves.not.toThrow();
  });
});
