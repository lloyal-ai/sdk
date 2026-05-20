/**
 * Tests for `createInMemoryConfigStore()` — RFC §5.6.
 *
 * The in-memory implementation is the reference; harnesses needing
 * durable storage implement {@link AppConfigStore} themselves. These
 * tests lock the semantics every implementation must preserve:
 * whole-replace `set`, idempotent `clear`, `get` returns the most
 * recent write.
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { run } from 'effection';
import { createInMemoryConfigStore } from '../src/config-store';

describe('createInMemoryConfigStore', () => {
  it('get returns undefined before any set', async () => {
    const result = await run(function* () {
      const store = createInMemoryConfigStore();
      return yield* store.get('web');
    });
    expect(result).toBeUndefined();
  });

  it('set then get returns the stored config', async () => {
    const result = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('jira', { baseUrl: 'https://acme.atlassian.net', token: 'sekrit' });
      return yield* store.get('jira');
    });
    expect(result).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      token: 'sekrit',
    });
  });

  it('set is whole-replace, not merge (later set drops earlier keys)', async () => {
    const result = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('jira', { baseUrl: 'https://a', token: 'old' });
      yield* store.set('jira', { token: 'new' });
      return yield* store.get('jira');
    });
    // `baseUrl` is gone — set is whole-replace, not merge.
    expect(result).toEqual({ token: 'new' });
  });

  it('clear removes a previously-set config', async () => {
    const result = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('jira', { token: 'x' });
      yield* store.clear('jira');
      return yield* store.get('jira');
    });
    expect(result).toBeUndefined();
  });

  it('clear on a never-set app is a no-op', async () => {
    await expect(
      run(function* () {
        const store = createInMemoryConfigStore();
        yield* store.clear('never-set');
      }),
    ).resolves.not.toThrow();
  });

  it('configs for different apps are isolated', async () => {
    const result = await run(function* () {
      const store = createInMemoryConfigStore();
      yield* store.set('web', { tavilyKey: 'web-key' });
      yield* store.set('corpus', { resourcePaths: ['./docs'] });
      const web = yield* store.get('web');
      const corpus = yield* store.get('corpus');
      return { web, corpus };
    });
    expect(result.web).toEqual({ tavilyKey: 'web-key' });
    expect(result.corpus).toEqual({ resourcePaths: ['./docs'] });
  });
});
