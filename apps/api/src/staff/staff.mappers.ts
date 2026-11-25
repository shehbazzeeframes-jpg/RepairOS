import { createHash, randomBytes } from 'node:crypto';
import { ROLE_ORDER, type Role, type StaffListItem, type StaffStatus } from '@repairos/contracts';
import type { Invitation, Membership, ScopedTx, User } from '@repairos/db';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One-line role descriptions used in invite emails. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: 'Full access to the shop, including settings, staff and billing.',
  MANAGER: 'Runs the shop day to day: settings, staff, timesheets and reports.',
  FRONT_DESK: 'Checks in devices, talks to customers and takes payments.',
  TECHNICIAN: 'Works on repairs, updates tickets and uses parts.',
};

/** 32 random bytes, base64url (43 chars). Only its SHA-256 is stored; the token itself is never logged. */
export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isInviteExpired(inv: Pick<Invitation, 'status' | 'expiresAt'>, now = new Date()): boolean {
  return inv.status === 'PENDING' && inv.expiresAt.getTime() <= now.getTime();
}

type MemberRow = Membership & { user: Pick<User, 'id' | 'name' | 'email'> };

export interface ClockInfo {
  open: Set<string>;
  lastClockIn: Map<string, Date>;
}

export function memberItem(m: MemberRow, selfId: string, clock: ClockInfo): StaffListItem {
  return {
    kind: 'MEMBER',
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    status: m.status === 'ACTIVE' ? 'ACTIVE' : 'DEACTIVATED',
    isSelf: m.userId === selfId,
    clockedIn: clock.open.has(m.userId),
    lastClockInAt: clock.lastClockIn.get(m.userId)?.toISOString() ?? null,
    deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
    inviteExpiresAt: null,
    inviteExpired: false,
    inviteEmailStatus: null,
    inviteLinkCopiedAt: null,
  };
}

export function inviteItem(inv: Invitation, now = new Date()): StaffListItem {
  return {
    kind: 'INVITE',
    id: inv.id,
    userId: null,
    name: null,
    email: inv.email,
    role: inv.role,
    status: 'INVITED',
    isSelf: false,
    clockedIn: false,
    lastClockInAt: null,
    deactivatedAt: null,
    inviteExpiresAt: inv.expiresAt.toISOString(),
    inviteExpired: isInviteExpired(inv, now),
    inviteEmailStatus: inv.emailStatus,
    inviteLinkCopiedAt: inv.linkCopiedAt?.toISOString() ?? null,
  };
}

/** Open entries and latest clock-in per user, for the given users (or the whole shop). */
export async function clockInfo(tx: ScopedTx, userIds?: string[]): Promise<ClockInfo> {
  const where = userIds ? { userId: { in: userIds } } : {};
  const [open, last] = await Promise.all([
    tx.timeEntry.findMany({ where: { ...where, clockOutAt: null }, select: { userId: true } }),
    tx.timeEntry.groupBy({ by: ['userId'], where, _max: { clockInAt: true } }),
  ]);
  const lastClockIn = new Map<string, Date>();
  for (const row of last) if (row._max.clockInAt) lastClockIn.set(row.userId, row._max.clockInAt);
  return { open: new Set(open.map((o) => o.userId)), lastClockIn };
}

/** ACTIVE memberships + PENDING unexpired invites (story §2 Rules). */
export async function seatsUsed(tx: ScopedTx, now = new Date()): Promise<number> {
  const [members, invites] = await Promise.all([
    tx.membership.count({ where: { status: 'ACTIVE' } }),
    tx.invitation.count({ where: { status: 'PENDING', expiresAt: { gt: now } } }),
  ]);
  return members + invites;
}

const STATUS_ORDER: Record<StaffStatus, number> = { ACTIVE: 0, INVITED: 1, DEACTIVATED: 2 };

/** ACTIVE (Owners, Managers, Front desk, Technicians, then name), INVITED (by email), DEACTIVATED (by name). */
export function compareStaff(a: StaffListItem, b: StaffListItem): number {
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (s) return s;
  if (a.status === 'ACTIVE') {
    const r = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    if (r) return r;
  }
  if (a.status === 'INVITED') return a.email.localeCompare(b.email);
  return (a.name ?? '').localeCompare(b.name ?? '') || a.email.localeCompare(b.email);
}
