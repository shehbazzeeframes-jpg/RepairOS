'use client';

import { MeResponse } from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { apiFetch } from './api';
import { authClient } from './auth-client';
import { meQueryKey } from './me';

/**
 * Story §7: a person may own up to 3 shops. Not exported by contracts (it's an API env value);
 * the UI only uses it to pre-disable "Create a new shop", the API's SHOP_LIMIT_REACHED is the rule.
 */
export const MAX_OWNED_SHOPS = 3;

export function ownedShopCount(me: MeResponse): number {
  return me.memberships.filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE').length;
}

/** POST /api/me/active-shop, then drop every shop-scoped cache and land on the dashboard. */
export function useSwitchShop() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (shopId: string) =>
      apiFetch('/api/me/active-shop', MeResponse, { method: 'POST', json: { shopId } }),
    onSuccess: (me) => {
      queryClient.removeQueries({ queryKey: ['shop'] });
      queryClient.setQueryData(meQueryKey, me);
      router.push('/');
    },
  });
}

export function useSignOut(redirectTo: string | null = '/sign-in') {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    await authClient.signOut();
    queryClient.clear();
    queryClient.setQueryData(meQueryKey, null);
    if (redirectTo) router.replace(redirectTo);
  };
}
