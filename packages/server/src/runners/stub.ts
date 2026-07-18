import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

/** json-schema-faker-style minimal derivation (design §6.1 Stub). */
export function deriveFromSchema(schema: any): unknown {
  if (schema === undefined || schema === null) return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const keys: string[] = schema.required ?? Object.keys(props);
      for (const key of keys) out[key] = deriveFromSchema(props[key] ?? {});
      return out;
    }
    case 'array':
      return [];
    case 'string':
      return 'stub';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

export class StubRunner implements TaskRunner {
  constructor(private overrides: Record<string, Record<string, unknown>> = {}) {}

  async run(
    contract: AgentTaskContract | CodeTaskContract,
    _inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    const override = this.overrides[ctx.nodeId];
    if (override) return { output: override };
    return { output: deriveFromSchema(contract.outputSchema) as Record<string, unknown> };
  }
}
