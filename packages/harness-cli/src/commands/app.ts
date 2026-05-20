import { parseArgs } from 'node:util';
import type { Command } from '../command';

const USAGE = [
  'harness.dev app — scaffold a new HDK app',
  '',
  'Usage:',
  '  npx harness.dev app <name> [--dir <path>]',
  '',
  'Arguments:',
  '  <name>        App name (lowercase, [a-z][a-z0-9_-]{1,63}) — also the',
  '                manifest `name` and the directory created for it.',
  '',
  'Options:',
  '  --dir <path>  Parent directory to create the app in (default: cwd)',
  '  -h, --help    Show this help',
  '',
  'Emits the minimum authoring surface (RFC §4.1): app.json, agent.eta,',
  'src/{index,source,tools/*}.ts, package.json, tsconfig.json, README.md.',
].join('\n');

export const appCommand: Command = {
  name: 'app',
  summary: 'Scaffold a new HDK app',
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
      process.stderr.write('harness.dev app: missing <name>\n\n' + USAGE + '\n');
      return 1;
    }

    process.stderr.write(
      `harness.dev app: not yet implemented (next up).\n` +
        `Would scaffold app "${name}"` +
        (values.dir ? ` in ${values.dir}` : '') +
        `.\n`,
    );
    return 1;
  },
};
