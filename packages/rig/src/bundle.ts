/**
 * Signed-bundle App distribution — RFC §5.7, §8.
 *
 * Hosted bundles are ESM modules whose default export is a zero-arg
 * `Operation<App>` factory — *identical* in shape to the npm-distributed
 * path. Bundles ship signed with Ed25519; the harness configures a
 * `trustRoots: Map<publisherKeyId, publicKey>` and `loadBundle` refuses
 * to import anything whose signature doesn't match a configured trust
 * root (RFC §8.4).
 *
 * **Two-step verify-then-import.** `verifyBundle` is a synchronous pure
 * check the caller runs *before* `loadBundle` ever evaluates the bundle
 * source. `loadBundle` invokes verification internally too — bypassing
 * it via direct ESM import would let a malicious bundle execute
 * top-level side effects before the signature gate runs.
 *
 * **`loadBundle` is `Operation` but not `resource()`** (RFC §6.2):
 * loaded modules can't be unloaded in Node, so there's no scope-bound
 * teardown to perform. `loadBundle` returns an `AppFactory`; whoever
 * enables it next (`createAppRegistry({ apps })` / `registry.enable`)
 * runs it in a detached scope that owns the constructed App's teardown.
 *
 * @packageDocumentation
 * @category Contract
 */

import { call } from 'effection';
import type { Operation } from 'effection';
import type { AppFactory } from '@lloyal-labs/lloyal-agents';
import { cancellableFetch } from './cancellable-fetch';

/**
 * Manifest describing a signed bundle. Typically fetched from a
 * catalog index (RFC §8.5) alongside the bundle URL.
 */
export interface AppBundleManifest {
  /** App identifier (matches `App.manifest.name` after load). */
  name: string;
  /** Semver of this bundle release. */
  version: string;
  /**
   * Path/URL of the ESM module relative to the bundle root. The
   * caller provides this *or* the absolute `bundleUrl` to
   * `loadBundle`; this field is the canonical record of what was
   * signed (signature is over `entry`'s bytes).
   */
  entry: string;
  /** Base64-encoded Ed25519 signature over the bundle bytes. */
  signature: string;
  /**
   * Identifier of the publisher's signing key. The harness looks
   * this up in its `trustRoots` map to obtain the verifying key.
   */
  publisherKeyId: string;
  /** Declared bundle size in bytes (sanity check vs. download). */
  sizeBytes: number;
  /**
   * peerDependencies of the bundle (e.g., `{"@lloyal-labs/rig":
   * "^3.0.0"}`). Informational; harness may pre-flight check.
   */
  peerDependencies?: Record<string, string>;
}

/**
 * Options for {@link loadBundle}.
 */
export interface LoadBundleOptions {
  /**
   * Map from `publisherKeyId` to Ed25519 raw public key bytes (32
   * bytes). The harness owns this map; framework refuses any
   * `publisherKeyId` not present.
   */
  trustRoots: Map<string, Uint8Array>;
  /**
   * Override the HTTP fetch implementation for testing. Defaults to
   * the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * HTTP timeout per `cancellableFetch` semantics. Defaults to
   * `cancellableFetch`'s own default (30 s).
   */
  timeoutMs?: number;
}

/**
 * Raised when `loadBundle` rejects a bundle for any signature,
 * size, or trust-roots reason. Distinct from network errors raised
 * by `cancellableFetch`.
 */
export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleVerificationError';
  }
}

/**
 * Verify an Ed25519 signature over `bytes` using `publicKey` (32-byte
 * raw key). Returns `true` if the signature is authentic; `false`
 * otherwise. Pure / synchronous in spirit, but `crypto.subtle.verify`
 * is async so the function returns a `Promise<boolean>`.
 *
 * The RFC §5.7 signature shows `verifyBundle` as sync — that's because
 * the WebCrypto API used to expose synchronous Ed25519 verification
 * via `crypto.sign.verify`. With WebCrypto we accept the Promise
 * shape; callers `yield* call(() => verifyBundle(...))` to bridge.
 */
export async function verifyBundle(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureBase64);
  } catch {
    return false;
  }
  if (publicKey.byteLength !== 32) return false;
  if (signature.byteLength !== 64) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    toArrayBuffer(signature),
    toArrayBuffer(bytes),
  );
}

/**
 * Fetch a signed bundle, verify its Ed25519 signature against the
 * harness's `trustRoots`, dynamically import the ESM module, and return
 * its default-exported {@link AppFactory} (a zero-arg `Operation<App>`).
 *
 * **It returns the factory; it does not invoke it.** Construction is the
 * registry's job — `createAppRegistry({ apps })` / `registry.enable` runs
 * the factory inside the app's detached scope so the App's `ensure(...)`
 * teardown is bound to that scope and `AppConfigStoreCtx` / `RerankerCtx`
 * are seeded into it (RFC §5.7, §6). Usage:
 * `createAppRegistry({ configStore, apps: [yield* loadBundle(...)] })`.
 *
 * Failure modes (all raised as {@link BundleVerificationError}):
 * - `publisherKeyId` not present in `trustRoots`
 * - Downloaded byte length does not match `manifest.sizeBytes`
 * - Signature verification fails
 * - Imported module has no default export or default is not a function
 *
 * Verification always runs *before* import, so a tampered cache is
 * caught at load time, not trusted from download. Network errors during
 * fetch propagate from `cancellableFetch` (e.g., `FetchTimeoutError`).
 *
 * **Dynamic `import()` justification.** This is the documented
 * exception to the no-inline-imports rule (CLAUDE.md feedback memo):
 * loading a *runtime-fetched* ESM module is the entire feature, and
 * the import target cannot be known until after the bytes are
 * verified. The top-level imports of this file remain conventional;
 * only the bundle source itself is loaded via dynamic `import()`.
 */
export function* loadBundle(
  bundleUrl: string,
  manifest: AppBundleManifest,
  options: LoadBundleOptions,
): Operation<AppFactory> {
  const trustKey = options.trustRoots.get(manifest.publisherKeyId);
  if (!trustKey) {
    throw new BundleVerificationError(
      `No trust root configured for publisherKeyId="${manifest.publisherKeyId}" — ` +
        `harness must register the publisher's public key before loading this bundle.`,
    );
  }

  const response = yield* cancellableFetch(bundleUrl, undefined, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) {
    throw new BundleVerificationError(
      `Bundle fetch from ${bundleUrl} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const bytes = new Uint8Array(yield* call(() => response.arrayBuffer()));

  if (bytes.byteLength !== manifest.sizeBytes) {
    throw new BundleVerificationError(
      `Bundle size mismatch: manifest declares ${manifest.sizeBytes} bytes but ` +
        `downloaded ${bytes.byteLength} bytes — possible tampering or stale manifest.`,
    );
  }

  const ok = yield* call(() => verifyBundle(bytes, manifest.signature, trustKey));
  if (!ok) {
    throw new BundleVerificationError(
      `Ed25519 signature verification failed for bundle "${manifest.name}@${manifest.version}" ` +
        `(publisherKeyId="${manifest.publisherKeyId}"). The bundle was tampered with, the ` +
        `signature is corrupted, or the manifest's publisherKeyId is wrong.`,
    );
  }

  // Documented exception to the no-inline-imports rule: a *runtime-fetched*
  // ESM module is the entire feature. Top-level imports of this file are
  // conventional; only the verified bundle bytes are imported dynamically.
  const dataUrl = `data:text/javascript;base64,${bytesToBase64(bytes)}`;
  const module = (yield* call(() =>
    import(/* @vite-ignore */ dataUrl).then((m) => m as { default?: unknown }),
  )) as { default?: unknown };

  const factory = module.default;
  if (typeof factory !== 'function') {
    throw new BundleVerificationError(
      `Bundle "${manifest.name}@${manifest.version}" has no default export, or the ` +
        `default export is not a function. Bundles must default-export a zero-arg ` +
        `generator factory returning Operation<App>.`,
    );
  }

  // Return the factory; the registry runs it inside the app's detached
  // scope where the framework contexts are seeded and the App's teardown
  // can be bound (RFC §5.7, §6).
  return factory as AppFactory;
}

// ── Helpers ───────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Coerce a `Uint8Array` whose underlying buffer is `ArrayBufferLike`
 * (could be SharedArrayBuffer-backed) into a fresh `ArrayBuffer` copy.
 * WebCrypto's typed signature rejects `SharedArrayBuffer`-backed
 * inputs; this is the simplest portable cast that satisfies the
 * `BufferSource` constraint in lib.dom.d.ts.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}
