/**
 * The contract every `harness` subcommand implements. The dispatcher
 * ({@link ./cli}) resolves the first positional argument to a `Command`
 * and hands it the remaining argv; the command parses its own flags and
 * returns a process exit code.
 *
 * @packageDocumentation
 */

export interface Command {
  /** The token typed after `harness` (e.g. `create-app`). */
  readonly name: string;
  /** One-line description shown in the top-level help listing. */
  readonly summary: string;
  /** Full usage block shown by `harness <name> --help`. */
  readonly usage: string;
  /**
   * Execute the command with the argv that followed its name (the
   * command's name and the global `harness` token are already stripped).
   * Returns the process exit code (0 = success).
   */
  run(argv: string[]): Promise<number>;
}
