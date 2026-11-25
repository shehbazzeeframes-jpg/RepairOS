import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { addMemberApi, jsonHeaders, newOwnerShop, uniqueEmail } from './stack';

/** Sprint 2 real-stack helpers (no mocks: everything hits the real API through the web origin). */

/** Screenshot evidence path under docs/qa/sprint2/. */
export function shot2(name: string): string {
  return new URL(`../../../docs/qa/sprint2/${name}.png`, import.meta.url).pathname;
}

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Sends a JSON request and returns status + parsed body (never throws on non-2xx). */
export async function call(
  ctx: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json; headers: Record<string, string> }> {
  const res = await ctx.fetch(path, {
    method,
    data: data === undefined ? undefined : data,
    headers: { ...jsonHeaders, ...headers },
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body, headers: res.headers() };
}

/** Like `call` but expects a status (default 2xx) and returns the body. */
export async function ok(
  ctx: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<Json> {
  const r = await call(ctx, method, path, data, headers);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

export async function axe(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const e of exclude) builder = builder.exclude(e);
  const result = await builder.analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

/** Valid IMEIs (Luhn) built from a prefix. */
export function imei(seed = Date.now()): string {
  let body = ('35' + String(seed).replace(/\D/g, '')).slice(0, 14).padEnd(14, '7');
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

let phoneSeq = Math.floor(Math.random() * 900);
/** A fresh, valid national-format mobile per country (unique within a run). */
export function phone(country: 'US' | 'GB' | 'PK'): string {
  phoneSeq += 1;
  const n = String(phoneSeq).padStart(3, '0');
  const t = String(Date.now() % 10000).padStart(4, '0');
  if (country === 'US') return `(212) 555-${t.slice(0, 1)}${n}`.slice(0, 14);
  if (country === 'GB') return `07400 9${t.slice(0, 2)}${n}`;
  return `0300 ${t}${n}`;
}

export type DefaultStatusName =
  | 'Received'
  | 'Diagnosing'
  | 'Awaiting approval'
  | 'Awaiting parts'
  | 'In repair'
  | 'Ready for pickup'
  | 'Unrepairable'
  | 'Collected'
  | 'Cancelled';

export interface Shop2 {
  owner: { email: string; name: string; ctx: APIRequestContext };
  shop: { id: string; name: string };
  statuses: Record<DefaultStatusName, Json>;
}

export async function statusesByName(
  ctx: APIRequestContext,
): Promise<Record<DefaultStatusName, Json>> {
  const list = await ok(ctx, 'GET', '/api/ticket-statuses');
  return Object.fromEntries((list.items as Json[]).map((s) => [s.name, s])) as Record<
    DefaultStatusName,
    Json
  >;
}

/** Fresh owner + shop (with default statuses). */
export async function freshShop(country: 'US' | 'GB' | 'PK', label = 'S2'): Promise<Shop2> {
  const o = await newOwnerShop(country, label);
  return {
    owner: { email: o.email, name: o.name, ctx: o.ctx },
    shop: o.shop,
    statuses: await statusesByName(o.ctx),
  };
}

/** Adds a member with a role; returns their email, name and API client. */
export async function member(
  s: Shop2,
  role: 'MANAGER' | 'FRONT_DESK' | 'TECHNICIAN',
  name?: string,
) {
  const email = uniqueEmail(role.toLowerCase().replace('_', ''));
  const n =
    name ?? `QA ${role === 'FRONT_DESK' ? 'Desk' : role === 'TECHNICIAN' ? 'Tech' : 'Manager'}`;
  const ctx = await addMemberApi(s.owner.ctx, email, role, n);
  const me = await ok(ctx, 'GET', '/api/me');
  return { email, name: n, ctx, userId: me.user.id as string };
}

/** Creates a customer through the API. */
export async function customer(ctx: APIRequestContext, body: Json): Promise<Json> {
  const r = await call(ctx, 'POST', '/api/customers', body);
  expect(r.status, `create customer: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body;
}

/** Check-in through the API: new customer + new phone device by default. */
export async function checkIn(
  ctx: APIRequestContext,
  body: Json = {},
  idempotencyKey?: string,
): Promise<Json> {
  const data = {
    issues: [{ code: 'SCREEN_CRACKED' }],
    ...(body.customerId
      ? {}
      : {
          newCustomer: {
            kind: 'PERSON',
            firstName: `Cust${Date.now().toString(36)}`,
            email: uniqueEmail('cust'),
            phones: [],
          },
        }),
    ...(body.deviceId ? {} : { newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 13' } }),
    ...body,
  };
  const r = await call(
    ctx,
    'POST',
    '/api/tickets',
    data,
    idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  );
  expect(r.status, `check-in: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

export function uuid(): string {
  return randomUUID();
}

export async function setStatus(
  ctx: APIRequestContext,
  ticketId: string,
  statusId: string,
  note?: Json,
) {
  return call(
    ctx,
    'POST',
    `/api/tickets/${ticketId}/status`,
    note ? { statusId, note } : { statusId },
  );
}
