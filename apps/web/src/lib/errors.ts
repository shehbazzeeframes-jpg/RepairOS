import { API_ERROR_MESSAGES, ApiErrorCode } from '@repairos/contracts';
import { isApiRequestError } from './api';

const FALLBACK = 'Something went wrong. Please try again.';

/** The contract error code of an API failure, or null (network, invalid response, unknown code). */
export function errorCode(err: unknown): ApiErrorCode | null {
  if (!isApiRequestError(err)) return null;
  const parsed = ApiErrorCode.safeParse(err.body.code);
  return parsed.success ? parsed.data : null;
}

/** True when `err` is an API failure with one of the given codes. */
export function hasErrorCode(err: unknown, ...codes: ApiErrorCode[]): boolean {
  const code = errorCode(err);
  return code !== null && codes.includes(code);
}

/** Fill `{placeholders}` in a template; null if any stays unfilled. */
export function fillTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string | null {
  const filled = template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
  return /\{\w+\}/.test(filled) ? null : filled;
}

/**
 * User-facing copy for an error: `API_ERROR_MESSAGES[code]` with placeholders filled from `vars`.
 * Falls back to the API's own (already substituted) message when a placeholder is unknown or the
 * code has no copy.
 */
export function errorMessage(err: unknown, vars: Record<string, string | undefined> = {}): string {
  if (!isApiRequestError(err)) return err instanceof Error && err.message ? err.message : FALLBACK;
  const code = errorCode(err);
  const template = code ? API_ERROR_MESSAGES[code] : undefined;
  if (template) {
    const filled = fillTemplate(template, vars);
    if (filled) return filled;
  }
  return err.body.message || FALLBACK;
}
