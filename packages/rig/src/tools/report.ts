import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema } from '@lloyal-labs/lloyal-agents';

/**
 * Terminal tool for submitting agent results
 *
 * Used as the `terminalTool` in agent pools — when an agent calls
 * this tool, the pool records the result string and marks the agent
 * as finished. The tool itself is a no-op; the agent pool intercepts
 * the call and extracts the `result` argument.
 *
 * @category Rig
 */
export class ReportTool extends Tool<{ result: string }> {
  readonly name = 'report';
  readonly description: string;
  readonly parameters: JsonSchema;

  constructor(opts?: {
    /** Override the tool description shown in the agent's tool schema. */
    description?: string;
    /** Override the result parameter description. */
    resultDescription?: string;
  }) {
    super();
    this.description = opts?.description ??
      'Submit your final research findings with specific evidence, direct quotes, data points, and source URLs from the pages you read. State what you found AND what you checked but could not find. Do not summarize — preserve detail.';
    this.parameters = {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: opts?.resultDescription ??
            'Detailed findings with direct quotes, data points, and source URLs. Include what was found and what was not found.',
        },
      },
      required: ['result'],
    };
  }

  *execute(): Operation<unknown> { return {}; }
}
