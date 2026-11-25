import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CountryCode, type Role, Shop } from '@repairos/contracts';
import type { PrismaClient } from '@repairos/db';
import { listOutbox, type OutboxItem } from '@repairos/email';
import { type Agent, agentFor, signUp, TEST_OUTBOX_DIR, uniqueEmail } from './helpers';

export interface Person {
  agent: Agent;
  userId: string;
  email: string;
  name: string;
}

export interface OwnerWithShop extends Person {
  shopId: string;
}

/** Signs up a user and creates a shop through the API; the user is its OWNER and it is their active shop. */
export async function ownerWithShop(
  app: NestExpressApplication,
  opts: { country?: CountryCode; name?: string; shopName?: string; timezone?: string } = {},
): Promise<OwnerWithShop> {
  const agent = agentFor(app);
  const name = opts.name ?? 'Olivia Owner';
  const { email, userId } = await signUp(agent, name, uniqueEmail('owner'));
  const res = await agent
    .post('/api/shops')
    .send({ name: opts.shopName ?? 'Test Shop', country: opts.country ?? 'US', ...(opts.timezone ? { timezone: opts.timezone } : {}) });
  if (res.status !== 201) throw new Error(`create shop failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, userId, email, name, shopId: Shop.parse(res.body).id };
}

export interface Member extends Person {
  membershipId: string;
}

/**
 * Signs up a user and adds an ACTIVE membership directly (table owner, bypassing the invite flow, for speed).
 * Their first request falls back to this shop as the active shop.
 */
export async function addMember(
  app: NestExpressApplication,
  adminDb: PrismaClient,
  shopId: string,
  role: Role,
  name = `${role.toLowerCase()} person`,
): Promise<Member> {
  const agent = agentFor(app);
  const { email, userId } = await signUp(agent, name, uniqueEmail(role.toLowerCase()));
  const m = await adminDb.membership.create({ data: { shopId, userId, role } });
  return { agent, userId, email, name, membershipId: m.id };
}

/** Newest outbox email to `to` (sync email delivery in tests writes straight to TEST_OUTBOX_DIR). */
export async function lastEmailTo(to: string): Promise<OutboxItem | undefined> {
  return (await listOutbox(TEST_OUTBOX_DIR, 1000)).find((i) => i.to === to);
}

export async function emailsTo(to: string): Promise<OutboxItem[]> {
  return (await listOutbox(TEST_OUTBOX_DIR, 1000)).filter((i) => i.to === to);
}

export const INVITE_LINK = /http:\/\/localhost:3000\/invite\/([A-Za-z0-9_-]{43})/;

/** Token from the newest invite email to `to`. */
export async function inviteTokenFor(to: string): Promise<string> {
  const mail = await lastEmailTo(to);
  const token = mail?.text.match(INVITE_LINK)?.[1];
  if (!token) throw new Error(`no invite email for ${to}`);
  return token;
}

/** Audit events of a shop (table owner read). */
export function auditOf(adminDb: PrismaClient, shopId: string, action?: string) {
  return adminDb.auditLog.findMany({ where: { shopId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } });
}

/** Moves an invite's resend/link-copy audit history out of the 1/min window. */
export async function ageInviteSends(adminDb: PrismaClient, inviteId: string, minutes = 2): Promise<void> {
  await adminDb.$executeRaw`UPDATE audit_logs SET "createdAt" = "createdAt" - make_interval(mins => ${minutes}) WHERE "entityId" = ${inviteId}`;
}
