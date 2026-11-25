import type { MeResponse } from '@repairos/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { meQueryKey } from './me';
import { isOtherShopQuery } from './queries';

function activeShopIdOf(me: MeResponse | null): string | null {
  return me?.activeShop?.id ?? null;
}

/**
 * Review M3: shop-scoped data must never show under another shop. Query keys already carry the shop
 * id; on top of that, whenever the cached /api/me's active shop changes (shop switch, the API's
 * deactivation fallback, another tab switching shop, sign-out) every other shop's cached query is
 * dropped. Returns the unsubscribe function.
 */
export function watchActiveShop(client: QueryClient): () => void {
  let current: string | null | undefined = undefined;
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== meQueryKey[0]) return;
    const data = event.query.state.data as MeResponse | null | undefined;
    if (data === undefined) return;
    const next = activeShopIdOf(data);
    if (next === current) return;
    current = next;
    client.removeQueries({ predicate: (q) => isOtherShopQuery(q.queryKey, next) });
  });
}
