import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

/** Runs SQL against the QA database as the owner role (test setup only, e.g. to age an invite). */
export function sql(query: string): string {
  const root = new URL('../../../', import.meta.url).pathname;
  const env = readFileSync(`${root}.env`, 'utf8');
  const url = /^DATABASE_URL=(.*)$/m.exec(env)?.[1]?.trim();
  if (!url) throw new Error('DATABASE_URL missing');
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', query], {
    encoding: 'utf8',
  }).trim();
}

/** Real-stack helpers. Everything goes through the web origin (Next rewrites /api to the API). */
export const BASE = process.env.REAL_BASE_URL ?? 'http://localhost:3200';
export const PASSWORD = 'Password123!';

export const SEED = {
  owner: 'owner@demo.test',
  manager: 'manager@demo.test',
  frontdesk: 'frontdesk@demo.test',
  tech: 'tech@demo.test',
  former: 'former@demo.test',
  pkOwner: 'owner.pk@demo.test',
  usShopId: 'seed_shop_us_demo',
  usShop: 'Demo Phone Repair',
  pkShop: 'Lahore Mobile Clinic',
} as const;

let counter = 0;
/** A unique, lower-case address for this run. */
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}${counter}@qa.test`;
}

const jsonHeaders = { 'content-type': 'application/json', origin: BASE };

/** A fresh API client (own cookie jar) signed in as `email`. */
export async function apiAs(email: string, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const res = await ctx.post('/api/auth/sign-in/email', {
    data: { email, password },
    headers: jsonHeaders,
  });
  expect(res.status(), `sign in ${email}: ${await res.text()}`).toBe(200);
  return ctx;
}

/** Signs up a new account and returns a signed-in API client. */
export async function signUpApi(
  name: string,
  email: string,
  password = PASSWORD,
): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const res = await ctx.post('/api/auth/sign-up/email', {
    data: { name, email, password },
    headers: jsonHeaders,
  });
  expect(res.status(), `sign up ${email}: ${await res.text()}`).toBe(200);
  return ctx;
}

export async function createShopApi(
  ctx: APIRequestContext,
  name: string,
  country: 'US' | 'GB' | 'PK',
) {
  const res = await ctx.post('/api/shops', { data: { name, country }, headers: jsonHeaders });
  expect(res.status(), `create shop: ${await res.text()}`).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

/** A brand-new owner with a brand-new shop (keeps tests independent of each other and of the seed). */
export async function newOwnerShop(country: 'US' | 'GB' | 'PK', label = 'Owner') {
  const email = uniqueEmail(label.toLowerCase().replace(/\W+/g, ''));
  const name = `${label} ${country}`;
  const ctx = await signUpApi(name, email);
  const shop = await createShopApi(
    ctx,
    `QA ${country} ${Date.now().toString(36)}${counter}`,
    country,
  );
  return { email, name, ctx, shop };
}

export async function inviteApi(ctx: APIRequestContext, email: string, role: string) {
  return ctx.post('/api/staff/invites', { data: { email, role }, headers: jsonHeaders });
}

export interface OutboxItem {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  createdAt: string;
}

/** Newest outbox email to `to` matching `subject` (polls: the worker sends asynchronously). */
export async function waitForEmail(
  to: string,
  subject: RegExp,
  after?: string,
): Promise<OutboxItem> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  let found: OutboxItem | undefined;
  await expect
    .poll(
      async () => {
        const res = await ctx.get('/api/dev/outbox');
        const { items } = (await res.json()) as { items: OutboxItem[] };
        found = items.find(
          (i) =>
            i.to.toLowerCase() === to.toLowerCase() &&
            subject.test(i.subject) &&
            (!after || i.id !== after),
        );
        return !!found;
      },
      { timeout: 20_000, message: `email to ${to} matching ${subject}` },
    )
    .toBe(true);
  await ctx.dispose();
  return found!;
}

export function inviteLinkFrom(item: OutboxItem): string {
  const m = /https?:\/\/[^\s"<>]+\/invite\/[A-Za-z0-9_-]+/.exec(item.text);
  if (!m) throw new Error(`No invite link in email ${item.id}`);
  return m[0];
}

export function resetLinkFrom(item: OutboxItem): string {
  const m = /https?:\/\/[^\s"<>]+\/reset-password[^\s"<>]*/.exec(item.text);
  if (!m) throw new Error(`No reset link in email ${item.id}`);
  return m[0];
}

/** Invites `email` as `role` from `ownerCtx`, then signs the person up and accepts through the API. */
export async function addMemberApi(
  ownerCtx: APIRequestContext,
  email: string,
  role: string,
  name = 'QA Person',
) {
  const res = await inviteApi(ownerCtx, email, role);
  expect(res.status(), `invite ${email}: ${await res.text()}`).toBe(201);
  const link = inviteLinkFrom(await waitForEmail(email, /invited you to join/));
  const token = link.split('/invite/')[1]!;
  const ctx = await signUpApi(name, email);
  const acc = await ctx.post(`/api/invites/${token}/accept`, { headers: jsonHeaders, data: {} });
  expect(acc.status(), `accept: ${await acc.text()}`).toBeLessThan(300);
  return ctx;
}

/** Invites an existing account and accepts with that account's API client. */
export async function inviteExistingApi(
  ownerCtx: APIRequestContext,
  memberCtx: APIRequestContext,
  email: string,
  role: string,
) {
  const res = await inviteApi(ownerCtx, email, role);
  expect(res.status(), `invite ${email}: ${await res.text()}`).toBe(201);
  const token = inviteLinkFrom(await waitForEmail(email, /invited you to join/)).split(
    '/invite/',
  )[1]!;
  const acc = await memberCtx.post(`/api/invites/${token}/accept`, {
    headers: jsonHeaders,
    data: {},
  });
  expect(acc.status(), `accept: ${await acc.text()}`).toBeLessThan(300);
}

/** Signs in through the real sign-in form. */
export async function uiSignIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

/** Signs the page's browser context in via the API (shares the context's cookie jar). Faster than the form. */
export async function signInContext(page: Page, email: string, password = PASSWORD) {
  const res = await page.request.post('/api/auth/sign-in/email', {
    data: { email, password },
    headers: jsonHeaders,
  });
  expect(res.status(), `sign in ${email}`).toBe(200);
}

export function toast(page: Page, text: string | RegExp) {
  return page.getByRole('region', { name: 'Notifications' }).getByText(text);
}

export { jsonHeaders };

/** Screenshot evidence path under docs/qa/sprint1/. */
export function shot(name: string): string {
  return new URL(`../../../docs/qa/sprint1/${name}.png`, import.meta.url).pathname;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Audit events for the active shop over the last few days (API requires from/to). */
export async function auditEvents(
  ctx: APIRequestContext,
  extra = '',
): Promise<{ id: string; action: string; [k: string]: unknown }[]> {
  const now = Date.now();
  const from = isoDate(new Date(now - 3 * 86400_000));
  const to = isoDate(new Date(now + 86400_000));
  const res = await ctx.get(`/api/audit-events?from=${from}&to=${to}&limit=100${extra}`);
  expect(res.status(), `audit list: ${await res.text()}`).toBe(200);
  return (await res.json()).items;
}
