import { expect, test } from '@playwright/test';
import {
  BusinessHoursResponse,
  ShopProfile,
  TaxRate,
  TaxSettings,
  UpdateBusinessHoursInput,
} from '@repairos/contracts';
import { SHOP_SETTINGS, TAX_RATES, VAT, ZERO, meAs } from './support/fixtures';
import { ME_WITH_SHOP, apiError, mockApi, toast } from './support/mock-api';

const settingsHandlers = {
  'GET /api/shop': (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, json: SHOP_SETTINGS }),
  'GET /api/shop/tax-rates': (route: import('@playwright/test').Route) =>
    route.fulfill({ status: 200, json: TAX_RATES }),
};

test.describe('settings navigation and permissions', () => {
  test('owners see every settings page in the secondary nav', async ({ page }) => {
    await mockApi(page, { me: ME_WITH_SHOP, handlers: settingsHandlers });
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/general$/);
    const nav = page.getByRole('navigation', { name: 'Settings' });
    for (const label of ['General', 'Tax', 'Business hours', 'Staff', 'Timesheets', 'Audit log']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  });

  test('front desk has no Settings nav and sees "no access" on a direct visit', async ({ page }) => {
    const api = await mockApi(page, { me: meAs('FRONT_DESK') });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Account: Alex Morgan' }).click();
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/settings/staff');
    await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
    expect(api.calls.some((c) => c.path === '/api/staff')).toBe(false);
  });
});

test.describe('general', () => {
  test('shows country and currency locked with the reason, and saves only changed fields', async ({ page }) => {
    let saved: unknown;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        ...settingsHandlers,
        'PATCH /api/shop': async (route, request) => {
          saved = request.postDataJSON();
          await route.fulfill({
            status: 200,
            json: ShopProfile.parse({ ...SHOP_SETTINGS.shop, name: 'Fix It Phones Soho', updatedAt: '2026-11-25T12:00:00.000Z' }),
          });
        },
      },
    });
    await page.goto('/settings/general');
    await expect(page.getByLabel('Shop name')).toHaveValue('Fix It Phones');
    await expect(page.getByText("Country and currency can't be changed after the shop is created.", { exact: false })).toBeVisible();
    await expect(page.getByText('United Kingdom', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Postcode')).toHaveValue('SW1A 1AA');
    await expect(page.getByLabel('Town/City')).toHaveValue('London');
    await expect(page.getByLabel('County')).toBeVisible();

    await page.getByLabel('Postcode').fill('nope');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('form', { name: 'Shop details' }).getByText('Enter a valid postcode')).toBeVisible();

    await page.getByLabel('Postcode').fill('sw1a1aa');
    await page.getByLabel('Shop name').fill('Fix It Phones Soho');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(toast(page, 'Shop details saved')).toBeVisible();
    expect(saved).toEqual({ name: 'Fix It Phones Soho' });
  });
});

test.describe('tax', () => {
  test('adds a rate with three decimals and explains that history never changes', async ({ page }) => {
    let created: unknown;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        ...settingsHandlers,
        'POST /api/shop/tax-rates': async (route, request) => {
          created = request.postDataJSON();
          await route.fulfill({
            status: 201,
            json: TaxRate.parse({ ...ZERO, id: 'tax_new', name: 'City tax', rateMilliPct: 8875 }),
          });
        },
      },
    });
    await page.goto('/settings/tax');
    await expect(page.getByText('Editing never changes past records')).toBeVisible();
    await expect(page.getByRole('cell', { name: '20%' })).toBeVisible();
    await expect(page.getByText('Goods default', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add tax rate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add tax rate' });
    await dialog.getByLabel('Name').fill('City tax');
    await dialog.getByLabel('Rate (%)').fill('8.8755');
    await dialog.getByRole('button', { name: 'Add rate' }).click();
    await expect(dialog.locator('form').getByText('Enter a rate from 0 to 100 with up to 3 decimals')).toBeVisible();
    await dialog.getByLabel('Rate (%)').fill('8.875%');
    await dialog.getByRole('button', { name: 'Add rate' }).click();
    await expect(toast(page, 'City tax added')).toBeVisible();
    expect(created).toEqual({ name: 'City tax', rateMilliPct: 8875, appliesTo: 'all' });
  });

  test('archiving the default rate shows the contract message', async ({ page }) => {
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        ...settingsHandlers,
        'POST /api/shop/tax-rates/:id/archive': (route) =>
          route.fulfill({ status: 409, json: apiError(409, 'TAX_RATE_IS_DEFAULT', 'Choose another default first') }),
      },
    });
    await page.goto('/settings/tax');
    await page.getByRole('button', { name: 'Actions for VAT' }).click();
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(toast(page, 'Choose another default first.')).toBeVisible();
  });

  test('toggling prices-include-tax asks first', async ({ page }) => {
    let body: unknown;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        ...settingsHandlers,
        'PATCH /api/shop/tax-settings': async (route, request) => {
          body = request.postDataJSON();
          await route.fulfill({ status: 200, json: TaxSettings.parse({ pricesIncludeTax: false }) });
        },
      },
    });
    await page.goto('/settings/tax');
    await page.getByRole('switch', { name: 'Prices include tax' }).click();
    await expect(page.getByText("Past sales don't change.")).toBeVisible();
    await page.getByRole('button', { name: 'Change setting' }).click();
    await expect(toast(page, 'Prices now exclude tax')).toBeVisible();
    expect(body).toEqual({ pricesIncludeTax: false });
    expect(VAT.isDefaultGoods).toBe(true);
  });
});

test.describe('business hours', () => {
  test('opens Sunday, copies Monday to the weekdays and saves the week', async ({ page }) => {
    let saved: UpdateBusinessHoursInput | undefined;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        ...settingsHandlers,
        'PUT /api/shop/hours': async (route, request) => {
          saved = UpdateBusinessHoursInput.parse(request.postDataJSON());
          await route.fulfill({ status: 200, json: BusinessHoursResponse.parse({ days: saved.days }) });
        },
      },
    });
    await page.goto('/settings/hours');
    // GB shops list Monday first.
    const rows = page.getByRole('switch');
    await expect(rows.first()).toHaveAccessibleName('Monday open');
    await expect(page.getByText('Closed')).toBeVisible();

    await page.getByRole('switch', { name: 'Sunday open' }).click();
    await page.getByRole('switch', { name: 'Monday open' }).click();
    await page.getByRole('button', { name: 'Copy Monday to all weekdays' }).click();
    await page.getByRole('button', { name: 'Save hours' }).click();
    await expect(toast(page, 'Business hours saved')).toBeVisible();
    expect(saved?.days.find((d) => d.weekday === 0)).toMatchObject({ isOpen: true, opensAt: '10:00', closesAt: '19:00' });
    for (const weekday of [1, 2, 3, 4, 5]) {
      expect(saved?.days.find((d) => d.weekday === weekday)?.isOpen).toBe(false);
    }
    expect(saved?.days.find((d) => d.weekday === 6)?.isOpen).toBe(true);
  });
});
