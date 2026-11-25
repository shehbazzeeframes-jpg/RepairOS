import { MeResponse, permissionsFor } from '@repairos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissAccessRemoved, getAccessRemoved, noteMe } from './access-removed';
import { fetchMe } from './me';

const shopB = {
  id: 'B',
  name: 'Shop B',
  country: 'GB',
  currency: 'GBP',
  locale: 'en-GB',
  timezone: 'Europe/London',
  pricesIncludeTax: true,
  phone: null,
  createdAt: '2026-11-20T09:00:00.000Z',
};

function me(accessRemoved: { shopId: string; shopName: string } | null): MeResponse {
  return MeResponse.parse({
    user: { id: 'u1', name: 'Alex', email: 'alex@example.com' },
    memberships: [{ shopId: 'B', shopName: 'Shop B', role: 'OWNER', status: 'ACTIVE' }],
    activeShop: shopB,
    role: 'OWNER',
    permissions: permissionsFor('OWNER'),
    accessRemoved,
  });
}

const REMOVED_A = { shopId: 'A', shopName: 'Shop A' };

afterEach(() => {
  dismissAccessRemoved();
  vi.unstubAllGlobals();
});

describe('access-removed latch (QA BUG-03)', () => {
  it('keeps the one-shot accessRemoved after a later /me returns null', () => {
    noteMe(me(REMOVED_A));
    noteMe(me(null));
    expect(getAccessRemoved()).toEqual(REMOVED_A);
  });

  it('clears on dismiss and on sign-out', () => {
    noteMe(me(REMOVED_A));
    dismissAccessRemoved();
    expect(getAccessRemoved()).toBeNull();
    noteMe(me(REMOVED_A));
    noteMe(null);
    expect(getAccessRemoved()).toBeNull();
  });

  it('fetchMe feeds every /me body to the latch, even one React Query later discards', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(me(REMOVED_A)))
      .mockResolvedValueOnce(Response.json(me(null)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchMe();
    await expect(fetchMe()).resolves.toMatchObject({ accessRemoved: null });
    expect(getAccessRemoved()).toEqual(REMOVED_A);
  });

  it('fetchMe clears the latch when signed out (401)', async () => {
    noteMe(me(REMOVED_A));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Sign in' },
            { status: 401 },
          ),
        ),
    );
    await expect(fetchMe()).resolves.toBeNull();
    expect(getAccessRemoved()).toBeNull();
  });
});
