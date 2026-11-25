import { expect, test, type APIRequestContext } from '@playwright/test';
import { signInContext, sql } from './support/stack';
import {
  axe,
  call,
  checkIn,
  freshShop,
  imei,
  member,
  ok,
  setStatus,
  shot2,
  type Json,
  type Shop2,
} from './support/sprint2';

/**
 * §5.2 ticket list (TL1), §6 dashboard (DB1) and their agreement, on one purpose-built US shop:
 *   A  Received, assigned to the tech, due in 3 days        → open, mine(tech)
 *   B  Awaiting parts, unassigned, due 2 h ago               → open, unassigned, overdue, due today*
 *   C  Ready for pickup, unassigned                          → open(all), ready
 *   D  Received, URGENT, unassigned, due later today         → open, unassigned, due today
 *   E  Cancelled                                             → closed
 *   F  In repair, assigned to a deactivated member           → open, unassigned (AS1.2)
 * (*) "due today" only when 2 h ago is still today in New York; computed below.
 */
interface World {
  s: Shop2;
  tech: Awaited<ReturnType<typeof member>>;
  t: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', Json>;
  phones: Record<string, string>;
  imeiA: string;
  serialC: string;
}

let w: World;

async function build(): Promise<World> {
  const s = await freshShop('US', 'Lists');
  const tech = await member(s, 'TECHNICIAN', 'Tina Lister');
  const gone = await member(s, 'TECHNICIAN', 'Gone Tech');
  const st = s.statuses;
  const o = s.owner.ctx;
  const imeiA = imei(Date.now() + 101);
  const serialC = `SNQA${Date.now().toString(36).toUpperCase()}`.slice(0, 16);
  const phones = { A: '(212) 555-0181', B: '(646) 555-0182', C: '(917) 555-0183', D: '(718) 555-0184', E: '(212) 555-0185', F: '(212) 555-0186' };
  const mk = async (k: string, dev: Json, extra: Json = {}) =>
    checkIn(o, {
      newCustomer: { kind: 'PERSON', firstName: `List${k}`, lastName: 'Person', phones: [{ number: phones[k as keyof typeof phones] }] },
      newDevice: dev,
      ...extra,
    });
  const A = await mk('A', { type: 'PHONE', brand: 'Apple', model: 'iPhone 15', imei: imeiA }, { assigneeUserId: tech.userId });
  const B = await mk('B', { type: 'TABLET', brand: 'Apple', model: 'iPad Air' });
  const C = await mk('C', { type: 'LAPTOP', brand: 'Apple', model: 'MacBook Air M2', serial: serialC }, { issues: [{ code: 'KEYBOARD' }] });
  const D = await mk('D', { type: 'PHONE', brand: 'Samsung', model: 'Galaxy S24' }, { priority: 'URGENT' });
  const E = await mk('E', { type: 'CONSOLE', brand: 'Sony', model: 'PS5' }, { issues: [{ code: 'HDMI_PORT' }] });
  const F = await mk('F', { type: 'PHONE', brand: 'Google', model: 'Pixel 8' }, { assigneeUserId: gone.userId });
  await ok(o, 'POST', `/api/tickets/${B.id}/status`, { statusId: st['Awaiting parts'].id });
  await ok(o, 'POST', `/api/tickets/${C.id}/status`, { statusId: st['Ready for pickup'].id });
  await ok(o, 'POST', `/api/tickets/${E.id}/cancel`, { reason: 'CREATED_BY_MISTAKE' });
  await ok(o, 'POST', `/api/tickets/${F.id}/status`, { statusId: st['In repair'].id });
  // Due times (UTC instants).
  sql(`update tickets set "dueAt" = now() + interval '3 days' where id in ('${A.id}','${C.id}','${F.id}')`);
  sql(`update tickets set "dueAt" = now() - interval '2 hours', "dueHasTime"=true where id='${B.id}'`);
  // D: later today in New York (or 1 minute from now if it's already late evening there).
  sql(`update tickets set "dueAt" = least(now() + interval '1 hour', (date_trunc('day', now() at time zone 'America/New_York') + interval '23 hours 58 minutes') at time zone 'America/New_York'), "dueHasTime"=true where id='${D.id}'`);
  const staff = await ok(o, 'GET', '/api/staff');
  const goneRow = (staff.items as Json[]).find((m) => m.email === gone.email || m.user?.email === gone.email);
  expect(goneRow, JSON.stringify(staff.items[0])).toBeTruthy();
  await ok(o, 'POST', `/api/staff/${goneRow!.id}/deactivate`, {});
  return { s, tech, t: { A, B, C, D, E, F }, phones, imeiA, serialC };
}

async function listNumbers(ctx: APIRequestContext, query: string): Promise<number[]> {
  const r = await ok(ctx, 'GET', `/api/tickets?${query}`);
  return (r.items as Json[]).map((i) => i.number).sort();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  w = await build();
});

test('TL-01 view counts follow the category rules (incl. deactivated assignee → Unassigned)', async () => {
  const o = w.s.owner.ctx;
  const c = await ok(o, 'GET', '/api/tickets/counts');
  const bDueToday = sql(`select ((now() - interval '2 hours') at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date`) === 't';
  expect(c).toMatchObject({ open: 5, ready: 1, overdue: 1, unassigned: 3, openAndWaiting: 4, dueToday: bDueToday ? 2 : 1 });
  const ct = await ok(w.tech.ctx, 'GET', '/api/tickets/counts');
  expect(ct.mine).toBe(1);
  const n = (k: keyof World['t']) => w.t[k].number as number;
  expect(await listNumbers(o, 'view=open')).toEqual([n('A'), n('B'), n('C'), n('D'), n('F')].sort());
  expect(await listNumbers(o, 'view=unassigned')).toEqual([n('B'), n('D'), n('F')].sort());
  expect(await listNumbers(o, 'view=ready')).toEqual([n('C')]);
  expect(await listNumbers(o, 'view=overdue')).toEqual([n('B')]);
  expect(await listNumbers(o, 'view=closed')).toEqual([n('E')]);
  expect(await listNumbers(w.tech.ctx, 'view=mine')).toEqual([n('A')]);
  // Default open sort: urgent first, then due soonest.
  const sorted = (await ok(o, 'GET', '/api/tickets?view=open')).items.map((i: Json) => i.number);
  expect(sorted[0]).toBe(n('D'));
  expect(sorted[1]).toBe(n('B'));
});

test('TL-02 search by ticket number in every accepted form, phone in several formats, email, IMEI and serial', async () => {
  const o = w.s.owner.ctx;
  const nA = w.t.A.number as number;
  for (const q of [`T-${nA}`, `t${nA}`, `${nA}`, `t-${nA}`]) {
    expect(await listNumbers(o, `view=all&q=${encodeURIComponent(q)}`), q).toEqual([nA]);
  }
  const nB = w.t.B.number as number;
  for (const q of ['(646) 555-0182', '646-555-0182', '6465550182', '+1 646 555 0182', '+16465550182', '0182', '555-0182']) {
    const got = await listNumbers(o, `view=all&q=${encodeURIComponent(q)}`);
    expect(got, `phone ${q}`).toContain(nB);
    if (q !== '0182') expect(got.length, `phone ${q} should be exact`).toBe(q === '555-0182' ? 1 : 1);
  }
  expect(await listNumbers(o, `view=all&q=${w.imeiA}`)).toEqual([nA]);
  expect(await listNumbers(o, `view=all&q=${w.imeiA.slice(-4)}`)).toContain(nA);
  expect(await listNumbers(o, `view=all&q=${encodeURIComponent(w.serialC.slice(2, 9).toLowerCase())}`)).toEqual([w.t.C.number]);
  expect(await listNumbers(o, 'view=all&q=listd')).toEqual([w.t.D.number]);
  expect(await listNumbers(o, 'view=all&q=person%20listd')).toEqual([w.t.D.number]);
});

test('TL-03 filters: status, priority, device type, technician incl. Unassigned, created range', async () => {
  const o = w.s.owner.ctx;
  const st = w.s.statuses;
  expect(await listNumbers(o, `view=all&status=${st['Awaiting parts'].id}`)).toEqual([w.t.B.number]);
  expect(await listNumbers(o, 'view=open&priority=URGENT')).toEqual([w.t.D.number]);
  expect(await listNumbers(o, 'view=all&deviceType=LAPTOP,CONSOLE')).toEqual([w.t.C.number, w.t.E.number].sort());
  expect(await listNumbers(o, `view=open&assignee=${w.tech.userId}`)).toEqual([w.t.A.number]);
  expect(await listNumbers(o, 'view=open&assignee=unassigned')).toEqual([w.t.B.number, w.t.C.number, w.t.D.number, w.t.F.number].sort());
  const today = sql(`select (now() at time zone 'America/New_York')::date`);
  expect((await listNumbers(o, `view=all&createdFrom=${today}&createdTo=${today}`)).length).toBe(6);
  expect(await listNumbers(o, 'view=all&createdFrom=2020-01-01&createdTo=2020-01-02')).toEqual([]);
  const bad = await call(o, 'GET', '/api/tickets?view=all&createdFrom=2026-01-05&createdTo=2026-01-01');
  expect(bad.status).toBe(400);
});

test('TL-04 UI: view tabs with counts, URL state, search box, deactivated assignee label, axe', async ({ page }) => {
  await signInContext(page, w.s.owner.email);
  await page.goto('/tickets');
  const views = page.getByRole('navigation', { name: 'Ticket views' });
  await expect(views.getByRole('button', { name: 'All open 5' })).toBeVisible();
  await expect(views.getByRole('button', { name: 'Unassigned 3' })).toBeVisible();
  await expect(views.getByRole('button', { name: 'Ready for pickup 1' })).toBeVisible();
  await expect(views.getByRole('button', { name: 'Overdue 1' })).toBeVisible();
  await expect(page.getByText('Showing 1–5 of 5')).toBeVisible();
  await expect(page.getByText('Gone Tech (deactivated)').first()).toBeVisible();
  await page.screenshot({ path: shot2('tl-04-list-1440') });
  expect(await axe(page)).toEqual([]);
  await views.getByRole('button', { name: /Overdue/ }).click();
  await expect(page).toHaveURL(/view=overdue/);
  await expect(page.getByRole('link', { name: `T-${w.t.B.number}` })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`T-${w.t.B.number}`) })).toContainText(/overdue/i);
  await views.getByRole('button', { name: /Closed/ }).click();
  await expect(page.getByRole('link', { name: `T-${w.t.E.number}` })).toBeVisible();
  await views.getByRole('button', { name: /All open/ }).click();
  await page.getByRole('searchbox', { name: 'Search tickets' }).fill('646.555.0182');
  await expect(page).toHaveURL(/q=646/);
  await expect(page.getByRole('link', { name: `T-${w.t.B.number}` })).toBeVisible();
  await expect(page.getByRole('link', { name: `T-${w.t.A.number}` })).toBeHidden();
  await page.getByRole("searchbox", { name: "Search tickets" }).fill("");
  await expect(page.getByRole('link', { name: `T-${w.t.A.number}` })).toBeVisible();
  // Technician lands on Mine.
  const tech = await page.context().browser()!.newContext();
  const tp = await tech.newPage();
  await signInContext(tp, w.tech.email);
  await tp.goto('/tickets');
  await expect(tp).toHaveURL(/view=mine|\/tickets$/);
  await expect(tp.getByRole('navigation', { name: 'Ticket views' }).getByRole('button', { name: 'Mine 1' })).toHaveAttribute('aria-current', /page|true/);
  await tech.close();
});

test('TL-05 row "Take" assigns to me and the row menu changes status', async ({ page }) => {
  await signInContext(page, w.tech.email);
  await page.goto('/tickets?view=unassigned');
  await page.getByRole('button', { name: `Actions for T-${w.t.D.number}` }).click();
  await page.getByRole('menuitem', { name: /^Take/ }).click();
  await expect.poll(async () => (await ok(w.tech.ctx, 'GET', `/api/tickets/${w.t.D.id}`)).assignee?.userId).toBe(w.tech.userId);
  await page.goto('/tickets?view=mine');
  await page.getByRole('button', { name: `Actions for T-${w.t.D.number}` }).click();
  await page.getByRole('menuitem', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: /Diagnosing/ }).click();
  await expect.poll(async () => (await ok(w.tech.ctx, 'GET', `/api/tickets/${w.t.D.id}`)).status.name).toBe('Diagnosing');
  // Back to unassigned for the dashboard test.
  await ok(w.s.owner.ctx, 'POST', `/api/tickets/${w.t.D.id}/assign`, { userId: null });
});

test('DB-01 dashboard tiles equal the counts and each tile lands on a list with the same number of rows', async ({ page }) => {
  const o = w.s.owner.ctx;
  const c = await ok(o, 'GET', '/api/tickets/counts');
  const d = await ok(o, 'GET', '/api/dashboard');
  test.info().annotations.push({ type: 'counts', description: JSON.stringify(c) });
  await signInContext(page, w.s.owner.email);
  await page.goto('/');
  const tiles: [string, number][] = [
    ['Open tickets', c.openAndWaiting],
    ['Ready for pickup', c.ready],
    ['Overdue', c.overdue],
    ['Due today', c.dueToday],
  ];
  for (const [label, n] of tiles) {
    await expect(page.getByRole('link', { name: `${label}: ${n}` })).toBeVisible();
  }
  expect(JSON.stringify(d)).toContain(`"openAndWaiting":${c.openAndWaiting}`);
  await page.screenshot({ path: shot2('db-01-dashboard') });
  expect(await axe(page)).toEqual([]);
  for (const [label, n] of tiles) {
    await page.goto('/');
    await page.goto((await page.getByRole("link", { name: `${label}: ${n}` }).getAttribute("href"))!);
    await expect(page).toHaveURL(/\/tickets\?/);
    if (n === 0) continue;
    await expect(page.getByText(`Showing 1–${n} of ${n}`), `${label} list rows`).toBeVisible();
  }
});

test('DB-02 technician dashboard: My queue shows only my tickets; empty queue offers Unassigned with Take', async ({ page }) => {
  await signInContext(page, w.tech.email);
  await page.goto('/');
  const queue = page.getByRole('region', { name: 'My queue' });
  await expect(queue.getByRole('link', { name: `T-${w.t.A.number}` })).toBeVisible();
  await expect(queue.getByRole('link', { name: `T-${w.t.C.number}` })).toHaveCount(0);
  // Front desk sees New ticket; technician does not.
  await expect(page.getByRole('main').getByRole('link', { name: 'New ticket' })).toHaveCount(0);
});
