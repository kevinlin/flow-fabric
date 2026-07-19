import { describe, it, expectTypeOf } from 'vitest';
import type { InstanceDto, InstanceDetailDto, DefinitionMetricsDto } from '../src/index.js';

describe('API DTOs', () => {
  it('InstanceDto carries status and definition linkage', () => {
    expectTypeOf<InstanceDto>().toHaveProperty('status');
    expectTypeOf<InstanceDto>().toHaveProperty('definitionId');
    expectTypeOf<InstanceDto['definitionId']>().toEqualTypeOf<string | null>();
  });
  it('InstanceDetailDto bundles timeline + events', () => {
    expectTypeOf<InstanceDetailDto>().toHaveProperty('instance');
    expectTypeOf<InstanceDetailDto>().toHaveProperty('timeline');
    expectTypeOf<InstanceDetailDto>().toHaveProperty('events');
  });
  it('DefinitionMetricsDto exposes runs + successRate', () => {
    expectTypeOf<DefinitionMetricsDto['successRate']>().toEqualTypeOf<number | null>();
  });
});
