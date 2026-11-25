'use client';

import { MeResponse, ROLE_LABELS, type Role } from '@repairos/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, isApiRequestError } from './api';

export const meQueryKey = ['me'] as const;

/** GET /api/me. Resolves to null when signed out (401). */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch('/api/me', MeResponse);
  } catch (err) {
    if (isApiRequestError(err) && err.status === 401) return null;
    throw err;
  }
}

/** Refetched on window focus (and on any 403, see providers) so role changes apply promptly. */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function roleLabel(role: Role | null | undefined): string {
  return role ? ROLE_LABELS[role] : 'No role';
}
