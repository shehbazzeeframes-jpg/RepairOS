import { expect, test, type Page } from '@playwright/test';
import { ME_WITH_SHOP, mockApi } from './support/mock-api';

/**
 * Sprint 2 check-in prototype (/prototype/check-in): proves the keyboard-only paths and counts
 * keystrokes for the two scenarios in docs/screens/sprint2.md §2. The page itself also reports the
 * time and keystrokes it saw, which this test logs (and attaches) for the spec and the hallway test.
 *
 * Keystrokes are counted the way the story does (TK1.11): the customer search term is listed
 * separately; a chord such as ⌘↵ counts as one keystroke; typed text counts one per character.
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

async function open(page: Page) {
  await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/prototype/check-in');
  const search = page.getByRole('combobox', { name: 'Find customer' });
  await expect(search).toBeFocused();
  return search;
}

async function finish(page: Page, keys: Keys, name: string, started: number) {
  const wall = (Date.now() - started) / 1000;
  await expect(page.getByText('Ticket T-1042 created')).toBeVisible();
  const metrics = (
    (await page.getByText(/Checked in in .* keystrokes\./).textContent()) ?? ''
  ).replace(/^.*(Checked in)/, '$1');
  await expect(page.getByText(/passes createTicketSchema/)).toBeVisible();
  const line = `${name}: ${keys.search} keystrokes of search term + ${keys.after} after it = ${
    keys.search + keys.after
  } total; Playwright wall time ${wall.toFixed(1)} s; page says "${metrics.trim()}"`;
  console.log(line);
  test.info().annotations.push({ type: 'keystrokes', description: line });
  return { total: keys.search + keys.after, after: keys.after };
}

test('returning customer with a known device: keyboard only, ≤ 15 keystrokes after the search', async ({
  page,
}) => {
  await open(page);
  const started = Date.now();
  const keys = new Keys(page);

  await keys.type('ali k');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  keys.endSearch();
  await keys.press('Enter'); // first match: Ali Khan

  const device = page.getByRole('radio', { name: /Apple iPhone 13/ });
  await expect(device).toBeFocused();
  await expect(device).toBeChecked();
  await keys.press('Enter'); // most recent device

  const issue = page.getByRole('textbox', { name: 'Find an issue' });
  await expect(issue).toBeFocused();
  await keys.type('scr');
  await keys.press('Enter'); // adds "Screen cracked"
  await expect(page.getByRole('button', { name: 'Screen cracked', pressed: true })).toBeVisible();

  await keys.press('ControlOrMeta+Enter');
  const { after } = await finish(page, keys, 'Returning customer', started);
  expect(after).toBeLessThanOrEqual(15);
  await expect(page.getByText(/Ali Khan · Apple iPhone 13 · Screen cracked/)).toBeVisible();
});

test('new customer and new device: keyboard only', async ({ page }) => {
  await open(page);
  const started = Date.now();
  const keys = new Keys(page);

  await keys.type('Priya Shah');
  await expect(page.getByRole('option', { name: /New customer “Priya Shah”/ })).toBeVisible();
  keys.endSearch();
  await keys.press('Enter'); // the only option: New customer "Priya Shah"

  await expect(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Priya');
  await expect(page.getByRole('textbox', { name: 'Last name' })).toHaveValue('Shah');
  const phone = page.getByRole('textbox', { name: 'Phone' });
  await expect(phone).toBeFocused();
  await keys.type('07400 900123');
  await keys.press('Enter'); // use this customer

  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model).toBeFocused();
  await keys.type('iph 13');
  await expect(page.getByRole('option', { name: 'Apple iPhone 13', exact: true })).toBeVisible();
  await keys.press('Enter'); // fills type Phone, brand Apple, model iPhone 13

  const imei = page.getByRole('textbox', { name: 'IMEI' });
  await expect(imei).toBeFocused();
  await keys.type('356938035643809'); // or a scanner: same keys + Enter
  await keys.press('Enter');

  const none = page.getByRole('radio', { name: 'None' });
  await expect(none).toBeFocused();
  await keys.press('ArrowRight'); // PIN
  await expect(page.getByLabel('PIN/passcode')).toBeVisible(); // a person sees the field appear
  await keys.press('Tab');
  await expect(page.getByLabel('PIN/passcode')).toBeFocused();
  await keys.type('1234');
  await keys.press('Enter'); // use this device

  const issue = page.getByRole('textbox', { name: 'Find an issue' });
  await expect(issue).toBeFocused();
  await keys.type('scr');
  await keys.press('Enter');
  await keys.press('ControlOrMeta+Enter');

  await finish(page, keys, 'New customer + new device', started);
  await expect(page.getByText(/Priya Shah · Apple iPhone 13 · Screen cracked/)).toBeVisible();
});

test('scanning an IMEI selects the customer and the device in one go', async ({ page }) => {
  await open(page);
  await page.keyboard.type('356938035643809');
  await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
  await expect(page.getByText('Apple iPhone 13', { exact: true })).toBeVisible();
});

test('create with nothing filled lists what is missing and focuses the customer search', async ({
  page,
}) => {
  const search = await open(page);
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(
    page.getByText(/Before creating: choose a customer · choose a device/),
  ).toBeVisible();
  await expect(search).toBeFocused();
});

test('the pattern grid works by keyboard', async ({ page }) => {
  await open(page);
  await page.keyboard.type('Priya');
  await expect(page.getByRole('option', { name: /New customer/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900123');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pixel 8');
  await page.getByRole('option', { name: 'Google Pixel 8', exact: true }).click();
  await page.getByRole('radio', { name: 'Pattern' }).click();
  await page.getByRole('button', { name: 'Dot 1', exact: true }).focus();
  await page.keyboard.type('1596');
  await expect(page.getByText('Pattern: 1 → 5 → 9 → 6 (4 dots)')).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(page.getByText('Pattern: 1 → 5 → 9 (3 dots)')).toBeVisible();
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
});
