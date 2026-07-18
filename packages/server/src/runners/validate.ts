import { Ajv } from 'ajv';

export class OutputValidationError extends Error {}

const ajv = new Ajv({ allErrors: true });

export function validateOutput(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new OutputValidationError(ajv.errorsText(validate.errors));
  }
}
