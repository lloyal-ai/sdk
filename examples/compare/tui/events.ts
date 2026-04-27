/**
 * Bus event union for the compare TUI.
 *
 * `DagEvent` is the canonical type the harness emits — defined once in
 * `../harness.ts` (the producer). Here we just compose it with the
 * runtime's `AgentEvent` to type the bus that the reducer consumes.
 */

import type { AgentEvent } from '@lloyal-labs/lloyal-agents';
import type { DagEvent } from '../harness';

export type WorkflowEvent = DagEvent | AgentEvent;
