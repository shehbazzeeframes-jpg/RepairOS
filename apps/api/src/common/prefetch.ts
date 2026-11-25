import type { IncomingHttpHeaders } from 'node:http';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase() ?? '';

/**
 * True for speculative requests the user did not ask for (BUG-02): Next.js router prefetches
 * (`Next-Router-Prefetch: 1`), and browser link prefetch / speculation rules (`Purpose: prefetch`,
 * `Sec-Purpose: prefetch` or `prefetch;prerender`, Firefox's `X-Moz: prefetch`). GET endpoints with side effects
 * skip them.
 */
export function isPrefetchRequest(headers: IncomingHttpHeaders): boolean {
  if (first(headers['next-router-prefetch']) !== '') return true;
  const purposes = [first(headers['purpose']), first(headers['sec-purpose']), first(headers['x-purpose']), first(headers['x-moz'])];
  return purposes.some((p) => p.split(/[;,\s]+/).includes('prefetch'));
}
