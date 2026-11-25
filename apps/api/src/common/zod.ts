import { Body, type PipeTransform, Query } from '@nestjs/common';
import { validationFailed } from './errors';

/**
 * Structural type for a Zod schema (contracts own the zod dependency; the API never builds its own
 * schemas, it validates with the shared ones).
 */
export interface ParseSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ParseSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw validationFailed(result.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
}

/** `@ZodBody(CreateShopInput) input: CreateShopInput` validates the body with a contracts schema. */
export const ZodBody = <T>(schema: ParseSchema<T>) => Body(new ZodValidationPipe(schema));
export const ZodQuery = <T>(schema: ParseSchema<T>) => Query(new ZodValidationPipe(schema));
