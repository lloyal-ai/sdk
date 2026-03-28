import type { Operation } from 'effection';
import { Tool } from '../../src/Tool';
import type { JsonSchema } from '../../src/types';

/**
 * Configurable mock tool for tests.
 * Returns a fixed result or an error.
 */
export class MockTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  private _result: unknown;

  constructor(name: string, opts?: { result?: unknown; description?: string }) {
    super();
    this.name = name;
    this.description = opts?.description ?? `mock ${name}`;
    this.parameters = { type: 'object', properties: {} };
    this._result = opts?.result ?? {};
  }

  *execute(): Operation<unknown> {
    return this._result;
  }
}
