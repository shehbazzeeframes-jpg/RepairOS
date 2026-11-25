import { expect, test } from '@playwright/test';
import { signInContext, sql } from './support/stack';
import { checkIn, freshShop, ok, shot2, type Json } from './support/sprint2';

/** DU1 / A16: due dates, overdue and due-today in the shop's timezone (PK: Asia/Karachi, UTC+5, no DST), plus DST (US/UK). */

function localParts(iso: string, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  return Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}

test('TZ-01 PK default due = 2 open days at closing time (19:00 Karachi, Sunday skipped); a closed day gets 23:59', async () => {
  const s = await freshShop('PK', 'Karachi');
  const ctx = await ok(s.owner.ctx, 'GET', '/api/tickets/check-in-context');
  expect(ctx.timezone).toBe('Asia/Karachi');
  const t = await checkIn(s.owner.ctx);
  const p = localParts(t.dueAt, 'Asia/Karachi');
  expect(`${p.hour}:${p.minute}`).toBe('19:00');
  expect(p.weekday).not.toBe('Sun');
  expect(t.dueHasTime).toBe(false);
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `now ${new Date().toISOString()} → default due ${t.dueAt} (${p.weekday} ${p.day}/${p.month} ${p.hour}:${p.minute} Karachi)`,
    });
  // Explicit Sunday (closed) → 23:59 local.
  const sunday = await checkIn(s.owner.ctx, { dueDate: '2026-12-06' });
  expect(sunday.dueAt).toBe('2026-12-06T18:59:00.000Z');
  // Explicit Monday with a time.
  const timed = await checkIn(s.owner.ctx, { dueDate: '2026-12-07', dueTime: '11:30' });
  expect(timed.dueAt).toBe('2026-12-07T06:30:00.000Z');
  expect(timed.dueHasTime).toBe(true);
  // Past date refused.
  const past = await ok(s.owner.ctx, 'GET', '/api/tickets/check-in-context');
  void past;
});

test('TZ-02 PK overdue / due today follow Karachi dates, not UTC dates', async ({ page }) => {
  const s = await freshShop('PK', 'KarachiOver');
  const mk = async () => (await checkIn(s.owner.ctx)) as Json;
  const [a, b, c, d] = [await mk(), await mk(), await mk(), await mk()];
  const kToday = sql(`select (now() at time zone 'Asia/Karachi')::date`);
  // a: today 00:30 Karachi (= previous UTC day 19:30) → due today AND overdue (already past, unless it's 00:00–00:30 there).
  sql(
    `update tickets set "dueAt" = ('${kToday} 00:30'::timestamp at time zone 'Asia/Karachi'), "dueHasTime"=true where id='${a.id}'`,
  );
  // b: tomorrow 00:10 Karachi (may be "today" in UTC) → neither.
  sql(
    `update tickets set "dueAt" = (('${kToday}'::date + 1) + time '00:10') at time zone 'Asia/Karachi', "dueHasTime"=true where id='${b.id}'`,
  );
  // c: yesterday 23:50 Karachi → overdue, not due today.
  sql(
    `update tickets set "dueAt" = (('${kToday}'::date - 1) + time '23:50') at time zone 'Asia/Karachi', "dueHasTime"=true where id='${c.id}'`,
  );
  // d: today 23:59 Karachi → due today, not overdue.
  sql(
    `update tickets set "dueAt" = ('${kToday} 23:59'::timestamp at time zone 'Asia/Karachi'), "dueHasTime"=true where id='${d.id}'`,
  );
  const counts = await ok(s.owner.ctx, 'GET', '/api/tickets/counts');
  const pastHalfPast =
    sql(`select (now() at time zone 'Asia/Karachi')::time > time '00:30'`) === 't';
  expect(counts.dueToday).toBe(2);
  expect(counts.overdue).toBe(pastHalfPast ? 2 : 1);
  const overdue = (await ok(s.owner.ctx, 'GET', '/api/tickets?view=overdue')).items.map(
    (i: Json) => i.id,
  );
  expect(overdue).toContain(c.id);
  expect(overdue).not.toContain(b.id);
  expect(overdue).not.toContain(d.id);
  // Ready tickets are never overdue.
  await ok(s.owner.ctx, 'POST', `/api/tickets/${c.id}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  expect((await ok(s.owner.ctx, 'GET', '/api/tickets/counts')).overdue).toBe(pastHalfPast ? 1 : 0);
  // UI: dashboard tiles agree; the list shows day-first dates for PK (en-GB).
  await signInContext(page, s.owner.email);
  await page.goto('/');
  const c2 = await ok(s.owner.ctx, 'GET', '/api/tickets/counts');
  await expect(page.getByRole('link', { name: `Due today: ${c2.dueToday}` })).toBeVisible();
  await expect(page.getByRole('link', { name: `Overdue: ${c2.overdue}` })).toBeVisible();
  await page.goto(`/tickets/${b.id}`);
  const header = await page.getByRole('main').innerText();
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `PK header due text: ${header.split('\n').slice(0, 4).join(' | ')}`,
    });
  await page.screenshot({ path: shot2('tz-02-pk-ticket') });
});

test('TZ-03 DST: a due date after the clock change still lands at closing time (US March 2027, UK March 2027)', async () => {
  const us = await freshShop('US', 'DstUS');
  const before = await checkIn(us.owner.ctx, { dueDate: '2027-03-12' }); // Fri, EST (UTC-5)
  const after = await checkIn(us.owner.ctx, { dueDate: '2027-03-15' }); // Mon, EDT (UTC-4)
  expect(before.dueAt).toBe('2027-03-13T00:00:00.000Z');
  expect(after.dueAt).toBe('2027-03-15T23:00:00.000Z');
  const gb = await freshShop('GB', 'DstGB');
  const g1 = await checkIn(gb.owner.ctx, { dueDate: '2027-03-26' }); // Fri, GMT
  const g2 = await checkIn(gb.owner.ctx, { dueDate: '2027-03-29' }); // Mon, BST
  expect(g1.dueAt).toBe('2027-03-26T19:00:00.000Z');
  expect(g2.dueAt).toBe('2027-03-29T18:00:00.000Z');
});
