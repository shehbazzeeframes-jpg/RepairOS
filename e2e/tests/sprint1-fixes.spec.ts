import { expect, test, type Page, type Route } from '@playwright/test';
import {
  MeResponse,
  Shop,
  StaffListItem,
  TimeclockStatus,
  TimesheetResponse,
  permissionsFor,
} from '@repairos/contracts';
import {
  INVITE_JO,
  ME_ROW,
  NOW,
  PRIYA,
  SAM,
  SAM_ENTRIES,
  SHOP_SETTINGS,
  TIMESHEET,
  staffList,
} from './support/fixtures';
import { ME_WITH_SHOP, SHOP, USER, apiError, mockApi, toast } from './support/mock-api';

/** Regression tests for the Sprint 1 review (M3, gap 8) and QA bugs BUG-02, -03, -05, -06, -07. */

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

const SHOP_B = Shop.parse({
  ...SHOP,
  id: 'shp_b',
  name: 'Mobile Medics',
  createdAt: '2026-11-21T09:00:00.000Z',
});

const MEMBERSHIPS = [
  { shopId: SHOP.id, shopName: SHOP.name, role: 'OWNER', status: 'ACTIVE' },
  { shopId: SHOP_B.id, shopName: SHOP_B.name, role: 'OWNER', status: 'ACTIVE' },
] as const;

function meIn(shop: Shop, extra: Partial<MeResponse> = {}): MeResponse {
  return MeResponse.parse({
    user: USER,
    memberships: MEMBERSHIPS,
    activeShop: shop,
    role: 'OWNER',
    permissions: permissionsFor('OWNER'),
    accessRemoved: null,
    ...extra,
  });
}

const BEA = StaffListItem.parse({
  ...SAM,
  id: 'mem_bea',
  userId: 'usr_bea',
  name: 'Bea Bright',
  email: 'bea@mobilemedics.co.uk',
});

/** What React Query listens to for "the window got focus again". */
async function refocus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
}

test.describe('review M3: shop-scoped data never shows under another shop', () => {
  test('when /me reports another shop on refocus, shop A staff and the open dialog go away', async ({
    page,
  }) => {
    let releaseB: () => void = () => {};
    const bHeld = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const api = await mockApi(page, {
      me: meIn(SHOP),
      handlers: {
        // The API answers for the session's active shop, as the real one does.
        'GET /api/staff': async (route: Route) => {
          if (api.me?.activeShop?.id === SHOP_B.id) {
            await bHeld;
            return route.fulfill({ json: staffList([ME_ROW, BEA], 2) });
          }
          return route.fulfill({ json: staffList([ME_ROW, PRIYA, SAM, INVITE_JO], 4) });
        },
      },
    });
    await page.goto('/settings/staff');
    await expect(page.getByRole('row', { name: /Sam Lee/ })).toBeVisible();
    await expect(page.getByRole('link', { name: SHOP.name })).toBeVisible();

    // A form from shop A is open when another tab switches the session to shop B.
    await page.getByRole('button', { name: 'Invite staff' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Invite staff' });
    await dialog.getByLabel('Email').fill('half-typed@example.com');
    api.me = meIn(SHOP_B);
    await refocus(page);

    await expect(page.getByRole('link', { name: SHOP_B.name })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // Shop A's rows are gone while shop B's list is still loading...
    await expect(page.getByRole('row', { name: /Sam Lee/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Priya Shah/ })).toHaveCount(0);
    await expect(page.getByLabel('Loading staff')).toBeVisible();
    // ...and then shop B's own rows show.
    releaseB();
    await expect(page.getByRole('row', { name: /Bea Bright/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Sam Lee/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite staff' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('QA BUG-02 / review gap 8: timesheet CSV export', () => {
  const exportCalls = (calls: { path: string; search: string }[]) =>
    calls.filter((c) => c.path.startsWith('/api/timesheets/export.csv'));

  test('rendering Timesheets never requests the export; a click downloads it', async ({ page }) => {
    const api = await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': (route) => route.fulfill({ json: staffList([ME_ROW, SAM], 2) }),
        'GET /api/timesheets': (route) => route.fulfill({ json: TIMESHEET }),
        'GET /api/timesheets/export.csv': (route) =>
          route.fulfill({
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition':
                'attachment; filename="timesheet-fix-it-phones-2026-11-23-2026-11-29.csv"',
            },
            body: '﻿Staff name,Email\r\nSam Lee,sam@fixitphones.co.uk\r\n',
          }),
      },
    });
    await page.goto('/settings/timesheets');
    const exportLink = page.getByRole('link', { name: 'Export CSV' });
    await expect(exportLink).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sam Lee · 23h 5m' })).toBeVisible();
    // Hover (Next prefetches links on hover too) and change the range, then give prefetch time to run.
    await exportLink.hover();
    await page.getByRole('switch', { name: /Needs review/ }).click();
    await page.waitForTimeout(1500);
    expect(exportCalls(api.calls)).toEqual([]);
    await expect(exportLink).toHaveAttribute('download', '');

    const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
    expect(download.suggestedFilename()).toBe('timesheet-fix-it-phones-2026-11-23-2026-11-29.csv');
    expect(exportCalls(api.calls)).toHaveLength(1);
    expect(exportCalls(api.calls)[0]?.search).toBe(
      '?from=2026-11-23&to=2026-11-29&needsReview=true',
    );
    await expect(page).toHaveURL(/\/settings\/timesheets$/);
  });

  test('an export error shows the API message, not raw JSON', async ({ page }) => {
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': (route) => route.fulfill({ json: staffList([ME_ROW, SAM], 2) }),
        'GET /api/timesheets': (route) => route.fulfill({ json: TIMESHEET }),
        'GET /api/timesheets/export.csv': (route) =>
          route.fulfill({
            status: 429,
            json: apiError(429, 'RATE_LIMITED', 'Too many exports. Wait a minute and try again.'),
          }),
      },
    });
    let downloaded = false;
    page.on('download', () => {
      downloaded = true;
    });
    await page.goto('/settings/timesheets');
    await page.getByRole('link', { name: 'Export CSV' }).click();
    await expect(toast(page, /Wait a minute and try again/)).toBeVisible();
    await expect(page.getByText('"statusCode"')).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/timesheets$/);
    expect(downloaded).toBe(false);
  });
});

test.describe('QA BUG-03: access-removed banner after an in-app action', () => {
  test('the one-shot accessRemoved is kept until dismissed, across later /me refetches', async ({
    page,
  }) => {
    const removed = meIn(SHOP_B, {
      memberships: [MEMBERSHIPS[1]],
      accessRemoved: { shopId: SHOP.id, shopName: SHOP.name },
    });
    const after = MeResponse.parse({ ...removed, accessRemoved: null });
    let meCalls = 0;
    let deactivated = false;
    let firstAfter = Number.POSITIVE_INFINITY;
    const forbidden = (route: Route) =>
      route.fulfill({
        status: 403,
        json: apiError(403, 'FORBIDDEN', "You don't have permission to do that"),
      });
    await mockApi(page, {
      me: null,
      handlers: {
        // Like the API: the first /me after the fallback carries accessRemoved, later ones don't.
        'GET /api/me': (route) => {
          meCalls += 1;
          if (!deactivated) return route.fulfill({ json: meIn(SHOP) });
          const body = meCalls === firstAfter ? removed : after;
          return route.fulfill({ json: body });
        },
        'GET /api/timeclock/me': (route) =>
          deactivated
            ? forbidden(route)
            : route.fulfill({
                json: TimeclockStatus.parse({
                  serverNow: NOW.toISOString(),
                  openEntry: null,
                  todayMinutes: 0,
                  recentEntries: [],
                }),
              }),
        'POST /api/timeclock/clock-in': forbidden,
      },
    });
    await page.goto('/');
    await expect(page.getByRole('link', { name: SHOP.name })).toBeVisible();

    // The owner of shop A deactivates this user; their next action is in-app (no reload).
    deactivated = true;
    firstAfter = meCalls + 1;
    await page.getByRole('button', { name: 'Clock in' }).click();

    const banner = page.getByText(`You no longer have access to ${SHOP.name}.`);
    await expect(page.getByRole('link', { name: SHOP_B.name })).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(page.getByText(`You're now working in ${SHOP_B.name}.`)).toBeVisible();

    // A later /me (accessRemoved: null) must not take the banner away.
    const before = meCalls;
    await refocus(page);
    await expect.poll(() => meCalls).toBeGreaterThan(before);
    await page.waitForTimeout(300);
    await expect(banner).toBeVisible();

    await page
      .getByRole('button', { name: /Dismiss|Close/ })
      .first()
      .click();
    await expect(banner).toHaveCount(0);
    await refocus(page);
    await page.waitForTimeout(300);
    await expect(banner).toHaveCount(0);
  });
});

test.describe('QA BUG-05: tables are readable at 1024px', () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  /** Texts of elements inside `scope` whose content is cut (wider than their box). */
  async function truncated(page: Page, selector: string) {
    return page
      .locator(selector)
      .evaluateAll((cells) =>
        cells.flatMap((cell) =>
          [cell, ...Array.from(cell.querySelectorAll('*'))]
            .filter(
              (e) =>
                (e.textContent ?? '').trim() !== '' &&
                (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1,
            )
            .map((e) => e.textContent ?? ''),
        ),
      );
  }

  test('staff: names, the "You" badge and statuses are not cut; the page does not scroll sideways', async ({
    page,
  }) => {
    const owner = StaffListItem.parse({ ...ME_ROW, name: 'Demo Owner' });
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': (route) =>
          route.fulfill({ json: staffList([owner, PRIYA, SAM, INVITE_JO], 4) }),
      },
    });
    await page.goto('/settings/staff');
    const me = page.getByRole('row', { name: /Demo Owner/ });
    await expect(me).toBeVisible();
    // Name and Status columns (1st and 4th) of every row.
    const cut = await truncated(
      page,
      'tbody tr td:nth-child(1), tbody tr td:nth-child(3), tbody tr td:nth-child(4), tbody tr td:nth-child(5)',
    );
    expect(cut).toEqual([]);
    await expect(me.getByText('You', { exact: true })).toBeVisible();
    const pageScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageScroll).toBeLessThanOrEqual(0);
  });

  test('timesheets: "Deactivated" and "Closed on deactivation" badges are not cut', async ({
    page,
  }) => {
    const sheet = TimesheetResponse.parse({
      ...TIMESHEET,
      staff: TIMESHEET.staff.map((p) =>
        p.name === 'Sam Lee'
          ? {
              ...p,
              status: 'DEACTIVATED',
              days: [
                p.days[0],
                {
                  ...p.days[1],
                  entries: [{ ...SAM_ENTRIES[1], closedReason: 'DEACTIVATED' }],
                },
              ],
            }
          : p,
      ),
    });
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': (route) => route.fulfill({ json: staffList([ME_ROW, SAM], 2) }),
        'GET /api/timesheets': (route) => route.fulfill({ json: sheet }),
      },
    });
    await page.goto('/settings/timesheets');
    await expect(page.getByText('Closed on deactivation')).toBeVisible();
    await expect(page.getByText('Deactivated', { exact: true })).toBeVisible();
    const cut = await truncated(page, 'tbody td');
    expect(cut).toEqual([]);
  });
});

test('QA BUG-06: business-hours time inputs are named by day', async ({ page }) => {
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: { 'GET /api/shop': (route) => route.fulfill({ json: SHOP_SETTINGS }) },
  });
  await page.goto('/settings/hours');
  await expect(page.getByRole('switch', { name: 'Monday open' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Monday opens', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Monday closes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Saturday opens', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Opens', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Closes', exact: true })).toHaveCount(0);
});

test('QA BUG-07: the clocked-in button has one clear name', async ({ page }) => {
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/timeclock/me': (route) =>
        route.fulfill({
          json: TimeclockStatus.parse({
            serverNow: NOW.toISOString(),
            openEntry: {
              ...SAM_ENTRIES[0],
              id: 'te_open',
              userId: USER.id,
              clockInAt: '2026-11-25T12:46:00.000Z',
              clockOutAt: null,
              localDate: '2026-11-25',
              durationMinutes: 134,
            },
            todayMinutes: 134,
            recentEntries: [],
          }),
        }),
    },
  });
  await page.goto('/');
  const clock = page.getByRole('button', { name: /^Clocked in/ });
  await expect(clock).toHaveAccessibleName('Clocked in 2h 14m');
});
