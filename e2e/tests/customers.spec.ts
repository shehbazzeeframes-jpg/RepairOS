import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MeResponse, Shop, permissionsFor } from '@repairos/contracts';
import { meAs } from './support/fixtures';
import { ME_WITH_SHOP, USER, apiError, toast } from './support/mock-api';
import { ALI, KHALID, mockSprint2 } from './support/sprint2';
import { selectOption } from './support/select';

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const US_SHOP = Shop.parse({
  id: 'shp_us',
  name: 'Fix It Phones NYC',
  country: 'US',
  currency: 'USD',
  locale: 'en-US',
  timezone: 'America/New_York',
  pricesIncludeTax: false,
  phone: null,
  createdAt: '2026-11-20T09:00:00.000Z',
});
const ME_US = MeResponse.parse({
  user: USER,
  memberships: [{ shopId: US_SHOP.id, shopName: US_SHOP.name, role: 'OWNER', status: 'ACTIVE' }],
  activeShop: US_SHOP,
  role: 'OWNER',
  permissions: permissionsFor('OWNER'),
  accessRemoved: null,
});

test('customer list: search, archived switch, open a customer', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/customers');
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ali Khan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Khalid Mahmood' })).toHaveCount(0);
  await page.getByRole('switch', { name: 'Show archived' }).click();
  await expect(page).toHaveURL(/archived=true/);
  await expect(page.getByRole('link', { name: 'Khalid Mahmood' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('nobody');
  await expect(page.getByRole('heading', { name: 'No customers match “nobody”' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await page.getByRole('link', { name: 'Ali Khan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ali Khan' })).toBeVisible();
  await axe(page);
});

test('customer detail: tickets via the list filter, devices, consent history', async ({ page }) => {
  const api = await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}`);
  await expect(page.getByText(/SMS marketing: Yes since/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
  expect(
    api.state.calls.some(
      (c) => c.path === '/api/tickets' && c.search.includes(`customerId=${ALI.id}`),
    ),
  ).toBe(true);
  await page
    .getByRole('navigation', { name: 'Customer sections' })
    .getByRole('button', { name: /Devices/ })
    .click();
  await expect(page.getByRole('button', { name: 'Add device' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Actions for Apple iPhone 13' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Customer sections' })
    .getByRole('button', { name: /Details/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Consent history' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'In store – signed form' })).toBeVisible();
  await axe(page);
});

test('new customer with two phones and a US verbal SMS consent shows the TCPA warning', async ({
  page,
}) => {
  const api = await mockSprint2(page, { me: ME_US });
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Dana');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('212 555 0142');
  await page.getByRole('button', { name: 'Add phone' }).click();
  await page.getByRole('textbox', { name: 'Phone 2' }).fill('212 555 0199');
  await page.getByRole('switch', { name: 'Marketing by SMS' }).click();
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText('Choose how consent was given').first()).toBeVisible();
  await selectOption(page, 'How was consent given?', 'In store – verbal');
  await expect(page.getByText(/US law \(TCPA\) expects written consent/)).toBeVisible();
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(toast(page, 'Customer added')).toBeVisible();
  const post = api.state.calls.find((c) => c.method === 'POST' && c.path === '/api/customers');
  expect(post?.body).toMatchObject({
    firstName: 'Dana',
    phones: [
      { number: expect.stringContaining('555-0142'), isPrimary: true },
      { number: expect.stringContaining('555-0199') },
    ],
    consents: [{ channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_VERBAL' }],
  });
});

test('validation: a person needs a first name and a phone or email', async ({ page }) => {
  const api = await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/customers/new');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText('Enter a first name').first()).toBeVisible();
  await expect(page.getByText('Add a phone number or an email').first()).toBeVisible();
  expect(api.state.calls.some((c) => c.method === 'POST' && c.path === '/api/customers')).toBe(
    false,
  );
});

test('edit: a version conflict keeps the input and offers Reload', async ({ page }) => {
  await mockSprint2(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'PATCH /api/customers/:id': (route) =>
        route.fulfill({
          status: 409,
          json: apiError(409, 'STALE_RECORD', 'Someone else changed this customer.'),
        }),
    },
  });
  await page.goto(`/customers/${ALI.id}/edit`);
  await page.getByRole('textbox', { name: 'Last name' }).fill('Khan-Smith');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText('Someone else changed this customer. Reload to see their changes.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Last name' })).toHaveValue('Khan-Smith');
});

test('erase is blocked while tickets are open; archived customers can be restored', async ({
  page,
}) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase Ali Khan?' });
  await expect(
    dialog.getByText("Close or cancel this customer's 1 open tickets first."),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Erase customer' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/customers/${KHALID.id}`);
  await expect(page.getByText('Archived customer')).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await expect(toast(page, 'Customer restored')).toBeVisible();
});

test('erase needs ERASE typed, then shows the erased state', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${KHALID.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase Khalid Mahmood?' });
  await expect(dialog.getByRole('button', { name: 'Erase customer' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type ERASE to confirm' }).fill('ERASE');
  await dialog.getByRole('button', { name: 'Erase customer' }).click();
  await expect(page.getByRole('heading', { name: 'This customer was erased.' })).toBeVisible();
});

test('export downloads the JSON file', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Export data/ }).click();
  expect((await download).suggestedFilename()).toBe(`customer-${ALI.id}-2026-11-25.json`);
  await expect(toast(page, 'Export downloaded')).toBeVisible();
});

test('add a device: IMEI validated, model suggestions fill brand and type', async ({ page }) => {
  const api = await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}?tab=devices`);
  await page.getByRole('button', { name: 'Add device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add device' });
  await dialog.getByRole('combobox', { name: 'Model' }).fill('galaxy s24 ultra');
  await page.getByRole('option', { name: 'Galaxy S24 Ultra', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Brand Samsung' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'IMEI' }).fill('356938035643808');
  await expect(dialog.getByText(/This IMEI isn't valid/).first()).toBeVisible();
  await dialog.getByRole('textbox', { name: 'IMEI' }).fill('490154203237518');
  await dialog.getByRole('radio', { name: 'PIN/passcode' }).click();
  await dialog.getByLabel('PIN/passcode').fill('0000');
  await dialog.getByRole('button', { name: 'Add device' }).click();
  await expect(toast(page, 'Samsung Galaxy S24 Ultra added')).toBeVisible();
  const post = api.state.calls.find(
    (c) => c.method === 'POST' && c.path === `/api/customers/${ALI.id}/devices`,
  );
  expect(post?.body).toMatchObject({
    type: 'PHONE',
    brand: 'Samsung',
    model: 'Galaxy S24 Ultra',
    imei: '490154203237518',
    passcode: { lockType: 'PIN', value: '0000' },
  });
});

test('technicians can view customers but not edit them; front desk cannot erase', async ({
  page,
}) => {
  await mockSprint2(page, { me: meAs('TECHNICIAN') });
  await page.goto(`/customers/${ALI.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ali Khan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await page.goto('/customers/new');
  await expect(
    page.getByRole('heading', { name: "You don't have access to this page" }),
  ).toBeVisible();

  await mockSprint2(page, { me: meAs('FRONT_DESK') });
  await page.goto(`/customers/${ALI.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Erase…' })).toHaveCount(0);
});
