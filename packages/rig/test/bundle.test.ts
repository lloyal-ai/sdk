/**
 * Tests for {@link verifyBundle} and {@link loadBundle} — RFC §5.7, §8.
 *
 * Contracts verified:
 *
 * 1. **verifyBundle happy path** — a freshly generated keypair signs
 *    a payload; `verifyBundle` returns `true`.
 * 2. **verifyBundle rejects a tampered payload** — flipping one byte
 *    flips the result to `false`.
 * 3. **verifyBundle rejects a malformed signature** — wrong-length
 *    signature bytes, invalid base64.
 * 4. **loadBundle rejects unknown publisherKeyId** — manifest's
 *    `publisherKeyId` not in `trustRoots` raises
 *    {@link BundleVerificationError} before any fetch happens.
 * 5. **loadBundle rejects size mismatch** — manifest declares one
 *    size, fetch returns another.
 * 6. **loadBundle rejects bad signature** — fetched bytes don't
 *    match the manifest's signature.
 * 7. **loadBundle happy path** — fetch + verify + dynamic import +
 *    factory invocation produces an `App`.
 * 8. **loadBundle rejects bundles without a default-exported
 *    function** — module loads but the export shape is wrong.
 *
 * @category Testing
 */

import { describe, it, expect, vi } from 'vitest';
import { run } from 'effection';
import type { Operation } from 'effection';
import type { App, AppFactory } from '@lloyal-labs/lloyal-agents';
import {
  verifyBundle,
  loadBundle,
  BundleVerificationError,
  type AppBundleManifest,
} from '../src/bundle';

// ── Helpers: keypair + signing ───────────────────────────────────

async function generateKeypair(): Promise<{
  publicKey: Uint8Array;
  signKey: CryptoKey;
}> {
  const keypair = (await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey('raw', keypair.publicKey),
  );
  return { publicKey: rawPub, signKey: keypair.privateKey };
}

async function signBytes(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, key, buf),
  );
  let s = '';
  for (let i = 0; i < sig.length; i++) s += String.fromCharCode(sig[i]);
  return btoa(s);
}

// ── Bundle source authoring ─────────────────────────────────────

/**
 * Build an ESM module body whose default export is a zero-arg
 * generator factory returning an `App`-shaped object. Encoded as
 * UTF-8 bytes so signing covers the actual import source.
 */
function makeBundleSource(appName: string, contractName: string): Uint8Array {
  const src = `
export default function* () {
  return {
    name: ${JSON.stringify(appName)},
    version: '1.0.0',
    manifest: {
      name: ${JSON.stringify(appName)},
      version: '1.0.0',
      modelContractVersion: '3.0',
      contract: {
        name: ${JSON.stringify(contractName)},
        useWhen: 'test bundle',
        tools: ['x'],
      },
    },
    source: { name: ${JSON.stringify(appName)} },
    tools: [],
    agent: 'test agent template',
  };
}
`;
  return new TextEncoder().encode(src);
}

// ── verifyBundle ────────────────────────────────────────────────

describe('verifyBundle', () => {
  it('returns true for an authentic signature', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello bundle');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, publicKey)).toBe(true);
  });

  it('returns false when payload bytes are tampered', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('hello bundle');
    const sig = await signBytes(signKey, bytes);
    const tampered = new Uint8Array(bytes);
    tampered[0] ^= 0x01;
    expect(await verifyBundle(tampered, sig, publicKey)).toBe(false);
  });

  it('returns false for a wrong-length signature', async () => {
    const { publicKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    const badSig = btoa('short');
    expect(await verifyBundle(bytes, badSig, publicKey)).toBe(false);
  });

  it('returns false for invalid base64 signature', async () => {
    const { publicKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    expect(await verifyBundle(bytes, '!!! not base64 !!!', publicKey)).toBe(false);
  });

  it('returns false for a wrong-length public key', async () => {
    const { signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('payload');
    const sig = await signBytes(signKey, bytes);
    expect(await verifyBundle(bytes, sig, new Uint8Array(16))).toBe(false);
  });
});

// ── loadBundle ──────────────────────────────────────────────────

function makeFetchReturning(bytes: Uint8Array, status = 200): typeof fetch {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return vi.fn(async () => new Response(buf, { status })) as unknown as typeof fetch;
}

describe('loadBundle', () => {
  it('rejects when publisherKeyId is not in trustRoots', async () => {
    const manifest: AppBundleManifest = {
      name: 'orphan',
      version: '1.0.0',
      entry: 'orphan@1.0.0.mjs',
      signature: btoa('x'.repeat(64)),
      publisherKeyId: 'unknown-pub',
      sizeBytes: 0,
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      run(function* () {
        return yield* loadBundle('https://example.com/orphan.mjs', manifest, {
          trustRoots: new Map(),
          fetchImpl,
        });
      }),
    ).rejects.toBeInstanceOf(BundleVerificationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when fetched size does not match manifest.sizeBytes', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const realBytes = makeBundleSource('size_mismatch', 'size_mismatch_research');
    const realSig = await signBytes(signKey, realBytes);
    const manifest: AppBundleManifest = {
      name: 'size_mismatch',
      version: '1.0.0',
      entry: 'size_mismatch.mjs',
      signature: realSig,
      publisherKeyId: 'pub',
      sizeBytes: realBytes.byteLength + 999, // wrong
    };

    await expect(
      run(function* () {
        return yield* loadBundle('https://example.com/x.mjs', manifest, {
          trustRoots: new Map([['pub', publicKey]]),
          fetchImpl: makeFetchReturning(realBytes),
        });
      }),
    ).rejects.toThrow(/Bundle size mismatch/);
  });

  it('rejects when signature does not match fetched bytes', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const realBytes = makeBundleSource('bad_sig', 'bad_sig_research');
    const wrongSig = await signBytes(
      signKey,
      new TextEncoder().encode('some other payload'),
    );
    const manifest: AppBundleManifest = {
      name: 'bad_sig',
      version: '1.0.0',
      entry: 'bad_sig.mjs',
      signature: wrongSig,
      publisherKeyId: 'pub',
      sizeBytes: realBytes.byteLength,
    };

    await expect(
      run(function* () {
        return yield* loadBundle('https://example.com/x.mjs', manifest, {
          trustRoots: new Map([['pub', publicKey]]),
          fetchImpl: makeFetchReturning(realBytes),
        });
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('loads, verifies, and invokes a valid bundle', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = makeBundleSource('happy', 'happy_research');
    const sig = await signBytes(signKey, bytes);
    const manifest: AppBundleManifest = {
      name: 'happy',
      version: '1.0.0',
      entry: 'happy.mjs',
      signature: sig,
      publisherKeyId: 'pub',
      sizeBytes: bytes.byteLength,
    };

    // loadBundle returns the factory; invoking it (as the registry would)
    // produces the App.
    const app: App = await run(function* () {
      const factory = yield* loadBundle('https://example.com/happy.mjs', manifest, {
        trustRoots: new Map([['pub', publicKey]]),
        fetchImpl: makeFetchReturning(bytes),
      });
      return yield* factory();
    });

    expect(app.name).toBe('happy');
    expect(app.manifest.contract.name).toBe('happy_research');
  });

  it('rejects when default export is not a function', async () => {
    const { publicKey, signKey } = await generateKeypair();
    const bytes = new TextEncoder().encode('export default 42;\n');
    const sig = await signBytes(signKey, bytes);
    const manifest: AppBundleManifest = {
      name: 'not_fn',
      version: '1.0.0',
      entry: 'not_fn.mjs',
      signature: sig,
      publisherKeyId: 'pub',
      sizeBytes: bytes.byteLength,
    };

    await expect(
      run(function* (): Operation<App> {
        return yield* loadBundle('https://example.com/x.mjs', manifest, {
          trustRoots: new Map([['pub', publicKey]]),
          fetchImpl: makeFetchReturning(bytes),
        });
      }),
    ).rejects.toThrow(/no default export.*not a function/);
  });

  it('rejects non-200 HTTP responses', async () => {
    const { publicKey } = await generateKeypair();
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest: AppBundleManifest = {
      name: 'http_fail',
      version: '1.0.0',
      entry: 'http_fail.mjs',
      signature: btoa('x'.repeat(64)),
      publisherKeyId: 'pub',
      sizeBytes: 0,
    };

    await expect(
      run(function* () {
        return yield* loadBundle('https://example.com/missing.mjs', manifest, {
          trustRoots: new Map([['pub', publicKey]]),
          fetchImpl: makeFetchReturning(bytes, 404),
        });
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
