import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../common/errors';
import type { AuthContext } from './auth-context';
import { ROLES } from './auth-context';
import { RolesGuard } from './guards';

function ctxWith(auth: AuthContext | undefined, roles?: string[]): ExecutionContext {
  const handler = () => undefined;
  if (roles) Reflect.defineMetadata(ROLES, roles, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
}

const user = { id: 'u', name: 'U', email: 'u@test.dev' };

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows routes without @Roles', () => {
    expect(guard.canActivate(ctxWith({ user, sessionId: 's', activeShop: null }))).toBe(true);
  });

  it('403 without an active shop', () => {
    expect(() => guard.canActivate(ctxWith({ user, sessionId: 's', activeShop: null }, ['OWNER']))).toThrow(ApiException);
  });

  it('403 when the role is not allowed, ok when it is', () => {
    const tech: AuthContext = { user, sessionId: 's', activeShop: { shopId: 'a', role: 'TECHNICIAN' } };
    expect(() => guard.canActivate(ctxWith(tech, ['OWNER', 'MANAGER']))).toThrow(/role/);
    expect(guard.canActivate(ctxWith(tech, ['OWNER', 'TECHNICIAN']))).toBe(true);
  });
});
