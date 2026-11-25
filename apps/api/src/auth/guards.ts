import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@repairos/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiException, forbidden } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AUTH, type Auth } from './auth';
import { type AuthedRequest, IS_PUBLIC, ROLES } from './auth-context';

/**
 * Global guard: every route needs a valid Better Auth session unless marked @Public().
 * Loads the session's active shop and re-validates the membership on every request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!result) throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in required');

    const { user, session } = result;
    const activeShopId = session.activeShopId ?? null;
    let membership = activeShopId ? await this.prisma.findMembership(user.id, activeShopId) : null;

    // A fresh sign-in (or a revoked active shop) falls back to the user's oldest membership,
    // so existing members are not sent to onboarding. Users with no shop keep activeShop = null.
    if (!membership) {
      membership = await this.prisma.forUser(user.id, (tx) =>
        tx.membership.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'asc' },
          select: { shopId: true, role: true },
        }),
      );
      if (membership && membership.shopId !== activeShopId) {
        await this.prisma.base.session.update({ where: { id: session.id }, data: { activeShopId: membership.shopId } });
      }
    }

    req.auth = {
      user: { id: user.id, name: user.name, email: user.email },
      sessionId: session.id,
      activeShop: membership ? { shopId: membership.shopId, role: membership.role } : null,
    };
    return true;
  }
}

/** Enforces @Roles(...): needs an active shop and one of the listed roles. Runs after AuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const active = ctx.switchToHttp().getRequest<AuthedRequest>().auth?.activeShop;
    if (!active) throw forbidden('Select an active shop first');
    if (!roles.includes(active.role)) throw forbidden('Your role does not allow this action');
    return true;
  }
}
