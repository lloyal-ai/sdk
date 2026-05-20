import { parseArgs } from 'node:util';
import type { Command } from '../command';

const USAGE = [
  'harness.dev — scaffold a new harness project (the default action)',
  '',
  'Usage:',
  '  npx harness.dev <name> [--dir <path>]',
  '',
  'Arguments:',
  '  <name>        Harness project name — also the directory created.',
  '',
  'Options:',
  '  --dir <path>  Parent directory to create the harness in (default: cwd)',
  '  -h, --help    Show this help',
  '',
  'Emits a runnable harness: pool wiring, createAppRegistry({ apps }),',
  'an AppConfigStore, and model boot. Scaffold apps with `harness.dev app`.',
].join('\n');

export const createCommand: Command = {
  name: 'create',
  summary: 'Scaffold a new harness (the default action — name is optional verb)',
  usage: USAGE,
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        dir: { type: 'string' },
      },
      allowPositionals: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    const name = positionals[0];
    if (!name) {
      process.stderr.write('harness.dev: missing harness <name>\n\n' + USAGE + '\n');
      return 1;
    }

    process.stderr.write(
      `harness.dev: not yet implemented.\n` +
        `Would scaffold harness "${name}"` +
        (values.dir ? ` in ${values.dir}` : '') +
        `.\n`,
    );
    return 1;
  },
};
