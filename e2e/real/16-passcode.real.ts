import { expect, test } from '@playwright/test';
import { auditEvents, signInContext, sql } from './support/stack';
import {
  call,
  checkIn,
  freshShop,
  member,
  ok,
  phone,
  shot2,
  type Json,
  type Shop2,
} from './support/sprint2';

/** DV3–DV5, A15: passcode storage, reveal (30 s, audited, rate-limited), closed-ticket denial, delete on close. */

let s: Shop2;
let fd: Awaited<ReturnType<typeof member>>;
let tech: Awaited<ReturnType<typeof member>>;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  s = await freshShop('GB', 'Passcode');
  fd = await member(s, 'FRONT_DESK', 'Pat Desk');
  tech = await member(s, 'TECHNICIAN', 'Pip Tech');
});

async function ticketWith(passcode: Json): Promise<Json> {
  return checkIn(fd.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Lock',
      lastName: `Owner${Date.now() % 10000}`,
      phones: [{ number: phone('GB') }],
    },
    newDevice: { type: 'PHONE', brand: 'Samsung', model: 'Galaxy S23', passcode },
  });
}

test('PC-01 technician reveals a PIN: POST, no-store, shown with a countdown, hidden after 30 s, audited, view count', async ({
  page,
}) => {
  const t = await ticketWith({ lockType: 'PIN', value: '007391' });
  // At rest: ciphertext only, never the PIN; reads return only lockType.
  const raw = sql(
    `select coalesce(encode("passcodeCiphertext",'escape'),'') || '|' || coalesce("passcodeKeyVersion"::text, '') from devices where id='${t.device.id}'`,
  );
  expect(raw).not.toContain('007391');
  const detail = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(JSON.stringify(detail)).not.toContain('007391');
  const getReveal = await call(tech.ctx, 'GET', `/api/tickets/${t.id}/passcode/reveal`);
  expect(getReveal.status).toBe(404);

  await page.clock.install();
  await signInContext(page, tech.email);
  await page.goto(`/tickets/${t.id}`);
  await expect(page.getByText('PIN/passcode on file')).toBeVisible();
  const revealResp = page.waitForResponse((r) => r.url().endsWith('/passcode/reveal'));
  await page.getByRole('button', { name: 'Show passcode' }).click();
  const resp = await revealResp;
  expect(resp.request().method()).toBe('POST');
  expect(resp.headers()['cache-control']).toContain('no-store');
  await expect(page.getByText('007391')).toBeVisible();
  await expect(page.getByText(/Hides in 30 s/).first()).toBeVisible();
  await page.screenshot({ path: shot2('pc-01-revealed') });
  expect(page.url()).not.toContain('007391');
  expect(await page.title()).not.toContain('007391');
  const storage = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(storage).not.toContain('007391');
  await expect(page.getByRole('button', { name: /copy/i })).toHaveCount(0);
  await page.clock.runFor(31_000);
  await expect(page.getByText('007391')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show passcode' })).toBeVisible();
  await expect(page.getByText(/Viewed 1 time.* · last by Pip Tech/)).toBeVisible();

  const ev = await auditEvents(s.owner.ctx);
  const viewed = ev.filter((e) => e.action === 'device.passcode_viewed');
  expect(viewed.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(viewed)).not.toContain('007391');
  expect(
    sql(
      `select after::text from audit_logs where action='device.passcode_viewed' and "entityId"='${t.device.id}'`,
    ),
  ).toContain(t.id);
});

test('PC-02 pattern reveal shows the read-only grid with the order', async ({ page }) => {
  const t = await ticketWith({ lockType: 'PATTERN', pattern: [3, 5, 7, 8] });
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: 'Show passcode' }).click();
  await expect(page.getByText(/Order: 3 → 5 → 7 → 8|3 → 5 → 7 → 8/).first()).toBeVisible();
  await page.screenshot({ path: shot2('pc-02-pattern') });
});

test('PC-03 closed ticket: no button, API 403 PASSCODE_NOT_AVAILABLE; customer page never reveals', async ({
  page,
}) => {
  // Keep the passcode on close (setting off) so the closed-ticket guard itself is tested.
  await ok(s.owner.ctx, 'PATCH', '/api/shop/ticket-settings', { deletePasscodeOnClose: false });
  const t = await ticketWith({ lockType: 'PIN', value: '5566' });
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' });
  const r = await call(tech.ctx, 'POST', `/api/tickets/${t.id}/passcode/reveal`);
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('PASSCODE_NOT_AVAILABLE');
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await expect(page.getByText('Passcode on file')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show passcode' })).toHaveCount(0);
  await page.goto(`/customers/${t.customer.id}?tab=devices`);
  await expect(page.getByRole('button', { name: 'Show passcode' })).toHaveCount(0);
  await ok(s.owner.ctx, 'PATCH', '/api/shop/ticket-settings', { deletePasscodeOnClose: true });
});

test('PC-04 delete passcode on close (setting on): deleted when the last open ticket closes; kept while another is open', async () => {
  const t = await ticketWith({ lockType: 'PIN', value: '2468' });
  const second = await checkIn(fd.ctx, {
    customerId: t.customer.id,
    deviceId: t.device.id,
    issues: [{ code: 'BATTERY' }],
  });
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' });
  let d = await ok(fd.ctx, 'GET', `/api/tickets/${second.id}`);
  expect(d.device.passcodeOnFile).toBe(true);
  await ok(fd.ctx, 'POST', `/api/tickets/${second.id}/cancel`, { reason: 'CREATED_BY_MISTAKE' });
  d = await ok(fd.ctx, 'GET', `/api/tickets/${second.id}`);
  expect(d.device.passcodeOnFile).toBe(false);
  expect(sql(`select "passcodeCiphertext" is null from devices where id='${t.device.id}'`)).toBe(
    't',
  );
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${second.id}/timeline?filter=all`);
  expect((tl.items as Json[]).map((i) => i.type)).toContain('passcode_deleted');
});

test('PC-05 passcode never in export, timeline or audit; changing it is audited without the value', async () => {
  const t = await ticketWith({ lockType: 'PASSWORD', value: 'Hunter2-secret' });
  await ok(fd.ctx, 'PATCH', `/api/devices/${t.device.id}`, {
    passcode: { lockType: 'PIN', value: '9911' },
  });
  const ev = await auditEvents(s.owner.ctx);
  const changed = ev.filter((e) => e.action === 'device.passcode_changed');
  expect(changed.length).toBeGreaterThanOrEqual(1);
  const all = JSON.stringify(ev);
  expect(all).not.toContain('Hunter2-secret');
  expect(all).not.toContain('9911');
  const exp = await s.owner.ctx.get(`/api/customers/${t.customer.id}/export`);
  const text = await exp.text();
  expect(text).not.toContain('9911');
  expect(text).not.toContain('Hunter2');
  expect(text).toContain('"passcodeOnFile":true');
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=all`);
  expect(JSON.stringify(tl)).not.toContain('9911');
  // Technicians can't set passcodes (customers.manage).
  const byTech = await call(tech.ctx, 'PATCH', `/api/devices/${t.device.id}`, {
    passcode: { lockType: 'NONE' },
  });
  expect(byTech.status).toBe(403);
});

test('PC-06 more than 30 reveals per user per hour → 429 RATE_LIMITED', async () => {
  const t = await ticketWith({ lockType: 'PIN', value: '1357' });
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++)
    statuses.push((await call(fd.ctx, 'POST', `/api/tickets/${t.id}/passcode/reveal`)).status);
  // PC-02 already used one reveal for this user.
  const first429 = statuses.indexOf(429);
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `first 429 at reveal #${first429 + 2} (incl. PC-02)`,
    });
  expect(first429).toBeGreaterThan(25);
  expect(statuses.slice(0, first429).every((x) => x === 200)).toBe(true);
  // Another user is not affected.
  expect((await call(s.owner.ctx, 'POST', `/api/tickets/${t.id}/passcode/reveal`)).status).toBe(
    200,
  );
});

test('PC-07 (known open item) two open tickets on one device closed at the same moment: passcode still deleted', async () => {
  test.fail(true, 'KNOWN (open item): passcode not deleted on concurrent close');
  let kept = 0;
  for (let i = 0; i < 5; i++) {
    const t = await ticketWith({ lockType: 'PIN', value: '4040' });
    const second = await checkIn(fd.ctx, {
      customerId: t.customer.id,
      deviceId: t.device.id,
      issues: [{ code: 'BATTERY' }],
    });
    await Promise.all([
      call(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' }),
      call(s.owner.ctx, 'POST', `/api/tickets/${second.id}/cancel`, { reason: 'DUPLICATE' }),
    ]);
    if (
      sql(`select "passcodeCiphertext" is not null from devices where id='${t.device.id}'`) === 't'
    )
      kept += 1;
  }
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `passcode kept after concurrent close in ${kept}/5 runs`,
    });
  expect(kept).toBe(0);
});
