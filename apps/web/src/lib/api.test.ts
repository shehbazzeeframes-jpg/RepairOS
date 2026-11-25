import { Shop } from '@repairos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiFetch, isShopScopedPath, setRequestShopId, toApiError } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  setRequestShopId(null);
});

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

const shop = {
  id: 's1',
  name: 'Fix It',
  country: 'GB',
  currency: 'GBP',
  locale: 'en-GB',
  timezone: 'Europe/London',
  pricesIncludeTax: true,
  phone: null,
  createdAt: '2026-11-20T09:00:00.000Z',
};

describe('apiFetch', () => {
  it('parses a 2xx body with the contract schema', async () => {
    stubFetch(Response.json(shop, { status: 201 }));
    await expect(apiFetch('/api/shops', Shop, { method: 'POST', json: {} })).resolves.toEqual(shop);
  });

  it('sends JSON with credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(shop));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/shops', Shop, { method: 'POST', json: { name: 'Fix It' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect(init.body).toBe('{"name":"Fix It"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws ApiRequestError with the API error body', async () => {
    const body = { statusCode: 403, code: 'FORBIDDEN', message: 'Owners only' };
    stubFetch(Response.json(body, { status: 403 }));
    const err = await apiFetch('/api/shops', Shop).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(403);
    expect((err as ApiRequestError).body).toEqual(body);
  });

  it('rejects a 2xx body that does not match the contract', async () => {
    stubFetch(Response.json({ id: 1 }));
    const err = await apiFetch('/api/shops', Shop).catch((e: unknown) => e);
    expect((err as ApiRequestError).body.code).toBe('INVALID_RESPONSE');
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await apiFetch('/api/me', Shop).catch((e: unknown) => e);
    expect((err as ApiRequestError).body).toMatchObject({ statusCode: 0, code: 'NETWORK_ERROR' });
  });
});

describe('toApiError', () => {
  it('normalises non-contract JSON bodies', async () => {
    const err = await toApiError(Response.json({ message: 'Nope' }, { status: 401 }));
    expect(err).toEqual({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Nope' });
  });

  it('normalises empty and HTML bodies from a proxy or crash', async () => {
    const err = await toApiError(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(err).toEqual({
      statusCode: 502,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
    });
  });
});

describe('X-Shop-Id (A13)', () => {
  it('knows which paths are shop-scoped', () => {
    expect(isShopScopedPath('/api/tickets?view=open')).toBe(true);
    expect(isShopScopedPath('/api/shop/tax-rates')).toBe(true);
    expect(isShopScopedPath('/api/me')).toBe(false);
    expect(isShopScopedPath('/api/me/active-shop')).toBe(false);
    expect(isShopScopedPath('/api/auth/sign-out')).toBe(false);
    expect(isShopScopedPath('/api/shops')).toBe(false);
    expect(isShopScopedPath('/api/invites/abc/accept')).toBe(false);
  });

  it('sends the rendered shop on shop-scoped requests only', async () => {
    setRequestShopId('s1');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(shop)));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/shop', Shop);
    await apiFetch('/api/me', Shop);
    const headersOf = (i: number) =>
      (fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headersOf(0)['X-Shop-Id']).toBe('s1');
    expect(headersOf(1)['X-Shop-Id']).toBeUndefined();
  });

  it('discards a response echoed for another shop', async () => {
    setRequestShopId('s1');
    stubFetch(Response.json(shop, { headers: { 'X-Shop-Id': 's2' } }));
    const err = await apiFetch('/api/shop', Shop).catch((e: unknown) => e);
    expect((err as ApiRequestError).body).toMatchObject({
      statusCode: 409,
      code: 'ACTIVE_SHOP_CHANGED',
    });
  });

  it('accepts a matching echo', async () => {
    setRequestShopId('s1');
    stubFetch(Response.json(shop, { headers: { 'X-Shop-Id': 's1' } }));
    await expect(apiFetch('/api/shop', Shop)).resolves.toEqual(shop);
  });
});
