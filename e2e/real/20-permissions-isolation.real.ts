import { expect, test, type Page } from '@playwright/test';
import { SEED, apiAs, signInContext } from './support/stack';
import { call, checkIn, freshShop, member, ok, type Json } from './support/sprint2';

/** §0 permissions per role (nav + direct URL + API) and tenant isolation for the Sprint 2 tables. */

const NO_ACCESS = "You don't have access to this page";

async function expectNoAccess(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: NO_ACCESS }), url).toBeVisible();
}
async function expectAccess(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1 }).first(), url).toBeVisible();
  await expect(page.getByRole('heading', { name: NO_ACCESS }), url).toHaveCount(0);
}

test('PERM-S2-01 technician: sees tickets/customers, no check-in or customer edits, no ticket settings; API agrees', async ({
  page,
}) => {
  const s = await freshShop('US', 'PermTech');
  const tech = await member(s, 'TECHNICIAN');
  const t = await checkIn(s.owner.ctx);
  await ok(s.owner.ctx, 'POST', `/api/tickets/${t.id}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  await signInContext(page, tech.email);
  await page.goto('/');
  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link', { name: 'Tickets' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Customers' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'New ticket' }),
  ).toHaveCount(0);
  for (const u of [
    '/tickets/new',
    '/customers/new',
    `/customers/${t.customer.id}/edit`,
    '/settings/statuses',
    '/settings/tickets',
  ])
    await expectNoAccess(page, u);
  for (const u of ['/tickets', `/tickets/${t.id}`, '/customers', `/customers/${t.customer.id}`])
    await expectAccess(page, u);
  await page.goto(`/customers/${t.customer.id}`);
  await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New ticket' })).toHaveCount(0);
  const c = tech.ctx;
  const denied: [string, string, unknown][] = [
    [
      'POST',
      '/api/tickets',
      { customerId: t.customer.id, deviceId: t.device.id, issues: [{ code: 'BATTERY' }] },
    ],
    ['POST', '/api/customers', { kind: 'PERSON', firstName: 'X', email: 'x@qa.test' }],
    ['PATCH', `/api/customers/${t.customer.id}`, { version: 1, firstName: 'Y' }],
    ['POST', `/api/customers/${t.customer.id}/devices`, { type: 'PHONE', brand: 'A', model: 'B' }],
    ['POST', `/api/tickets/${t.id}/status`, { statusId: s.statuses['Collected'].id }],
    ['POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' }],
    ['POST', `/api/customers/${t.customer.id}/archive`, {}],
    ['GET', `/api/customers/${t.customer.id}/export`, undefined],
    ['POST', `/api/customers/${t.customer.id}/erase`, { confirm: 'ERASE' }],
    ['POST', '/api/ticket-statuses', { name: 'Nope', category: 'OPEN', colour: 'blue' }],
    ['PATCH', '/api/shop/ticket-settings', { defaultTurnaroundDays: 3 }],
  ];
  for (const [m, p, b] of denied) {
    const r = await call(c, m as 'GET', p, b);
    expect(r.status, `${m} ${p}`).toBe(403);
  }
  // Allowed: status within non-closed, assign, notes, reveal.
  expect(
    (await call(c, 'POST', `/api/tickets/${t.id}/assign`, { userId: tech.userId })).status,
  ).toBe(200);
  expect(
    (
      await call(c, 'POST', `/api/tickets/${t.id}/notes`, {
        body: 'tech note',
        visibility: 'INTERNAL',
      })
    ).status,
  ).toBe(201);
  expect(
    (await call(c, 'POST', `/api/tickets/${t.id}/status`, { statusId: s.statuses['In repair'].id }))
      .status,
  ).toBe(200);
});

test('PERM-S2-02 front desk: check-in and customers yes; export/erase and status/ticket settings no', async ({
  page,
}) => {
  const s = await freshShop('GB', 'PermFD');
  const fd = await member(s, 'FRONT_DESK');
  const t = await checkIn(s.owner.ctx);
  await signInContext(page, fd.email);
  for (const u of ['/tickets/new', '/customers/new', `/customers/${t.customer.id}/edit`])
    await expectAccess(page, u);
  for (const u of ['/settings/statuses', '/settings/tickets']) await expectNoAccess(page, u);
  await page.goto(`/customers/${t.customer.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Export data/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Erase…' })).toHaveCount(0);
  expect((await call(fd.ctx, 'GET', `/api/customers/${t.customer.id}/export`)).status).toBe(403);
  expect((await call(fd.ctx, 'GET', '/api/shop/ticket-settings')).status).toBe(403);
  expect((await call(fd.ctx, 'GET', '/api/tickets/check-in-context')).status).toBe(200);
});

test('PERM-S2-03 manager: statuses and ticket settings pages, export allowed; settings nav lists both', async ({
  page,
}) => {
  const s = await freshShop('PK', 'PermMgr');
  const mgr = await member(s, 'MANAGER');
  const t = await checkIn(s.owner.ctx);
  await signInContext(page, mgr.email);
  for (const u of ['/settings/statuses', '/settings/tickets', '/tickets/new'])
    await expectAccess(page, u);
  await page.goto('/settings/statuses');
  const nav = page.getByRole('navigation', { name: 'Settings' });
  await expect(nav.getByRole('link', { name: 'Ticket statuses' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Tickets' })).toBeVisible();
  expect((await call(mgr.ctx, 'GET', `/api/customers/${t.customer.id}/export`)).status).toBe(200);
});

test('ISO-S2-01 PK owner using US ids gets 404 everywhere (API and UI), never 403; lists and search show nothing', async ({
  page,
}) => {
  const pk = await apiAs(SEED.pkOwner);
  const us = await apiAs(SEED.owner);
  const usTicket = (await ok(us, 'GET', '/api/tickets?view=open')).items[0] as Json;
  const tId = usTicket.id as string;
  const detail = await ok(us, 'GET', `/api/tickets/${tId}`);
  const cId = detail.customer.id as string;
  const dId = detail.device.id as string;
  const usStatus = ((await ok(us, 'GET', '/api/ticket-statuses')).items as Json[])[1]!.id as string;
  const probes: [string, string, unknown][] = [
    ['GET', `/api/tickets/${tId}`, undefined],
    ['GET', `/api/tickets/${tId}/timeline`, undefined],
    ['PATCH', `/api/tickets/${tId}`, { version: detail.version, priority: 'URGENT' }],
    ['POST', `/api/tickets/${tId}/status`, { statusId: usStatus }],
    ['POST', `/api/tickets/${tId}/assign`, { userId: null }],
    ['POST', `/api/tickets/${tId}/notes`, { body: 'cross-shop', visibility: 'INTERNAL' }],
    ['POST', `/api/tickets/${tId}/cancel`, { reason: 'DUPLICATE' }],
    ['POST', `/api/tickets/${tId}/passcode/reveal`, undefined],
    ['GET', `/api/customers/${cId}`, undefined],
    ['PATCH', `/api/customers/${cId}`, { version: 1, firstName: 'Hacked' }],
    ['GET', `/api/customers/${cId}/consents`, undefined],
    [
      'POST',
      `/api/customers/${cId}/consents`,
      { changes: [{ channel: 'SMS', state: 'WITHDRAWN' }] },
    ],
    ['POST', `/api/customers/${cId}/archive`, {}],
    ['GET', `/api/customers/${cId}/export`, undefined],
    ['POST', `/api/customers/${cId}/erase`, { confirm: 'ERASE' }],
    ['GET', `/api/customers/${cId}/devices`, undefined],
    ['POST', `/api/customers/${cId}/devices`, { type: 'PHONE', brand: 'A', model: 'B' }],
    ['PATCH', `/api/devices/${dId}`, { colour: 'Red' }],
    ['PATCH', `/api/ticket-statuses/${usStatus}`, { name: 'Pwned' }],
  ];
  const results: string[] = [];
  for (const [m, p, b] of probes) {
    const r = await call(pk, m as 'GET', p, b);
    results.push(`${m} ${p} → ${r.status}`);
    expect(r.status, `${m} ${p}`).toBe(404);
  }
  // Creating a ticket in PK with a US customer/device → 404, nothing written.
  const cross = await call(pk, 'POST', '/api/tickets', {
    customerId: cId,
    deviceId: dId,
    issues: [{ code: 'BATTERY' }],
  });
  expect(cross.status).toBe(404);
  expect((await ok(pk, 'GET', `/api/tickets?view=all&customerId=${cId}`)).items).toEqual([]);
  const name = detail.customer.displayName as string;
  expect((await ok(pk, 'GET', `/api/customers?q=${encodeURIComponent(name)}`)).total).toBe(0);
  const g = await ok(pk, 'GET', `/api/search?q=${encodeURIComponent(name)}`);
  expect(g.customers.length + g.tickets.length).toBe(0);
  // US data unchanged.
  const after = await ok(us, 'GET', `/api/tickets/${tId}`);
  expect(after.version).toBe(detail.version);
  test.info().annotations.push({ type: 'probes', description: results.join('; ') });

  await signInContext(page, SEED.pkOwner);
  await page.goto(`/tickets/${tId}`);
  await expect(page.getByRole('heading', { name: "We can't find that ticket." })).toBeVisible();
  await page.goto(`/customers/${cId}`);
  await expect(page.getByRole('heading', { name: /We can't find that customer/ })).toBeVisible();
});
