/**
 * React access to the command dispatch function.
 *
 * `render()` creates a React context carrying a `dispatch(cmd)` that
 * sends into the Effection Signal shared with main.ts. Components call
 * `const dispatch = useCommand()` and fire commands directly.
 */

import { createContext, useContext } from 'react';
import type { Command } from '../commands';

export type CommandDispatch = (cmd: Command) => void;

const noop: CommandDispatch = () => {};

export const CommandContext = createContext<CommandDispatch>(noop);

export function useCommand(): CommandDispatch {
  return useContext(CommandContext);
}
