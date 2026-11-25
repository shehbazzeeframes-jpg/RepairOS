import { expect, test } from '@playwright/test';
import { ME_WITH_SHOP, apiError } from './support/mock-api';
import { mockSprint2, ticket } from './support/sprint2';

/**
 * Warranty check-in (M2): the API refuses a warranty unless the original was Collected and is the
 * same device. The form locks the device, warns early and shows the API message. Failed on main 84df6fb.
 */

// ---------- Warranty (M2) ----------

test('warranty check-in locks customer and device and says why', async ({ page }) => {
  const api = await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/new?warrantyOf=tkt_1030');
  await expect(page.getByText('Warranty for T-1030')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change device' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change customer' })).toHaveCount(0);
  await expect(page.getByText('A warranty ticket is for the same device as T-1030.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Find an issue' }).fill('scr');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page).toHaveURL(/\/tickets\/tkt_1043$/);
  expect(api.created[0]!.body).toMatchObject({ deviceId: 'dev_1', warrantyOfTicketId: 'tkt_1030' });
});

test('warranty refused by the API: its message, and “Create without the warranty link”', async ({
  page,
}) => {
  let refused = false;
  const api = await mockSprint2(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'POST /api/tickets': async (route, req) => {
        const body = req.postDataJSON() as { warrantyOfTicketId?: string };
        if (body.warrantyOfTicketId) {
          refused = true;
          return route.fulfill({
            status: 409,
            json: apiError(
              409,
              'WARRANTY_NOT_ALLOWED',
              'T-1030 was for a different device, so this can’t be a warranty ticket.',
            ),
          });
        }
        api.created.push({ body: body as never, idempotencyKey: null, shopId: null });
        return route.fulfill({ status: 201, json: ticket({ id: 'tkt_1043', number: 1043 }) });
      },
    },
  });
  await page.goto('/tickets/new?warrantyOf=tkt_1030');
  await page.getByRole('textbox', { name: 'Find an issue' }).fill('scr');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(
    page.getByText('T-1030 was for a different device, so this can’t be a warranty ticket.'),
  ).toBeVisible();
  expect(refused).toBe(true);
  await page.getByRole('button', { name: 'Create without the warranty link' }).click();
  await expect(page.getByText('Warranty for T-1030')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page).toHaveURL(/\/tickets\/tkt_1043$/);
  expect(api.created.at(-1)!.body).not.toHaveProperty('warrantyOfTicketId');
});

test('warranty of a ticket that was not collected: warned, no warranty link', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/new?warrantyOf=tkt_1041');
  await expect(page.getByText(/T-1041 hasn't been collected/)).toBeVisible();
  await expect(page.getByText('Warranty for T-1041')).toHaveCount(0);
});
