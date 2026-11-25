import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createTicketSchema } from '@repairos/contracts';
import { meAs } from './support/fixtures';
import { ME_WITH_SHOP, SHOP, apiError, toast } from './support/mock-api';
import { mockSprint2, type FakeApi } from './support/sprint2';

/**
 * Check-in at /tickets/new (spec §2) against the mocked API. The two keyboard-only scenarios keep
 * the prototype's keystroke budget (TK1.11: ≤ 15 after the search term on the returning path).
 * Keystrokes are counted as the story does: the customer search term separately; a chord such as
 * ⌘↵ is one keystroke; typed text one per character.
 */

class Keys {
  search = 0;
  after = 0;
  private inSearch = true;
  constructor(private readonly page: Page) {}
  endSearch() {
    this.inSearch = false;
  }
  private add(n: number) {
    if (this.inSearch) this.search += n;
    else this.after += n;
  }
  async type(text: string) {
    await this.page.keyboard.type(text);
    this.add(text.length);
  }
  async press(key: string) {
    await this.page.keyboard.press(key);
    this.add(1);
  }
}

async function open(
  page: Page,
  me = ME_WITH_SHOP,
  setup?: (api: FakeApi) => void,
): Promise<FakeApi> {
  const api = await mockSprint2(page, { me });
  setup?.(api);
  await page.goto('/tickets/new');
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
  // Create waits for the check-in context.
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  return api;
}

function report(keys: Keys, name: string) {
  const line = `${name}: ${keys.search} keystrokes of search term + ${keys.after} after it = ${keys.search + keys.after} total`;
  console.log(line);
  test.info().annotations.push({ type: 'keystrokes', description: line });
}

test('returning customer with a known device: keyboard only, ≤ 15 keystrokes after the search', async ({
  page,
}) => {
  const api = await open(page);
  const keys = new Keys(page);

  await keys.type('ali k');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  keys.endSearch();
  await keys.press('Enter');

  const device = page.getByRole('radio', { name: /Apple iPhone 13/ });
  await expect(device).toBeFocused();
  await expect(device).toBeChecked();
  await keys.press('Enter');

  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
  await keys.type('scr');
  await keys.press('Enter');
  await expect(page.getByRole('button', { name: 'Screen cracked', pressed: true })).toBeVisible();
  await expect(page.getByText(/Ali Khan · Apple iPhone 13 · Screen cracked/)).toBeVisible();

  await keys.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/\/tickets\/tkt_1043$/);
  await expect(toast(page, 'Ticket T-1043 created')).toBeVisible();
  report(keys, 'Returning customer');
  expect(keys.after).toBeLessThanOrEqual(15);

  // The body is the contract's, with an Idempotency-Key and the active shop.
  expect(api.created).toHaveLength(1);
  const sent = api.created[0]!;
  expect(createTicketSchema('GB').safeParse(sent.body).success).toBe(true);
  expect(sent.body).toMatchObject({
    customerId: 'cus_1',
    deviceId: 'dev_1',
    issues: [{ code: 'SCREEN_CRACKED' }],
  });
  expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent.shopId).toBe(SHOP.id);
});

test('new customer and new device: keyboard only', async ({ page }) => {
  const api = await open(page);
  const keys = new Keys(page);

  await keys.type('Priya Shah');
  await expect(page.getByRole('option', { name: /New customer “Priya Shah”/ })).toBeVisible();
  keys.endSearch();
  await keys.press('Enter');

  await expect(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Priya');
  await expect(page.getByRole('textbox', { name: 'Last name' })).toHaveValue('Shah');
  await expect(page.getByRole('textbox', { name: 'Phone' })).toBeFocused();
  await keys.type('07400 900123');
  await keys.press('Enter');

  await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
  await keys.type('iph 13');
  // R1/R2: one box, shortest match first.
  await expect(page.getByRole('option').first()).toHaveText(/Apple iPhone 13$/);
  await keys.press('Enter');

  await expect(page.getByRole('textbox', { name: 'IMEI' })).toBeFocused();
  await keys.type('490154203237518');
  await keys.press('Enter');

  await expect(page.getByRole('radio', { name: 'None' })).toBeFocused();
  await keys.press('ArrowRight');
  await expect(page.getByLabel('PIN/passcode')).toBeVisible();
  await keys.press('Tab');
  await expect(page.getByLabel('PIN/passcode')).toBeFocused();
  await keys.type('1234');
  await keys.press('Enter');

  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
  await keys.type('scr');
  await keys.press('Enter');
  await keys.press('ControlOrMeta+Enter');

  await expect(page).toHaveURL(/\/tickets\/tkt_1043$/);
  report(keys, 'New customer + new device');
  expect(keys.search + keys.after).toBeLessThanOrEqual(60);
  const body = api.created[0]!.body;
  expect(body.newCustomer).toMatchObject({
    firstName: 'Priya',
    lastName: 'Shah',
    phones: [{ number: '07400 900123' }],
  });
  expect(body.newDevice).toMatchObject({
    type: 'PHONE',
    brand: 'Apple',
    model: 'iPhone 13',
    imei: '490154203237518',
    passcode: { lockType: 'PIN', value: '1234' },
  });
});

test('scanning an IMEI selects the customer and the device in one go (R6)', async ({ page }) => {
  await open(page);
  await page.keyboard.type('356938035643809');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toContainText(
    'IMEI match: Apple iPhone 13',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
  await expect(page.getByText('Apple iPhone 13', { exact: true })).toBeVisible();
});

test('create with nothing filled lists what is missing and focuses the customer search', async ({
  page,
}) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(
    page.getByText(/Before creating: choose a customer · choose a device/),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
  expect(api.created).toHaveLength(0);
});

test('API validation errors land on the fields', async ({ page }) => {
  const api = await mockSprint2(page, {
    me: ME_WITH_SHOP,
    handlers: {
      'POST /api/tickets': (route) =>
        route.fulfill({
          status: 400,
          json: {
            ...apiError(400, 'VALIDATION_FAILED', 'Check the form'),
            issues: [
              { path: ['newDevice', 'imei'], message: 'This IMEI is already on another device.' },
            ],
          },
        }),
    },
  });
  await page.goto('/tickets/new');
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
  await page.keyboard.type('Jo Bloggs');
  await page.getByRole('option', { name: /New customer/ }).click();
  await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900124');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pixel 8');
  await page.getByRole('option', { name: 'Google Pixel 8', exact: true }).click();
  await page.getByRole('textbox', { name: 'IMEI' }).fill('490154203237518');
  await page.getByRole('button', { name: 'Use this device' }).click();
  await page.keyboard.type('batt');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText("Couldn't create the ticket")).toBeVisible();
  await expect(page.getByText('This IMEI is already on another device.').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'IMEI' })).toHaveAttribute('aria-invalid', 'true');
  expect(api.created).toHaveLength(0);
});

test('a phone that is already a customer shows the duplicate warning; "Use this customer" switches to them', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.type('Ali Again');
  await page.getByRole('option', { name: /New customer/ }).click();
  await page.getByRole('textbox', { name: 'Phone' }).fill('07400 123456');
  await expect(page.getByText('Already a customer?')).toBeVisible();
  await page.getByRole('button', { name: 'Use this customer' }).first().click();
  await expect(page.getByRole('heading', { name: 'Customer' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Apple iPhone 13/ })).toBeFocused();
});

test('an archived customer is offered with "Restore and use" and restored before create (R5)', async ({
  page,
}) => {
  const api = await open(page);
  await page.keyboard.type('khalid');
  const option = page.getByRole('option', { name: /Khalid Mahmood/ });
  await expect(option).toContainText('Archived · Restore and use');
  await page.keyboard.press('Enter');
  await expect(page.getByText("Restored. They're back in lists and search.")).toBeVisible();
  expect(
    api.state.calls.some((c) => c.path === '/api/customers' && c.search.includes('archived=true')),
  ).toBe(true);
  expect(api.writes.some((w) => w.path === '/api/customers/cus_4/restore')).toBe(true);
});

test('a draft is kept in this browser without the passcode and can be discarded', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.type('ali k');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio', { name: /Apple iPhone 13/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('scr');
  await page.keyboard.press('Enter');
  const stored = await page.evaluate(
    () =>
      Object.entries(localStorage).find(([k]) => k.startsWith('repairos:checkin-draft:'))?.[1] ??
      '',
  );
  expect(stored).toContain('SCREEN_CRACKED');
  await page.reload();
  await expect(page.getByText(/Draft restored from/)).toBeVisible();
  await expect(page.getByText(/Ali Khan · Apple iPhone 13 · Screen cracked/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeVisible();
});

test('the pattern grid works by keyboard and the secret never reaches the draft', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.type('Priya');
  await page.getByRole('option', { name: /New customer/ }).click();
  await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900123');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pixel 8');
  await page.getByRole('option', { name: 'Google Pixel 8', exact: true }).click();
  await page.getByRole('radio', { name: 'Pattern' }).click();
  await page.getByRole('button', { name: 'Dot 1', exact: true }).focus();
  await page.keyboard.type('1596');
  await expect(page.getByText('Pattern: 1 → 5 → 9 → 6 (4 dots)')).toBeVisible();
  const stored = await page.evaluate(
    () =>
      Object.entries(localStorage).find(([k]) => k.startsWith('repairos:checkin-draft:'))?.[1] ??
      '',
  );
  expect(stored).toContain('"lockType":"PATTERN"');
  expect(stored).toContain('"pattern":[]');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
});

test('technicians cannot open check-in', async ({ page }) => {
  await mockSprint2(page, { me: meAs('TECHNICIAN') });
  await page.goto('/tickets/new');
  await expect(
    page.getByRole('heading', { name: "You don't have access to this page" }),
  ).toBeVisible();
});

test('check-in has no axe violations', async ({ page }) => {
  await open(page);
  await page.keyboard.type('ali k');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio', { name: /Apple iPhone 13/ })).toBeFocused();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});
