import { expect, test } from '@playwright/test';
import {
  addMemberApi,
  apiAs,
  auditEvents,
  inviteApi,
  inviteLinkFrom,
  jsonHeaders,
  newOwnerShop,
  SEED,
  shot,
  signInContext,
  sql,
  toast,
  uniqueEmail,
  waitForEmail,
} from './support/stack';

type StaffItem = {
  id: string;
  email: string;
  role: string;
  status: string;
  kind: string;
  userId: string | null;
};
async function staffItems(ctx: import('@playwright/test').APIRequestContext): Promise<StaffItem[]> {
  return (await (await ctx.get('/api/staff?status=ACTIVE,INVITED,DEACTIVATED')).json()).items;
}

const SEAT_MSG = 'Your plan includes 5 users. Extra users are $5/month; billing arrives later.';

test.describe('Seat limit (S2.6, S3.3, rules)', () => {
  test('SEAT-01 seeded shop at 5/5: Invite disabled with the billing message; API 403 SEAT_LIMIT_REACHED', async ({
    page,
  }) => {
    await signInContext(page, SEED.owner);
    await page.goto('/settings/staff');
    await expect(page.getByText('5 of 5 users')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite staff' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.locator('.astryx-banner-description').getByText(SEAT_MSG)).toBeVisible();
    await page.screenshot({ path: shot('seat-01-limit') });
    const res = await inviteApi(page.request, uniqueEmail('sixth'), 'TECHNICIAN');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('SEAT_LIMIT_REACHED');
    expect(body.message).toBe(SEAT_MSG);
  });

  test('SEAT-02 fresh shop: 4 invites fill 5 seats; 5th refused; revoke frees a seat; expired invites do not count and resend re-checks', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Seats');
    const emails = [1, 2, 3, 4].map((i) => uniqueEmail(`seat${i}`));
    for (const e of emails)
      expect((await inviteApi(owner.ctx, e, 'TECHNICIAN')).status()).toBe(201);
    const fifth = await inviteApi(owner.ctx, uniqueEmail('seat5'), 'TECHNICIAN');
    expect(fifth.status()).toBe(403);
    expect((await fifth.json()).code).toBe('SEAT_LIMIT_REACHED');

    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await expect(page.getByText('5 of 5 users')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite staff' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Age one invite past its expiry: it stops counting.
    sql(
      `UPDATE invitations SET "expiresAt" = now() - interval '1 day' WHERE lower(email) = '${emails[0]}'`,
    );
    await page.reload();
    await expect(page.getByText('4 of 5 users')).toBeVisible();
    const expiredRow = page.getByRole('row', {
      name: new RegExp(emails[0]!.replace(/\./g, '\\.')),
    });
    await expect(expiredRow.getByText(/Expired on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite staff' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Expired invite link shows the expired message.
    const link = inviteLinkFrom(await waitForEmail(emails[0]!, /invited you to join/));
    const p2 = await page.context().browser()!.newPage();
    await p2.goto(link);
    await expect(
      p2.getByText(
        new RegExp(`This invite expired on .+\\. Ask ${owner.name} to send a new one\\.`),
      ),
    ).toBeVisible();
    await p2.close();

    // Fill the freed seat through the UI, then resending the expired invite must re-check seats.
    await page.getByRole('button', { name: 'Invite staff' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Invite staff' });
    await dialog.getByLabel('Email').fill(uniqueEmail('seat5b'));
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('5 of 5 users')).toBeVisible();
    const expired = (await staffItems(owner.ctx)).find((i) => i.email === emails[0])!;
    const resend = await owner.ctx.post(`/api/staff/invites/${expired.id}/resend`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(resend.status()).toBe(403);
    expect((await resend.json()).code).toBe('SEAT_LIMIT_REACHED');

    // Revoke frees a seat.
    const second = (await staffItems(owner.ctx)).find((i) => i.email === emails[1])!;
    expect(
      (
        await owner.ctx.post(`/api/staff/invites/${second.id}/revoke`, {
          headers: jsonHeaders,
          data: {},
        })
      ).status(),
    ).toBeLessThan(300);
    await page.reload();
    await expect(page.getByText('4 of 5 users')).toBeVisible();
  });

  test('SEAT-03 seat race: two invites at once with one seat left, exactly one succeeds', async () => {
    const owner = await newOwnerShop('GB', 'Race');
    for (let i = 0; i < 3; i++)
      expect((await inviteApi(owner.ctx, uniqueEmail(`r${i}`), 'TECHNICIAN')).status()).toBe(201);
    const [a, b] = await Promise.all([
      inviteApi(owner.ctx, uniqueEmail('ra'), 'TECHNICIAN'),
      inviteApi(owner.ctx, uniqueEmail('rb'), 'TECHNICIAN'),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([201, 403]);
  });
});

test.describe('Last owner and self protection (S4.3–4, S5.3–4)', () => {
  test('OWN-01 owner cannot change or deactivate themselves (UI hides, API 403 CANNOT_CHANGE_SELF)', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Solo');
    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await expect(
      page.getByRole('heading', { name: "You're the only one here. Invite your team." }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `Actions for ${owner.name}` })).toHaveCount(0);
    const self = (await staffItems(owner.ctx))[0]!;
    const role = await owner.ctx.patch(`/api/staff/${self.id}/role`, {
      headers: jsonHeaders,
      data: { role: 'MANAGER' },
    });
    expect(role.status()).toBe(403);
    expect((await role.json()).code).toBe('CANNOT_CHANGE_SELF');
    const deact = await owner.ctx.post(`/api/staff/${self.id}/deactivate`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(deact.status()).toBe(403);
    expect((await deact.json()).code).toBe('CANNOT_CHANGE_SELF');
  });

  test('OWN-02 two owners deactivate each other at once: one succeeds, the other is refused (LAST_OWNER or no longer a member)', async ({
    page,
  }) => {
    const a = await newOwnerShop('US', 'OwnerA');
    const bEmail = uniqueEmail('ownerb');
    const b = await addMemberApi(a.ctx, bEmail, 'OWNER', 'Owner B');
    const items = await staffItems(a.ctx);
    const aRow = items.find((i) => i.email === a.email)!;
    const bRow = items.find((i) => i.email === bEmail)!;
    const [r1, r2] = await Promise.all([
      a.ctx.post(`/api/staff/${bRow.id}/deactivate`, { headers: jsonHeaders, data: {} }),
      b.post(`/api/staff/${aRow.id}/deactivate`, { headers: jsonHeaders, data: {} }),
    ]);
    const statuses = [r1.status(), r2.status()];
    test
      .info()
      .annotations.push({
        type: 'race',
        description: JSON.stringify([statuses, await r1.text(), await r2.text()]),
      });
    expect(statuses.filter((s) => s < 300)).toHaveLength(1);
    const after = await sql(
      `SELECT count(*) FROM memberships WHERE "shopId" = '${a.shop.id}' AND role = 'OWNER' AND status = 'ACTIVE'`,
    );
    expect(after).toBe('1');
    await page.close();
  });

  test('OWN-03 LAST_OWNER through the UI: the only other owner deactivated, then the remaining owner is protected', async ({
    page,
  }) => {
    // Owner A promotes a manager to owner via the UI; owner B then deactivates A; B is now last owner.
    const a = await newOwnerShop('US', 'OwnerA');
    const bEmail = uniqueEmail('promoteme');
    const b = await addMemberApi(a.ctx, bEmail, 'MANAGER', 'Pat Promote');
    await signInContext(page, a.email);
    await page.goto('/settings/staff');
    await page.getByRole('button', { name: 'Actions for Pat Promote' }).click();
    await page.getByRole('menuitem', { name: 'Change role…' }).click();
    const dialog = page.getByRole('dialog', { name: "Change Pat Promote's role" });
    await dialog.getByRole('combobox', { name: 'Role' }).click();
    await page.getByRole('option', { name: /Owner/ }).click();
    await dialog.getByRole('button', { name: 'Change role' }).click();
    await expect(toast(page, 'Pat Promote is now Owner')).toBeVisible();

    const items = await staffItems(b);
    const aRow = items.find((i) => i.email === a.email)!;
    expect(
      (
        await b.post(`/api/staff/${aRow.id}/deactivate`, { headers: jsonHeaders, data: {} })
      ).status(),
    ).toBeLessThan(300);
    // B can't demote or deactivate itself; nobody else is an owner.
    const bRow = items.find((i) => i.email === bEmail)!;
    const r = await b.post(`/api/staff/${bRow.id}/deactivate`, { headers: jsonHeaders, data: {} });
    expect(r.status()).toBe(403);
    // Reactivate A keeps A's role (OWNER) — S5.7.
    expect(
      (
        await b.post(`/api/staff/${aRow.id}/reactivate`, { headers: jsonHeaders, data: {} })
      ).status(),
    ).toBeLessThan(300);
    const back = (await staffItems(b)).find((i) => i.email === a.email)!;
    expect(back.status).toBe('ACTIVE');
    expect(back.role).toBe('OWNER');
    const actions = (await auditEvents(b)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['member.role_changed', 'member.deactivated', 'member.reactivated']),
    );
  });
});

test.describe('Manager limits (S2.2, S4.2, rules)', () => {
  test('MGR-01 manager sees FD/T only in the role picker and has no actions on owners, managers or self', async ({
    page,
  }) => {
    await signInContext(page, SEED.manager);
    await page.goto('/settings/staff');
    await expect(page.getByRole('row', { name: /Maria Manager/ }).getByText('You')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for Demo Owner' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for Maria Manager' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions for Frank Desk' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for Tina Tech' })).toBeVisible();
    await page.screenshot({ path: shot('mgr-01-staff') });
  });

  test('MGR-02 manager API calls against owners/managers are 403', async () => {
    const mgr = await apiAs(SEED.manager);
    const items = await staffItems(mgr);
    const ownerRow = items.find((i) => i.email === SEED.owner)!;
    const techRow = items.find((i) => i.email === SEED.tech)!;
    const checks = {
      inviteManager: await inviteApi(mgr, uniqueEmail('m'), 'MANAGER'),
      inviteOwner: await inviteApi(mgr, uniqueEmail('o'), 'OWNER'),
      demoteOwner: await mgr.patch(`/api/staff/${ownerRow.id}/role`, {
        headers: jsonHeaders,
        data: { role: 'TECHNICIAN' },
      }),
      deactivateOwner: await mgr.post(`/api/staff/${ownerRow.id}/deactivate`, {
        headers: jsonHeaders,
        data: {},
      }),
      promoteTechToManager: await mgr.patch(`/api/staff/${techRow.id}/role`, {
        headers: jsonHeaders,
        data: { role: 'MANAGER' },
      }),
    };
    for (const [name, res] of Object.entries(checks)) {
      // inviteX may also be refused by seats (seed shop is full); the role rule must still win with 403 FORBIDDEN.
      const body = await res.json();
      expect.soft(res.status(), name).toBe(403);
      expect.soft(body.code, `${name} code`).toBe('FORBIDDEN');
    }
    expect((await staffItems(mgr)).find((i) => i.email === SEED.tech)!.role).toBe('TECHNICIAN');
  });

  test('MGR-03 manager in a shop with free seats can invite a technician but not a manager', async ({
    page,
  }) => {
    const owner = await newOwnerShop('PK', 'Owner');
    const mEmail = uniqueEmail('mgr');
    await addMemberApi(owner.ctx, mEmail, 'MANAGER', 'Mo Manager');
    await signInContext(page, mEmail);
    await page.goto('/settings/staff');
    await page.getByRole('button', { name: 'Invite staff' }).first().click();
    await page.getByRole('combobox', { name: 'Role' }).click();
    await expect(page.getByRole('option')).toHaveText([/Front desk/, /Technician/]);
    await page.keyboard.press('Escape');
    const res = await inviteApi(page.request, uniqueEmail('mgr2'), 'MANAGER');
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
    expect((await inviteApi(page.request, uniqueEmail('tech'), 'TECHNICIAN')).status()).toBe(201);
  });
});
