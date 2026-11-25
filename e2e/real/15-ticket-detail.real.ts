import { expect, test } from '@playwright/test';
import { auditEvents, signInContext, sql, toast } from './support/stack';
import {
  axe,
  call,
  checkIn,
  freshShop,
  member,
  ok,
  phone,
  setStatus,
  shot2,
  type Json,
  type Shop2,
} from './support/sprint2';

/** §5.3–5.6 ticket detail: transitions (A7), notes (A20), assign (AS1), cancel/reopen/warranty, concurrency. */

let s: Shop2;
let fd: Awaited<ReturnType<typeof member>>;
let tech: Awaited<ReturnType<typeof member>>;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  s = await freshShop('US', 'Detail');
  fd = await member(s, 'FRONT_DESK', 'Fran Desk');
  tech = await member(s, 'TECHNICIAN', 'Ted Tech');
});

async function ticket(extra: Json = {}): Promise<Json> {
  return checkIn(s.owner.ctx, {
    newCustomer: {
      kind: 'PERSON',
      firstName: 'Detail',
      lastName: `Cust${Date.now() % 100000}`,
      phones: [{ number: phone('US') }],
    },
    newDevice: {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 13',
      passcode: { lockType: 'PIN', value: '0420' },
    },
    accessories: ['CASE', 'CHARGER'],
    ...extra,
  });
}

test('TD-01 status menu: only allowed targets; Collected explained from an open ticket; change is on the timeline', async ({
  page,
}) => {
  const t = await ticket();
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await expect(page.getByRole('heading', { level: 1, name: t.numberLabel })).toBeVisible();
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('s');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Diagnosing/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Cancelled/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /Collected/ })).toBeDisabled();
  await expect(menu.getByText(/Mark it Ready for pickup first/)).toBeVisible();
  await page.screenshot({ path: shot2('td-01-status-menu') });
  await menu.getByRole('menuitem', { name: /Diagnosing/ }).click();
  await expect(toast(page, 'Status changed to Diagnosing')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ticket activity' })).toContainText(/changed status/);
  // Same status again is a no-op rejection; API refuses Collected from open.
  const same = await setStatus(fd.ctx, t.id, s.statuses['Diagnosing'].id);
  expect(same.status).toBe(409);
  const col = await setStatus(fd.ctx, t.id, s.statuses['Collected'].id);
  expect(col.status).toBe(409);
  expect(col.body.code).toBe('TRANSITION_NOT_ALLOWED');
  // Cancelled via the status endpoint is not allowed (must use Cancel ticket).
  const viaStatus = await setStatus(fd.ctx, t.id, s.statuses['Cancelled'].id);
  expect(viaStatus.status, JSON.stringify(viaStatus.body)).toBeGreaterThanOrEqual(400);
  expect(await axe(page)).toEqual([]);
});

test('TD-02 Unrepairable requires a note (API 400 without; UI dialog; note is customer-visible by default)', async ({
  page,
}) => {
  const t = await ticket();
  const bare = await setStatus(tech.ctx, t.id, s.statuses['Unrepairable'].id);
  expect(bare.status).toBe(400);
  await signInContext(page, tech.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: /Unrepairable/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as Unrepairable' });
  await dialog.getByRole('button', { name: 'Mark as Unrepairable' }).click();
  await expect(dialog.getByText('Write a note').first()).toBeVisible();
  await dialog
    .getByRole('textbox', { name: "Why can't it be repaired?" })
    .fill('Board is corroded beyond repair.');
  await page.screenshot({ path: shot2('td-02-unrepairable') });
  await dialog.getByRole('button', { name: 'Mark as Unrepairable' }).click();
  await expect(toast(page, 'Status changed to Unrepairable')).toBeVisible();
  const tl = await ok(tech.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=notes`);
  const note = (tl.items as Json[]).find((i) => JSON.stringify(i).includes('corroded'));
  expect(JSON.stringify(note)).toContain('CUSTOMER');
  const after = await ok(tech.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(after.status.category).toBe('READY');
});

test('TD-03 Collected only from ready, only with tickets.cancel; confirm lists the accessories; timeline + passcode deleted', async ({
  page,
}) => {
  const t = await ticket();
  await ok(tech.ctx, 'POST', `/api/tickets/${t.id}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  const byTech = await setStatus(tech.ctx, t.id, s.statuses['Collected'].id);
  expect(byTech.status).toBe(403);
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: 'Change status' }).click();
  await page.getByRole('menuitem', { name: /Collected/ }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(
    confirm.getByText(/Hand the device and these accessories back: .*Case.*Charger/),
  ).toBeVisible();
  await page.screenshot({ path: shot2('td-03-collect-confirm') });
  await confirm.getByRole('button', { name: 'Mark collected' }).click();
  await expect(page.getByText('Closed. Notes can still be added.')).toBeVisible();
  const after = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(after.status.systemRole).toBe('COLLECTED');
  expect(after.closedAt).toBeTruthy();
  expect(after.device.passcodeOnFile).toBe(false);
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=all`);
  expect((tl.items as Json[]).map((i) => i.type)).toContain('passcode_deleted');
  // Closed tickets are read-only except notes.
  const edit = await call(fd.ctx, 'PATCH', `/api/tickets/${t.id}`, {
    version: after.version,
    priority: 'URGENT',
  });
  expect(edit.status).toBe(409);
  expect(edit.body.code).toBe('TICKET_CLOSED');
  const move = await setStatus(fd.ctx, t.id, s.statuses['In repair'].id);
  expect(move.status).toBe(409);
  const note = await call(fd.ctx, 'POST', `/api/tickets/${t.id}/notes`, {
    body: 'Picked up by daughter.',
    visibility: 'INTERNAL',
  });
  expect(note.status).toBe(201);
});

test('TD-04 cancel needs a reason and the hand-back confirmation; audited; technicians cannot cancel', async ({
  page,
}) => {
  const t = await ticket();
  expect(
    (await call(tech.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' })).status,
  ).toBe(403);
  expect(
    (await call(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'CUSTOMER_TOOK_BACK' }))
      .status,
  ).toBe(400);
  expect(
    (
      await call(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, {
        reason: 'OTHER',
        note: 'no',
        returnedConfirmed: true,
      })
    ).status,
  ).toBe(400);
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: `More actions for ${t.numberLabel}` }).click();
  await page.getByRole('menuitem', { name: 'Cancel ticket…' }).click();
  const dialog = page.getByRole('dialog', { name: `Cancel ${t.numberLabel}` });
  await dialog.getByRole('radio', { name: 'Customer declined estimate' }).check();
  await dialog.getByRole('button', { name: 'Cancel ticket' }).click();
  await expect(
    dialog.getByText('Confirm the device and accessories were returned').first(),
  ).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Device and accessories returned/ }).check();
  await page.screenshot({ path: shot2('td-04-cancel') });
  await dialog.getByRole('button', { name: 'Cancel ticket' }).click();
  await expect(toast(page, `${t.numberLabel} cancelled`)).toBeVisible();
  const ev = await auditEvents(s.owner.ctx, '&group=tickets');
  const cancelled = ev.find(
    (e) => e.action === 'ticket.cancelled' && JSON.stringify(e).includes(t.id),
  );
  expect(cancelled, JSON.stringify(ev.slice(0, 3))).toBeTruthy();
});

test('TD-05 reopen within 7 days (default = status before close), audited; after 7 days only warranty/new ticket', async ({
  page,
}) => {
  const t = await ticket();
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/status`, {
    statusId: s.statuses['Awaiting parts'].id,
  });
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'CREATED_BY_MISTAKE' });
  expect(
    (await call(tech.ctx, 'POST', `/api/tickets/${t.id}/reopen`, { reason: 'Oops wrong one' }))
      .status,
  ).toBe(403);
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: `More actions for ${t.numberLabel}` }).click();
  await page.getByRole('menuitem', { name: 'Reopen…' }).click();
  const dialog = page.getByRole('dialog', { name: `Reopen ${t.numberLabel}` });
  await expect(dialog.getByText(/Ask the customer for it again/)).toBeVisible();
  await expect(
    dialog
      .getByRole('button', { name: /Reopen to/ })
      .or(dialog.getByRole('combobox', { name: 'Reopen to' })),
  ).toContainText('Awaiting parts');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Cancelled the wrong ticket');
  await dialog.getByRole('button', { name: 'Reopen ticket' }).click();
  await expect
    .poll(async () => (await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`)).status.name)
    .toBe('Awaiting parts');
  const after = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(after.reopenCount).toBe(1);
  expect(after.closedAt).toBeNull();
  const ev = await auditEvents(s.owner.ctx, '&group=tickets');
  expect(ev.some((e) => e.action === 'ticket.reopened' && JSON.stringify(e).includes(t.id))).toBe(
    true,
  );

  // Close again, age the close past the 7-day window.
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/cancel`, { reason: 'DUPLICATE' });
  sql(`update tickets set "closedAt" = now() - interval '8 days' where id='${t.id}'`);
  const late = await call(fd.ctx, 'POST', `/api/tickets/${t.id}/reopen`, {
    reason: 'Too late now',
  });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('REOPEN_WINDOW_PASSED');
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: `More actions for ${t.numberLabel}` }).click();
  await expect(page.getByRole('menuitem', { name: 'Reopen…' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'New ticket for this device' })).toBeVisible();
});

test('TD-06 warranty ticket from a Collected ticket: prefilled check-in, links both ways, root link; M2 and non-collected guards', async ({
  page,
}) => {
  const t = await ticket();
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/status`, { statusId: s.statuses['Collected'].id });
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: `More actions for ${t.numberLabel}` }).click();
  await page.getByRole('menuitem', { name: 'Create warranty ticket' }).click();
  await expect(page).toHaveURL(new RegExp(`warrantyOf=${t.id}`));
  await expect(page.getByText(`Warranty for ${t.numberLabel}`).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  await page.screenshot({ path: shot2('td-06-warranty-checkin') });
  await page.getByRole('textbox', { name: 'Find an issue' }).click();
  await page.keyboard.type('scr');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('heading', { level: 1, name: /^T-\d+$/ })).not.toHaveText(
    t.numberLabel,
  );
  const wId = page.url().split('/').pop()!;
  const w = await ok(fd.ctx, 'GET', `/api/tickets/${wId}`);
  expect(JSON.stringify(w)).toContain(t.id);
  await expect(page.getByText(`Warranty for ${t.numberLabel}`).first()).toBeVisible();
  const orig = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(JSON.stringify(orig)).toContain(wId);
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=all`);
  expect((tl.items as Json[]).map((i) => i.type)).toContain('warranty_linked');

  // Warranty of the warranty ticket links to the root original.
  await ok(fd.ctx, 'POST', `/api/tickets/${wId}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  await ok(fd.ctx, 'POST', `/api/tickets/${wId}/status`, { statusId: s.statuses['Collected'].id });
  const w2 = await checkIn(fd.ctx, {
    customerId: t.customer.id,
    deviceId: t.device.id,
    warrantyOfTicketId: wId,
  });
  expect(JSON.stringify(w2.warrantyOf ?? w2)).toContain(t.id);

  // A cancelled ticket can't be a warranty original.
  const c = await ticket();
  await ok(fd.ctx, 'POST', `/api/tickets/${c.id}/cancel`, { reason: 'DUPLICATE' });
  const bad = await call(fd.ctx, 'POST', '/api/tickets', {
    customerId: c.customer.id,
    deviceId: c.device.id,
    issues: [{ code: 'BATTERY' }],
    warrantyOfTicketId: c.id,
  });
  expect(bad.status).toBe(409);
});

test('TD-06b M2: a warranty ticket must be for the same device (and so the same customer)', async () => {
  test.fail(true, 'KNOWN (open item, M2): warranty accepts another device / another customer');
  const t = await ticket();
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/status`, {
    statusId: s.statuses['Ready for pickup'].id,
  });
  await ok(fd.ctx, 'POST', `/api/tickets/${t.id}/status`, { statusId: s.statuses['Collected'].id });
  const other = await ok(s.owner.ctx, 'POST', `/api/customers/${t.customer.id}/devices`, {
    type: 'PHONE',
    brand: 'Google',
    model: 'Pixel 7',
  });
  const sameCustomer = await call(fd.ctx, 'POST', '/api/tickets', {
    customerId: t.customer.id,
    deviceId: other.id,
    issues: [{ code: 'BATTERY' }],
    warrantyOfTicketId: t.id,
  });
  const stranger = await ticket();
  const otherCustomer = await call(fd.ctx, 'POST', '/api/tickets', {
    customerId: stranger.customer.id,
    deviceId: stranger.device.id,
    issues: [{ code: 'BATTERY' }],
    warrantyOfTicketId: t.id,
  });
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `other device: ${sameCustomer.status}; other customer: ${otherCustomer.status}`,
    });
  expect(sameCustomer.status).toBe(409);
  expect(sameCustomer.body.code).toBe('WARRANTY_NOT_ALLOWED');
  expect(otherCustomer.status).toBe(409);
});

test('TD-07 assignment: dialog, Take, timeline; deactivated members are not offered and are refused', async ({
  page,
}) => {
  const t = await ticket();
  await signInContext(page, tech.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('a');
  const dialog = page.getByRole('dialog', { name: `Assign ${t.numberLabel}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Take it myself' }).click();
  await expect
    .poll(async () => (await ok(tech.ctx, 'GET', `/api/tickets/${t.id}`)).assignee?.userId)
    .toBe(tech.userId);
  await expect(page.getByRole('list', { name: 'Ticket activity' })).toContainText(/Ted Tech/);
  const before = await ok(tech.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(before.status.name).toBe('Received'); // assigning doesn't change status
  // Unassign via API, and a deactivated member is refused.
  const gone = await member(s, 'TECHNICIAN', 'Leaving Tech');
  const staff = await ok(s.owner.ctx, 'GET', '/api/staff');
  const row = (staff.items as Json[]).find(
    (m) => m.email === gone.email || m.user?.email === gone.email,
  )!;
  await ok(s.owner.ctx, 'POST', `/api/staff/${row.id}/deactivate`, {});
  const refused = await call(fd.ctx, 'POST', `/api/tickets/${t.id}/assign`, {
    userId: gone.userId,
  });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe('ASSIGNEE_NOT_ACTIVE');
  const assignees = await ok(fd.ctx, 'GET', '/api/assignees');
  expect((assignees.items as Json[]).map((a) => a.name)).not.toContain('Leaving Tech');
  expect((assignees.items as Json[])[0]?.role).toBe('TECHNICIAN');
});

test('TD-08 notes: internal by default, customer-visible tone; author edits within 10 min; not after; not others', async ({
  page,
}) => {
  const t = await ticket();
  await signInContext(page, fd.email);
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('m');
  await expect(page.getByRole('textbox', { name: 'Add a note' })).toBeFocused();
  await page.keyboard.type('Internal: screen supplier is slow.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(toast(page, 'Note added')).toBeVisible();
  await page.getByRole('textbox', { name: 'Add a note' }).fill('Your screen arrives tomorrow.');
  await page
    .getByRole('radiogroup', { name: 'Note visibility' })
    .getByRole('radio', { name: 'Visible to customer' })
    .click();
  await expect(page.getByText(/Customers will see this on their repair status page/)).toBeVisible();
  await page.getByRole('button', { name: 'Add note' }).last().click();
  await expect(page.getByText('Visible to customer').first()).toBeVisible();
  await page.screenshot({ path: shot2('td-08-notes') });
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=notes`);
  const notes = (tl.items as Json[]).map((i) => i.data?.note ?? i);
  const internal = notes.find((n) => JSON.stringify(n).includes('supplier'));
  const visible = notes.find((n) => JSON.stringify(n).includes('arrives tomorrow'));
  expect(JSON.stringify(internal)).toContain('INTERNAL');
  expect(JSON.stringify(visible)).toContain('CUSTOMER');
  const noteId = internal.id as string;
  // Edit own within 10 minutes (UI "Edit note").
  await page
    .getByRole('button', { name: 'Edit note' })
    .or(page.getByRole('link', { name: 'Edit' }))
    .first()
    .click();
  await page.getByRole('textbox', { name: 'Edit note' }).fill('Internal: supplier ships Friday.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Internal: supplier ships Friday.')).toBeVisible();
  await expect(page.getByText(/edited/).first()).toBeVisible();
  // Visibility can't be changed; someone else can't edit; after 10 minutes the author can't either.
  const vis = await call(fd.ctx, 'PATCH', `/api/tickets/${t.id}/notes/${noteId}`, {
    body: 'x',
    visibility: 'CUSTOMER',
  });
  expect(vis.status).toBe(400);
  const other = await call(tech.ctx, 'PATCH', `/api/tickets/${t.id}/notes/${noteId}`, {
    body: 'Hijacked',
  });
  expect([403, 409]).toContain(other.status);
  sql(`update ticket_notes set "createdAt" = now() - interval '11 minutes' where id='${noteId}'`);
  const late = await call(fd.ctx, 'PATCH', `/api/tickets/${t.id}/notes/${noteId}`, {
    body: 'Too late edit',
  });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('NOTE_EDIT_WINDOW_PASSED');
  await page.reload();
  await expect(page.getByText('Internal: supplier ships Friday.')).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('TD-09 version conflict across two browser contexts: second save gets STALE_RECORD with who changed it; input kept', async ({
  browser,
}) => {
  test.fail(
    true,
    "BUG-02: after Reload the dialog keeps B's stale copy of fields B never edited, so the next save silently wipes A's change",
  );
  const t = await ticket();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await signInContext(a, fd.email);
  await signInContext(b, tech.email);
  await a.goto(`/tickets/${t.id}`);
  await b.goto(`/tickets/${t.id}`);
  await a.getByRole('button', { name: 'Edit details' }).first().click();
  await b.getByRole('button', { name: 'Edit details' }).first().click();
  const da = a.getByRole('dialog', { name: `Edit ${t.numberLabel}` });
  const db = b.getByRole('dialog', { name: `Edit ${t.numberLabel}` });
  await da.getByRole('textbox', { name: /Condition notes/ }).fill('Scratch on the back');
  await da.getByRole('button', { name: 'Save changes' }).click();
  await expect(da).toBeHidden();
  await db.getByRole('radio', { name: 'Urgent' }).click();
  await db.getByRole('textbox', { name: /Describe the problem/ }).fill('Also the speaker crackles');
  await db.getByRole('button', { name: 'Save changes' }).click();
  await expect(db.getByText('This ticket was changed by Fran Desk.')).toBeVisible();
  await b.screenshot({ path: shot2('td-09-stale') });
  await db.getByRole('button', { name: 'Reload' }).click();
  await expect(db.getByRole('radio', { name: 'Urgent' })).toBeChecked();
  await expect(db.getByRole('textbox', { name: /Describe the problem/ })).toHaveValue(
    'Also the speaker crackles',
  );
  // "Reload (refetch, form keeps values where unchanged)": a field B never touched must now show A's value.
  const shownCondition = await db.getByRole('textbox', { name: /Condition notes/ }).inputValue();
  test
    .info()
    .annotations.push({
      type: 'observed',
      description: `B's Condition notes after Reload: "${shownCondition}"`,
    });
  await db.getByRole('button', { name: 'Save changes' }).click();
  await expect(db).toBeHidden();
  const after = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}`);
  expect(after).toMatchObject({
    priority: 'URGENT',
    conditionNotes: 'Scratch on the back',
    description: 'Also the speaker crackles',
  });
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=all`);
  expect((tl.items as Json[]).filter((i) => i.type === 'fields_changed').length).toBe(2);
  await ctxA.close();
  await ctxB.close();
});

test('TD-10 concurrent pure status changes both apply in order (no version needed)', async () => {
  const t = await ticket();
  const [r1, r2] = await Promise.all([
    setStatus(fd.ctx, t.id, s.statuses['Diagnosing'].id),
    setStatus(tech.ctx, t.id, s.statuses['In repair'].id),
  ]);
  expect([r1.status, r2.status].every((x) => x === 200)).toBe(true);
  const tl = await ok(fd.ctx, 'GET', `/api/tickets/${t.id}/timeline?filter=status`);
  expect((tl.items as Json[]).filter((i) => i.type === 'status_changed').length).toBe(2);
});
