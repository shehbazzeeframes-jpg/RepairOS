'use client';

import type { MeResponse } from '@repairos/contracts';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from './me';
import { type GateMode, redirectFor } from './redirects';

export type { GateMode };

export type GateState =
  | { status: 'loading' }
  | { status: 'error'; error: Error; retry: () => void }
  | { status: 'ready'; me: MeResponse | null };

/** Loads GET /api/me and redirects when the user does not belong on this screen. */
export function useSessionGate(mode: GateMode): GateState {
  const router = useRouter();
  const query = useMe();
  const target = query.isSuccess ? redirectFor(mode, query.data) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (query.isPending) return { status: 'loading' };
  if (query.isError)
    return { status: 'error', error: query.error, retry: () => void query.refetch() };
  if (target) return { status: 'loading' };
  return { status: 'ready', me: query.data };
}
