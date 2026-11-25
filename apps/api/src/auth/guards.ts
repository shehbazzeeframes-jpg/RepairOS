import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_ERROR_MESSAGES, hasPermission, type Permission, SHOP_ID_HEADER } from '@repairos/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import type { Response } from 'express';
import { ApiException, apiError, forbidden } from '../common/errors';
import { type MembershipRef, PrismaService } from '../prisma/prisma.service';
import { AUTH, type Auth } from './auth';
import {
  type AuthContext,
  type AuthedRequest,
  IS_PUBLIC,
  OPTIONAL_AUTH,
  PERMISSION,
  SHOP_FALLBACK,
  SHOP_SCOPED,
  SIGNED_IN,
} from './auth-context';

export const ACCESS_REMOVED_MESSAGE = 'You no longer have access to this shop';

export interface ResolvedShop {
  activeShop: { shopId: string; role: MembershipRef['role'] } | null;
  /** The session's shop where the user is now DEACTIVATED (null otherwise). */
  accessRemovedShopId: string | null;
  /** New session.activeShopId to persist, when it changes. */
  moveSessionTo: string | null;
}

/**
 * Pure decision for the session's active shop (Risk #1). Only ACTIVE memberships ever count.
 *  - session shop ACTIVE → use it;
 *  - session shop DEACTIVATED → no active shop on this request (so it is rejected) unless `allowFallback`
 *    (GET /api/me), which moves the session to the oldest ACTIVE membership, if any;
 *  - no session shop / no membership there at all → oldest ACTIVE membership (fresh sign-in), if any.
 */
export function resolveActiveShop(
  sessionShopId: string | null,
  memberships: readonly MembershipRef[],
  allowFallback: boolean,
): ResolvedShop {
  const current = sessionShopId ? memberships.find((m) => m.shopId === sessionShopId) : undefined;
  if (current?.status === 'ACTIVE') {
    return { activeShop: { shopId: current.shopId, role: current.role }, accessRemovedShopId: null, moveSessionTo: null };
  }
  const removed = current?.status === 'DEACTIVATED' ? current.shopId : null;
  if (removed && !allowFallback) return { activeShop: null, accessRemovedShopId: removed, moveSessionTo: null };

  const fallback = memberships.find((m) => m.status === 'ACTIVE');
  return {
    activeShop: fallback ? { shopId: fallback.shopId, role: fallback.role } : null,
    accessRemovedShopId: removed,
    moveSessionTo: fallback && fallback.shopId !== sessionShopId ? fallback.shopId : null,
  };
}

/**
 * Global guard: every route needs a valid Better Auth session unless marked @Public().
 * Re-reads the user's memberships on every request, so role changes and deactivations apply to the very next request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets);
    if (isPublic && !optional) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const { headers, response: result } = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    // getSession can refresh the session (sliding expiry) or clear a stale cookie: pass those on.
    const setCookies = headers.getSetCookie();
    if (setCookies.length) ctx.switchToHttp().getResponse<Response>().append('Set-Cookie', setCookies);
    if (!result) {
      if (isPublic) return true;
      throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in required');
    }

    const { user, session } = result;
    const sessionShopId = (session as { activeShopId?: string | null }).activeShopId ?? null;
    const memberships = await this.prisma.membershipsOf(user.id);
    const allowFallback = this.reflector.getAllAndOverride<boolean>(SHOP_FALLBACK, targets) ?? false;
    const resolved = resolveActiveShop(sessionShopId, memberships, allowFallback);
    if (resolved.moveSessionTo) {
      await this.prisma.base.session.update({ where: { id: session.id }, data: { activeShopId: resolved.moveSessionTo } });
    }

    const auth: AuthContext = {
      user: { id: user.id, name: user.name, email: user.email },
      sessionId: session.id,
      activeShop: resolved.activeShop,
      accessRemovedShopId: resolved.accessRemovedShopId,
    };
    req.auth = auth;
    return true;
  }
}

/**
 * A13 / story §8.1: the shop the page was rendered for (`X-Shop-Id`) must be the session's shop. Absent → fine
 * (scripts, tests). Compared with the session's shop even when the user was just deactivated there, so that case
 * still gets the "access removed" 403 rather than a 409.
 */
export function shopHeaderMismatch(header: string | string[] | undefined, auth: AuthContext | undefined): boolean {
  if (header === undefined) return false;
  const value = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
  const sessionShop = auth?.activeShop?.shopId ?? auth?.accessRemovedShopId ?? null;
  return value !== sessionShop;
}

/**
 * Enforces @RequirePermission(...) with the contracts matrix, and fails closed: a non-public route that declares
 * neither a permission nor @SignedIn()/@ShopScoped() is refused. Runs after AuthGuard.
 * Shop-scoped routes (@RequirePermission or @ShopScoped) first get the X-Shop-Id check (409 ACTIVE_SHOP_CHANGED,
 * before the handler, so nothing is written) and echo the session's active shop in `X-Shop-Id`.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    const shopScoped = !!permission || !!this.reflector.getAllAndOverride<boolean>(SHOP_SCOPED, targets);
    const signedIn = this.reflector.getAllAndOverride<boolean>(SIGNED_IN, targets);
    if (!shopScoped) {
      if (signedIn) return true;
      throw forbidden('This route has no access rule');
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.auth;
    if (shopHeaderMismatch(req.headers[SHOP_ID_HEADER.toLowerCase()], auth)) throw apiError('ACTIVE_SHOP_CHANGED');
    if (!auth?.activeShop) {
      throw forbidden(auth?.accessRemovedShopId ? ACCESS_REMOVED_MESSAGE : 'Select an active shop first');
    }
    ctx.switchToHttp().getResponse<Response>().setHeader(SHOP_ID_HEADER, auth.activeShop.shopId);
    if (permission && !hasPermission(auth.activeShop.role, permission)) throw forbidden(API_ERROR_MESSAGES.FORBIDDEN);
    return true;
  }
}
