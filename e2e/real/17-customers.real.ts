import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { selectOption } from '../tests/support/select';
import { auditEvents, signInContext, sql, toast } from './support/stack';
import {
  axe,
  call,
  checkIn,
  customer,
  freshShop,
  imei,
  member,
  ok,
  phone,
  shot2,
  type Json,
} from './support/sprint2';

/** §1 customers (CU1–CU9) and §2 devices (DV1–DV2) on the real stack, per market. */

/** Searchable Selector (rendered as a button, e.g. State/Province). */
async function pickButtonSelect(page: Page, label: RegExp, option: string) {
  await page.getByRole('button', { name: label }).click();
  const choice = page.getByRole('option', { name: option, exact: true });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(page.getByRole('button', { name: label })).toContainText(option);
}

async function saveNew(page: Page) {
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(toast(page, 'Customer added')).toBeVisible();
  await expect(page).toHaveURL(/\/customers\/(?!new)[^/?]+/);
  return page.url().split('/customers/')[1]!.split(/[/?]/)[0]!;
}

test('CU-01 US: phone "(212) 555-0142" style + second phone + address (State select, ZIP) + verbal SMS consent shows the TCPA warning', async ({
  page,
}) => {
  const s = await freshShop('US', 'CustUS');
  await signInContext(page, s.owner.email);
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Dana');
  await page.getByRole('textbox', { name: 'Last name' }).fill('Brooks');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('(212) 555-0142');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).blur();
  await page.getByRole('button', { name: 'Add phone' }).click();
  await page.getByRole('textbox', { name: 'Phone 2' }).fill('646.555.0199');
  await expect(
    page.getByRole('radiogroup', { name: 'Preferred contact' }).getByRole('radio', { name: 'SMS' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Add address' }).click();
  await page.getByRole('textbox', { name: 'Address line 1' }).fill('350 5th Ave');
  await page.getByRole('textbox', { name: 'City' }).fill('New York');
  await pickButtonSelect(page, /^State/, 'NY');
  await page.getByRole('textbox', { name: 'ZIP code' }).fill('10118');
  await page.getByRole('switch', { name: 'Marketing by SMS' }).click();
  await selectOption(page, 'How was consent given?', 'In store – verbal');
  await expect(page.getByText(/US law \(TCPA\) expects written consent/)).toBeVisible();
  await page.screenshot({ path: shot2('cu-01-us-tcpa'), fullPage: true });
  const id = await saveNew(page);
  const c = await ok(s.owner.ctx, 'GET', `/api/customers/${id}`);
  expect(c.phones.map((p: Json) => p.e164)).toEqual(['+12125550142', '+16465550199']);
  expect(c.phones[0].isPrimary).toBe(true);
  expect(c).toMatchObject({
    region: 'NY',
    postcode: '10118',
    city: 'New York',
    preferredChannel: 'SMS',
  });
  const hist = await ok(s.owner.ctx, 'GET', `/api/customers/${id}/consents`);
  expect(hist.items[0]).toMatchObject({
    channel: 'SMS',
    state: 'GRANTED',
    source: 'IN_STORE_VERBAL',
  });
  // Detail page: national format, tel: link, consent summary, Consent history.
  await expect(page.getByRole('link', { name: 'Call (212) 555-0142' })).toHaveAttribute(
    'href',
    'tel:+12125550142',
  );
  await expect(page.getByText(/SMS marketing: Yes since/)).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('CU-02 UK: 07911 123456 + landline 020 7946 0018 (no WhatsApp link) + Postcode normalised; business customer without contact', async ({
  page,
}) => {
  const s = await freshShop('GB', 'CustGB');
  await signInContext(page, s.owner.email);
  await page.goto('/customers/new');
  await page
    .getByRole('radiogroup', { name: 'Customer type' })
    .getByRole('radio', { name: 'Business' })
    .click();
  await page.getByRole('textbox', { name: 'Business name' }).fill('Leeds Dental Ltd');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('07911 123456');
  await page.getByRole('button', { name: 'Add phone' }).click();
  await page.getByRole('textbox', { name: 'Phone 2' }).fill('020 7946 0018');
  await selectOption(page.getByRole('group', { name: 'Phone 2' }), 'Label', 'Landline');
  await page.getByRole('button', { name: 'Add address' }).click();
  await page.getByRole('textbox', { name: 'Address line 1' }).fill('1 Park Row');
  await page.getByRole('textbox', { name: 'Town/City' }).fill('Leeds');
  await page.getByRole('textbox', { name: 'County' }).fill('West Yorkshire');
  await page.getByRole('textbox', { name: 'Postcode' }).fill('ls1 5hd');
  const id = await saveNew(page);
  const c = await ok(s.owner.ctx, 'GET', `/api/customers/${id}`);
  expect(c.displayName).toBe('Leeds Dental Ltd');
  expect(c.phones.map((p: Json) => p.e164)).toEqual(['+447911123456', '+442079460018']);
  expect(c.postcode).toBe('LS1 5HD');
  await expect(page.getByRole('link', { name: /Call 07911 123456/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /WhatsApp 020 7946 0018/ })).toHaveCount(0);
  await page.screenshot({ path: shot2('cu-02-uk-business') });
  // Validation: invalid phone blocks save.
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Bad');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('07911 68');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).blur();
  // Save is blocked with the error (on-blur feedback is BUG-01).
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText('Enter a valid phone number').first()).toBeVisible();
  await expect(page).toHaveURL(/\/customers\/new$/);
});

test('CU-02b invalid phone is flagged when leaving the field (CU1.2)', async ({ page }) => {
  const s = await freshShop('GB', 'CustBlur');
  await signInContext(page, s.owner.email);
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Bad');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('07911 68');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).blur();
  await expect(page.getByText('Enter a valid phone number').first()).toBeVisible({ timeout: 3000 });
});

test('CU-03 PK: 0300-1234567 / 3001234567 / +92 300 1234567 all normalise; WhatsApp default; Province + postal code; single name', async ({
  page,
}) => {
  const s = await freshShop('PK', 'CustPK');
  for (const [n, f] of [
    ['0300-1234567', 'A'],
    ['3001234567', 'B'],
    ['+92 300 1234567', 'C'],
    ['923001234567', 'D'],
  ]) {
    const c = await customer(s.owner.ctx, {
      kind: 'PERSON',
      firstName: `Imran${f}`,
      phones: [{ number: n }],
    });
    expect(c.phones[0].e164, n).toBe('+923001234567');
    expect(c.preferredChannel).toBe('WHATSAPP');
  }
  // Search finds them by any format, and by 4+ digit substring.
  for (const q of ['0300 1234567', '+923001234567', '4567']) {
    const r = await ok(s.owner.ctx, 'GET', `/api/customers?q=${encodeURIComponent(q)}`);
    expect(r.total, q).toBe(4);
  }
  await signInContext(page, s.owner.email);
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Bilal');
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('0321 7654321');
  await expect(
    page
      .getByRole('radiogroup', { name: 'Preferred contact' })
      .getByRole('radio', { name: 'WhatsApp' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Add address' }).click();
  await page.getByRole('textbox', { name: 'Address line 1' }).fill('12 Mall Road');
  await page.getByRole('textbox', { name: 'City' }).fill('Lahore');
  await pickButtonSelect(page, /^Province/, 'Punjab');
  await page.getByRole('textbox', { name: 'Postal code' }).fill('54000');
  await page.getByRole('switch', { name: 'Marketing by WhatsApp' }).click();
  await selectOption(page, 'How was consent given?', 'In store – signed form');
  const id = await saveNew(page);
  const c = await ok(s.owner.ctx, 'GET', `/api/customers/${id}`);
  expect(c).toMatchObject({
    displayName: 'Bilal',
    region: 'Punjab',
    postcode: '54000',
    preferredChannel: 'WHATSAPP',
  });
  await expect(page.getByRole('link', { name: /WhatsApp 0321 7654321/ })).toHaveAttribute(
    'href',
    'https://wa.me/923217654321',
  );
  await page.screenshot({ path: shot2('cu-03-pk') });
});

test('CU-04 edit: STALE_RECORD across two contexts keeps input; consent withdraw then grant keeps both events', async ({
  browser,
}) => {
  const s = await freshShop('US', 'CustEdit');
  const c = await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'Eddie',
    phones: [{ number: phone('US') }],
    consents: [{ channel: 'EMAIL', state: 'GRANTED', source: 'ONLINE_FORM' }],
    email: `eddie${Date.now()}@qa.test`,
  });
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await signInContext(a, s.owner.email);
  await signInContext(b, s.owner.email);
  await a.goto(`/customers/${c.id}/edit`);
  await b.goto(`/customers/${c.id}/edit`);
  await a.getByRole('textbox', { name: 'Last name' }).fill('Alpha');
  await a.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(a, 'Customer saved')).toBeVisible();
  await b.getByRole('textbox', { name: 'Last name' }).fill('Bravo');
  await b.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    b.getByText('Someone else changed this customer. Reload to see their changes.'),
  ).toBeVisible();
  await expect(b.getByRole('textbox', { name: 'Last name' })).toHaveValue('Bravo');
  await b.screenshot({ path: shot2('cu-04-stale') });
  await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/consents`, {
    changes: [{ channel: 'EMAIL', state: 'WITHDRAWN' }],
  });
  await ok(s.owner.ctx, 'POST', `/api/customers/${c.id}/consents`, {
    changes: [{ channel: 'EMAIL', state: 'GRANTED', source: 'IN_STORE_SIGNED' }],
  });
  const hist = await ok(s.owner.ctx, 'GET', `/api/customers/${c.id}/consents`);
  expect((hist.items as Json[]).length).toBe(3);
  expect(hist.items[0]).toMatchObject({ state: 'GRANTED', source: 'IN_STORE_SIGNED' });
  const now = await ok(s.owner.ctx, 'GET', `/api/customers/${c.id}`);
  expect(JSON.stringify(now.consent)).toContain('IN_STORE_SIGNED');
  // Granting without a source is refused.
  expect(
    (
      await call(s.owner.ctx, 'POST', `/api/customers/${c.id}/consents`, {
        changes: [{ channel: 'SMS', state: 'GRANTED' }],
      })
    ).status,
  ).toBe(400);
  const withdrawn = (hist.items as Json[]).find((e) => e.state === 'WITHDRAWN');
  expect(withdrawn?.source).toBe('CUSTOMER_REQUEST');
});

test('CU-05 list: search any word order + accents, URL state with back button, archived hidden by default, filters', async ({
  page,
}) => {
  const s = await freshShop('US', 'CustList');
  await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'José',
    lastName: 'Peña',
    phones: [{ number: phone('US') }],
    tags: ['VIP'],
  });
  const arch = await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'Old',
    lastName: 'Archive',
    phones: [{ number: phone('US') }],
  });
  await ok(s.owner.ctx, 'POST', `/api/customers/${arch.id}/archive`, {});
  expect((await ok(s.owner.ctx, 'GET', '/api/customers?q=pena%20jose')).total).toBe(1);
  expect((await ok(s.owner.ctx, 'GET', '/api/customers?q=archive')).total).toBe(0);
  expect((await ok(s.owner.ctx, 'GET', '/api/customers?q=archive&archived=true')).total).toBe(1);
  expect((await ok(s.owner.ctx, 'GET', '/api/customers?tags=vip')).total).toBe(1);
  await signInContext(page, s.owner.email);
  await page.goto('/customers');
  await expect(page.getByRole('searchbox', { name: 'Search customers' })).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('pena jose');
  await expect(page).toHaveURL(/q=pena/);
  await expect(page.getByRole('link', { name: 'José Peña' })).toBeVisible();
  await page.getByRole('switch', { name: 'Show archived' }).click();
  await expect(page).toHaveURL(/archived=true/);
  await page.screenshot({ path: shot2('cu-05-list') });
  expect(await axe(page)).toEqual([]);
});

test('CU-05b customer list: the back button steps back through search/filter changes (CU5.5)', async ({
  page,
}) => {
  const s = await freshShop('US', 'CustBack');
  await signInContext(page, s.owner.email);
  await page.goto('/');
  await page.goto('/customers');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('pena jose');
  await expect(page).toHaveURL(/q=pena/);
  await page.getByRole('switch', { name: 'Show archived' }).click();
  await expect(page).toHaveURL(/archived=true/);
  await page.goBack();
  test.info().annotations.push({ type: 'observed', description: `after Back: ${page.url()}` });
  await expect(page).toHaveURL(/\/customers\?.*q=pena/);
  await expect(page).not.toHaveURL(/archived=true/);
});

test('CU-06 archive blocked with open tickets; archive/restore audited; archived hidden from global search', async ({
  page,
}) => {
  const s = await freshShop('US', 'CustArch');
  const t = await checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Arch',
      lastName: 'Ivy',
      phones: [{ number: phone('US') }],
    },
  });
  const blocked = await call(s.owner.ctx, 'POST', `/api/customers/${t.customer.id}/archive`, {});
  expect(blocked.status).toBe(409);
  expect(blocked.body.code).toBe('CUSTOMER_HAS_OPEN_TICKETS');
  expect(blocked.body.message).toContain('1 open ticket');
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' });
  await signInContext(page, s.owner.email);
  await page.goto(`/customers/${t.customer.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  await page
    .getByRole('alertdialog')
    .or(page.getByRole('dialog'))
    .getByRole('button', { name: /Archive/ })
    .click();
  await expect(page.getByText('Archived customer')).toBeVisible();
  const search = await ok(s.owner.ctx, 'GET', '/api/search?q=arch%20ivy');
  expect(search.customers.length).toBe(0);
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await expect(toast(page, 'Customer restored')).toBeVisible();
  const ev = await auditEvents(s.owner.ctx);
  expect(ev.map((e) => e.action)).toEqual(
    expect.arrayContaining(['customer.archived', 'customer.restored']),
  );
});

test('CU-07 export: download and inspect (no passcodes, internal notes included per A11-c), audited with counts only', async ({
  page,
}) => {
  const s = await freshShop('GB', 'CustExport');
  const t = await checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Ex',
      lastName: 'Port',
      phones: [{ number: phone('GB') }],
      notes: 'Prefers mornings',
    },
    newDevice: {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 12',
      imei: imei(Date.now() + 33),
      passcode: { lockType: 'PIN', value: '864209' },
      notes: 'Dent on corner',
    },
  });
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/notes`, {
    body: 'INTERNAL-NOTE-MARKER',
    visibility: 'INTERNAL',
  });
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/notes`, {
    body: 'CUSTOMER-NOTE-MARKER',
    visibility: 'CUSTOMER',
  });
  await signInContext(page, s.owner.email);
  await page.goto(`/customers/${t.customer.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Export data/ }).click();
  const download = await dl;
  const today = sql(`select (now() at time zone 'Europe/London')::date`);
  expect(download.suggestedFilename()).toBe(`customer-${t.customer.id}-${today}.json`);
  const text = readFileSync((await download.path())!, 'utf8');
  const json = JSON.parse(text);
  expect(json.shop.name).toBe(s.shop.name);
  expect(json.devices[0].passcodeOnFile).toBe(true);
  expect(text).not.toContain('864209');
  expect(text).not.toMatch(/ciphertext|passcodeIv|"iv"/i);
  expect(text).toContain('CUSTOMER-NOTE-MARKER');
  expect(text).toContain('Prefers mornings');
  expect(text).toContain('Dent on corner');
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `internal note in export: ${text.includes('INTERNAL-NOTE-MARKER')}`,
    });
  const ev = await auditEvents(s.owner.ctx);
  const exp = ev.find((e) => e.action === 'customer.exported');
  expect(exp).toBeTruthy();
  const after = sql(
    `select coalesce(before::text,'') || coalesce(after::text,'') from audit_logs where action='customer.exported' and "shopId"='${s.shop.id}'`,
  );
  expect(after).not.toContain('Port');
  expect(after).not.toContain('+44');
});

test('CU-07b A11-c: the export includes internal ticket notes', async () => {
  const s = await freshShop('GB', 'CustExport2');
  const t = await checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Ex',
      lastName: 'Two',
      phones: [{ number: phone('GB') }],
    },
  });
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/notes`, {
    body: 'INTERNAL-NOTE-MARKER',
    visibility: 'INTERNAL',
  });
  const text = await (await s.owner.ctx.get(`/api/customers/${t.customer.id}/export`)).text();
  expect(text).toContain('INTERNAL-NOTE-MARKER');
});

test('CU-08 erase: blocked with open tickets, then allowed; customer unfindable afterwards; ticket kept as "Erased customer"', async ({
  page,
}) => {
  const s = await freshShop('US', 'CustErase');
  const ph = '(917) 555-0177';
  const email = `erase.me.${Date.now()}@qa.test`;
  const theImei = imei(Date.now() + 55);
  const t = await checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Erin',
      lastName: 'Erasable',
      email,
      phones: [{ number: ph }],
      notes: 'Lives upstairs',
      tags: ['Regular'],
      consents: [{ channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED' }],
      addressLine1: '1 Erase St',
      city: 'Albany',
      region: 'NY',
      postcode: '12207',
    },
    newDevice: {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 14',
      imei: theImei,
      colour: 'Blue',
      passcode: { lockType: 'PIN', value: '1111' },
    },
  });
  const fd = await member(s, 'FRONT_DESK');
  expect(
    (await call(fd.ctx, 'POST', `/api/customers/${t.customer.id}/erase`, { confirm: 'ERASE' }))
      .status,
  ).toBe(403);
  const blocked = await call(s.owner.ctx, 'POST', `/api/customers/${t.customer.id}/erase`, {
    confirm: 'ERASE',
  });
  expect(blocked.status).toBe(409);
  expect(blocked.body.code).toBe('CUSTOMER_HAS_OPEN_TICKETS');

  await signInContext(page, s.owner.email);
  await page.goto(`/customers/${t.customer.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Erase Erin Erasable?' });
  await expect(dialog.getByText(/Close or cancel this customer's 1 open ticket/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/cancel`, {
    reason: 'CUSTOMER_TOOK_BACK',
    returnedConfirmed: true,
  });
  await page.reload();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase…' }).click();
  dialog = page.getByRole('dialog', { name: 'Erase Erin Erasable?' });
  await expect(
    dialog.getByText(
      'Notes on tickets are kept as repair records. Remove personal details from them first if needed.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Erase customer' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Type ERASE to confirm' }).fill('ERASE');
  await page.screenshot({ path: shot2('cu-08-erase-dialog') });
  await dialog.getByRole('button', { name: 'Erase customer' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'This customer was erased.' })
      .or(page.getByRole('heading', { name: 'Erased customer' })),
  ).toBeVisible();

  // Unfindable by name, phone, email, IMEI: customer list, duplicates, global search, check-in search, device lookup.
  for (const q of ['Erasable', 'erin', '917 555 0177', '0177', email]) {
    const list = await ok(
      s.owner.ctx,
      'GET',
      `/api/customers?q=${encodeURIComponent(q)}&archived=true`,
    );
    expect(list.total, `customers q=${q}`).toBe(0);
    const g = await ok(s.owner.ctx, 'GET', `/api/search?q=${encodeURIComponent(q)}`);
    expect(g.customers.length + g.tickets.length + g.devices.length, `global q=${q}`).toBe(0);
  }
  expect(
    (await ok(s.owner.ctx, 'GET', `/api/customers/duplicates?phone=${encodeURIComponent(ph)}`))
      .items.length,
  ).toBe(0);
  expect(
    (await ok(s.owner.ctx, 'GET', `/api/customers/duplicates?email=${encodeURIComponent(email)}`))
      .items.length,
  ).toBe(0);
  const lookup = await call(s.owner.ctx, 'GET', `/api/devices/lookup?imei=${theImei}`);
  expect(JSON.stringify(lookup.body)).not.toContain('iPhone 14');
  // Ticket kept, found by number only, shown as Erased customer.
  const byNumber = await ok(s.owner.ctx, 'GET', `/api/tickets?view=all&q=${t.numberLabel}`);
  expect(byNumber.items[0].customer.displayName).toBe('Erased customer');
  // No identifiers left in the customer/device/phone/consent tables or the ticket search column.
  const row = sql(`select row_to_json(c)::text from customers c where id='${t.customer.id}'`);
  for (const v of ['Erin', 'Erasable', email, '9175550177', 'Erase St', 'upstairs', 'Regular'])
    expect(row, v).not.toContain(v);
  expect(sql(`select count(*) from customer_phones where "customerId"='${t.customer.id}'`)).toBe(
    '0',
  );
  expect(
    sql(`select count(*) from customer_consent_events where "customerId"='${t.customer.id}'`),
  ).toBe('0');
  const dev = sql(`select row_to_json(d)::text from devices d where id='${t.device.id}'`);
  expect(dev).not.toContain(theImei);
  expect(dev).not.toContain('Blue');
  expect(dev).toContain('iPhone 14');
  const ticketRow = sql(`select row_to_json(t)::text from tickets t where id='${t.id}'`);
  for (const v of ['Erasable', '9175550177', theImei])
    expect(ticketRow, `ticket row ${v}`).not.toContain(v);
  const audit = sql(
    `select coalesce(string_agg(coalesce(before::text,'')||coalesce(after::text,''), ' '),'') from audit_logs where "shopId"='${s.shop.id}'`,
  );
  for (const v of ['Erasable', email, '9175550177']) expect(audit, `audit ${v}`).not.toContain(v);
  // Erased: can't be edited, restored, exported or used.
  expect((await call(s.owner.ctx, 'GET', `/api/customers/${t.customer.id}/export`)).status).toBe(
    404,
  );
  expect(
    (await call(s.owner.ctx, 'POST', `/api/customers/${t.customer.id}/restore`, {})).status,
  ).toBeGreaterThanOrEqual(404);
  const reuse = await call(s.owner.ctx, 'POST', '/api/tickets', {
    customerId: t.customer.id,
    deviceId: t.device.id,
    issues: [{ code: 'BATTERY' }],
  });
  expect(reuse.status).toBe(409);
  expect(reuse.body.code).toBe('CUSTOMER_ERASED');
});

test('CU-09 erase redacts identifiers typed into ticket free text and notes (A11-b)', async () => {
  const s = await freshShop('US', 'CustRedact');
  const t = await checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Rhoda',
      lastName: 'Redactme',
      phones: [{ number: '(917) 555-0166' }],
    },
    description: 'Rhoda Redactme says call 917-555-0166 when done',
  });
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/notes`, {
    body: 'Spoke to Redactme on (917) 555-0166',
    visibility: 'INTERNAL',
  });
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/cancel`, {
    reason: 'OTHER',
    note: 'Redactme changed her mind',
    returnedConfirmed: true,
  });
  await ok(s.owner.ctx, 'POST', `/api/customers/${t.customer.id}/erase`, { confirm: 'ERASE' });
  const blob = [
    sql(`select row_to_json(t)::text from tickets t where id='${t.id}'`),
    sql(`select coalesce(string_agg(body, ' '),'') from ticket_notes where "ticketId"='${t.id}'`),
    sql(
      `select coalesce(string_agg(data::text, ' '),'') from ticket_events where "ticketId"='${t.id}'`,
    ),
    sql(
      `select coalesce(string_agg(coalesce(after::text,''), ' '),'') from audit_logs where "shopId"='${s.shop.id}'`,
    ),
  ].join('\n');
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `left: ${['Redactme', '917-555-0166', '(917) 555-0166'].filter((v) => blob.includes(v)).join(', ')}`,
    });
  expect(blob).not.toContain('Redactme');
  expect(blob).not.toContain('555-0166');
});

test("CU-10 devices: IMEI Luhn/length errors, serial normalised, another customer's IMEI warns but saves", async ({
  page,
}) => {
  const s = await freshShop('US', 'Devices');
  const theImei = imei(Date.now() + 77);
  const a = await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'First',
    lastName: 'Owner',
    phones: [{ number: phone('US') }],
  });
  const b = await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'Second',
    lastName: 'Owner',
    phones: [{ number: phone('US') }],
  });
  await ok(s.owner.ctx, 'POST', `/api/customers/${a.id}/devices`, {
    type: 'PHONE',
    brand: 'Apple',
    model: 'iPhone 13',
    imei: theImei,
  });
  const bad = await call(s.owner.ctx, 'POST', `/api/customers/${b.id}/devices`, {
    type: 'PHONE',
    brand: 'Apple',
    model: 'iPhone 13',
    imei: theImei.slice(0, 14) + String((Number(theImei[14]) + 1) % 10),
  });
  expect(bad.status).toBe(400);
  const ser = await ok(s.owner.ctx, 'POST', `/api/customers/${b.id}/devices`, {
    type: 'LAPTOP',
    brand: 'Apple',
    model: 'MacBook Air M2',
    serial: ' c02-xk 12ab ',
  });
  expect(ser.serial).toBe('C02XK12AB');
  await signInContext(page, s.owner.email);
  await page.goto(`/customers/${b.id}?tab=devices`);
  await page.getByRole('button', { name: 'Add device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add device' });
  await dialog.getByRole('combobox', { name: 'Model' }).fill('iphone 13');
  await page
    .getByRole('option', { name: /^(Apple )?iPhone 13$/ })
    .first()
    .click();
  await dialog.getByRole('textbox', { name: 'IMEI' }).fill('35693803564380');
  await dialog.getByRole('textbox', { name: 'IMEI' }).blur();
  const onBlur = await dialog.getByText(/IMEI has 15 digits/).count();
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `14-digit IMEI error shown on blur: ${onBlur > 0}`,
    });
  await dialog.getByRole('button', { name: 'Add device' }).click();
  await expect(dialog.getByText(/IMEI has 15 digits/).first()).toBeVisible();
  await dialog
    .getByRole('textbox', { name: 'IMEI' })
    .fill(`${theImei.slice(0, 5)} ${theImei.slice(5, 10)}-${theImei.slice(10)}`);
  await expect(dialog.getByText(/This IMEI is on First Owner's/)).toBeVisible();
  await page.screenshot({ path: shot2('cu-10-imei-owner-warning') });
  await dialog.getByRole('button', { name: 'Add device' }).click();
  await expect(toast(page, /added/)).toBeVisible();
  const devs = await ok(s.owner.ctx, 'GET', `/api/customers/${b.id}/devices`);
  expect((devs.items as Json[]).some((d) => d.imei === theImei)).toBe(true);
  expect(await axe(page)).toEqual([]);
});

test('CU-10b a 14-digit IMEI shows the error when leaving the field (screen spec §5: "once 15+ digits or on blur")', async ({
  page,
}) => {
  const s = await freshShop('US', 'DevBlur');
  const c = await customer(s.owner.ctx, {
    kind: 'PERSON',
    firstName: 'Blur',
    phones: [{ number: phone('US') }],
  });
  await signInContext(page, s.owner.email);
  await page.goto(`/customers/${c.id}?tab=devices`);
  await page.getByRole('button', { name: 'Add device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add device' });
  await dialog.getByRole('combobox', { name: 'Model' }).fill('iphone 13');
  await page
    .getByRole('option', { name: /^(Apple )?iPhone 13$/ })
    .first()
    .click();
  await dialog.getByRole('textbox', { name: 'IMEI' }).fill('35693803564380');
  await dialog.getByRole('textbox', { name: 'IMEI' }).blur();
  await expect(dialog.getByText(/IMEI has 15 digits/).first()).toBeVisible({ timeout: 3000 });
});
