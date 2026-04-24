/**
 * Model catalog + download helper for the deep-research example.
 *
 * Two entries today: the default Qwen3.5-4B Q4_K_M LLM and the
 * Qwen3-Reranker 0.6B Q8_0 reranker. Extend by adding a new
 * ModelCatalogEntry; no plumbing changes required.
 *
 * `resolveModelPath` maps a configured value (CLI arg, env, harness.json,
 * or a catalog id) to a filesystem path. `downloadIfMissing` atomically
 * streams the catalog entry into the XDG cache; progress reporting is
 * pushed through a caller-supplied `onProgress` callback so main.ts can
 * route updates into Ink events.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Catalog ──────────────────────────────────────────────────────

export interface ModelCatalogEntry {
  /** Stable identifier. Stored in harness.json `model.path` / `model.reranker`. */
  id: string;
  /** Human-readable label used in progress lines and error messages. */
  label: string;
  /** Role within the deep-research pipeline. */
  kind: "llm" | "reranker";
  /** Huggingface resolve/main URL (raw bytes). NOT the /blob/ web page. */
  url: string;
  /** Filename inside the cache dir — basename of the URL. */
  filename: string;
  /** Approximate size in bytes. Used as a fallback when a Content-Length
   *  header isn't available for progress ETA. */
  sizeBytes: number;
  /** Suggested LLM context size. Used only when no CLI/env/file value is
   *  provided and the caller picks a default per model family. */
  recommendedNCtx?: number;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "qwen3.5-4b-q4",
    label: "Qwen3.5-4B Q4_K_M",
    kind: "llm",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    filename: "Qwen3.5-4B-Q4_K_M.gguf",
    sizeBytes: 2_600_000_000,
    recommendedNCtx: 32768,
  },
  {
    id: "qwen3-reranker-0.6b-q8",
    label: "Qwen3-Reranker 0.6B Q8_0",
    kind: "reranker",
    url: "https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf",
    filename: "qwen3-reranker-0.6b-q8_0.gguf",
    sizeBytes: 630_000_000,
  },
];

/** First LLM entry, used when no `model.path` is configured. */
export const DEFAULT_LLM = MODEL_CATALOG.find((e) => e.kind === "llm")!;
/** First reranker entry, used when no `model.reranker` is configured. */
export const DEFAULT_RERANKER = MODEL_CATALOG.find((e) => e.kind === "reranker")!;

// ── Cache directory ──────────────────────────────────────────────

/** XDG-compliant cache directory for downloaded models. Respects
 *  `XDG_CACHE_HOME`; otherwise `~/.cache/lloyal/models/`. */
export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "lloyal", "models");
}

// ── Resolution ───────────────────────────────────────────────────

export interface ResolvedModel {
  /** Absolute filesystem path where the file should live. */
  path: string;
  /** The catalog entry, if the value matched an id or we fell back to
   *  the kind's default. Null for a user-supplied explicit path. */
  entry: ModelCatalogEntry | null;
}

/** Map a configured value to a filesystem path.
 *
 * - Unset → cache path for the kind's default entry.
 * - Matches a catalog id → cache path for that entry.
 * - Anything else → treated as an explicit filesystem path (returned as-is,
 *   no download).
 */
export function resolveModelPath(
  configValue: string | undefined,
  kind: "llm" | "reranker",
): ResolvedModel {
  if (!configValue) {
    const entry = kind === "llm" ? DEFAULT_LLM : DEFAULT_RERANKER;
    return { path: path.join(cacheDir(), entry.filename), entry };
  }
  const byId = MODEL_CATALOG.find((e) => e.id === configValue);
  if (byId) {
    return { path: path.join(cacheDir(), byId.filename), entry: byId };
  }
  return { path: path.resolve(configValue), entry: null };
}

// ── Download ─────────────────────────────────────────────────────

/** Stream a catalog entry into the cache atomically. No-op if the file
 *  already exists. `onProgress` is called throttled (~5 Hz) during the
 *  transfer — callers pipe it into Ink events (TTY) or stderr one-liners
 *  (non-TTY). Returns the final dest path. */
export async function downloadIfMissing(
  entry: ModelCatalogEntry,
  opts: { onProgress?: (got: number, total: number) => void } = {},
): Promise<string> {
  const dest = path.join(cacheDir(), entry.filename);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(cacheDir(), { recursive: true });
  const tmp = dest + ".partial";
  try { fs.unlinkSync(tmp); } catch { /* stale, or first run */ }

  const res = await fetch(entry.url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${entry.url}`);
  }
  const total = Number(res.headers.get("content-length") ?? entry.sizeBytes);

  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastEmit = 0;

  const emit = (final = false): void => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!final && now - lastEmit < 200) return;
    lastEmit = now;
    opts.onProgress(got, total);
  };

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      out.write(chunk);
      got += chunk.byteLength;
      emit();
    }
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  fs.renameSync(tmp, dest);
  emit(true);
  return dest;
}

