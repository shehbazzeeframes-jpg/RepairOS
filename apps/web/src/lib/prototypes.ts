/**
 * Design prototypes under /prototype/* (local mock data, no API writes) exist in dev builds and in
 * the e2e build that sets NEXT_PUBLIC_PROTOTYPES=1; a production build serves a 404 (like /dev/outbox).
 */
export function isPrototypeEnabled(env: {
  NODE_ENV?: string;
  NEXT_PUBLIC_PROTOTYPES?: string;
}): boolean {
  return env.NODE_ENV !== 'production' || env.NEXT_PUBLIC_PROTOTYPES === '1';
}
