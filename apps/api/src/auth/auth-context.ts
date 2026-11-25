import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@repairos/contracts';
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
  /** null when the session has no active shop, or the user is no longer a member of it. */
  activeShop: ActiveShopContext | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'repairos:isPublic';
export const ROLES = 'repairos:roles';

/** Opt a route out of the global session requirement. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Require an active shop where the caller has one of these roles (403 otherwise). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

function authOf(ctx: ExecutionContext): AuthContext {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in required');
  return auth;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => authOf(ctx).user);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => authOf(ctx));

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
