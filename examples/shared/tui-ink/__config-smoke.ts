/**
 * Config smoke test — verifies load precedence, env-guarded writes, and
 * auto-gitignore behavior against a scratch tmpdir.
 *
 *   npx tsx examples/shared/tui-ink/__config-smoke.ts
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, saveConfig } from './config';

function check(label: string, fn: () => void) {
  try {
    fn();
    process.stdout.write(`ok  ${label}\n`);
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

function scratchDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-smoke-${label}-`));
  return dir;
}

check('load: missing file → defaults', () => {
  const dir = scratchDir('missing');
  const { config, origin, loadedFromFile } = loadConfig(
    path.join(dir, 'harness.json'),
    {},
    {},
  );
  assert.equal(loadedFromFile, false);
  assert.equal(config.defaults.reasoningMode, 'deep');
  assert.equal(config.sources.tavilyKey, undefined);
  assert.equal(origin.tavilyKey, 'unset');
  assert.equal(origin.reasoningMode, 'default');
});

check('load: env var supplies tavilyKey', () => {
  const dir = scratchDir('env');
  const { config, origin } = loadConfig(
    path.join(dir, 'harness.json'),
    {},
    { TAVILY_API_KEY: 'tvly-env' },
  );
  assert.equal(config.sources.tavilyKey, 'tvly-env');
  assert.equal(origin.tavilyKey, 'env');
});

check('load: file supplies tavilyKey when env absent', () => {
  const dir = scratchDir('file');
  const file = path.join(dir, 'harness.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sources: { tavilyKey: 'tvly-file' },
      defaults: { reasoningMode: 'flat' },
    }),
  );
  const { config, origin } = loadConfig(file, {}, {});
  assert.equal(config.sources.tavilyKey, 'tvly-file');
  assert.equal(origin.tavilyKey, 'file');
  assert.equal(config.defaults.reasoningMode, 'flat');
  assert.equal(origin.reasoningMode, 'file');
});

check('load: precedence CLI > env > file > default', () => {
  const dir = scratchDir('prec');
  const file = path.join(dir, 'harness.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sources: { tavilyKey: 'tvly-file' },
      defaults: { reasoningMode: 'flat' },
    }),
  );
  const { config, origin } = loadConfig(
    file,
    { tavilyKey: 'tvly-cli', reasoningMode: 'deep' },
    { TAVILY_API_KEY: 'tvly-env' },
  );
  assert.equal(config.sources.tavilyKey, 'tvly-cli');
  assert.equal(origin.tavilyKey, 'cli');
  assert.equal(config.defaults.reasoningMode, 'deep');
  assert.equal(origin.reasoningMode, 'cli');
});

check('save: creates file, then reload returns same values', () => {
  const dir = scratchDir('save');
  const file = path.join(dir, 'harness.json');
  saveConfig(
    { sources: { tavilyKey: 'tvly-abc', corpusPath: '/tmp/x' } },
    file,
    {},
  );
  assert.equal(fs.existsSync(file), true);
  const { config } = loadConfig(file, {}, {});
  assert.equal(config.sources.tavilyKey, 'tvly-abc');
  assert.equal(config.sources.corpusPath, '/tmp/x');
});

check('save: env set → tavilyKey in patch is dropped', () => {
  const dir = scratchDir('envguard');
  const file = path.join(dir, 'harness.json');
  const result = saveConfig(
    { sources: { tavilyKey: 'tvly-should-be-skipped', corpusPath: '/tmp/y' } },
    file,
    { TAVILY_API_KEY: 'tvly-env' },
  );
  assert.deepEqual(result.skipped, ['sources.tavilyKey']);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.sources.tavilyKey, undefined);
  assert.equal(raw.sources.corpusPath, '/tmp/y');
});

check('save: merges patch with existing file (other fields preserved)', () => {
  const dir = scratchDir('merge');
  const file = path.join(dir, 'harness.json');
  saveConfig({ sources: { tavilyKey: 'tvly-a' } }, file, {});
  saveConfig({ sources: { corpusPath: '/tmp/z' } }, file, {});
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.sources.tavilyKey, 'tvly-a');
  assert.equal(raw.sources.corpusPath, '/tmp/z');
});

check('save: first save in git repo appends to .gitignore', () => {
  const dir = scratchDir('git');
  execSync('git init -q', { cwd: dir });
  const file = path.join(dir, 'harness.json');
  const r = saveConfig({ defaults: { reasoningMode: 'flat' } as never }, file, {});
  assert.equal(r.gitignored, true);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /\bharness\.json\b/);
});

check('save: second save does not re-append to .gitignore', () => {
  const dir = scratchDir('git-noop');
  execSync('git init -q', { cwd: dir });
  const file = path.join(dir, 'harness.json');
  saveConfig({ defaults: { reasoningMode: 'flat' } as never }, file, {});
  const r2 = saveConfig({ sources: { corpusPath: '/a' } }, file, {});
  assert.equal(r2.gitignored, false);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  const matches = gi.match(/\bharness\.json\b/g) ?? [];
  assert.equal(matches.length, 1);
});

check('save: non-git dir → gitignored=false, no .gitignore written', () => {
  const dir = scratchDir('nogit');
  const file = path.join(dir, 'harness.json');
  const r = saveConfig({ sources: { corpusPath: '/b' } }, file, {});
  assert.equal(r.gitignored, false);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
});

process.stdout.write('---\n');
process.stdout.write(process.exitCode ? 'FAILED\n' : 'all passed\n');
