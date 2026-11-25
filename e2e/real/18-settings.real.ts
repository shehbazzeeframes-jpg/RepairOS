import { expect, test } from '@playwright/test';
import { auditEvents, signInContext, sql, toast } from './support/stack';
import { axe, call, checkIn, freshShop, ok, phone, setStatus, shot2, statusesByName, type Json } from './support/sprint2';

/** §3 ticket statuses (ST1, A9, §5.12) and §4 ticket settings (TS1). */

test('ST-01 rename (unique, case-insensitive), recolour, notify; system statuses rename but never hide or re-categorise', async () => {
  const s = await freshShop('US', 'Statuses');
  const o = s.owner.ctx;
  const st = s.statuses;
  const renamed = await ok(o, 'PATCH', `/api/ticket-statuses/${st['Diagnosing'].id}`, { name: 'On the bench', colour: 'purple', notifyCustomer: true });
  expect(renamed).toMatchObject({ name: 'On the bench', colour: 'purple', notifyCustomer: true });
  const dup = await call(o, 'PATCH', `/api/ticket-statuses/${st['In repair'].id}`, { name: 'RECEIVED' });
  expect(dup.status).toBe(409);
  expect(dup.body.code).toBe('STATUS_NAME_TAKEN');
  const sys = await ok(o, 'PATCH', `/api/ticket-statuses/${st['Received'].id}`, { name: 'Checked in' });
  expect(sys.name).toBe('Checked in');
  for (const [id, body] of [
    [st['Received'].id, { isHidden: true }],
    [st['Collected'].id, { category: 'READY' }],
    [st['Cancelled'].id, { isHidden: true }],
  ] as const) {
    const r = await call(o, 'PATCH', `/api/ticket-statuses/${id}`, body);
    expect(r.status, JSON.stringify(body)).toBe(409);
    expect(r.body.code).toBe('SYSTEM_STATUS_LOCKED');
  }
  const ev = await auditEvents(o);
  expect(ev.filter((e) => e.action === 'ticket_status.updated').length).toBeGreaterThanOrEqual(2);
  // A ticket in a renamed status shows the new name; its number label is unchanged.
  const t = await checkIn(o);
  expect(t.status.name).toBe('Checked in');
});

test('ST-02 hide: tickets stay, status leaves the menu, a change into it is 409 STATUS_HIDDEN; last visible ready is protected', async ({ page }) => {
  const s = await freshShop('US', 'Hide');
  const o = s.owner.ctx;
  const st = s.statuses;
  const t = await checkIn(o);
  await ok(o, 'POST', `/api/tickets/${t.id}/status`, { statusId: st['Awaiting approval'].id });
  await ok(o, 'PATCH', `/api/ticket-statuses/${st['Awaiting approval'].id}`, { isHidden: true });
  const still = await ok(o, 'GET', `/api/tickets/${t.id}`);
  expect(still.status.name).toBe('Awaiting approval');
  const t2 = await checkIn(o);
  const into = await setStatus(o, t2.id, st['Awaiting approval'].id);
  expect(into.status).toBe(409);
  expect(into.body.code).toBe('STATUS_HIDDEN');
  // Ready has two visible statuses; hiding both is refused on the second.
  await ok(o, 'PATCH', `/api/ticket-statuses/${st['Unrepairable'].id}`, { isHidden: true });
  const last = await call(o, 'PATCH', `/api/ticket-statuses/${st['Ready for pickup'].id}`, { isHidden: true });
  expect(last.status).toBe(409);
  expect(last.body.code).toBe('LAST_VISIBLE_STATUS');
  await signInContext(page, s.owner.email);
  await page.goto(`/tickets/${t2.id}`);
  await page.getByRole('button', { name: 'Change status' }).click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /Awaiting approval/ })).toHaveCount(0);
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /Unrepairable/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The hidden status's ticket still shows it normally.
  await page.goto(`/tickets/${t.id}`);
  await expect(page.getByRole('main').getByText('Awaiting approval').first()).toBeVisible();
});

test('ST-03 category change moves its tickets at once (views/counts); to/from Closed while in use → STATUS_IN_USE', async ({ page }) => {
  const s = await freshShop('US', 'Category');
  const o = s.owner.ctx;
  const custom = await ok(o, 'POST', '/api/ticket-statuses', { name: 'Bench test', category: 'OPEN', colour: 'teal' });
  const tickets = [await checkIn(o), await checkIn(o)];
  for (const t of tickets) await ok(o, 'POST', `/api/tickets/${t.id}/status`, { statusId: custom.id });
  let counts = await ok(o, 'GET', '/api/tickets/counts');
  expect(counts.openAndWaiting).toBe(2);
  expect(counts.ready).toBe(0);

  await signInContext(page, s.owner.email);
  await page.goto('/settings/statuses');
  await page.getByRole('button', { name: 'Actions for Bench test' }).click();
  await page.getByRole('menuitem', { name: /Edit/ }).click();
  const dialog = page.getByRole('dialog').first();
  await dialog.getByRole('radio', { name: 'Ready' }).click();
  await dialog.getByRole('button', { name: /Save/ }).click();
  await expect(page.getByText(/2 tickets will move from In progress to Ready/)).toBeVisible();
  await page.screenshot({ path: shot2('st-03-category-confirm') });
  await page.getByRole('alertdialog').getByRole('button').filter({ hasText: /Move|Change|Save|Continue/ }).first().click();
  await expect.poll(async () => (await ok(o, 'GET', '/api/tickets/counts')).ready).toBe(2);
  counts = await ok(o, 'GET', '/api/tickets/counts');
  expect(counts.openAndWaiting).toBe(0);
  expect(sql(`select string_agg(distinct "statusCategory"::text, ',') from tickets where "statusId"='${custom.id}'`)).toBe('READY');
  const toClosed = await call(o, 'PATCH', `/api/ticket-statuses/${custom.id}`, { category: 'CLOSED' });
  expect(toClosed.status).toBe(409);
  expect(toClosed.body.code).toBe('STATUS_IN_USE');
  // A new custom closed status is allowed and reachable only via Cancel ticket.
  const closedCustom = await ok(o, 'POST', '/api/ticket-statuses', { name: 'Scrapped', category: 'CLOSED', colour: 'neutral' });
  const viaStatus = await setStatus(o, tickets[0]!.id, closedCustom.id);
  expect(viaStatus.status).toBeGreaterThanOrEqual(400);
  const viaCancel = await ok(o, 'POST', `/api/tickets/${tickets[0]!.id}/cancel`, { statusId: closedCustom.id, reason: 'OTHER', note: 'Customer abandoned', returnedConfirmed: true });
  expect(viaCancel.status.name).toBe('Scrapped');
});

test('ST-04 requiresNote on a custom status; reorder (API + Move down); max 20; audit', async ({ page }) => {
  const s = await freshShop('GB', 'Reorder');
  const o = s.owner.ctx;
  const needs = await ok(o, 'POST', '/api/ticket-statuses', { name: 'Awaiting customer', category: 'WAITING', colour: 'orange', requiresNote: true });
  const t = await checkIn(o);
  expect((await setStatus(o, t.id, needs.id)).status).toBe(400);
  expect((await setStatus(o, t.id, needs.id, { body: 'Left a voicemail', visibility: 'INTERNAL' })).status).toBe(200);

  await signInContext(page, s.owner.email);
  await page.goto('/settings/statuses');
  await page.getByRole('button', { name: 'Actions for Diagnosing' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await expect.poll(async () => {
    const list = (await ok(o, 'GET', '/api/ticket-statuses')).items as Json[];
    return list.findIndex((x) => x.name === 'Diagnosing') > list.findIndex((x) => x.name === 'Awaiting approval');
  }).toBe(true);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: shot2('st-04-statuses') });
  // Reorder with an incomplete list is rejected.
  const ids = ((await ok(o, 'GET', '/api/ticket-statuses')).items as Json[]).map((x) => x.id);
  expect((await call(o, 'PUT', '/api/ticket-statuses/order', { ids: ids.slice(1) })).status).toBe(400);
  // Up to 20 statuses.
  for (let i = ids.length; i < 20; i++) await ok(o, 'POST', '/api/ticket-statuses', { name: `Extra ${i}`, category: 'OPEN', colour: 'blue' });
  const over = await call(o, 'POST', '/api/ticket-statuses', { name: 'One too many', category: 'OPEN', colour: 'blue' });
  expect(over.status).toBe(409);
  expect(over.body.code).toBe('STATUS_LIMIT_REACHED');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add status' })).toBeDisabled();
  const ev = await auditEvents(o);
  expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(['ticket_status.created', 'ticket_status.reordered']));
});

test('TS-01 ticket settings: prefix display + search, next number only upwards, turnaround, audited; UI preview', async ({ page }) => {
  const s = await freshShop('US', 'TSettings');
  const o = s.owner.ctx;
  const t = await checkIn(o);
  expect(t.numberLabel).toBe('T-1001');
  expect((await call(o, 'PATCH', '/api/shop/ticket-settings', { numberPrefix: 'ab1' })).status).toBe(400);
  const low = await call(o, 'PATCH', '/api/shop/ticket-settings', { nextNumber: 1001 });
  expect(low.status).toBe(409);
  expect(low.body.code).toBe('TICKET_NUMBER_TOO_LOW');
  await signInContext(page, s.owner.email);
  await page.goto('/settings/tickets');
  await expect(page.getByText('Next ticket: T-1002')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ticket number prefix' }).fill('rp-');
  await page.getByRole('spinbutton', { name: 'Next ticket number' }).fill('5000');
  await page.getByRole('spinbutton', { name: 'Next ticket number' }).press('Tab');
  const preview = await page.getByText(/^Next ticket: /).innerText();
  test.info().annotations.push({ type: 'observed', description: `preview after typing 5000: ${preview}` });
  await page.getByRole('spinbutton', { name: 'Default turnaround' }).fill('0');
  await page.screenshot({ path: shot2('ts-01-ticket-settings') });
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(page, 'Ticket settings saved')).toBeVisible();
  const old = await ok(o, 'GET', `/api/tickets/${t.id}`);
  expect(old.numberLabel).toBe('RP-1001');
  const next = await checkIn(o);
  expect(next.numberLabel).toBe('RP-5000');
  const ctx = await ok(o, 'GET', '/api/tickets/check-in-context');
  const today = sql(`select (now() at time zone 'America/New_York')::date`);
  expect(JSON.stringify(ctx.defaultDue)).toContain(today);
  for (const q of ['RP-5000', 'rp5000', '5000']) {
    expect((await ok(o, 'GET', `/api/tickets?view=all&q=${q}`)).items.map((i: Json) => i.number), q).toEqual([5000]);
  }
  const ev = await auditEvents(o);
  expect(ev.some((e) => e.action === 'shop.ticket_settings_updated')).toBe(true);
});

test('TS-02 gapless numbering: 20 parallel creates + failures → contiguous numbers, no duplicates', async () => {
  const s = await freshShop('PK', 'Gapless');
  const o = s.owner.ctx;
  const jobs = Array.from({ length: 24 }, (_, i) =>
    call(o, 'POST', '/api/tickets', i % 6 === 5
      ? { newCustomer: { kind: 'PERSON', firstName: 'Bad', phones: [{ number: '123' }] }, newDevice: { type: 'PHONE', brand: 'X', model: 'Y' }, issues: [{ code: 'BATTERY' }] }
      : { newCustomer: { kind: 'PERSON', firstName: `P${i}`, phones: [{ number: phone('PK') }] }, newDevice: { type: 'PHONE', brand: 'Tecno', model: 'Spark 10' }, issues: [{ code: 'BATTERY' }] }),
  );
  const res = await Promise.all(jobs);
  const okCount = res.filter((r) => r.status === 201).length;
  expect(okCount).toBe(20);
  const nums = sql(`select string_agg(number::text, ',' order by number) from tickets where "shopId"='${s.shop.id}'`).split(',').map(Number);
  expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => 1001 + i));
  void statusesByName;
});
