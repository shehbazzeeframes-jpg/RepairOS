import type { Page, Request, Route } from '@playwright/test';
import { ApiError, MeResponse, Shop } from '@repairos/contracts';

/** Fixtures are parsed with the shared contracts, so a contract change breaks the mocks loudly. */
export const USER = { id: 'usr_1', name: 'Alex Morgan', email: 'alex@fixitphones.co.uk' };

export const SHOP: Shop = Shop.parse({
  id: 'shp_1',
  name: 'Fix It Phones',
  country: 'GB',
  currency: 'GBP',
  locale: 'en-GB',
  timezone: 'Europe/London',
  pricesIncludeTax: true,
  phone: '+442071234567',
  createdAt: '2026-11-20T09:00:00.000Z',
});

export const ME_WITH_SHOP: MeResponse = MeResponse.parse({
  user: USER,
  memberships: [{ shopId: SHOP.id, shopName: SHOP.name, role: 'OWNER' }],
  activeShop: SHOP,
  role: 'OWNER',
});

export const ME_NO_SHOP: MeResponse = MeResponse.parse({
  user: USER,
  memberships: [],
  activeShop: null,
  role: null,
});

export function apiError(statusCode: number, code: string, message: string): ApiError {
  return ApiError.parse({ statusCode, code, message });
}

type Handler = (route: Route, request: Request) => Promise<void> | void;

export interface MockApiOptions {
  /** GET /api/me: a body, or null for 401 (signed out). Can be changed later via `state.me`. */
  me: MeResponse | null;
  /** Extra handlers keyed by "METHOD /api/path". */
  handlers?: Record<string, Handler>;
}

export interface MockApiState {
  me: MeResponse | null;
  calls: { method: string; path: string; body: unknown }[];
}

/** Intercepts every /api/** request from the page. Unknown routes return a 404 ApiError. */
export async function mockApi(page: Page, options: MockApiOptions): Promise<MockApiState> {
  const state: MockApiState = { me: options.me, calls: [] };
  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    let body: unknown = undefined;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    state.calls.push({ method: request.method(), path: url.pathname, body });

    const handler = options.handlers?.[key];
    if (handler) return handler(route, request);

    if (key === 'GET /api/me') {
      return state.me
        ? route.fulfill({ status: 200, json: state.me })
        : route.fulfill({
            status: 401,
            json: apiError(401, 'UNAUTHENTICATED', 'Sign in to continue'),
          });
    }
    if (key === 'POST /api/auth/sign-out') {
      state.me = null;
      return route.fulfill({ status: 200, json: { success: true } });
    }
    return route.fulfill({ status: 404, json: apiError(404, 'NOT_FOUND', `No mock for ${key}`) });
  });
  return state;
}
