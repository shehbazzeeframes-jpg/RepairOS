import { Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_MESSAGES,
  canManageRole,
  type CreateInviteInput,
  type InviteLinkResponse,
  manageableRoles,
  type Role,
  ROLE_LABELS,
  SEAT_LIMIT,
  type StaffListItem,
  type StaffListResponse,
  type StaffStatus,
} from '@repairos/contracts';
import type { Invitation, ScopedTx, Shop } from '@repairos/db';
import { inviteEmail } from '@repairos/email';
import type { Actor } from '../auth/auth-context';
import { isUniqueViolation, lockShop, writeAudit } from '../common/audit';
import { apiError, ApiException, forbidden, notFound } from '../common/errors';
import { formatLocalDateTime } from '../common/time';
import { CONFIG, type AppConfig } from '../config';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  clockInfo,
  compareStaff,
  INVITE_TTL_MS,
  inviteItem,
  isInviteExpired,
  memberItem,
  newInviteToken,
  ROLE_DESCRIPTIONS,
  seatsUsed,
} from './staff.mappers';

/** §2 rate limits. */
export const INVITES_PER_SHOP_PER_DAY = 20;
export const INVITE_SENDS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const roleForbidden = () => forbidden(API_ERROR_MESSAGES.FORBIDDEN);

@Injectable()
export class StaffService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  // ---------- List ----------

  async list(actor: Actor, statuses: StaffStatus[]): Promise<StaffListResponse> {
    const now = new Date();
    return this.db(actor).tx(async (tx) => {
      const [members, invites, clock, used] = await Promise.all([
        tx.membership.findMany({ include: { user: { select: { id: true, name: true, email: true } } } }),
        tx.invitation.findMany({ where: { status: 'PENDING' } }),
        clockInfo(tx),
        seatsUsed(tx, now),
      ]);
      const items = [...members.map((m) => memberItem(m, actor.userId, clock)), ...invites.map((i) => inviteItem(i, now))]
        .filter((i) => statuses.includes(i.status))
        .sort(compareStaff);
      return { items, seats: { used, limit: SEAT_LIMIT } };
    });
  }

  private async memberItemById(tx: ScopedTx, actor: Actor, membershipId: string): Promise<StaffListItem> {
    const m = await tx.membership.findFirst({
      where: { id: membershipId },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!m) throw notFound();
    return memberItem(m, actor.userId, await clockInfo(tx, [m.userId]));
  }

  // ---------- Invites ----------

  /** POST /api/staff/invites */
  async createInvite(actor: Actor, input: CreateInviteInput): Promise<StaffListItem> {
    if (!manageableRoles(actor.role).includes(input.role)) throw roleForbidden();
    const { token, tokenHash } = newInviteToken();
    const now = new Date();
    const db = this.db(actor);

    let created: { invite: Invitation; shop: Shop };
    try {
      created = await db.tx(async (tx) => {
        await lockShop(tx, actor.shopId);
        const shop = await tx.shop.findFirstOrThrow();
        await this.assertNotMember(tx, input.email);
        const pending = await tx.invitation.findFirst({ where: { status: 'PENDING', email: input.email }, select: { id: true } });
        if (pending) throw apiError('INVITE_PENDING', { email: input.email });
        if ((await seatsUsed(tx, now)) >= SEAT_LIMIT) throw apiError('SEAT_LIMIT_REACHED');
        const today = await tx.invitation.count({ where: { createdAt: { gt: new Date(now.getTime() - DAY_MS) } } });
        if (today >= INVITES_PER_SHOP_PER_DAY) {
          throw new ApiException(429, 'RATE_LIMITED', `You can send up to ${INVITES_PER_SHOP_PER_DAY} invites a day. Try again tomorrow.`);
        }
        const invite = await tx.invitation.create({
          data: {
            shopId: actor.shopId,
            email: input.email,
            role: input.role,
            tokenHash,
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
            invitedByUserId: actor.userId,
            lastSentAt: now,
            sendCount: 1,
            emailStatus: 'QUEUED',
          },
        });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'invite.created',
          entityId: invite.id,
          after: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString() },
        });
        return { invite, shop };
      });
    } catch (err) {
      // Two managers inviting the same email at once: the partial unique index decides.
      if (isUniqueViolation(err)) throw apiError('INVITE_PENDING', { email: input.email });
      throw err;
    }

    await this.sendInviteEmail(actor, created.shop, created.invite, token);
    return this.inviteItemById(actor, created.invite.id);
  }

  /** 409 ALREADY_MEMBER for an ACTIVE member (incl. yourself), MEMBER_DEACTIVATED for a deactivated one. */
  private async assertNotMember(tx: ScopedTx, email: string): Promise<void> {
    const user = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, name: true } });
    if (!user) return;
    const m = await tx.membership.findFirst({ where: { userId: user.id }, select: { status: true } });
    if (!m) return;
    if (m.status === 'ACTIVE') throw apiError('ALREADY_MEMBER', { email });
    throw apiError('MEMBER_DEACTIVATED', { name: user.name });
  }

  private async inviteItemById(actor: Actor, id: string): Promise<StaffListItem> {
    const invite = await this.db(actor).client.invitation.findFirst({ where: { id } });
    if (!invite) throw notFound();
    return inviteItem(invite);
  }

  private async sendInviteEmail(actor: Actor, shop: Shop, invite: Invitation, token: string): Promise<void> {
    const rendered = inviteEmail({
      inviterName: actor.name,
      inviterEmail: actor.email,
      shopName: shop.name,
      roleLabel: ROLE_LABELS[invite.role],
      roleDescription: ROLE_DESCRIPTIONS[invite.role],
      url: this.inviteUrl(token),
      expiresText: formatLocalDateTime(invite.expiresAt, shop.timezone, shop.locale),
    });
    await this.email.dispatch(
      { to: invite.email, ...rendered },
      { kind: 'invite', shopId: invite.shopId, invitationId: invite.id, sendCount: invite.sendCount },
    );
  }

  private inviteUrl(token: string): string {
    return `${this.config.appUrl}/invite/${token}`;
  }

  /** Loads a PENDING invite the actor may manage (404 / 403 / 409 INVITE_NOT_PENDING). */
  private async manageableInvite(tx: ScopedTx, actor: Actor, id: string): Promise<Invitation> {
    const invite = await tx.invitation.findFirst({ where: { id } });
    if (!invite) throw notFound();
    if (!canManageRole(actor.role, invite.role)) throw roleForbidden();
    if (invite.status !== 'PENDING') throw apiError('INVITE_NOT_PENDING');
    return invite;
  }

  /**
   * Resend and copy-link share one budget per invite: 1 per minute and 5 per day. The original send does not
   * count, so "Invite, then Copy link for WhatsApp" works straight away. Counted from the audit log (DB-backed,
   * so it holds across API instances).
   */
  private async assertSendRate(tx: ScopedTx, inviteId: string, now: Date): Promise<void> {
    const recent = await tx.auditLog.count({
      where: {
        entityId: inviteId,
        action: { in: ['invite.resent', 'invite.link_copied'] },
        createdAt: { gt: new Date(now.getTime() - 60_000) },
      },
    });
    if (recent > 0) throw new ApiException(429, 'RATE_LIMITED', 'Wait a minute before sending this invite again.');
    const today = await tx.auditLog.count({
      where: { entityId: inviteId, action: { in: ['invite.resent', 'invite.link_copied'] }, createdAt: { gt: new Date(now.getTime() - DAY_MS) } },
    });
    if (today >= INVITE_SENDS_PER_DAY) {
      throw new ApiException(429, 'RATE_LIMITED', 'This invite was sent too many times today. Try again tomorrow.');
    }
  }

  /** Resend (new token + email) or copy link (new token, no email, D10). Both reset the 7-day expiry. */
  private async rotate(actor: Actor, id: string, kind: 'resend' | 'link') {
    const { token, tokenHash } = newInviteToken();
    const now = new Date();
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const invite = await this.manageableInvite(tx, actor, id);
      await this.assertSendRate(tx, id, now);
      // An expired invite holds no seat, so bringing it back must fit in the plan.
      if (isInviteExpired(invite, now) && (await seatsUsed(tx, now)) >= SEAT_LIMIT) throw apiError('SEAT_LIMIT_REACHED');
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      const updated = await tx.invitation.update({
        where: { id },
        data:
          kind === 'resend'
            ? { tokenHash, expiresAt, sendCount: { increment: 1 }, lastSentAt: now, emailStatus: 'QUEUED', linkCopiedAt: null }
            : { tokenHash, expiresAt, linkCopiedAt: now },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: kind === 'resend' ? 'invite.resent' : 'invite.link_copied',
        entityId: id,
        before: { expiresAt: invite.expiresAt.toISOString() },
        after: { email: invite.email, role: invite.role, expiresAt: expiresAt.toISOString() },
      });
      const shop = await tx.shop.findFirstOrThrow();
      return { invite: updated, shop, token };
    });
  }

  /** POST /api/staff/invites/:id/resend */
  async resendInvite(actor: Actor, id: string): Promise<StaffListItem> {
    const { invite, shop, token } = await this.rotate(actor, id, 'resend');
    await this.sendInviteEmail(actor, shop, invite, token);
    return this.inviteItemById(actor, id);
  }

  /** POST /api/staff/invites/:id/link (D10). The URL is returned once and never logged or audited. */
  async copyInviteLink(actor: Actor, id: string): Promise<InviteLinkResponse> {
    const { invite, token } = await this.rotate(actor, id, 'link');
    return { url: this.inviteUrl(token), expiresAt: invite.expiresAt.toISOString() };
  }

  /** POST /api/staff/invites/:id/revoke (also "Remove" for expired invites). */
  async revokeInvite(actor: Actor, id: string): Promise<void> {
    await this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const invite = await this.manageableInvite(tx, actor, id);
      await tx.invitation.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedByUserId: actor.userId } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'invite.revoked',
        entityId: id,
        before: { status: 'PENDING', email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString() },
        after: { status: 'REVOKED' },
      });
    });
  }

  // ---------- Members ----------

  private async loadMember(tx: ScopedTx, membershipId: string) {
    const m = await tx.membership.findFirst({ where: { id: membershipId }, include: { user: { select: { name: true } } } });
    if (!m) throw notFound();
    return m;
  }

  /** Last ACTIVE owner check, under the shop lock. */
  private async assertNotLastOwner(tx: ScopedTx): Promise<void> {
    const owners = await tx.membership.count({ where: { role: 'OWNER', status: 'ACTIVE' } });
    if (owners <= 1) throw apiError('LAST_OWNER');
  }

  /** PATCH /api/staff/:membershipId/role */
  async changeRole(actor: Actor, membershipId: string, role: Role): Promise<StaffListItem> {
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const m = await this.loadMember(tx, membershipId);
      if (m.userId === actor.userId) throw apiError('CANNOT_CHANGE_SELF');
      if (!canManageRole(actor.role, m.role, role)) throw roleForbidden();
      if (m.status !== 'ACTIVE') {
        throw apiError('MEMBER_DEACTIVATED', { name: m.user.name });
      }
      if (m.role !== role) {
        if (m.role === 'OWNER') await this.assertNotLastOwner(tx);
        await tx.membership.update({ where: { id: m.id }, data: { role } });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'member.role_changed',
          entityId: m.id,
          before: { role: m.role },
          after: { role },
        });
      }
      return this.memberItemById(tx, actor, m.id);
    });
  }

  /** POST /api/staff/:membershipId/deactivate: also closes an open time entry (D8). */
  async deactivate(actor: Actor, membershipId: string): Promise<StaffListItem> {
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const m = await this.loadMember(tx, membershipId);
      if (m.userId === actor.userId) throw apiError('CANNOT_CHANGE_SELF', {}, "You can't deactivate yourself.");
      if (!canManageRole(actor.role, m.role)) throw roleForbidden();
      if (m.status === 'DEACTIVATED') return this.memberItemById(tx, actor, m.id);
      if (m.role === 'OWNER') await this.assertNotLastOwner(tx);

      const now = new Date();
      await tx.membership.update({
        where: { id: m.id },
        data: { status: 'DEACTIVATED', deactivatedAt: now, deactivatedByUserId: actor.userId },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'member.deactivated',
        entityId: m.id,
        before: { status: 'ACTIVE' },
        after: { status: 'DEACTIVATED' },
      });

      const open = await tx.timeEntry.findFirst({ where: { userId: m.userId, clockOutAt: null } });
      if (open) {
        await tx.timeEntry.update({ where: { id: open.id }, data: { clockOutAt: now, closedReason: 'DEACTIVATED' } });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'time_entry.auto_closed',
          entityId: open.id,
          before: { userId: m.userId, clockInAt: open.clockInAt.toISOString(), clockOutAt: null, closedReason: null },
          after: { clockOutAt: now.toISOString(), closedReason: 'DEACTIVATED' },
        });
      }
      return this.memberItemById(tx, actor, m.id);
    });
  }

  /** POST /api/staff/:membershipId/reactivate: same role as before, seat limit checked. */
  async reactivate(actor: Actor, membershipId: string): Promise<StaffListItem> {
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const m = await this.loadMember(tx, membershipId);
      if (m.userId === actor.userId) throw apiError('CANNOT_CHANGE_SELF');
      if (!canManageRole(actor.role, m.role)) throw roleForbidden();
      if (m.status === 'ACTIVE') return this.memberItemById(tx, actor, m.id);
      if ((await seatsUsed(tx)) >= SEAT_LIMIT) throw apiError('SEAT_LIMIT_REACHED');
      await tx.membership.update({ where: { id: m.id }, data: { status: 'ACTIVE', deactivatedAt: null, deactivatedByUserId: null } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'member.reactivated',
        entityId: m.id,
        before: { status: 'DEACTIVATED' },
        after: { status: 'ACTIVE' },
      });
      return this.memberItemById(tx, actor, m.id);
    });
  }
}
