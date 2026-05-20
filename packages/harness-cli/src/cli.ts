#!/usr/bin/env node
/**
 * `harness.dev` — the Harness Development Kit CLI.
 *
 * Thin dispatcher. The first positional selects a named subcommand
 * (currently just `app`); if it isn't one, the whole argv is treated as
 * the default action — scaffolding a harness (`harness.dev <name>`),
 * also reachable as the explicit `create` verb.
 * Global `--help` / `--version` are handled here; all other flag parsing
 * belongs to the individual command.
 *
 * The package and the bin share the name `harness.dev`, so the
 * invocation is identical whether run via `npx harness.dev …` or as the
 * globally-installed `harness.dev …` command.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMMAND, findCommand } from './commands';

function version(): string {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function printHelp(): void {
  process.stdout.write(
    [
      'harness.dev — Harness Development Kit CLI',
      '',
      'Usage:',
      '  npx harness.dev <name>            Scaffold a new harness',
      '  npx harness.dev app <name>        Scaffold a new app',
      '',
      'After `npm i -g harness.dev`, drop the `npx ` prefix.',
      '',
      'Options:',
      '  -h, --help     Show this help',
      '  -v, --version  Print the version',
      '',
      'Run `npx harness.dev <command> --help` for command-specific options.',
      '',
    ].join('\n'),
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return 0;
  }

  const named = findCommand(first);
  if (named) {
    return named.run(rest);
  }

  // Not a recognized subcommand → default action (scaffold a harness),
  // treating `first` as the harness name.
  return DEFAULT_COMMAND.run([...argv]);
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
