'use client';

import type { MeResponse } from '@repairos/contracts';
import { useSyncExternalStore } from 'react';

export type AccessRemoved = NonNullable<MeResponse['accessRemoved']>;

/**
 * Latch for the in-app "You no longer have access to {shop}" banner (S5.5, QA BUG-03).
 *
 * The API reports `accessRemoved` once: the first GET /api/me after the fallback carries it and the
 * next one returns null. An in-app action can trigger two /me fetches in a row (each 403 refetches
 * /me, and a newer fetch cancels the older one, so React Query may never render the first body).
 * So every /me body is fed in here as it arrives (see `fetchMe`), and the first non-null value is
 * kept until the user dismisses it or signs out.
 */
let latched: AccessRemoved | null = null;
const listeners = new Set<() => void>();

function set(next: AccessRemoved | null) {
  if (next === latched) return;
  latched = next;
  for (const listener of listeners) listener();
}

/** Call with every GET /api/me result: keeps a non-null `accessRemoved`, clears on sign-out (null). */
export function noteMe(me: MeResponse | null): void {
  if (me === null) set(null);
  else if (me.accessRemoved && me.accessRemoved.shopId !== latched?.shopId) set(me.accessRemoved);
}

export function dismissAccessRemoved(): void {
  set(null);
}

export function getAccessRemoved(): AccessRemoved | null {
  return latched;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The latched banner value, or null. Hidden while the removed shop is the active one again
 * (e.g. the user was reactivated and switched back).
 */
export function useAccessRemoved(activeShopId: string | null): AccessRemoved | null {
  const value = useSyncExternalStore(subscribe, getAccessRemoved, () => null);
  return value && value.shopId !== activeShopId ? value : null;
}
