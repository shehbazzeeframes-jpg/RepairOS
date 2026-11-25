import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse } from '@repairos/contracts';
import type { AuthContext } from '../auth/auth-context';
import { forbidden } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { toShopDto } from '../shops/shops.service';

@Injectable()
export class MeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getMe(auth: AuthContext): Promise<MeResponse> {
    const userId = auth.user.id;
    const memberships = await this.prisma.forUser(userId, (tx) =>
      tx.membership.findMany({
        where: { userId },
        include: { shop: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    let activeShop: MeResponse['activeShop'] = null;
    if (auth.activeShop) {
      const db = this.prisma.forShop({ shopId: auth.activeShop.shopId, userId });
      const row = await db.client.shop.findFirst();
      activeShop = row ? toShopDto(row) : null;
    }

    return {
      user: auth.user,
      memberships: memberships.map((m) => ({ shopId: m.shopId, shopName: m.shop.name, role: m.role })),
      activeShop,
      role: activeShop ? (auth.activeShop?.role ?? null) : null,
    };
  }

  /** Switches the session's active shop after checking membership (403 when not a member). */
  async setActiveShop(auth: AuthContext, shopId: string): Promise<MeResponse> {
    const membership = await this.prisma.findMembership(auth.user.id, shopId);
    if (!membership) throw forbidden('You are not a member of this shop');
    await this.prisma.base.session.update({ where: { id: auth.sessionId }, data: { activeShopId: shopId } });
    return this.getMe({ ...auth, activeShop: { shopId, role: membership.role } });
  }
}
