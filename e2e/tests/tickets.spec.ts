import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { meAs } from './support/fixtures';
import { ME_WITH_SHOP, apiError, toast } from './support/mock-api';
import { ST, mockSprint2, ref, statusList, ticket } from './support/sprint2';

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test.describe('ticket list', () => {
  test('views with counts, search, row menu status change', async ({ page }) => {
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();
    const views = page.getByRole('navigation', { name: 'Ticket views' });
    await expect(views.getByRole('button', { name: 'All open 4' })).toBeVisible();
    await expect(views.getByRole('button', { name: 'Overdue 1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
    await expect(page.getByText('Showing 1–4 of 4')).toBeVisible();

    // "/" focuses the page's own search; typing filters through the URL.
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search tickets' })).toBeFocused();
    await page.keyboard.type('sarah');
    await expect(page).toHaveURL(/q=sarah/);
    await expect(page.getByRole('link', { name: 'T-1040' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'T-1042' })).toBeHidden();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();

    // Row menu → Change status ▸ Diagnosing (optimistic, then the server's answer).
    await page.getByRole('button', { name: 'Actions for T-1039' }).click();
    await page.getByRole('menuitem', { name: 'Change status' }).click();
    await page.getByRole('menuitem', { name: /Diagnosing/ }).click();
    await expect(toast(page, 'Status changed to Diagnosing')).toBeVisible();
    expect(api.writes.some((w) => w.path === '/api/tickets/tkt_1039/status')).toBe(true);
    await axe(page);
  });

  test('technicians land on Mine and the ready view shows its empty copy', async ({ page }) => {
    await mockSprint2(page, { me: meAs('TECHNICIAN'), tickets: [] });
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: 'Nothing assigned to you.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New ticket' })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Ticket views' })
      .getByRole('button', { name: /Ready for pickup/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Nothing waiting for pickup.' })).toBeVisible();
  });

  test('a list error offers Try again', async ({ page }) => {
    await mockSprint2(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'GET /api/tickets': (route) =>
          route.fulfill({ status: 500, json: apiError(500, 'INTERNAL', 'Boom') }),
      },
    });
    await page.goto('/tickets');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('ticket detail', () => {
  test('header, cards, timeline and adding a note', async ({ page }) => {
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets/tkt_1042');
    await expect(page.getByRole('heading', { level: 1, name: 'T-1042' })).toBeVisible();
    await expect(page.getByText('Urgent').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add note' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Customer' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ali Khan' })).toBeVisible();
    await expect(page.getByText('IMEI •••• 3809')).toBeVisible();
    await expect(page.getByText('Ordered a new screen, arrives tomorrow.')).toBeVisible();
    await expect(page.getByText('Visible to customer').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print' })).toBeDisabled();

    await page.keyboard.press('m');
    await expect(page.getByRole('textbox', { name: 'Add a note' })).toBeFocused();
    await page.keyboard.type('Customer asked for a call.');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(toast(page, 'Note added')).toBeVisible();
    const note = api.state.calls.find(
      (c) => c.method === 'POST' && c.path === '/api/tickets/tkt_1042/notes',
    );
    expect(note?.body).toEqual({ body: 'Customer asked for a call.', visibility: 'INTERNAL' });
    await axe(page);
  });

  test('status menu: allowed targets only; Unrepairable asks for a note', async ({ page }) => {
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets/tkt_1042');
    await expect(page.getByRole('button', { name: 'Change status' })).toBeVisible();
    await page.keyboard.press('s');
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Ready Ready for pickup', exact: true }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Cancelled/ })).toHaveCount(0);
    // Collected from an in-progress ticket is explained, not offered.
    await expect(menu.getByRole('menuitem', { name: /Collected/ })).toBeDisabled();
    await expect(menu.getByText(/Mark it Ready for pickup first/)).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Ready Unrepairable', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark as Unrepairable' });
    await dialog.getByRole('button', { name: 'Mark as Unrepairable' }).click();
    await expect(dialog.getByText('Write a note').first()).toBeVisible();
    await dialog
      .getByRole('textbox', { name: "Why can't it be repaired?" })
      .fill('Logic board is beyond repair.');
    await dialog.getByRole('button', { name: 'Mark as Unrepairable' }).click();
    await expect(toast(page, 'Status changed to Unrepairable')).toBeVisible();
    const call = api.state.calls.find((c) => c.path === '/api/tickets/tkt_1042/status');
    expect(call?.body).toEqual({
      statusId: ST.unrepairable,
      note: { body: 'Logic board is beyond repair.', visibility: 'CUSTOMER' },
    });
  });

  test('a transition the server refuses rolls back with the contract message', async ({ page }) => {
    await mockSprint2(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'POST /api/tickets/:id/status': (route) =>
          route.fulfill({
            status: 409,
            json: apiError(409, 'TRANSITION_NOT_ALLOWED', "This ticket can't move to that status."),
          }),
      },
    });
    await page.goto('/tickets/tkt_1042');
    await page.getByRole('button', { name: 'Change status' }).click();
    await page.getByRole('menuitem', { name: /Diagnosing/ }).click();
    await expect(toast(page, "This ticket can't move to that status.")).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('In repair');
  });

  test('a write that still races after retries (409 CONFLICT) shows the API message', async ({
    page,
  }) => {
    const message = 'This status was changed at the same time. Check the ticket and try again.';
    await mockSprint2(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'POST /api/tickets/:id/status': (route) =>
          route.fulfill({ status: 409, json: apiError(409, 'CONFLICT', message) }),
        'PATCH /api/tickets/:id': (route) =>
          route.fulfill({ status: 409, json: apiError(409, 'CONFLICT', message) }),
      },
    });
    await page.goto('/tickets/tkt_1042');
    await page.getByRole('button', { name: 'Change status' }).click();
    await page.getByRole('menuitem', { name: /Diagnosing/ }).click();
    await expect(toast(page, message)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('In repair');

    await page.getByRole('button', { name: 'Edit details' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Edit T-1042' });
    await dialog.getByRole('radio', { name: 'Normal' }).click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText(message)).toBeVisible();
    await expect(page.getByText('CONFLICT', { exact: true })).toHaveCount(0);
  });

  test('passcode reveal: POST, shown with a countdown, hidden after 30 s', async ({ page }) => {
    await page.clock.install();
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets/tkt_1042');
    await expect(page.getByText('PIN/passcode on file')).toBeVisible();
    await expect(page.getByText(/Viewed 2 times · last by Sam Patel/)).toBeVisible();
    await page.getByRole('button', { name: 'Show passcode' }).click();
    await expect(page.getByText('482913')).toBeVisible();
    await expect(page.getByText('Hides in 30 s').first()).toBeVisible();
    expect(
      api.writes.filter((w) => w.path === '/api/tickets/tkt_1042/passcode/reveal'),
    ).toHaveLength(1);
    await expect(page.getByText(/Viewed 3 times · last by Alex Morgan/)).toBeVisible();
    await page.clock.runFor(31_000);
    await expect(page.getByText('482913')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show passcode' })).toBeVisible();
    expect(page.url()).not.toContain('482913');
  });

  test('version conflict: "This ticket was changed by …" with Reload, input kept', async ({
    page,
  }) => {
    let version = 3;
    await mockSprint2(page, {
      me: ME_WITH_SHOP,
      handlers: {
        'PATCH /api/tickets/:id': (route) =>
          route.fulfill({
            status: 409,
            json: apiError(409, 'STALE_RECORD', 'This ticket changed since you opened it.'),
          }),
        'GET /api/tickets/:id': (route) => {
          const t = ticket({
            id: 'tkt_1042',
            number: 1042,
            statusId: ST.inRepair,
            version: version++,
          });
          return route.fulfill({ status: 200, json: t });
        },
      },
    });
    await page.goto('/tickets/tkt_1042');
    await page.getByRole('button', { name: 'Edit details' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Edit T-1042' });
    await dialog.getByRole('radio', { name: 'Urgent' }).click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByText('This ticket was changed by Alex Morgan.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Reload' }).click();
    await expect(dialog.getByRole('radio', { name: 'Urgent' })).toBeChecked();
  });

  test('cancel needs a reason and the hand-back confirmation', async ({ page }) => {
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets/tkt_1041');
    await page.getByRole('button', { name: 'More actions for T-1041' }).click();
    await page.getByRole('menuitem', { name: 'Cancel ticket…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel T-1041' });
    await dialog.getByRole('radio', { name: 'Customer took device back' }).check();
    await dialog.getByRole('button', { name: 'Cancel ticket' }).click();
    await expect(
      dialog.getByText('Confirm the device and accessories were returned').first(),
    ).toBeVisible();
    await dialog.getByRole('checkbox', { name: /Device and accessories returned/ }).check();
    await dialog.getByRole('button', { name: 'Cancel ticket' }).click();
    await expect(toast(page, 'T-1041 cancelled')).toBeVisible();
    expect(api.state.calls.find((c) => c.path.endsWith('/cancel'))?.body).toMatchObject({
      reason: 'CUSTOMER_TOOK_BACK',
      returnedConfirmed: true,
      statusId: ST.cancelled,
    });
  });

  test('technicians see no close actions and cannot reveal on a closed ticket', async ({
    page,
  }) => {
    const closed = ticket({ id: 'tkt_1030', number: 1030, statusId: ST.collected });
    await mockSprint2(page, { me: meAs('TECHNICIAN'), tickets: [closed] });
    await page.goto('/tickets/tkt_1030');
    await expect(page.getByRole('heading', { level: 1, name: 'T-1030' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change status' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show passcode' })).toHaveCount(0);
    await expect(page.getByText('Passcode on file')).toBeVisible();
  });

  test('an unknown ticket shows the not-found state', async ({ page }) => {
    await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/tickets/tkt_nope');
    await expect(page.getByRole('heading', { name: "We can't find that ticket." })).toBeVisible();
  });
});

test('statuses fixture matches the seeded workflow', () => {
  expect(statusList().map((s) => s.name)).toContain('Unrepairable');
  expect(ref(statusList()[0]!).systemRole).toBe('INITIAL');
});
