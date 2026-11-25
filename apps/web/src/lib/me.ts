'use client';

import { MeResponse, ROLE_LABELS, type Role } from '@repairos/contracts';
import { useQuery } from '@tanstack/react-query';
import { noteMe } from './access-removed';
import { apiFetch, isApiRequestError } from './api';

export const meQueryKey = ['me'] as const;

/**
 * GET /api/me. Resolves to null when signed out (401). Every body is also fed to the
 * access-removed latch, even when React Query later discards this fetch for a newer one.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  let me: MeResponse | null;
  try {
    me = await apiFetch('/api/me', MeResponse);
  } catch (err) {
    if (isApiRequestError(err) && err.status === 401) me = null;
    else throw err;
  }
  noteMe(me);
  return me;
}

/**
 * Refetched on every window focus, even when fresh (and on any 403, see providers), so role changes
 * apply promptly and a shop switch made in another tab is picked up as soon as this tab is used
 * (review M3: shop-scoped data is then dropped, see lib/shop-cache).
 */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
  });
}

export function roleLabel(role: Role | null | undefined): string {
  return role ? ROLE_LABELS[role] : 'No role';
}
