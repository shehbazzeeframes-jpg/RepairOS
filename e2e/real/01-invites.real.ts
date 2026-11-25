import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  BASE,
  apiAs,
  auditEvents,
  inviteApi,
  inviteLinkFrom,
  jsonHeaders,
  newOwnerShop,
  shot,
  signInContext,
  signUpApi,
  toast,
  uniqueEmail,
  waitForEmail,
} from './support/stack';

test.describe('Invites (story §2 S2/S3, §3 A1/A2, §8 E1, D7, D10)', () => {
  test('INV-01 owner invites a new person; email in /dev/outbox; sign up with locked email; join with the invited role', async ({
    page,
    browser,
  }) => {
    const owner = await newOwnerShop('US', 'Inviter');
    const invitee = uniqueEmail('newhire');

    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    await expect(page.getByText('1 of 5 users')).toBeVisible();
    await page.getByRole('button', { name: 'Invite staff' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Invite staff' });
    await dialog.getByLabel('Email').fill(`  ${invitee.toUpperCase()} `);
    await dialog.getByRole('combobox', { name: 'Role' }).click();
    // Owner may assign every role.
    await expect(page.getByRole('option')).toHaveText([
      /Owner/,
      /Manager/,
      /Front desk/,
      /Technician/,
    ]);
    await page.getByRole('option', { name: /Technician/ }).click();
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    await expect(toast(page, `Invite sent to ${invitee}`)).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(invitee.replace(/\./g, '\\.')) });
    await expect(row.getByText('Invited')).toBeVisible();
    await expect(page.getByText('2 of 5 users')).toBeVisible();

    // E1: the email (subject, body, link) lands in the outbox and the dev page shows it.
    const mail = await waitForEmail(invitee, /invited you to join/);
    expect(mail.subject).toBe(`${owner.name} invited you to join ${owner.shop.name} on RepairOS`);
    expect(mail.text).toContain(
      `${owner.name} (${owner.email}) has invited you to join ${owner.shop.name} as Technician.`,
    );
    expect(mail.text).toMatch(/This invite expires on .+\./);
    expect(mail.text).toContain("If you weren't expecting this, you can ignore this email.");
    const link = inviteLinkFrom(mail);
    expect(link.startsWith(`${BASE}/invite/`)).toBe(true);
    // E1.4: the worker marks the invite SENT.
    await expect
      .poll(
        async () =>
          (
            (await (await owner.ctx.get('/api/staff')).json()).items as {
              email: string;
              inviteEmailStatus: string;
            }[]
          ).find((i) => i.email === invitee)?.inviteEmailStatus,
      )
      .toBe('SENT');

    // The invitee, in a separate signed-out browser, opens the link from /dev/outbox.
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.goto('/dev/outbox');
    await expect(p2.getByRole('heading', { level: 1, name: 'Dev outbox' })).toBeVisible();
    await p2.getByText(mail.subject).first().click();
    await expect(p2.getByRole('heading', { level: 2, name: mail.subject })).toBeVisible();
    const path = new URL(link).pathname;
    await p2.getByRole('link', { name: path }).click();
    await expect(p2).toHaveURL(new RegExp(`${path}$`));
    await expect(
      p2.getByRole('heading', { level: 1, name: `Join ${owner.shop.name}` }),
    ).toBeVisible();
    await expect(p2.getByText(`${owner.name} invited you to join`)).toBeVisible();
    await p2.getByRole('link', { name: 'Create account' }).click();
    await expect(p2).toHaveURL(/\/sign-up\?invite=/);
    const email = p2.getByLabel('Work email');
    await expect(email).toHaveValue(invitee);
    await expect(email).toHaveAttribute('readonly', '');
    await p2.getByLabel('Your name').fill('Nia Newhire');
    await p2.getByLabel('Password').fill('Password123!');
    await p2.getByRole('button', { name: 'Create account' }).click();
    await expect(p2).toHaveURL(new RegExp(`${path}$`));
    await p2.getByRole('button', { name: `Join ${owner.shop.name}` }).click();
    await expect(p2).toHaveURL(/\/$/);
    await expect(toast(p2, `Welcome to ${owner.shop.name}`)).toBeVisible();
    await p2.screenshot({ path: shot('inv-01-joined') });

    const me = await (await p2.request.get('/api/me')).json();
    expect(me.activeShop.id).toBe(owner.shop.id);
    expect(me.role).toBe('TECHNICIAN');
    // D7: link was never copied, so accepting verifies the email.
    const session = await (await p2.request.get('/api/auth/get-session')).json();
    expect(session.user.emailVerified).toBe(true);
    // Technician sees no Settings.
    await expect(
      p2.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
    ).toHaveCount(0);

    // Owner's list now shows the person as Active.
    await page.reload();
    const memberRow = page.getByRole('row', { name: /Nia Newhire/ });
    await expect(memberRow.getByText('Active')).toBeVisible();
    await expect(memberRow.getByText('Technician')).toBeVisible();
    await ctx.close();

    // E1.3: From = EMAIL_FROM, Reply-To = inviter (read from the outbox file, which stores the envelope).
    const outboxFile = new URL(`../../.outbox/${mail.id}.json`, import.meta.url);
    const stored = JSON.parse(readFileSync(outboxFile, 'utf8')) as {
      from: string;
      replyTo: string | null;
      html: string;
    };
    test.info().annotations.push({
      type: 'envelope',
      description: JSON.stringify({ from: stored.from, replyTo: stored.replyTo }),
    });
    expect(stored.replyTo).toBeNull(); // L4: no Reply-To with the inviter's unverified address
    expect(stored.from).toMatch(/RepairOS/);
    expect(stored.html).toContain('Accept invite');
    // §6 / E1.5: invite.created + invite.accepted audited, and the token never appears in the audit log.
    const events = await auditEvents(owner.ctx);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['invite.created', 'invite.accepted']),
    );
    const token = link.split('/invite/')[1]!;
    for (const e of events) {
      const detail = await (await owner.ctx.get(`/api/audit-events/${e.id}`)).text();
      expect(detail).not.toContain(token);
    }
  });

  test('INV-02 existing account: "I already have an account" prefills sign-in and returns to the invite', async ({
    page,
  }) => {
    const owner = await newOwnerShop('GB', 'Inviter');
    const invitee = uniqueEmail('existing');
    await signUpApi('Ex Isting', invitee);
    expect((await inviteApi(owner.ctx, invitee, 'FRONT_DESK')).status()).toBe(201);
    const link = inviteLinkFrom(await waitForEmail(invitee, /invited you to join/));

    await page.goto(link);
    await page.getByRole('link', { name: 'I already have an account' }).click();
    await expect(page.getByLabel('Email')).toHaveValue(invitee);
    await expect(page.getByText(`Sign in to join ${owner.shop.name}`)).toBeVisible();
    await page.getByLabel('Password').fill('Password123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // A signed-in user with no shop stays on /invite (not onboarding).
    await expect(page).toHaveURL(new RegExp(`${new URL(link).pathname}$`));
    await page.getByRole('button', { name: `Join ${owner.shop.name}` }).click();
    await expect(page).toHaveURL(/\/$/);
    const me = await (await page.request.get('/api/me')).json();
    expect(me.role).toBe('FRONT_DESK');

    // Re-opening the link: "You've already joined".
    await page.goto(link);
    await expect(page.getByText(`You've already joined ${owner.shop.name}.`)).toBeVisible();
    await expect(page.getByRole('button', { name: `Go to ${owner.shop.name}` })).toBeVisible();
  });

  test('INV-03 wrong account is refused (UI + API 403 INVITE_EMAIL_MISMATCH) and the invite stays pending', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Inviter');
    const invitee = uniqueEmail('rightperson');
    const wrong = uniqueEmail('wrongperson');
    await signUpApi('Wrong Person', wrong);
    expect((await inviteApi(owner.ctx, invitee, 'TECHNICIAN')).status()).toBe(201);
    const link = inviteLinkFrom(await waitForEmail(invitee, /invited you to join/));
    const token = link.split('/invite/')[1]!;

    await signInContext(page, wrong);
    await page.goto(link);
    await expect(
      page.getByText(`This invite is for ${invitee}, but you're signed in as ${wrong}.`),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `Join ${owner.shop.name}` })).toHaveCount(0);
    await page.screenshot({ path: shot('inv-03-wrong-account') });

    const res = await page.request.post(`/api/invites/${token}/accept`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('INVITE_EMAIL_MISMATCH');
    const me = await (await page.request.get('/api/me')).json();
    expect(me.activeShop).toBeNull();

    const staff = await (await owner.ctx.get('/api/staff')).json();
    expect(staff.items.find((i: { email: string }) => i.email === invitee).status).toBe('INVITED');

    await page.getByRole('button', { name: 'Sign out and continue' }).click();
    await expect(page).toHaveURL(new RegExp(`/invite/${token}$`));
    await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();
  });

  test('INV-04 copy invite link: clipboard + dialog, emailed link stops working, copied link joins without verifying email (D7/D10)', async ({
    page,
    context,
    browser,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const owner = await newOwnerShop('PK', 'Inviter');
    const invitee = uniqueEmail('whatsapp');
    expect((await inviteApi(owner.ctx, invitee, 'TECHNICIAN')).status()).toBe(201);
    const emailed = inviteLinkFrom(await waitForEmail(invitee, /invited you to join/));

    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await page.getByRole('button', { name: `Actions for ${invitee}` }).click();
    await page.getByRole('menuitem', { name: /Copy invite link/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite link copied' });
    await expect(dialog.getByText('Paste it into WhatsApp', { exact: false })).toBeVisible();
    const copied = await dialog.getByLabel('Invite link').inputValue();
    expect(copied).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]+$`));
    expect(copied).not.toBe(emailed);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
    await page.screenshot({ path: shot('inv-04-copy-link') });

    // Old emailed link is now invalid (token rotated).
    const oldPreview = await page.request.get(`/api/invites/${emailed.split('/invite/')[1]}`);
    expect(oldPreview.status()).toBe(404);

    // Audit event for the copy exists.
    const actions = (await auditEvents(owner.ctx)).map((e) => e.action);
    expect(actions).toContain('invite.link_copied');

    // The copied link works; accepting it does NOT set emailVerified (D7).
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(copied);
    await p2.getByRole('link', { name: 'Create account' }).click();
    await p2.getByLabel('Your name').fill('Wa User');
    await p2.getByLabel('Password').fill('Password123!');
    await p2.getByRole('button', { name: 'Create account' }).click();
    await p2.getByRole('button', { name: `Join ${owner.shop.name}` }).click();
    await expect(p2).toHaveURL(/\/$/);
    const session = await (await p2.request.get('/api/auth/get-session')).json();
    expect(session.user.emailVerified).toBe(false);
    await ctx2.close();
  });

  test('INV-05 resend rotates the token; revoke shows the revoked state and frees the seat', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Inviter');
    const invitee = uniqueEmail('resend');
    expect((await inviteApi(owner.ctx, invitee, 'FRONT_DESK')).status()).toBe(201);
    const first = await waitForEmail(invitee, /invited you to join/);
    const firstLink = inviteLinkFrom(first);

    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await expect(page.getByText('2 of 5 users')).toBeVisible();
    await page.getByRole('button', { name: `Actions for ${invitee}` }).click();
    await page.getByRole('menuitem', { name: /Resend invite/ }).click();
    await expect(toast(page, `Invite sent again to ${invitee}`)).toBeVisible();
    const second = await waitForEmail(invitee, /invited you to join/, first.id);
    const secondLink = inviteLinkFrom(second);
    expect(secondLink).not.toBe(firstLink);
    expect(
      (await page.request.get(`/api/invites/${firstLink.split('/invite/')[1]}`)).status(),
    ).toBe(404);

    // Resend again within a minute is rate limited (429).
    const staff = await (await owner.ctx.get('/api/staff')).json();
    const inv = staff.items.find((i: { email: string }) => i.email === invitee);
    const again = await owner.ctx.post(`/api/staff/invites/${inv.id}/resend`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(again.status()).toBe(429);

    await page.getByRole('button', { name: `Actions for ${invitee}` }).click();
    await page.getByRole('menuitem', { name: /Revoke invite/ }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText('The link in their email will stop working', { exact: false }),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Revoke invite' }).click();
    await expect(
      page.getByRole('row', { name: new RegExp(invitee.replace(/\./g, '\\.')) }),
    ).toHaveCount(0);
    await expect(page.getByText('1 of 5 users')).toBeVisible();

    await page.goto(secondLink);
    await expect(
      page.getByText('This invite is no longer valid. Ask the shop for a new invite.'),
    ).toBeVisible();
    expect((await auditEvents(owner.ctx)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['invite.resent', 'invite.revoked']),
    );
  });

  test('INV-06 unknown / malformed token shows one generic page', async ({ page }) => {
    await page.goto('/invite/not-a-real-token');
    await expect(page.getByText("This invite link isn't valid.")).toBeVisible();
    await page.goto('/invite/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(page.getByText("This invite link isn't valid.")).toBeVisible();
  });

  test('INV-07 duplicate / member / deactivated invite errors from the real API', async ({
    page,
  }) => {
    const ctx = await apiAs('owner@demo.test');
    // Seed shop: active member, deactivated member, pending invite.
    const member = await inviteApi(ctx, 'tech@demo.test', 'TECHNICIAN');
    const deact = await inviteApi(ctx, 'former@demo.test', 'TECHNICIAN');
    const pending = await inviteApi(ctx, 'NEW.HIRE@demo.test', 'TECHNICIAN');
    const self = await inviteApi(ctx, 'owner@demo.test', 'TECHNICIAN');
    const codes = await Promise.all(
      [member, deact, pending, self].map(async (r) => [r.status(), (await r.json()).code]),
    );
    // The seed shop is also at 5/5 seats; record what wins.
    test.info().annotations.push({ type: 'codes', description: JSON.stringify(codes) });
    expect(codes[0]![1]).toBe('ALREADY_MEMBER');
    expect(codes[1]![1]).toBe('MEMBER_DEACTIVATED');
    expect(codes[2]![1]).toBe('INVITE_PENDING');
    expect(codes[3]![1]).toBe('ALREADY_MEMBER');
    await page.close();
  });
});
