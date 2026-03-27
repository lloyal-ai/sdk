import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

/**
 * Terminal tool for submitting research findings
 *
 * Used as the `terminalTool` in agent pools -- when an agent calls
 * this tool, the pool records the findings string and marks the
 * agent as finished. The tool itself is a no-op; the agent pool
 * intercepts the call and extracts the `findings` argument.
 *
 * @category Rig
 */
export class ReportTool extends Tool<{ findings: string }> {
  readonly name = 'report';
  readonly description = 'Submit your final research findings with specific evidence, direct quotes, data points, and source URLs from the pages you read. State what you found AND what you checked but could not find. Do not summarize — preserve detail.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { findings: { type: 'string', description: 'Detailed findings with direct quotes, data points, and source URLs. Include what was found and what was not found.' } },
    required: ['findings'],
  };

  *execute(): Operation<unknown> { return {}; }
}
