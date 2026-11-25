import type { Page, Request, Route } from '@playwright/test';
import {
  ApiError,
  DashboardSummary,
  MeResponse,
  Shop,
  TimeclockStatus,
  permissionsFor,
} from '@repairos/contracts';

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
  memberships: [{ shopId: SHOP.id, shopName: SHOP.name, role: 'OWNER', status: 'ACTIVE' }],
  activeShop: SHOP,
  role: 'OWNER',
  permissions: permissionsFor('OWNER'),
  accessRemoved: null,
});

export const ME_NO_SHOP: MeResponse = MeResponse.parse({
  user: USER,
  memberships: [],
  activeShop: null,
  role: null,
  permissions: [],
  accessRemoved: null,
});

/** Clocked out, no recent entries (served for every page by default). */
export const CLOCKED_OUT: TimeclockStatus = TimeclockStatus.parse({
  serverNow: new Date().toISOString(),
  openEntry: null,
  todayMinutes: 0,
  recentEntries: [],
});

export const EMPTY_DASHBOARD: DashboardSummary = DashboardSummary.parse({
  counts: {
    open: 0,
    mine: 0,
    unassigned: 0,
    ready: 0,
    overdue: 0,
    dueToday: 0,
    openAndWaiting: 0,
    serverNow: new Date().toISOString(),
  },
  myQueue: [],
  myQueueTotal: 0,
  unassigned: [],
});

export function apiError(statusCode: number, code: string, message: string): ApiError {
  return ApiError.parse({ statusCode, code, message });
}

type Handler = (route: Route, request: Request) => Promise<void> | void;

export interface MockApiOptions {
  /** GET /api/me: a body, or null for 401 (signed out). Can be changed later via `state.me`. */
  me: MeResponse | null;
  /**
   * Extra handlers keyed by "METHOD /api/path". Path segments may be `:params`
   * ("POST /api/staff/:id/deactivate"); exact keys win over patterns.
   */
  handlers?: Record<string, Handler>;
}

export interface MockApiState {
  me: MeResponse | null;
  calls: { method: string; path: string; search: string; body: unknown }[];
}

function compile(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** A toast by its text (Astryx also mirrors it into a live region, so scope to the viewport). */
export function toast(page: Page, text: string | RegExp) {
  return page.getByRole('region', { name: 'Notifications' }).getByText(text);
}

/** Intercepts every /api/** request from the page. Unknown routes return a 404 ApiError. */
export async function mockApi(page: Page, options: MockApiOptions): Promise<MockApiState> {
  const state: MockApiState = { me: options.me, calls: [] };
  const patterns = Object.entries(options.handlers ?? {}).map(
    ([key, handler]) => [compile(key), handler] as const,
  );
  await page.route('**/api/**', async (route, request) => {
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    let body: unknown = undefined;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    state.calls.push({ method: request.method(), path: url.pathname, search: url.search, body });

    const handler = options.handlers?.[key] ?? patterns.find(([re]) => re.test(key))?.[1];
    if (handler) return handler(route, request);

    if (key === 'GET /api/me') {
      return state.me
        ? route.fulfill({ status: 200, json: state.me })
        : route.fulfill({
            status: 401,
            json: apiError(401, 'UNAUTHENTICATED', 'Sign in to continue'),
          });
    }
    if (key === 'GET /api/timeclock/me') return route.fulfill({ status: 200, json: CLOCKED_OUT });
    // Sprint 2: the dashboard every signed-in page can land on (an empty shop unless a test mocks it).
    if (key === 'GET /api/dashboard') return route.fulfill({ status: 200, json: EMPTY_DASHBOARD });
    if (key === 'POST /api/auth/sign-out') {
      state.me = null;
      return route.fulfill({ status: 200, json: { success: true } });
    }
    return route.fulfill({ status: 404, json: apiError(404, 'NOT_FOUND', `No mock for ${key}`) });
  });
  return state;
}
