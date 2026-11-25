import { MeResponse, permissionsFor } from '@repairos/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { meQueryKey } from './me';
import { isOtherShopQuery, qk } from './queries';
import { watchActiveShop } from './shop-cache';

function shop(id: string) {
  return {
    id,
    name: `Shop ${id}`,
    country: 'GB',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
    pricesIncludeTax: true,
    phone: null,
    createdAt: '2026-11-20T09:00:00.000Z',
  };
}

function me(activeShopId: string | null): MeResponse {
  return MeResponse.parse({
    user: { id: 'u1', name: 'Alex', email: 'alex@example.com' },
    memberships: [],
    activeShop: activeShopId ? shop(activeShopId) : null,
    role: activeShopId ? 'OWNER' : null,
    permissions: activeShopId ? permissionsFor('OWNER') : [],
    accessRemoved: null,
  });
}

const cachedKeys = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .map((q) => q.queryKey);

describe('shop-scoped query keys', () => {
  it('carry the shop id', () => {
    expect(qk.staff('A', ['ACTIVE'])).toEqual(['shop', 'A', 'staff', 'ACTIVE']);
    expect(qk.staff('A', ['ACTIVE'])).not.toEqual(qk.staff('B', ['ACTIVE']));
    expect(qk.staffAll('A')).toEqual(qk.staff('A', ['ACTIVE']).slice(0, 3));
  });

  it('isOtherShopQuery matches only other shops’ shop-scoped keys', () => {
    expect(isOtherShopQuery(qk.timeclock('A'), 'B')).toBe(true);
    expect(isOtherShopQuery(qk.timeclock('B'), 'B')).toBe(false);
    expect(isOtherShopQuery(qk.timeclock('B'), null)).toBe(true);
    expect(isOtherShopQuery(meQueryKey, 'B')).toBe(false);
    expect(isOtherShopQuery(qk.invite('tok'), 'B')).toBe(false);
  });
});

describe('watchActiveShop (review M3)', () => {
  it('drops the old shop’s queries when /me reports another active shop', () => {
    const client = new QueryClient();
    const stop = watchActiveShop(client);
    client.setQueryData(meQueryKey, me('A'));
    client.setQueryData(qk.staff('A', ['ACTIVE']), { items: ['a-staff'] });
    client.setQueryData(qk.shopSettings('A'), { name: 'A' });
    client.setQueryData(qk.invite('tok'), { ok: true });

    // Same shop: nothing is dropped.
    client.setQueryData(meQueryKey, me('A'));
    expect(client.getQueryData(qk.staff('A', ['ACTIVE']))).toEqual({ items: ['a-staff'] });

    // Another tab switched shop / the API fell back after a deactivation.
    client.setQueryData(meQueryKey, me('B'));
    expect(client.getQueryData(qk.staff('A', ['ACTIVE']))).toBeUndefined();
    expect(client.getQueryData(qk.shopSettings('A'))).toBeUndefined();
    expect(cachedKeys(client)).toEqual(expect.arrayContaining([meQueryKey, qk.invite('tok')]));
    expect(cachedKeys(client).filter((k) => k[0] === 'shop')).toEqual([]);

    // B's own data survives later /me updates for B.
    client.setQueryData(qk.staff('B', ['ACTIVE']), { items: ['b-staff'] });
    client.setQueryData(meQueryKey, me('B'));
    expect(client.getQueryData(qk.staff('B', ['ACTIVE']))).toEqual({ items: ['b-staff'] });
    stop();
  });

  it('drops every shop query on sign-out (me = null) and when no shop is active', () => {
    const client = new QueryClient();
    const stop = watchActiveShop(client);
    client.setQueryData(meQueryKey, me('A'));
    client.setQueryData(qk.timeclock('A'), { open: true });
    client.setQueryData(meQueryKey, null);
    expect(client.getQueryData(qk.timeclock('A'))).toBeUndefined();

    client.setQueryData(meQueryKey, me('A'));
    client.setQueryData(qk.timeclock('A'), { open: true });
    client.setQueryData(meQueryKey, me(null));
    expect(client.getQueryData(qk.timeclock('A'))).toBeUndefined();
    stop();
  });
});
