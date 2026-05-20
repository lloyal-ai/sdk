import type { Command } from '../command';
import { createCommand } from './create';
import { appCommand } from './app';

/**
 * The default command — runs when no recognized subcommand is given
 * (bare `harness.dev <name>` scaffolds a harness). Also reachable as the
 * explicit `create` verb.
 */
export const DEFAULT_COMMAND = createCommand;

/** Named subcommands, in help-listing order. */
export const SUBCOMMANDS: readonly Command[] = [appCommand];

/** Resolve a typed token to a subcommand (or the explicit `create` verb). */
export function findCommand(name: string): Command | undefined {
  if (name === createCommand.name) return createCommand;
  return SUBCOMMANDS.find((c) => c.name === name);
}
