import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../common/errors';
import type { MembershipRef } from '../prisma/prisma.service';
import type { AuthContext } from './auth-context';
import { IS_PUBLIC, PERMISSION, SHOP_SCOPED, SIGNED_IN } from './auth-context';
import { PermissionGuard, resolveActiveShop } from './guards';

function ctxWith(
  auth: AuthContext | undefined,
  meta: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  res = { headers: {} as Record<string, string> },
): ExecutionContext {
  const handler = () => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  const response = { setHeader: (k: string, v: string) => (res.headers[k] = v) };
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ auth, headers }), getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const user = { id: 'u', name: 'U', email: 'u@test.dev' };
const base = { user, sessionId: 's', accessRemovedShopId: null };

describe('PermissionGuard', () => {
  const guard = new PermissionGuard(new Reflector());

  it('fails closed on a route with no access rule, allows @Public and @SignedIn', () => {
    expect(() => guard.canActivate(ctxWith({ ...base, activeShop: null }))).toThrow(/no access rule/);
    expect(guard.canActivate(ctxWith(undefined, { [IS_PUBLIC]: true }))).toBe(true);
    expect(guard.canActivate(ctxWith({ ...base, activeShop: null }, { [SIGNED_IN]: true }))).toBe(true);
  });

  it('403 without an active shop, with the access-removed message after deactivation', () => {
    expect(() => guard.canActivate(ctxWith({ ...base, activeShop: null }, { [PERMISSION]: 'timeclock.self' }))).toThrow(
      /Select an active shop/,
    );
    expect(() =>
      guard.canActivate(ctxWith({ ...base, activeShop: null, accessRemovedShopId: 'a' }, { [PERMISSION]: 'timeclock.self' })),
    ).toThrow(/no longer have access/);
  });

  it('checks the role against the contracts matrix', () => {
    const tech: AuthContext = { ...base, activeShop: { shopId: 'a', role: 'TECHNICIAN' } };
    expect(() => guard.canActivate(ctxWith(tech, { [PERMISSION]: 'settings.view' }))).toThrow(ApiException);
    expect(() => guard.canActivate(ctxWith(tech, { [PERMISSION]: 'settings.view' }))).toThrow(/role does not allow/);
    expect(guard.canActivate(ctxWith(tech, { [PERMISSION]: 'timeclock.self' }))).toBe(true);
    const owner: AuthContext = { ...base, activeShop: { shopId: 'a', role: 'OWNER' } };
    expect(guard.canActivate(ctxWith(owner, { [PERMISSION]: 'billing.manage' }))).toBe(true);
  });

  it('A13: X-Shop-Id mismatch → 409 ACTIVE_SHOP_CHANGED on shop-scoped routes; absent or equal → allowed and echoed', () => {
    const owner: AuthContext = { ...base, activeShop: { shopId: 'a', role: 'OWNER' } };
    const res = { headers: {} as Record<string, string> };
    expect(guard.canActivate(ctxWith(owner, { [PERMISSION]: 'tickets.view' }, { 'x-shop-id': 'a' }, res))).toBe(true);
    expect(res.headers['X-Shop-Id']).toBe('a');
    expect(guard.canActivate(ctxWith(owner, { [PERMISSION]: 'tickets.view' }))).toBe(true);
    expect(guard.canActivate(ctxWith(owner, { [SHOP_SCOPED]: true }, { 'x-shop-id': 'a' }))).toBe(true);
    for (const meta of [{ [PERMISSION]: 'tickets.view' }, { [SHOP_SCOPED]: true }]) {
      let caught: unknown;
      try {
        guard.canActivate(ctxWith(owner, meta, { 'x-shop-id': 'b' }));
      } catch (err) {
        caught = err;
      }
      expect((caught as ApiException).getResponse()).toMatchObject({ statusCode: 409, code: 'ACTIVE_SHOP_CHANGED' });
    }
    // The mismatch wins over a missing permission (the role may differ in the other shop).
    const tech: AuthContext = { ...base, activeShop: { shopId: 'a', role: 'TECHNICIAN' } };
    expect(() => guard.canActivate(ctxWith(tech, { [PERMISSION]: 'settings.view' }, { 'x-shop-id': 'b' }))).toThrow(/switched shop/);
    // Signed-in-only routes (/api/me, shop switch) are not shop-scoped.
    expect(guard.canActivate(ctxWith(owner, { [SIGNED_IN]: true }, { 'x-shop-id': 'b' }))).toBe(true);
    // Deactivated in the session shop, header = that shop → the access-removed 403, not a 409.
    expect(() =>
      guard.canActivate(
        ctxWith({ ...base, activeShop: null, accessRemovedShopId: 'a' }, { [PERMISSION]: 'timeclock.self' }, { 'x-shop-id': 'a' }),
      ),
    ).toThrow(/no longer have access/);
  });
});

describe('resolveActiveShop (Risk #1)', () => {
  const m = (shopId: string, status: MembershipRef['status'], role: MembershipRef['role'] = 'OWNER'): MembershipRef => ({
    shopId,
    role,
    status,
    createdAt: new Date(),
    deactivatedAt: status === 'DEACTIVATED' ? new Date() : null,
  });

  it('uses the session shop when ACTIVE', () => {
    expect(resolveActiveShop('b', [m('a', 'ACTIVE'), m('b', 'ACTIVE', 'TECHNICIAN')], false)).toEqual({
      activeShop: { shopId: 'b', role: 'TECHNICIAN' },
      accessRemovedShopId: null,
      moveSessionTo: null,
    });
  });

  it('a deactivated session shop yields no active shop unless fallback is allowed', () => {
    const ms = [m('a', 'DEACTIVATED'), m('b', 'ACTIVE', 'MANAGER')];
    expect(resolveActiveShop('a', ms, false)).toEqual({ activeShop: null, accessRemovedShopId: 'a', moveSessionTo: null });
    expect(resolveActiveShop('a', ms, true)).toEqual({
      activeShop: { shopId: 'b', role: 'MANAGER' },
      accessRemovedShopId: 'a',
      moveSessionTo: 'b',
    });
  });

  it('the oldest-membership fallback skips deactivated memberships', () => {
    expect(resolveActiveShop(null, [m('a', 'DEACTIVATED'), m('b', 'ACTIVE')], false)).toMatchObject({
      activeShop: { shopId: 'b' },
      moveSessionTo: 'b',
    });
    expect(resolveActiveShop(null, [m('a', 'DEACTIVATED')], true)).toEqual({
      activeShop: null,
      accessRemovedShopId: null,
      moveSessionTo: null,
    });
  });
});
