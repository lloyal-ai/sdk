/**
 * harness.json — transparent per-workspace config for the deep-research
 * example.
 *
 * Precedence at read time:   CLI flag > env var > harness.json > default.
 * Precedence at write time:  env-set secrets are NEVER persisted to disk;
 *                            everything else roundtrips through harness.json.
 *
 * Storage shape is intentionally small and scoped — see `Config` below.
 * Writes are atomic (tmp-file + rename). First save in a git repo auto-
 * appends the file to `.gitignore`; the caller gets back a flag that can
 * be shown in a toast so the user knows what landed on disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_CONFIG_PATH = './harness.json';

export interface ConfigSources {
  tavilyKey?: string;
  corpusPath?: string;
}

export interface ConfigDefaults {
  reasoningMode: 'flat' | 'deep';
  verifyCount: number;
  maxTurns: number;
}

export interface ConfigModel {
  path?: string;
  reranker?: string;
}

export interface Config {
  version: 1;
  sources: ConfigSources;
  defaults: ConfigDefaults;
  model: ConfigModel;
}

/** Which layer supplied a given field — used for composer UI hints like
 *  `Tavily ✓ (env)`. Computed per-field at loadConfig time. */
export interface ConfigOrigin {
  tavilyKey: 'env' | 'file' | 'cli' | 'unset';
  corpusPath: 'file' | 'cli' | 'unset';
  reasoningMode: 'cli' | 'file' | 'default';
  modelPath: 'cli' | 'file' | 'default';
  reranker: 'cli' | 'file' | 'default';
}

export interface LoadedConfig {
  config: Config;
  origin: ConfigOrigin;
  path: string;
  /** true iff harness.json existed on disk and was read successfully. */
  loadedFromFile: boolean;
}

export interface CliOverrides {
  tavilyKey?: string;
  corpusPath?: string;
  reasoningMode?: 'flat' | 'deep';
  modelPath?: string;
  reranker?: string;
}

export interface SaveResult {
  path: string;
  /** true iff this save appended `harness.json` to `.gitignore` during this
   *  call. Only ever true on the very first save in a git repo. */
  gitignored: boolean;
  /** Fields that were IN the patch but deliberately skipped (env won). */
  skipped: string[];
}

// ── Defaults ────────────────────────────────────────────────────────

function builtinDefaults(): Config {
  return {
    version: 1,
    sources: {},
    defaults: {
      reasoningMode: 'deep',
      verifyCount: 3,
      maxTurns: 10,
    },
    model: {},
  };
}

// ── Load ────────────────────────────────────────────────────────────

function readFileIfExists(p: string): Config | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config> & { version?: number };
    if (parsed.version !== 1) {
      // Future: migrate older versions. For now, ignore and rebuild.
      return null;
    }
    const defaults = builtinDefaults();
    return {
      version: 1,
      sources: { ...defaults.sources, ...(parsed.sources ?? {}) },
      defaults: { ...defaults.defaults, ...(parsed.defaults ?? {}) },
      model: { ...defaults.model, ...(parsed.model ?? {}) },
    };
  } catch {
    return null;
  }
}

export function loadConfig(
  configPath: string | undefined,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  const resolvedPath = path.resolve(configPath ?? DEFAULT_CONFIG_PATH);
  const fromFile = readFileIfExists(resolvedPath);
  const base = fromFile ?? builtinDefaults();

  const envTavily = env.TAVILY_API_KEY?.trim() || undefined;

  // ── Merge with precedence: CLI > env > file > default ──
  const tavilyKey = cli.tavilyKey ?? envTavily ?? base.sources.tavilyKey;
  const corpusPath = cli.corpusPath ?? base.sources.corpusPath;
  const reasoningMode =
    cli.reasoningMode ?? base.defaults.reasoningMode ?? 'deep';
  const modelPath = cli.modelPath ?? base.model.path;
  const reranker = cli.reranker ?? base.model.reranker;

  const config: Config = {
    version: 1,
    sources: { tavilyKey, corpusPath },
    defaults: {
      reasoningMode,
      verifyCount: base.defaults.verifyCount,
      maxTurns: base.defaults.maxTurns,
    },
    model: { path: modelPath, reranker },
  };

  const origin: ConfigOrigin = {
    tavilyKey: cli.tavilyKey
      ? 'cli'
      : envTavily
        ? 'env'
        : base.sources.tavilyKey
          ? 'file'
          : 'unset',
    corpusPath: cli.corpusPath
      ? 'cli'
      : base.sources.corpusPath
        ? 'file'
        : 'unset',
    reasoningMode: cli.reasoningMode
      ? 'cli'
      : fromFile?.defaults.reasoningMode
        ? 'file'
        : 'default',
    modelPath: cli.modelPath ? 'cli' : fromFile?.model.path ? 'file' : 'default',
    reranker: cli.reranker ? 'cli' : fromFile?.model.reranker ? 'file' : 'default',
  };

  return { config, origin, path: resolvedPath, loadedFromFile: !!fromFile };
}

// ── Save ────────────────────────────────────────────────────────────

/** Writes `harness.json` atomically with a tmp-file-and-rename. Honors the
 *  "don't persist env-provided secrets" rule: if `TAVILY_API_KEY` is set
 *  and the patch included a `sources.tavilyKey`, that field is dropped and
 *  reported in `skipped`. */
export function saveConfig(
  patch: Partial<Config>,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SaveResult {
  const resolvedPath = path.resolve(configPath ?? DEFAULT_CONFIG_PATH);
  const current = readFileIfExists(resolvedPath) ?? builtinDefaults();

  const skipped: string[] = [];
  const nextSources: ConfigSources = {
    ...current.sources,
    ...(patch.sources ?? {}),
  };
  if (env.TAVILY_API_KEY && patch.sources && 'tavilyKey' in patch.sources) {
    // Env wins — drop any attempted write of the secret.
    delete nextSources.tavilyKey;
    skipped.push('sources.tavilyKey');
  }

  const next: Config = {
    version: 1,
    sources: nextSources,
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
    model: { ...current.model, ...(patch.model ?? {}) },
  };

  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = resolvedPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, resolvedPath);

  const gitignored = maybeAppendGitignore(resolvedPath);
  return { path: resolvedPath, gitignored, skipped };
}

/** If CWD (or an ancestor) is a git repo, append `harness.json` to the
 *  nearest `.gitignore` iff the file isn't already ignored. Returns true
 *  when a write happened; false if we didn't touch the file (not a repo,
 *  or already ignored, or IO failure — all benign). Called on EVERY save,
 *  but only ever mutates on the first call per repo. */
function maybeAppendGitignore(configFilePath: string): boolean {
  try {
    const repoRoot = findGitRoot(path.dirname(configFilePath));
    if (!repoRoot) return false;
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const relative = path
      .relative(repoRoot, configFilePath)
      .replace(/\\/g, '/');
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : '';
    // Match if the file is already listed verbatim, as a filename-only entry,
    // or via a wildcard like `harness.json` anywhere in the file.
    const name = path.basename(configFilePath);
    const needle = new RegExp(
      `(^|\\n)\\s*(${escapeRe(relative)}|${escapeRe(name)})\\s*(\\n|$)`,
    );
    if (needle.test(existing)) return false;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, prefix + relative + '\n');
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
