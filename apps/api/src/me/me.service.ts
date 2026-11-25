import { Inject, Injectable } from '@nestjs/common';
import { type MeResponse, permissionsFor } from '@repairos/contracts';
import type { AuthContext } from '../auth/auth-context';
import { forbidden } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { toShopDto } from '../shops/shops.service';

@Injectable()
export class MeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getMe(auth: AuthContext): Promise<MeResponse> {
    const userId = auth.user.id;
    // ACTIVE memberships only (Risk #1); the RLS shop read policy also requires ACTIVE.
    const memberships = await this.prisma.forUser(userId, (tx) =>
      tx.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { shop: { select: { name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

    let activeShop: MeResponse['activeShop'] = null;
    if (auth.activeShop) {
      const row = await this.prisma.forShop({ shopId: auth.activeShop.shopId, userId }).client.shop.findFirst();
      activeShop = row ? toShopDto(row) : null;
    }
    const role = activeShop ? (auth.activeShop?.role ?? null) : null;

    return {
      user: auth.user,
      memberships: memberships.map((m) => ({ shopId: m.shopId, shopName: m.shop.name, role: m.role, status: m.status })),
      activeShop,
      role,
      permissions: permissionsFor(role),
      accessRemoved: await this.accessRemoved(auth, activeShop !== null),
    };
  }

  /**
   * Non-null when the session's shop was one where the user is now DEACTIVATED, or when the user has no ACTIVE
   * membership but at least one DEACTIVATED one (the most recently deactivated shop).
   */
  private async accessRemoved(auth: AuthContext, hasActiveShop: boolean): Promise<MeResponse['accessRemoved']> {
    let shopId = auth.accessRemovedShopId;
    if (!shopId && !hasActiveShop) {
      const all = await this.prisma.membershipsOf(auth.user.id);
      const deactivated = all
        .filter((m) => m.status === 'DEACTIVATED')
        .sort((a, b) => (b.deactivatedAt?.getTime() ?? 0) - (a.deactivatedAt?.getTime() ?? 0));
      if (all.every((m) => m.status !== 'ACTIVE')) shopId = deactivated[0]?.shopId ?? null;
    }
    if (!shopId) return null;
    // The user may no longer read that shop through RLS (membership not ACTIVE): read only its name, scoped to it.
    const shop = await this.prisma.forShop({ shopId }).client.shop.findFirst({ select: { name: true } });
    return shop ? { shopId, shopName: shop.name } : null;
  }

  /** Switches the session's active shop. 403 unless the user is an ACTIVE member there (deactivated → 403). */
  async setActiveShop(auth: AuthContext, shopId: string): Promise<MeResponse> {
    const membership = await this.prisma.findActiveMembership(auth.user.id, shopId);
    if (!membership) throw forbidden('You are not a member of this shop');
    await this.prisma.base.session.update({ where: { id: auth.sessionId }, data: { activeShopId: shopId } });
    return this.getMe({ ...auth, activeShop: { shopId, role: membership.role }, accessRemovedShopId: null });
  }
}
