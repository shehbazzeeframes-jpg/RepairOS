import { expect, test } from '@playwright/test';
import { MeResponse, TimeclockStatus } from '@repairos/contracts';
import { NOW, meAs } from './support/fixtures';
import { CLOCKED_OUT, ME_NO_SHOP, ME_WITH_SHOP, SHOP, USER, apiError, mockApi, toast } from './support/mock-api';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

function clockedInAt(iso: string, todayMinutes = 0): TimeclockStatus {
  return TimeclockStatus.parse({
    serverNow: NOW.toISOString(),
    openEntry: {
      id: 'te_open',
      userId: USER.id,
      clockInAt: iso,
      clockOutAt: null,
      localDate: iso.slice(0, 10),
      durationMinutes: 0,
      source: 'SELF',
      closedReason: null,
      flaggedLong: false,
      stillOpen: false,
      edited: null,
    },
    todayMinutes,
    recentEntries: [],
  });
}

test.describe('clock in/out', () => {
  test('clocks in optimistically, shows elapsed time and clocks out with a toast', async ({ page }) => {
    let releaseClockIn: () => void = () => undefined;
    const clockInHeld = new Promise<void>((resolve) => (releaseClockIn = resolve));
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/timeclock/me': (route) => route.fulfill({ json: CLOCKED_OUT }),
        'POST /api/timeclock/clock-in': async (route) => {
          await clockInHeld;
          await route.fulfill({ json: clockedInAt('2026-11-25T12:46:00.000Z') });
        },
        'POST /api/timeclock/clock-out': (route) =>
          route.fulfill({ json: { ...CLOCKED_OUT, serverNow: NOW.toISOString(), todayMinutes: 472 } }),
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Clock in' }).click();
    // Optimistic: the state flips before the server answers.
    await expect(page.getByRole('button', { name: 'Clocked in 0m' })).toBeVisible();
    releaseClockIn();
    await expect(page.getByRole('button', { name: 'Clocked in 2h 14m' })).toBeVisible();

    await page.getByRole('button', { name: 'Clocked in 2h 14m' }).click();
    await page.getByRole('menuitem', { name: 'Clock out' }).click();
    await expect(toast(page, 'Clocked out. 7h 52m today.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible();
  });

  test('already clocked in elsewhere: refreshes to the real state', async ({ page }) => {
    let clockedIn = false;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/timeclock/me': (route) =>
          route.fulfill({ json: clockedIn ? clockedInAt('2026-11-25T14:00:00.000Z') : CLOCKED_OUT }),
        'POST /api/timeclock/clock-in': async (route) => {
          clockedIn = true;
          await route.fulfill({ status: 409, json: apiError(409, 'ALREADY_CLOCKED_IN', 'Already') });
        },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(toast(page, "You're already clocked in.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clocked in 1h 0m' })).toBeVisible();
  });

  test('warns after a 14-hour open shift', async ({ page }) => {
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/timeclock/me': (route) => route.fulfill({ json: clockedInAt('2026-11-24T08:00:00.000Z') }),
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Clocked in 31h 0m' }).click();
    await expect(page.getByText('Still clocked in since Tue 08:00.')).toBeVisible();
    await expect(page.getByText('Clock out and ask a manager to fix the time.')).toBeVisible();
  });
});

test.describe('user menu', () => {
  const twoShops = MeResponse.parse({
    ...ME_WITH_SHOP,
    memberships: [
      ...ME_WITH_SHOP.memberships,
      { shopId: 'shp_2', shopName: 'Mobile Medics', role: 'TECHNICIAN', status: 'ACTIVE' },
    ],
  });

  test('switches shop', async ({ page }) => {
    const second = meAs('TECHNICIAN', {
      memberships: twoShops.memberships,
      activeShop: { ...SHOP, id: 'shp_2', name: 'Mobile Medics' },
    });
    const api = await mockApi(page, {
      me: twoShops,
      handlers: {
        'POST /api/me/active-shop': async (route) => {
          api.me = second;
          await route.fulfill({ json: second });
        },
      },
    });
    await page.goto('/settings/general');
    await page.getByRole('button', { name: 'Account: Alex Morgan' }).click();
    await expect(page.getByRole('menuitemradio', { name: /Fix It Phones/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: /Mobile Medics/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'Mobile Medics' })).toBeVisible();
    // Technicians have no settings.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
    expect(api.calls.find((c) => c.path === '/api/me/active-shop')?.body).toEqual({ shopId: 'shp_2' });
  });

  test('"Create a new shop" opens onboarding and shows SHOP_LIMIT_REACHED', async ({ page }) => {
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'POST /api/shops': (route) =>
          route.fulfill({ status: 403, json: apiError(403, 'SHOP_LIMIT_REACHED', 'Limit') }),
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Account: Alex Morgan' }).click();
    await page.getByRole('menuitem', { name: 'Create a new shop' }).click();
    await expect(page).toHaveURL(/\/onboarding\?new=1$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Set up another shop' })).toBeVisible();
    await page.getByLabel('Shop name').fill('Second Shop');
    await page.getByRole('combobox', { name: 'Country' }).click();
    await page.getByRole('option', { name: 'United Kingdom' }).click();
    await page.getByRole('button', { name: 'Create shop' }).click();
    await expect(
      page.getByText('You can own up to 3 shops for now. Contact support if you need more.'),
    ).toBeVisible();
  });
});

test.describe('access removed', () => {
  const removed = MeResponse.parse({
    ...ME_NO_SHOP,
    accessRemoved: { shopId: SHOP.id, shopName: SHOP.name },
  });

  test('a user whose only membership was deactivated sees the access-removed page, not onboarding', async ({
    page,
  }) => {
    const api = await mockApi(page, { me: removed });
    await page.goto('/');
    await expect(page).toHaveURL(/\/access-removed$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'You no longer have access to Fix It Phones' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create your own shop' })).toHaveAttribute('href', '/onboarding');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(api.calls.some((c) => c.path === '/api/auth/sign-out')).toBe(true);
  });

  test('a user moved to another shop sees a banner once', async ({ page }) => {
    await mockApi(page, {
      me: MeResponse.parse({ ...ME_WITH_SHOP, accessRemoved: { shopId: 'shp_9', shopName: 'Old Shop' } }),
    });
    await page.goto('/');
    await expect(page.getByText('You no longer have access to Old Shop.')).toBeVisible();
  });
});
