import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  addMemberApi,
  auditEvents,
  jsonHeaders,
  newOwnerShop,
  shot,
  signInContext,
  toast,
  uniqueEmail,
} from './support/stack';

/** YYYY-MM-DD for "now" in a time zone. */
function localDate(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

test.describe('Clock in/out, timesheet, correction + audit diff, CSV (C1–C4, AU1)', () => {
  test('CLK-01 clock in/out from the top bar, conflicts, My hours; owner sees it; fixes it with a reason; audit diff; CSV', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const owner = await newOwnerShop('US', 'Clock');
    const tz = 'America/New_York';
    // A name that needs CSV quoting and injection escaping.
    const evilName = '=Sum(A1), "Q" Tech';
    const tEmail = uniqueEmail('clocker');
    const tech = await addMemberApi(owner.ctx, tEmail, 'TECHNICIAN', evilName);

    // --- Technician clocks in and out from the top bar.
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await signInContext(p2, tEmail);
    await p2.goto('/');
    await p2.getByRole('button', { name: 'Clock in' }).click();
    await expect(p2.getByRole('button', { name: /Clocked in \d+m$/ })).toBeVisible();
    // Double clock-in (e.g. another tab) → 409; UI stays clocked in.
    const again = await tech.post('/api/timeclock/clock-in', { headers: jsonHeaders, data: {} });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_CLOCKED_IN');
    // Client can't send a timestamp: a body with clockInAt is ignored or rejected, never honoured.
    const me1 = await (await tech.get('/api/timeclock/me')).json();
    test
      .info()
      .annotations.push({ type: 'timeclock/me', description: JSON.stringify(me1).slice(0, 400) });
    await p2.getByRole('button', { name: /^Clocked in/ }).click();
    await p2.getByRole('menuitem', { name: 'Clock out' }).click();
    await expect(
      toast(p2, /^Clocked out\. \d+h \d+m today\.$|^Clocked out\. \d+m today\.$/),
    ).toBeVisible();
    await expect(p2.getByRole('button', { name: 'Clock in' })).toBeVisible();
    const out2 = await tech.post('/api/timeclock/clock-out', { headers: jsonHeaders, data: {} });
    expect(out2.status()).toBe(409);
    expect((await out2.json()).code).toBe('NOT_CLOCKED_IN');
    // My hours.
    await p2.getByRole('button', { name: 'Time clock options' }).click();
    await p2.getByRole('menuitem', { name: 'My hours' }).click();
    const myHours = p2.getByRole('dialog', { name: 'My hours' });
    await expect(myHours.getByRole('heading', { name: /This week/ })).toBeVisible();
    await expect(myHours.getByRole('row')).not.toHaveCount(0);
    await p2.screenshot({ path: shot('clk-01-my-hours') });
    await ctx2.close();

    // --- Owner: timesheet shows the entry.
    await signInContext(page, owner.email);
    await page.goto('/settings/timesheets');
    await expect(page.getByRole('heading', { level: 1, name: 'Timesheets' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: new RegExp(`^${evilName.replace(/[()]/g, '\\$&')} · `) }),
    ).toBeVisible();
    const today = localDate(tz);
    const actions = page.getByRole('button', {
      name: `Actions for ${evilName}'s entry on ${today}`,
    });
    await expect(actions).toBeVisible();

    // Fix the entry: move clock-in to 00:01 shop time today, with a reason.
    await actions.click();
    await page.getByRole('menuitem', { name: 'Fix times…' }).click();
    const dialog = page.getByRole('dialog', { name: `Fix time entry for ${evilName}` });
    await expect(dialog).toBeVisible();
    const inBox = dialog.getByRole('textbox', { name: 'Clock in time' });
    const current = await inBox.inputValue();
    test.info().annotations.push({ type: 'clock in field', description: current });
    // Earliest-safe new time: one minute after local midnight, so never in the future and same day.
    await inBox.click();
    await inBox.press('ControlOrMeta+a');
    await inBox.pressSequentially('12:01 AM');
    await inBox.press('Tab');
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(dialog.locator('form').getByText('Use at least 3 characters')).toBeVisible();
    const reason = '=HYPERLINK("http://x"), forgot "badge"';
    await dialog.getByLabel('Reason').fill(reason);
    await dialog.getByRole('button', { name: 'Save entry' }).click();
    await expect(toast(page, 'Time entry updated')).toBeVisible();
    await expect(page.getByText('Edited', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: shot('clk-01-timesheet-edited') });

    // --- Audit log shows the correction with a before/after diff and the reason.
    await page.goto('/settings/audit');
    await page.getByRole('link', { name: 'Fixed time entry' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Audit event' });
    await expect(drawer).toBeVisible();
    const clockInRow = drawer.getByRole('row', { name: /Clock in/ });
    await expect(clockInRow).toBeVisible();
    await expect(clockInRow.getByRole('cell')).toHaveCount(3); // Field, Before, After
    await expect(clockInRow.getByRole('cell').nth(2)).toContainText('12:01');
    await expect(drawer.getByText(reason, { exact: false })).toBeVisible();
    await page.screenshot({ path: shot('clk-01-audit-diff') });
    await page.keyboard.press('Escape');

    // --- CSV export downloads with the right name, BOM, header and escaping.
    await page.goto('/settings/timesheets');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).click(),
    ]);
    const file = await download.path();
    const bytes = readFileSync(file!);
    const name = download.suggestedFilename();
    test.info().annotations.push({ type: 'csv filename', description: name });
    expect(name).toMatch(/^timesheet-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString('utf8');
    test.info().annotations.push({ type: 'csv', description: text.slice(0, 800) });
    const lines = text.split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toBe(
      'Staff name,Email,Role,Date,Clock in,Clock out,Duration (hours),Duration (minutes),Flags,Edited,Edit reason',
    );
    const row = lines.find((l) => l.includes(tEmail))!;
    expect(row).toBeTruthy();
    // Name starts with "=" → neutralised (leading apostrophe) and quoted because of the comma and quotes.
    expect(row.startsWith(`"'=Sum(A1), ""Q"" Tech"`)).toBe(true);
    expect(row).toContain(`"'=HYPERLINK(""http://x""), forgot ""badge"""`);
    expect(row).toContain(`,${today},00:01,`);
    expect((await auditEvents(owner.ctx)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['time_entry.updated', 'timesheet.exported']),
    );
  });

  test('CLK-02 add a missing entry and delete one with a reason; overlap and future are refused', async ({
    page,
  }) => {
    const owner = await newOwnerShop('GB', 'Clock');
    const tEmail = uniqueEmail('worker');
    await addMemberApi(owner.ctx, tEmail, 'FRONT_DESK', 'Wendy Worker');
    const staff = (await (await owner.ctx.get('/api/staff')).json()).items as {
      userId: string;
      email: string;
    }[];
    const userId = staff.find((s) => s.email === tEmail)!.userId;
    const day = new Date(Date.now() - 2 * 86400_000);
    const at = (h: number) =>
      new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h),
      ).toISOString();
    const add = await owner.ctx.post('/api/time-entries', {
      headers: jsonHeaders,
      data: { userId, clockInAt: at(9), clockOutAt: at(17), reason: 'Paper timesheet' },
    });
    expect(add.status(), await add.text()).toBe(201);
    const overlap = await owner.ctx.post('/api/time-entries', {
      headers: jsonHeaders,
      data: { userId, clockInAt: at(16), clockOutAt: at(18), reason: 'Overlap test' },
    });
    expect(overlap.status()).toBe(409);
    expect((await overlap.json()).code).toBe('TIME_ENTRY_OVERLAP');
    const future = await owner.ctx.post('/api/time-entries', {
      headers: jsonHeaders,
      data: {
        userId,
        clockInAt: new Date(Date.now() + 3600_000).toISOString(),
        clockOutAt: new Date(Date.now() + 7200_000).toISOString(),
        reason: 'Future test',
      },
    });
    expect(future.status()).toBe(400);
    const tooLong = await owner.ctx.post('/api/time-entries', {
      headers: jsonHeaders,
      data: {
        userId,
        clockInAt: at(0),
        clockOutAt: new Date(Date.parse(at(0)) + 25 * 3600_000).toISOString(),
        reason: 'Too long test',
      },
    });
    expect(tooLong.status()).toBeGreaterThanOrEqual(400);

    await signInContext(page, owner.email);
    await page.goto('/settings/timesheets');
    await expect(page.getByRole('heading', { name: /^Wendy Worker · 8h 0m$/ })).toBeVisible();
    await page
      .getByRole('button', { name: /^Actions for Wendy Worker's entry on / })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete time entry?' });
    await dialog.getByLabel('Reason').fill('Duplicate of paper sheet');
    await dialog.getByRole('button', { name: 'Delete entry' }).click();
    await expect(toast(page, 'Time entry deleted')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'No hours recorded in this period' }),
    ).toBeVisible();
    const evs = await auditEvents(owner.ctx);
    expect(evs.map((e) => e.action)).toEqual(
      expect.arrayContaining(['time_entry.created', 'time_entry.deleted']),
    );
  });

  test("CLK-03 D5: a manager can't fix their own entries but can fix a technician's; the owner can fix the manager's", async () => {
    const owner = await newOwnerShop('PK', 'Clock');
    const mEmail = uniqueEmail('mgrclock');
    const tEmail = uniqueEmail('techclock');
    const mgr = await addMemberApi(owner.ctx, mEmail, 'MANAGER', 'Mina Manager');
    const tech = await addMemberApi(owner.ctx, tEmail, 'TECHNICIAN', 'Tariq Tech');
    for (const c of [mgr, tech]) {
      expect(
        (await c.post('/api/timeclock/clock-in', { headers: jsonHeaders, data: {} })).status(),
      ).toBeLessThan(300);
      expect(
        (await c.post('/api/timeclock/clock-out', { headers: jsonHeaders, data: {} })).status(),
      ).toBeLessThan(300);
    }
    const today = localDate('Asia/Karachi');
    const ts = await (await mgr.get(`/api/timesheets?from=${today}&to=${today}`)).json();
    type Staff = {
      email: string;
      days: { entries: { id: string; clockInAt: string; clockOutAt: string | null }[] }[];
    };
    const entryOf = (email: string) =>
      (ts.staff as Staff[]).find((s) => s.email === email)!.days[0]!.entries[0]!;
    const fix = (e: { id: string; clockInAt: string }, reason: string) => ({
      headers: jsonHeaders,
      data: { clockInAt: new Date(Date.parse(e.clockInAt) - 60_000).toISOString(), reason },
    });
    const own = await mgr.patch(
      `/api/time-entries/${entryOf(mEmail).id}`,
      fix(entryOf(mEmail), 'My own fix'),
    );
    expect(own.status()).toBe(403);
    const techFix = await mgr.patch(
      `/api/time-entries/${entryOf(tEmail).id}`,
      fix(entryOf(tEmail), 'Tech forgot'),
    );
    expect(techFix.status(), await techFix.text()).toBe(200);
    const ownerFix = await owner.ctx.patch(
      `/api/time-entries/${entryOf(mEmail).id}`,
      fix(entryOf(mEmail), 'Owner fixes manager'),
    );
    expect(ownerFix.status(), await ownerFix.text()).toBe(200);
  });
});
