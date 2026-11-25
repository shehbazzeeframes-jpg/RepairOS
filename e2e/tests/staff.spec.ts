import { expect, test } from '@playwright/test';
import { InviteLinkResponse, StaffListItem } from '@repairos/contracts';
import {
  INVITE_JO,
  INVITE_OLD,
  ME_ROW,
  NOW,
  PRIYA,
  SAM,
  meAs,
  staffList,
} from './support/fixtures';
import { ME_WITH_SHOP, apiError, mockApi, toast } from './support/mock-api';

const ROWS = [ME_ROW, PRIYA, SAM, INVITE_JO, INVITE_OLD];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test('lists staff with roles, statuses, last clock-in and the seat meter', async ({ page }) => {
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: { 'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 4) }) },
  });
  await page.goto('/settings/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await expect(page.getByText('4 of 5 users')).toBeVisible();
  await expect(
    page.getByText('Active users and pending invites count toward your plan.'),
  ).toBeVisible();

  const sam = page.getByRole('row', { name: /Sam Lee/ });
  await expect(sam.getByText('Technician')).toBeVisible();
  await expect(sam.getByText('Active')).toBeVisible();
  await expect(page.getByRole('row', { name: /Alex Morgan/ }).getByText('You')).toBeVisible();
  // Own row has no actions.
  await expect(page.getByRole('button', { name: 'Actions for Alex Morgan' })).toHaveCount(0);

  const jo = page.getByRole('row', { name: /jo@example.com/ });
  await expect(jo.getByText('Invited')).toBeVisible();
  await expect(jo.getByText('Email failed', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('row', { name: /old@example.com/ }).getByText(/Expired on/),
  ).toBeVisible();
});

test('invites a technician', async ({ page }) => {
  let body: unknown;
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/staff': (route) => route.fulfill({ json: staffList([ME_ROW], 1) }),
      'POST /api/staff/invites': async (route, request) => {
        body = request.postDataJSON();
        await route.fulfill({
          status: 201,
          json: StaffListItem.parse({
            ...INVITE_JO,
            email: 'new@example.com',
            inviteEmailStatus: 'QUEUED',
          }),
        });
      },
    },
  });
  await page.goto('/settings/staff');
  await expect(
    page.getByRole('heading', { name: "You're the only one here. Invite your team." }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Invite staff' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Invite staff' });
  await dialog.getByLabel('Email').fill('New@Example.com ');
  await dialog.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: /Front desk/ }).click();
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(toast(page, 'Invite sent to new@example.com')).toBeVisible();
  expect(body).toEqual({ email: 'new@example.com', role: 'FRONT_DESK' });
});

test('managers can only invite front desk and technicians', async ({ page }) => {
  await mockApi(page, {
    me: meAs('MANAGER'),
    handlers: { 'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 4) }) },
  });
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'Invite staff' }).click();
  await page.getByRole('combobox', { name: 'Role' }).click();
  await expect(page.getByRole('option')).toHaveText([/Front desk/, /Technician/]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A manager can't act on another manager.
  await expect(page.getByRole('button', { name: 'Actions for Priya Shah' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for Sam Lee' })).toBeVisible();
});

test('at the seat limit the invite button is disabled with the billing message', async ({
  page,
}) => {
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: { 'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 5) }) },
  });
  await page.goto('/settings/staff');
  await expect(page.getByText('5 of 5 users')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite staff' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(
    page
      .locator('.astryx-banner-description')
      .getByText('Your plan includes 5 users. Extra users are $5/month; billing arrives later.'),
  ).toBeVisible();
});

test('the API seat limit error shows in the invite dialog', async ({ page }) => {
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 4) }),
      'POST /api/staff/invites': (route) =>
        route.fulfill({ status: 403, json: apiError(403, 'SEAT_LIMIT_REACHED', 'Seats full') }),
    },
  });
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'Invite staff' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite staff' });
  await dialog.getByLabel('Email').fill('late@example.com');
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(dialog.getByText('No seats left')).toBeVisible();
  await expect(
    dialog.getByText('Extra users are $5/month; billing arrives later.', { exact: false }),
  ).toBeVisible();
});

test('deactivating the last owner shows the LAST_OWNER message', async ({ page }) => {
  const otherOwner = StaffListItem.parse({ ...PRIYA, role: 'OWNER' });
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/staff': (route) => route.fulfill({ json: staffList([ME_ROW, otherOwner], 2) }),
      'POST /api/staff/:id/deactivate': (route) =>
        route.fulfill({ status: 409, json: apiError(409, 'LAST_OWNER', 'Last owner') }),
    },
  });
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'Actions for Priya Shah' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(
    confirm.getByText('Priya Shah will lose access to Fix It Phones immediately.', {
      exact: false,
    }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Deactivate' }).click();
  await expect(toast(page, 'A shop needs at least one active owner.')).toBeVisible();
});

test('changes a role and resends a failed invite', async ({ page }) => {
  const api = await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 4) }),
      'PATCH /api/staff/:id/role': (route) =>
        route.fulfill({ json: StaffListItem.parse({ ...SAM, role: 'FRONT_DESK' }) }),
      'POST /api/staff/invites/:id/resend': (route) =>
        route.fulfill({ json: StaffListItem.parse({ ...INVITE_JO, inviteEmailStatus: 'QUEUED' }) }),
    },
  });
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'Actions for Sam Lee' }).click();
  await page.getByRole('menuitem', { name: 'Change role…' }).click();
  const dialog = page.getByRole('dialog', { name: "Change Sam Lee's role" });
  await dialog.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: /Front desk/ }).click();
  await dialog.getByRole('button', { name: 'Change role' }).click();
  await expect(toast(page, 'Sam Lee is now Front desk')).toBeVisible();
  expect(api.calls.find((c) => c.path === '/api/staff/mem_sam/role')?.body).toEqual({
    role: 'FRONT_DESK',
  });

  await page
    .getByRole('row', { name: /jo@example.com/ })
    .getByRole('link', { name: 'Resend invite' })
    .click();
  await expect(toast(page, 'Invite sent again to jo@example.com')).toBeVisible();
});

test('copies an invite link for WhatsApp', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const url = 'http://localhost:3100/invite/abcdefghijABCDEFGHIJabcdefghijABCDEFGHIJ123';
  await mockApi(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'GET /api/staff': (route) => route.fulfill({ json: staffList(ROWS, 4) }),
      'POST /api/staff/invites/:id/link': (route) =>
        route.fulfill({
          json: InviteLinkResponse.parse({ url, expiresAt: '2026-12-02T15:00:00.000Z' }),
        }),
    },
  });
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: 'Actions for jo@example.com' }).click();
  await page.getByRole('menuitem', { name: /Copy invite link/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite link copied' });
  await expect(dialog.getByText('Paste it into WhatsApp', { exact: false })).toBeVisible();
  await expect(dialog.getByLabel('Invite link')).toHaveValue(url);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
});
