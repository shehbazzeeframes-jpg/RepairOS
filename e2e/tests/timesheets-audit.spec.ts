import { expect, test } from '@playwright/test';
import { TimeEntry } from '@repairos/contracts';
import {
  AUDIT_DETAIL,
  AUDIT_PAGE_1,
  AUDIT_PAGE_2,
  EMPTY_TIMESHEET,
  ME_ROW,
  NOW,
  SAM,
  SAM_ENTRIES,
  TIMESHEET,
  meAs,
  staffList,
} from './support/fixtures';
import { ME_WITH_SHOP, mockApi, toast } from './support/mock-api';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

const staff = (route: import('@playwright/test').Route) =>
  route.fulfill({ json: staffList([ME_ROW, SAM], 2) });

test.describe('timesheets', () => {
  test('shows totals per person, flags long shifts and links the CSV export', async ({ page }) => {
    const api = await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': staff,
        'GET /api/timesheets': (route) => route.fulfill({ json: TIMESHEET }),
      },
    });
    await page.goto('/settings/timesheets');
    await expect(page.getByRole('heading', { level: 1, name: 'Timesheets' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sam Lee · 23h 5m' })).toBeVisible();
    await expect(page.getByText('Long shift')).toBeVisible();
    await expect(page.getByText('Edited', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Needs review (1)' })).toBeVisible();

    // Default range: this week, Monday to Sunday in shop time.
    const first = api.calls.find((c) => c.path === '/api/timesheets');
    expect(first?.search).toBe('?from=2026-11-23&to=2026-11-29');
    await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute(
      'href',
      '/api/timesheets/export.csv?from=2026-11-23&to=2026-11-29',
    );

    await page.getByRole('switch', { name: /Needs review/ }).click();
    await expect
      .poll(() => api.calls.filter((c) => c.path === '/api/timesheets').at(-1)?.search)
      .toBe('?from=2026-11-23&to=2026-11-29&needsReview=true');
  });

  test('fixing an entry needs a reason and sends the times in UTC', async ({ page }) => {
    let patch: unknown;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': staff,
        'GET /api/timesheets': (route) => route.fulfill({ json: TIMESHEET }),
        'PATCH /api/time-entries/:id': async (route, request) => {
          patch = request.postDataJSON();
          await route.fulfill({
            json: TimeEntry.parse({ ...SAM_ENTRIES[1], clockOutAt: '2026-11-24T18:00:00.000Z' }),
          });
        },
      },
    });
    await page.goto('/settings/timesheets');
    await page.getByRole('button', { name: "Actions for Sam Lee's entry on 2026-11-24" }).click();
    await page.getByRole('menuitem', { name: 'Fix times…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix time entry for Sam Lee' });
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(dialog.locator('form').getByText('Use at least 3 characters')).toBeVisible();

    const out = dialog.getByRole('textbox', { name: 'Clock out time' });
    await out.fill('18:00');
    await out.press('Enter');
    await dialog.getByLabel('Reason').fill('Forgot to clock out');
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(toast(page, 'Time entry updated')).toBeVisible();
    // 18:00 London on 24 Nov (GMT) = 18:00Z.
    expect(patch).toEqual({
      clockOutAt: '2026-11-24T18:00:00.000Z',
      reason: 'Forgot to clock out',
    });
  });

  test('deleting an entry asks for a reason', async ({ page }) => {
    let body: unknown;
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': staff,
        'GET /api/timesheets': (route) => route.fulfill({ json: TIMESHEET }),
        'DELETE /api/time-entries/:id': async (route, request) => {
          body = request.postDataJSON();
          await route.fulfill({ status: 204 });
        },
      },
    });
    await page.goto('/settings/timesheets');
    await page.getByRole('button', { name: "Actions for Sam Lee's entry on 2026-11-23" }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete time entry?' });
    await dialog.getByRole('button', { name: 'Delete entry' }).click();
    await expect(dialog.locator('form').getByText('Use at least 3 characters')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Duplicate');
    await dialog.getByRole('button', { name: 'Delete entry' }).click();
    await expect(toast(page, 'Time entry deleted')).toBeVisible();
    expect(body).toEqual({ reason: 'Duplicate' });
  });

  test('a front desk user has no access', async ({ page }) => {
    await mockApi(page, { me: meAs('FRONT_DESK') });
    await page.goto('/settings/timesheets');
    await expect(
      page.getByRole('heading', { name: "You don't have access to this page" }),
    ).toBeVisible();
  });

  test('empty period', async ({ page }) => {
    await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': staff,
        'GET /api/timesheets': (route) => route.fulfill({ json: EMPTY_TIMESHEET }),
      },
    });
    await page.goto('/settings/timesheets');
    await expect(
      page.getByRole('heading', { name: 'No hours recorded in this period' }),
    ).toBeVisible();
  });
});

test.describe('audit log', () => {
  test('filters, loads more and shows a readable diff', async ({ page }) => {
    const api = await mockApi(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/staff': staff,
        'GET /api/audit-events': (route, request) =>
          route.fulfill({
            json: new URL(request.url()).searchParams.get('cursor') ? AUDIT_PAGE_2 : AUDIT_PAGE_1,
          }),
        'GET /api/audit-events/:id': (route) => route.fulfill({ json: AUDIT_DETAIL }),
      },
    });
    await page.goto('/settings/audit');
    await expect(page.getByRole('cell', { name: 'Tax rate: VAT' })).toBeVisible();
    expect(api.calls.find((c) => c.path === '/api/audit-events')?.search).toBe(
      '?from=2026-11-19&to=2026-11-25',
    );

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('cell', { name: 'Shop: Fix It Phones' })).toBeVisible();
    await expect(page.getByText('System')).toBeVisible();
    await expect(page.getByText("You've reached the start of this period.")).toBeVisible();

    await page.getByRole('link', { name: 'Edited tax rate' }).click();
    const drawer = page.getByRole('dialog', { name: 'Audit event' });
    const rate = drawer.getByRole('row', { name: /Rate/ });
    await expect(rate.getByRole('cell', { name: '20%' })).toBeVisible();
    await expect(rate.getByRole('cell', { name: '17.5%' })).toBeVisible();
    await expect(
      drawer.getByRole('row', { name: /Applies to/ }).getByText('Goods (parts & accessories)'),
    ).toBeVisible();
    // Unchanged fields are hidden.
    await expect(drawer.getByRole('cell', { name: 'Name', exact: true })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Action' }).click();
    await page.getByRole('option', { name: 'All staff & invites' }).click();
    await expect
      .poll(() => api.calls.filter((c) => c.path === '/api/audit-events').at(-1)?.search)
      .toBe('?from=2026-11-19&to=2026-11-25&actionGroup=staff');
  });
});
