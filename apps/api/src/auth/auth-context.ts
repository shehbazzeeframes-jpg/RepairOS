import { applyDecorators, createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, Role } from '@repairos/contracts';
import type { Request } from 'express';
import { ApiException, forbidden } from '../common/errors';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface ActiveShopContext {
  shopId: string;
  role: Role;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  /** null when the session has no active shop, or the user is no longer an ACTIVE member of it. */
  activeShop: ActiveShopContext | null;
  /**
   * Set when the session's active shop is one where this user's membership is now DEACTIVATED
   * (Risk #1). GET /api/me turns it into `accessRemoved`.
   */
  accessRemovedShopId: string | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'repairos:isPublic';
export const OPTIONAL_AUTH = 'repairos:optionalAuth';
export const SIGNED_IN = 'repairos:signedIn';
export const PERMISSION = 'repairos:permission';
export const SHOP_FALLBACK = 'repairos:shopFallback';

/** Opt a route out of the global session requirement. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Public route that still reads the session when there is one (`req.auth` may be set). */
export const OptionalAuth = () => applyDecorators(SetMetadata(IS_PUBLIC, true), SetMetadata(OPTIONAL_AUTH, true));

/** Any signed-in user; no active shop or permission needed (e.g. /api/me, POST /api/shops, accepting an invite). */
export const SignedIn = () => SetMetadata(SIGNED_IN, true);

/**
 * Requires an active shop where the caller's role grants `permission` (contracts `hasPermission`).
 * Every non-public route must declare this or `@SignedIn()`: the PermissionGuard fails closed otherwise.
 */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);

/**
 * When the session's active shop has been deactivated for this user, move the session to their oldest ACTIVE
 * membership instead of rejecting. Only GET /api/me uses it (the web app refetches /me after a 403).
 */
export const AllowShopFallback = () => SetMetadata(SHOP_FALLBACK, true);

function authOf(ctx: ExecutionContext): AuthContext {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in required');
  return auth;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => authOf(ctx).user);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => authOf(ctx));

/** For @OptionalAuth routes: the auth context, or null when signed out. */
export const MaybeAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext | null => ctx.switchToHttp().getRequest<AuthedRequest>().auth ?? null,
);

/**
 * The validated active shop. Throws 403 when there is none; use `@ActiveShop({ optional: true })`
 * to receive null instead.
 */
export const ActiveShop = createParamDecorator(
  (opts: { optional?: boolean } | undefined, ctx: ExecutionContext): ActiveShopContext | null => {
    const active = authOf(ctx).activeShop;
    if (!active && !opts?.optional) throw forbidden('Select an active shop first');
    return active;
  },
);

/** Request context for services: the caller, their active shop and role. Throws 403 without an active shop. */
export interface Actor {
  userId: string;
  name: string;
  email: string;
  shopId: string;
  role: Role;
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const auth = authOf(ctx);
  if (!auth.activeShop) throw forbidden('Select an active shop first');
  return { userId: auth.user.id, name: auth.user.name, email: auth.user.email, ...auth.activeShop };
});
