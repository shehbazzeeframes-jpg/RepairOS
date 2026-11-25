import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  addMemberApi,
  auditEvents,
  jsonHeaders,
  newOwnerShop,
  SEED,
  shot,
  signInContext,
  sql,
  uniqueEmail,
} from './support/stack';

test.describe('Audit log viewer (AU1)', () => {
  test("AUD-01 manager sees the owner's events, filters by group, opens a diff; the log is read-only", async ({
    page,
  }) => {
    await signInContext(page, SEED.manager);
    await page.goto('/settings/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    // Seed: owner's invite and time-entry fix, plus the System auto-close.
    await expect(page.getByRole('cell', { name: 'Demo Owner' }).first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Action' }).click();
    await page.getByRole('option', { name: 'All staff & invites' }).click();
    await expect(page.getByRole('link', { name: 'Exported timesheet' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Deactivated' })).toBeVisible();
    await page.getByRole('link', { name: 'Invited' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Audit event' });
    await expect(drawer.getByRole('row', { name: /Email/ })).toContainText('new.hire@demo.test');
    await expect(drawer.getByRole('row', { name: /Role/ })).toContainText('Front desk');
    // Created event: only an After value.
    await expect(drawer.getByRole('columnheader', { name: 'Before' })).toHaveCount(0);
    await page.screenshot({ path: shot('aud-01-drawer') });
    await page.keyboard.press('Escape');

    // No API to change or delete entries.
    const ev = (await auditEvents(page.request))[0]!;
    for (const method of ['patch', 'delete', 'put'] as const) {
      const r = await page.request[method](`/api/audit-events/${ev.id}`, {
        headers: jsonHeaders,
        data: {},
      });
      expect.soft([404, 405], `${method} audit event`).toContain(r.status());
    }
  });

  test('AUD-02 the API database role cannot UPDATE or DELETE audit_logs', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const env = readFileSync(`${root}.env`, 'utf8');
    const appUrl = /^APP_DATABASE_URL=(.*)$/m.exec(env)![1]!.trim();
    const run = (q: string) => {
      try {
        execFileSync('psql', [appUrl, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', q], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
        return 'ok';
      } catch (e) {
        return String((e as { stderr?: string }).stderr ?? e);
      }
    };
    // Set the RLS shop context the same way the app would not matter: privilege check fails first.
    expect(run('UPDATE audit_logs SET action = action')).toMatch(/permission denied/);
    expect(run('DELETE FROM audit_logs')).toMatch(/permission denied/);
    expect(Number(sql('SELECT count(*) FROM audit_logs'))).toBeGreaterThan(0);
  });
});

test('AUD-03 merely viewing Timesheets must not write "Exported timesheet" audit events', async ({
  page,
}) => {
  const owner = await newOwnerShop('US', 'Viewer');
  await signInContext(page, owner.email);
  await page.goto('/settings/timesheets');
  await expect(page.getByRole('heading', { level: 1, name: 'Timesheets' })).toBeVisible();
  await page.waitForTimeout(2500);
  const actions = (await auditEvents(owner.ctx)).map((e) => e.action);
  test.info().annotations.push({ type: 'audit after viewing', description: actions.join(', ') });
  expect(actions).not.toContain('timesheet.exported');
});

test.describe('Timesheet flags and the long-shift clock warning (C1.4, C2.4)', () => {
  test('FLAG-01 a >14h open entry shows the top-bar warning and "Long shift"/"Still open" flags with Needs review', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Flags');
    const tEmail = uniqueEmail('longshift');
    const tech = await addMemberApi(owner.ctx, tEmail, 'TECHNICIAN', 'Larry Long');
    expect(
      (await tech.post('/api/timeclock/clock-in', { headers: jsonHeaders, data: {} })).status(),
    ).toBeLessThan(300);
    sql(
      `UPDATE time_entries SET "clockInAt" = now() - interval '15 hours' WHERE "shopId" = '${owner.shop.id}' AND "clockOutAt" IS NULL`,
    );

    await signInContext(page, tEmail);
    await page.goto('/');
    await page.getByRole('button', { name: /Clocked in/ }).click();
    await expect(page.getByText(/Still clocked in since .+\./)).toBeVisible();
    await expect(page.getByText('Clock out and ask a manager to fix the time.')).toBeVisible();
    await page.screenshot({ path: shot('flag-01-long-shift-warning') });
    await page.keyboard.press('Escape');

    await signInContext(page, owner.email);
    await page.goto('/settings/timesheets');
    await expect(page.getByRole('switch', { name: /Needs review \(1\)/ })).toBeVisible();
    await expect(page.getByText('Still open').first()).toBeVisible();
    await expect(page.getByText('Long shift').first()).toBeVisible();

    // Range over 93 days is refused by the API.
    const r = await owner.ctx.get('/api/timesheets?from=2026-01-01&to=2026-06-01');
    expect(r.status()).toBe(400);
  });
});
