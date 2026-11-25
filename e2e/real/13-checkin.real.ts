import { expect, test, type Page } from '@playwright/test';
import { SEED, apiAs, signInContext, sql, toast } from './support/stack';
import {
  call,
  checkIn,
  customer,
  freshShop,
  imei,
  member,
  ok,
  phone,
  shot2,
  uuid,
} from './support/sprint2';

/**
 * Sprint 2 §5.1 check-in (TK1–TK4) on the real stack. Keystrokes are counted the way the story does: the
 * customer search term separately; a chord (⌘↵) is one keystroke; typed text one per character.
 * Machine time = first keystroke → ticket page heading visible (real API, real DB transaction).
 */
class Keys {
  search = 0;
  after = 0;
  decisions = 0;
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
  async press(key: string, decision = false) {
    await this.page.keyboard.press(key);
    this.add(1);
    if (decision) this.decisions += 1;
  }
}

/** Keystroke-level model estimate (same constants as docs/screens/sprint2.md §2.6). */
function klm(keys: Keys): number {
  return (keys.search + keys.after) * 0.28 + keys.decisions * 1.35 + 3;
}

function report(name: string, keys: Keys, ms: number) {
  const line = `${name}: search ${keys.search} + after ${keys.after} = ${keys.search + keys.after} keystrokes; machine ${(ms / 1000).toFixed(2)} s; KLM person estimate ${klm(keys).toFixed(1)} s`;
  console.log(line);
  test.info().annotations.push({ type: 'timing', description: line });
}

async function openCheckIn(page: Page, url = '/tickets/new') {
  await page.goto(url);
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
}

test.describe('Check-in keyboard paths (TK1, TK2)', () => {
  test('CI-01 returning customer + known device as front desk, keyboard only, ≤ 15 keys after the search', async ({
    page,
  }) => {
    await signInContext(page, SEED.frontdesk);
    await openCheckIn(page);
    const keys = new Keys(page);
    const t0 = Date.now();
    await keys.type('linda c');
    const option = page.getByRole('option', { name: /Linda Clark/ });
    await expect(option).toBeVisible();
    keys.endSearch();
    await keys.press('Enter', true);
    const device = page
      .getByRole('radio', { name: /Nintendo Switch OLED|Apple|Samsung|Google/ })
      .first();
    await expect(device).toBeFocused();
    await expect(device).toBeChecked();
    await keys.press('Enter', true);
    await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
    // The issue list depends on the device type (Linda's latest device is a console): take the first preset.
    const firstIssue =
      (await page
        .getByRole('group', { name: 'Common issues' })
        .getByRole('button')
        .first()
        .getAttribute('aria-label')) ??
      (await page
        .getByRole('group', { name: 'Common issues' })
        .getByRole('button')
        .first()
        .innerText());
    await keys.type(firstIssue.trim().slice(0, 3).toLowerCase());
    await keys.press('Enter', true);
    await expect(
      page.getByRole('button', { name: firstIssue.trim(), pressed: true }),
    ).toBeVisible();
    await keys.press('ControlOrMeta+Enter', true);
    await expect(page).toHaveURL(/\/tickets\/(?!new)[^/]+$/);
    const heading = page.getByRole('heading', { level: 1, name: /^T-\d+$/ });
    await expect(heading).toBeVisible();
    const ms = Date.now() - t0;
    const number = await heading.textContent();
    await expect(toast(page, `Ticket ${number} created`)).toBeVisible();
    report('Returning customer (real stack)', keys, ms);
    await page.screenshot({ path: shot2('ci-01-created') });
    expect(keys.after).toBeLessThanOrEqual(15);
    expect(ms).toBeLessThan(60_000);
    // The ticket really exists, created by Frank Desk, in Received, for Linda Clark.
    const id = page.url().split('/').pop()!;
    const fd = await apiAs(SEED.frontdesk);
    const t = await ok(fd, 'GET', `/api/tickets/${id}`);
    expect(t.customer.displayName).toBe('Linda Clark');
    expect(t.status.systemRole).toBe('INITIAL');
    expect(t.issues).toEqual([expect.objectContaining({ label: firstIssue.trim() })]);
  });

  test('CI-02 new customer + new device with IMEI and a pattern lock, keyboard only (< 90 s target)', async ({
    page,
  }) => {
    const s = await freshShop('GB', 'CheckinNew');
    const fd = await member(s, 'FRONT_DESK');
    await signInContext(page, fd.email);
    await openCheckIn(page);
    const keys = new Keys(page);
    const theImei = imei(Date.now());
    const mobile = phone('GB');
    const t0 = Date.now();
    await keys.type('Priya Shah');
    await expect(page.getByRole('option', { name: /New customer “Priya Shah”/ })).toBeVisible();
    keys.endSearch();
    await keys.press('Enter', true);
    await expect(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Priya');
    await expect(page.getByRole('textbox', { name: 'Last name' })).toHaveValue('Shah');
    await expect(page.getByRole('textbox', { name: 'Phone' })).toBeFocused();
    await keys.type(mobile);
    await keys.press('Enter', true);
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
    await keys.type('iph 13');
    await expect(page.getByRole('option').first()).toHaveText(/iPhone 13$/);
    await keys.press('Enter', true);
    await expect(page.getByRole('textbox', { name: 'IMEI' })).toBeFocused();
    await keys.type(theImei);
    await keys.press('Enter', true);
    await expect(page.getByRole('radio', { name: 'None' })).toBeFocused();
    // None → PIN → Password → Pattern
    await keys.press('ArrowRight');
    await keys.press('ArrowRight');
    await keys.press('ArrowRight', true);
    await expect(page.getByRole('radio', { name: 'Pattern' })).toBeChecked();
    await keys.press('Tab');
    await expect(page.getByRole('button', { name: /^Dot \d/ }).first()).toBeVisible();
    await keys.type('1596');
    await expect(page.getByText('Pattern: 1 → 5 → 9 → 6 (4 dots)')).toBeVisible();
    await keys.press('Enter', true);
    await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
    await keys.type('scr');
    await keys.press('Enter', true);
    await keys.press('ControlOrMeta+Enter', true);
    const heading = page.getByRole('heading', { level: 1, name: /^T-\d+$/ });
    await expect(heading).toBeVisible();
    const ms = Date.now() - t0;
    report('New customer + new device + IMEI + pattern (real stack)', keys, ms);
    await page.screenshot({ path: shot2('ci-02-created') });
    expect(ms).toBeLessThan(90_000);
    expect(klm(keys)).toBeLessThan(90);

    const id = page.url().split('/').pop()!;
    const t = await ok(fd.ctx, 'GET', `/api/tickets/${id}`);
    expect(t.customer.displayName).toBe('Priya Shah');
    expect(t.device).toMatchObject({
      brand: 'Apple',
      model: 'iPhone 13',
      imei: theImei,
      lockType: 'PATTERN',
    });
    expect(t.device.passcodeOnFile).toBe(true);
    // Stored encrypted: the raw row has ciphertext, never the "1-5-9-6" sequence.
    const raw = sql(
      `select coalesce("passcodeCiphertext"::text,'') from devices where id='${t.device.id}'`,
    );
    expect(raw.length).toBeGreaterThan(10);
    expect(raw).not.toContain('1-5-9-6');
    expect(raw).not.toContain('1596');
    // No half-created records: exactly one customer and one device in the shop.
    expect(sql(`select count(*) from customers where "shopId"='${s.shop.id}'`)).toBe('1');
    expect(sql(`select count(*) from devices where "shopId"='${s.shop.id}'`)).toBe('1');
    // Phone stored E.164.
    const c = await ok(fd.ctx, 'GET', `/api/customers/${t.customer.id}`);
    expect(c.phones[0].e164).toMatch(/^\+447400\d{6}$/);
  });
});

test.describe('Check-in safeguards', () => {
  test('CI-03 idempotent create: the same Idempotency-Key returns the same ticket (sequential and concurrent)', async () => {
    const s = await freshShop('US', 'Idem');
    const key = uuid();
    const first = await call(
      s.owner.ctx,
      'POST',
      '/api/tickets',
      {
        newCustomer: { kind: 'PERSON', firstName: 'Idem', phones: [{ number: phone('US') }] },
        newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 12' },
        issues: [{ code: 'BATTERY' }],
      },
      { 'Idempotency-Key': key },
    );
    expect(first.status).toBe(201);
    const again = await call(
      s.owner.ctx,
      'POST',
      '/api/tickets',
      {
        newCustomer: { kind: 'PERSON', firstName: 'Idem', phones: [{ number: phone('US') }] },
        newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 12' },
        issues: [{ code: 'BATTERY' }],
      },
      { 'Idempotency-Key': key },
    );
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    // Five concurrent requests with one key → one ticket, one customer.
    const key2 = uuid();
    const body = {
      newCustomer: { kind: 'PERSON', firstName: 'Burst', phones: [{ number: phone('US') }] },
      newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 12' },
      issues: [{ code: 'BATTERY' }],
    };
    const res = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(s.owner.ctx, 'POST', '/api/tickets', body, { 'Idempotency-Key': key2 }),
      ),
    );
    const ids = new Set(res.filter((r) => r.status < 300).map((r) => r.body.id));
    test
      .info()
      .annotations.push({ type: 'statuses', description: res.map((r) => r.status).join(',') });
    expect(ids.size).toBe(1);
    expect(
      sql(`select count(*) from customers where "shopId"='${s.shop.id}' and "firstName"='Burst'`),
    ).toBe('1');
    // Gapless numbers: 1001, 1002.
    expect(
      sql(
        `select string_agg(number::text, ',' order by number) from tickets where "shopId"='${s.shop.id}'`,
      ),
    ).toBe('1001,1002');
  });

  test('CI-04 double ⌘↵ in the UI creates one ticket', async ({ page }) => {
    const s = await freshShop('US', 'DoubleSubmit');
    const c = await customer(s.owner.ctx, {
      kind: 'PERSON',
      firstName: 'Double',
      lastName: 'Tap',
      phones: [{ number: phone('US') }],
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, {
      type: 'PHONE',
      brand: 'Google',
      model: 'Pixel 8',
    });
    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    await page.keyboard.type('double tap');
    await expect(page.getByRole('option', { name: /Double Tap/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: /Pixel 8/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.type('bat');
    await page.keyboard.press('Enter');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/tickets')
        posts.push(r.headers()['idempotency-key'] ?? '');
    });
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByRole('heading', { level: 1, name: /^T-\d+$/ })).toBeVisible();
    expect(sql(`select count(*) from tickets where "shopId"='${s.shop.id}'`)).toBe('1');
    test
      .info()
      .annotations.push({
        type: 'posts',
        description: `${posts.length} POST(s), keys ${[...new Set(posts)].length}`,
      });
    expect(new Set(posts).size).toBeLessThanOrEqual(1);
  });

  test('CI-05 duplicate warning in check-in (phone of an existing customer) → Use this customer', async ({
    page,
  }) => {
    const s = await freshShop('PK', 'Dupe');
    const ph = phone('PK');
    const c = await customer(s.owner.ctx, {
      kind: 'PERSON',
      firstName: 'Ali',
      lastName: 'Raza',
      phones: [{ number: ph }],
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, {
      type: 'PHONE',
      brand: 'Infinix',
      model: 'Hot 30',
    });
    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    await page.keyboard.type('Ali Again');
    await page.getByRole('option', { name: /New customer “Ali Again”/ }).click();
    // Typed in another format: +92 3xx … must still match.
    const digits = ph.replace(/\D/g, '').slice(1);
    await page
      .getByRole('textbox', { name: 'Phone' })
      .fill(`+92 ${digits.slice(0, 3)} ${digits.slice(3)}`);
    await expect(page.getByText('Already a customer?')).toBeVisible();
    await expect(page.getByText(/Ali Raza/).first()).toBeVisible();
    await page.screenshot({ path: shot2('ci-05-duplicate') });
    await page.getByRole('button', { name: 'Use this customer' }).first().click();
    await expect(page.getByRole('radio', { name: /Hot 30/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.type('bat');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByRole('heading', { level: 1, name: /^T-\d+$/ })).toBeVisible();
    // Nothing typed was saved: still one customer.
    expect(sql(`select count(*) from customers where "shopId"='${s.shop.id}'`)).toBe('1');
    // The API never blocks duplicates (A5).
    const dup = await call(s.owner.ctx, 'POST', '/api/customers', {
      kind: 'PERSON',
      firstName: 'Sister',
      phones: [{ number: ph }],
    });
    expect(dup.status).toBe(201);
    const d = await ok(
      s.owner.ctx,
      'GET',
      `/api/customers/duplicates?phone=${encodeURIComponent(ph)}`,
    );
    expect(d.items.length).toBe(2);
  });

  test('CI-06 an archived customer is offered "Restore and use" and the ticket is created', async ({
    page,
  }) => {
    const s = await freshShop('US', 'Archived');
    const c = await customer(s.owner.ctx, {
      kind: 'PERSON',
      firstName: 'Zelda',
      lastName: 'Archer',
      phones: [{ number: phone('US') }],
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 14',
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/archive`, {});
    // API refuses a ticket for an archived customer.
    const dev = (await ok(s.owner.ctx, 'GET', `/api/customers/${c.id}/devices`)).items[0];
    const refused = await call(s.owner.ctx, 'POST', '/api/tickets', {
      customerId: c.id,
      deviceId: dev.id,
      issues: [{ code: 'BATTERY' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CUSTOMER_ARCHIVED');

    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    await page.keyboard.type('zelda');
    const option = page.getByRole('option', { name: /Zelda Archer/ });
    await expect(option).toContainText('Restore and use');
    await page.keyboard.press('Enter');
    await expect(page.getByText("Restored. They're back in lists and search.")).toBeVisible();
    await page.getByRole('radio', { name: /iPhone 14/ }).press('Enter');
    await page.keyboard.type('bat');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByRole('heading', { level: 1, name: /^T-\d+$/ })).toBeVisible();
    const after = await ok(s.owner.ctx, 'GET', `/api/customers/${c.id}`);
    expect(after.archivedAt).toBeNull();
  });

  test('CI-07 scanning a full IMEI into Find customer picks customer and device; Enter from the scanner jumps to Issues', async ({
    page,
  }) => {
    const s = await freshShop('US', 'Scan');
    const theImei = imei(Date.now() + 7);
    const c = await customer(s.owner.ctx, {
      kind: 'PERSON',
      firstName: 'Sam',
      lastName: 'Scanner',
      phones: [{ number: phone('US') }],
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 11',
    });
    await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, {
      type: 'PHONE',
      brand: 'Samsung',
      model: 'Galaxy S23',
      imei: theImei,
    });
    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    // A scanner types fast and sends Enter.
    await page.keyboard.type(theImei, { delay: 5 });
    await expect(page.getByRole('option', { name: /Sam Scanner/ })).toContainText('IMEI match');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Find an issue' })).toBeFocused();
    await expect(page.getByText('Samsung Galaxy S23').first()).toBeVisible();
    // Also through the list search with the IMEI.
    const list = await ok(s.owner.ctx, 'GET', `/api/devices/lookup?imei=${theImei}`);
    expect(JSON.stringify(list)).toContain('Galaxy S23');
  });

  test('CI-09 an invalid phone in the quick form is flagged before moving on (CU1.2: "on leaving the field")', async ({
    page,
  }) => {
    test.fail(
      true,
      'BUG-01: an invalid phone passes "Use this customer"; the error only appears at Create',
    );
    const s = await freshShop('GB', 'BadPhone');
    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    await page.keyboard.type('Bad Phone');
    await page.getByRole('option', { name: /New customer/ }).click();
    await expect(page.getByRole('textbox', { name: 'Phone' })).toBeFocused();
    // 07911 6… is not an allocated UK mobile range (libphonenumber: invalid).
    await page.keyboard.type('07911 687612');
    await page.keyboard.press('Enter');
    const phoneBox = page.getByRole('textbox', { name: 'Phone' });
    await page.waitForTimeout(500);
    const flagged =
      (await phoneBox.count()) > 0 && (await phoneBox.getAttribute('aria-invalid')) === 'true';
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return (
        el?.getAttribute('aria-label') ??
        (el?.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '') ??
        ''
      );
    });
    const modelFocused = /Model/.test(active ?? '');
    test
      .info()
      .annotations.push({
        type: 'observed',
        description: `aria-invalid after Enter: ${flagged}; moved to Model: ${modelFocused}`,
      });
    await page.screenshot({ path: shot2('ci-09-invalid-phone-accepted') });
    expect(modelFocused).toBe(false);
    await expect(phoneBox).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a valid phone number').first()).toBeVisible();
  });

  test('CI-08 draft survives a reload (without the passcode)', async ({ page }) => {
    const s = await freshShop('US', 'Draft');
    await signInContext(page, s.owner.email);
    await openCheckIn(page);
    await page.keyboard.type('Dee Raft');
    await page.getByRole('option', { name: /New customer/ }).click();
    await page.getByRole('textbox', { name: 'Phone' }).fill(phone('US'));
    await page.keyboard.press('Enter');
    await page.keyboard.type('pixel 8');
    await page
      .getByRole('option', { name: /Pixel 8$/ })
      .first()
      .click();
    await page.getByRole('radio', { name: 'PIN/passcode' }).click();
    await page.getByLabel('PIN/passcode').fill('8642');
    await page.getByRole('button', { name: 'Use this device' }).click();
    await page.keyboard.type('scr');
    await page.keyboard.press('Enter');
    const stored = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([k]) => k.startsWith('repairos:checkin-draft:'))
        .map(([, v]) => v)
        .join(''),
    );
    expect(stored).toContain('SCREEN_CRACKED');
    expect(stored).not.toContain('8642');
    await page.reload();
    await expect(page.getByText(/Draft restored from/)).toBeVisible();
    await expect(page.getByText(/Enter the passcode again/).first()).toBeVisible();
  });
});
