'use client';

import { useSyncExternalStore } from 'react';

/**
 * Latch for the "You're now working in {shop}" banner (A13 finish, spec §0.2).
 *
 * An API answer of 409 ACTIVE_SHOP_CHANGED (or a response whose echoed X-Shop-Id differs) means
 * another tab switched shop. The providers note the shop this page was rendered for and refetch
 * /api/me; the shell then remounts under the new shop (keyed by shop id), which would throw away
 * any component state, so the banner's state lives here at module level.
 */
export interface ShopChange {
  /** The shop the page was rendered for when the mismatch was seen. */
  fromShopId: string;
}

let latched: ShopChange | null = null;
const listeners = new Set<() => void>();

function set(next: ShopChange | null) {
  latched = next;
  for (const l of listeners) l();
}

/** Called when ACTIVE_SHOP_CHANGED is seen; `fromShopId` = the shop the page was rendered for. */
export function noteShopChanged(fromShopId: string | null): void {
  if (fromShopId && latched?.fromShopId !== fromShopId) set({ fromShopId });
}

export function dismissShopChanged(): void {
  if (latched) set(null);
}

export function getShopChanged(): ShopChange | null {
  return latched;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The banner should show once the session's active shop differs from the shop the page was on
 * (until then the /me refetch is still in flight).
 */
export function useShopChanged(activeShopId: string | null): ShopChange | null {
  const value = useSyncExternalStore(subscribe, getShopChanged, () => null);
  return value && activeShopId && value.fromShopId !== activeShopId ? value : null;
}
