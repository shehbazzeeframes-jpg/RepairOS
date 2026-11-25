import { expect, test, type Page, type Route } from '@playwright/test';
import { MeResponse, TimeclockStatus, TimesheetResponse } from '@repairos/contracts';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_DETAIL,
  AUDIT_PAGE_1,
  INVITE_JO,
  INVITE_OLD,
  INVITE_VALID,
  ME_ROW,
  NOW,
  PRIYA,
  SAM,
  SHOP_SETTINGS,
  TAX_RATES,
  TIMESHEET,
  TOKEN,
  meAs,
  staffList,
} from './support/fixtures';
import { ME_NO_SHOP, ME_WITH_SHOP, SHOP, USER, mockApi } from './support/mock-api';

/** Sprint 1 screens at 1440×900, deviceScaleFactor 1 → docs/screens/sprint1/*.png. */
const OUT_DIR = fileURLToPath(new URL('../../docs/screens/sprint1/', import.meta.url));

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT_DIR}${name}.png` });

const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });

const CLOCKED_IN = TimeclockStatus.parse({
  serverNow: NOW.toISOString(),
  openEntry: {
    id: 'te_open',
    userId: USER.id,
    clockInAt: '2026-11-25T12:46:00.000Z',
    clockOutAt: null,
    localDate: '2026-11-25',
    durationMinutes: 134,
    source: 'SELF',
    closedReason: null,
    flaggedLong: false,
    stillOpen: false,
    edited: null,
  },
  todayMinutes: 134,
  recentEntries: [],
});

const TWO_SHOPS = MeResponse.parse({
  ...ME_WITH_SHOP,
  memberships: [
    ...ME_WITH_SHOP.memberships,
    { shopId: 'shp_2', shopName: 'Mobile Medics', role: 'TECHNICIAN', status: 'ACTIVE' },
  ],
});

const appHandlers = {
  'GET /api/timeclock/me': json(CLOCKED_IN),
  'GET /api/shop': json(SHOP_SETTINGS),
  'GET /api/shop/tax-rates': json(TAX_RATES),
  'GET /api/staff': json(staffList([ME_ROW, PRIYA, SAM, INVITE_JO, INVITE_OLD], 4)),
  'GET /api/timesheets': json(TIMESHEET),
  'GET /api/audit-events': json(AUDIT_PAGE_1),
  'GET /api/audit-events/:id': json(AUDIT_DETAIL),
};

export function sprint1Screenshots() {
  test.describe('sprint 1', () => {
    test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(NOW);
    });

    for (const [name, path, heading] of [
      ['settings-general', '/settings/general', 'General'],
      ['settings-tax', '/settings/tax', 'Tax'],
      ['settings-hours', '/settings/hours', 'Business hours'],
      ['settings-staff', '/settings/staff', 'Staff'],
      ['settings-timesheets', '/settings/timesheets', 'Timesheets'],
      ['settings-audit', '/settings/audit', 'Audit log'],
    ] as const) {
      test(name, async ({ page }) => {
        await mockApi(page, { me: TWO_SHOPS, handlers: appHandlers });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect(page.getByLabel(/^Loading/)).toHaveCount(0);
        await settle(page);
        await shot(page, name);
      });
    }

    test('staff-invite-dialog', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP, handlers: appHandlers });
      await page.goto('/settings/staff');
      await page.getByRole('button', { name: 'Invite staff' }).click();
      await page
        .getByRole('dialog', { name: 'Invite staff' })
        .getByLabel('Email')
        .fill('jamie@example.com');
      await settle(page);
      await shot(page, 'staff-invite-dialog');
    });

    test('staff-seat-limit', async ({ page }) => {
      await mockApi(page, {
        me: ME_WITH_SHOP,
        handlers: {
          ...appHandlers,
          'GET /api/staff': json(staffList([ME_ROW, PRIYA, SAM, INVITE_JO, INVITE_OLD], 5)),
        },
      });
      await page.goto('/settings/staff');
      await expect(page.getByText('5 of 5 users')).toBeVisible();
      await settle(page);
      await shot(page, 'staff-seat-limit');
    });

    test('tax-rate-dialog', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP, handlers: appHandlers });
      await page.goto('/settings/tax');
      await page.getByRole('button', { name: 'Actions for VAT' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await settle(page);
      await shot(page, 'tax-rate-dialog');
    });

    test('timesheet-entry-dialog', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP, handlers: appHandlers });
      await page.goto('/settings/timesheets');
      await page.getByRole('button', { name: "Actions for Sam Lee's entry on 2026-11-24" }).click();
      await page.getByRole('menuitem', { name: 'Fix times…' }).click();
      await settle(page);
      await shot(page, 'timesheet-entry-dialog');
    });

    test('audit-drawer', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP, handlers: appHandlers });
      await page.goto('/settings/audit');
      await page.getByRole('link', { name: 'Edited tax rate' }).click();
      await expect(page.getByRole('cell', { name: '17.5%' })).toBeVisible();
      await settle(page);
      await shot(page, 'audit-drawer');
    });

    test('settings-no-access', async ({ page }) => {
      await mockApi(page, {
        me: meAs('TECHNICIAN'),
        handlers: { 'GET /api/timeclock/me': json(CLOCKED_IN) },
      });
      await page.goto('/settings/staff');
      await expect(
        page.getByRole('heading', { name: "You don't have access to this page" }),
      ).toBeVisible();
      await settle(page);
      await shot(page, 'settings-no-access');
    });

    test('clock-menu', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP, handlers: appHandlers });
      await page.goto('/');
      await page.getByRole('button', { name: 'Clocked in 2h 14m' }).click();
      await settle(page);
      await shot(page, 'clock-menu');
    });

    test('user-menu', async ({ page }) => {
      await mockApi(page, { me: TWO_SHOPS, handlers: appHandlers });
      await page.goto('/');
      await page.getByRole('button', { name: 'Account: Alex Morgan' }).click();
      await settle(page);
      await shot(page, 'user-menu');
    });

    test('forgot-password', async ({ page }) => {
      await mockApi(page, { me: null });
      await page.goto('/forgot-password');
      await settle(page);
      await shot(page, 'forgot-password');
    });

    test('reset-password', async ({ page }) => {
      await mockApi(page, { me: null });
      await page.goto('/reset-password?token=abc');
      await settle(page);
      await shot(page, 'reset-password');
    });

    test('invite-signed-out', async ({ page }) => {
      await mockApi(page, {
        me: null,
        handlers: { [`GET /api/invites/${TOKEN}`]: json(INVITE_VALID) },
      });
      await page.goto(`/invite/${TOKEN}`);
      await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();
      await settle(page);
      await shot(page, 'invite-signed-out');
    });

    test('invite-wrong-account', async ({ page }) => {
      await mockApi(page, {
        me: ME_NO_SHOP,
        handlers: { [`GET /api/invites/${TOKEN}`]: json(INVITE_VALID) },
      });
      await page.goto(`/invite/${TOKEN}`);
      await expect(page.getByRole('button', { name: 'Sign out and continue' })).toBeVisible();
      await settle(page);
      await shot(page, 'invite-wrong-account');
    });

    test('access-removed', async ({ page }) => {
      await mockApi(page, {
        me: MeResponse.parse({
          ...ME_NO_SHOP,
          accessRemoved: { shopId: SHOP.id, shopName: SHOP.name },
        }),
      });
      await page.goto('/access-removed');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settle(page);
      await shot(page, 'access-removed');
    });

    test('dev-outbox', async ({ page }) => {
      const email = {
        id: 'mail_1',
        to: 'jamie@example.com',
        subject: 'Alex Morgan invited you to join Fix It Phones on RepairOS',
        text: `Alex Morgan (alex@fixitphones.co.uk) has invited you to join Fix It Phones as Technician.\n\nAccept invite: http://localhost:3000/invite/${TOKEN}\n\nThis invite expires on 2 December 2026, 15:00.\nIf you weren't expecting this, you can ignore this email.`,
        html: `<div style="font-family:sans-serif"><h2>Join Fix It Phones</h2><p>Alex Morgan (alex@fixitphones.co.uk) has invited you to join <b>Fix It Phones</b> as <b>Technician</b>.</p><p><a href="http://localhost:3000/invite/${TOKEN}">Accept invite</a></p><p>This invite expires on 2 December 2026, 15:00.</p></div>`,
        createdAt: NOW.toISOString(),
      };
      await mockApi(page, {
        me: null,
        handlers: {
          'GET /api/dev/outbox': json({
            items: [
              email,
              {
                ...email,
                id: 'mail_0',
                to: 'alex@fixitphones.co.uk',
                subject: 'Reset your RepairOS password',
                createdAt: '2026-11-24T09:00:00.000Z',
              },
            ],
          }),
          'GET /api/dev/outbox/:id': json(email),
        },
      });
      await page.goto('/dev/outbox');
      await expect(page.getByRole('heading', { level: 2, name: email.subject })).toBeVisible();
      await settle(page);
      await shot(page, 'dev-outbox');
    });

    test('access-removed-banner', async ({ page }) => {
      await mockApi(page, {
        me: MeResponse.parse({
          ...TWO_SHOPS,
          accessRemoved: { shopId: 'shp_old', shopName: 'Phone Doctor Leeds' },
        }),
        handlers: appHandlers,
      });
      await page.goto('/');
      await expect(
        page.getByText('You no longer have access to Phone Doctor Leeds.'),
      ).toBeVisible();
      await settle(page);
      await shot(page, 'access-removed-banner');
    });
  });

  // Tablet width (BUG-05): tables wrap instead of cutting names and badges.
  test.describe('sprint 1 at 1024', () => {
    test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(NOW);
    });

    const deactivatedSheet = TimesheetResponse.parse({
      ...TIMESHEET,
      staff: TIMESHEET.staff.map((p) =>
        p.name === 'Sam Lee'
          ? {
              ...p,
              status: 'DEACTIVATED',
              days: p.days.map((d, i) =>
                i === 1
                  ? {
                      ...d,
                      entries: d.entries.map((e) => ({ ...e, closedReason: 'DEACTIVATED' })),
                    }
                  : d,
              ),
            }
          : p,
      ),
    });

    for (const [name, path, heading, extra] of [
      ['settings-staff-1024', '/settings/staff', 'Staff', {}],
      [
        'settings-timesheets-1024',
        '/settings/timesheets',
        'Timesheets',
        { 'GET /api/timesheets': json(deactivatedSheet) },
      ],
    ] as const) {
      test(name, async ({ page }) => {
        await mockApi(page, { me: TWO_SHOPS, handlers: { ...appHandlers, ...extra } });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect(page.getByLabel(/^Loading/)).toHaveCount(0);
        await settle(page);
        // The shell scrolls its content region, not the page: bring the flag badges into view.
        if (path === '/settings/timesheets')
          await page.getByText('Closed on deactivation').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT_DIR}${name}.png` });
      });
    }
  });
}
