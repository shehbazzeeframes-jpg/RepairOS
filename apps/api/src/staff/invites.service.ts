import { Inject, Injectable } from '@nestjs/common';
import { type AcceptInviteResponse, InviteToken, type InvitePreview } from '@repairos/contracts';
import type { AuthContext } from '../auth/auth-context';
import { lockShop, writeAudit } from '../common/audit';
import { apiError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { hashInviteToken, isInviteExpired } from './staff.mappers';

const invalid = () => apiError('INVITE_INVALID');

/** Public invite flow (story §3, D7). Tokens are only ever compared by SHA-256 hash. */
@Injectable()
export class InvitesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Token → (invitationId, shopId) through the SECURITY DEFINER lookup (RLS hides invitations without a shop
   * context). Malformed and unknown tokens are both 404 INVITE_INVALID.
   */
  private async locate(token: string): Promise<{ id: string; shopId: string }> {
    if (!InviteToken.safeParse(token).success) throw invalid();
    const rows = await this.prisma.base.$queryRaw<{ id: string; shopId: string }[]>`
      SELECT "id", "shopId" FROM app_invitation_by_token_hash(${hashInviteToken(token)})`;
    const row = rows[0];
    if (!row) throw invalid();
    return row;
  }

  /** GET /api/invites/:token */
  async preview(token: string, auth: AuthContext | null): Promise<InvitePreview> {
    const { id, shopId } = await this.locate(token);
    return this.prisma.forShop({ shopId }).tx(async (tx) => {
      const invite = await tx.invitation.findFirst({ where: { id } });
      if (!invite) throw invalid();
      const shop = await tx.shop.findFirstOrThrow({ select: { id: true, name: true } });
      if (invite.status === 'REVOKED') return { state: 'REVOKED' };
      if (invite.status === 'ACCEPTED') {
        if (auth && invite.acceptedByUserId === auth.user.id) return { state: 'ACCEPTED', shopId: shop.id, shopName: shop.name };
        throw invalid();
      }
      const inviter = invite.invitedByUserId
        ? await tx.user.findFirst({ where: { id: invite.invitedByUserId }, select: { name: true } })
        : null;
      return {
        state: isInviteExpired(invite) ? 'EXPIRED' : 'VALID',
        shopName: shop.name,
        inviterName: inviter?.name ?? shop.name,
        role: invite.role,
        email: invite.email,
        expiresAt: invite.expiresAt.toISOString(),
      };
    });
  }

  /**
   * POST /api/invites/:token/accept. One transaction, under the shop lock (so a double click or two tabs are
   * idempotent): invite → ACCEPTED, ACTIVE membership with the invite's role. L6: a DEACTIVATED membership is never
   * reactivated by an invite (only an Owner/Manager's Reactivate does that, with its seat check and audit):
   * 409 MEMBER_DEACTIVATED and the invite stays pending.
   * emailVerified = true unless the link was copied (D7), session's active shop = this shop, `invite.accepted`.
   * Never fails on seats (the invite already held one).
   */
  async accept(token: string, auth: AuthContext): Promise<AcceptInviteResponse> {
    const { id, shopId } = await this.locate(token);
    const userId = auth.user.id;
    const userEmail = auth.user.email.trim().toLowerCase();

    return this.prisma.forShop({ shopId, userId }).tx(async (tx) => {
      await lockShop(tx, shopId);
      const invite = await tx.invitation.findFirst({ where: { id } });
      if (!invite) throw invalid();
      const shop = await tx.shop.findFirstOrThrow({ select: { id: true, name: true } });
      const switchSession = () =>
        tx.$executeRaw`UPDATE "sessions" SET "activeShopId" = ${shopId}, "updatedAt" = now() WHERE "id" = ${auth.sessionId}`;

      if (invite.status === 'REVOKED') throw apiError('INVITE_REVOKED');
      if (invite.status === 'ACCEPTED') {
        if (invite.acceptedByUserId !== userId) throw invalid();
        const m = await tx.membership.findFirst({ where: { userId }, select: { role: true, status: true } });
        if (!m || m.status !== 'ACTIVE') throw invalid();
        await switchSession();
        return { shopId, shopName: shop.name, role: m.role, alreadyMember: true };
      }
      if (isInviteExpired(invite)) throw apiError('INVITE_EXPIRED');
      if (invite.email.trim().toLowerCase() !== userEmail) {
        throw apiError('INVITE_EMAIL_MISMATCH', { inviteEmail: invite.email, email: auth.user.email });
      }

      const existing = await tx.membership.findFirst({ where: { userId } });
      let membershipId: string;
      let role = invite.role;
      let alreadyMember = false;
      if (existing?.status === 'ACTIVE') {
        membershipId = existing.id;
        role = existing.role;
        alreadyMember = true;
      } else if (existing) {
        throw apiError(
          'MEMBER_DEACTIVATED',
          undefined,
          `Your access to ${shop.name} was turned off. Ask an owner or manager to reactivate you.`,
        );
      } else {
        membershipId = (await tx.membership.create({ data: { shopId, userId, role: invite.role }, select: { id: true } })).id;
      }

      const emailVerified = invite.linkCopiedAt === null;
      if (emailVerified) {
        await tx.$executeRaw`UPDATE "users" SET "emailVerified" = true, "updatedAt" = now() WHERE "id" = ${userId}`;
      }
      await tx.invitation.update({ where: { id }, data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: userId } });
      await writeAudit(tx, {
        shopId,
        actorUserId: userId,
        action: 'invite.accepted',
        entityId: id,
        before: { status: 'PENDING' },
        after: { status: 'ACCEPTED', membershipId, role, email: invite.email, emailVerified },
      });
      await switchSession();
      return { shopId, shopName: shop.name, role, alreadyMember };
    });
  }
}
