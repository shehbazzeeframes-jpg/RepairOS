/**
 * P1: the role × permission matrix is enforced by @RequirePermission on every route, routes fail closed,
 * and GET /api/me reports permissions. Denials are checked for every Sprint 1 route and role.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { hasPermission, MeResponse, type Permission, permissionsFor, type Role } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLLERS } from '../src/app.module';
import { IS_PUBLIC, PERMISSION, SHOP_SCOPED, SIGNED_IN } from '../src/auth/auth-context';
import { addMember, type Member, ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('route access declarations', () => {
  it('every route declares @Public(), @SignedIn() or @RequirePermission()', () => {
    const undeclared: string[] = [];
    let routes = 0;
    for (const controller of CONTROLLERS) {
      const proto = controller.prototype as unknown as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = proto[key];
        if (key === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        routes++;
        const declared =
          Reflect.getMetadata(IS_PUBLIC, handler) ||
          Reflect.getMetadata(SIGNED_IN, handler) ||
          Reflect.getMetadata(PERMISSION, handler) ||
          Reflect.getMetadata(SHOP_SCOPED, handler);
        if (!declared) undeclared.push(`${controller.name}.${key} (${String(Reflect.getMetadata(PATH_METADATA, handler))})`);
      }
    }
    expect(routes).toBeGreaterThan(30);
    expect(undeclared).toEqual([]);
  });
});

/** [method, path, required permission, body] for every permission-protected Sprint 1 route. */
const ROUTES: [string, string, Permission, unknown?][] = [
  ['get', '/api/shop', 'settings.view'],
  ['patch', '/api/shop', 'settings.manage', { name: 'Renamed' }],
  ['patch', '/api/shop/tax-settings', 'tax.manage', { pricesIncludeTax: true }],
  ['put', '/api/shop/hours', 'settings.manage', { days: [] }],
  ['get', '/api/shop/tax-rates', 'settings.view'],
  ['post', '/api/shop/tax-rates', 'tax.manage', { name: 'X', rateMilliPct: 1, appliesTo: 'all' }],
  ['patch', '/api/shop/tax-rates/x', 'tax.manage', { name: 'Y' }],
  ['post', '/api/shop/tax-rates/x/archive', 'tax.manage'],
  ['post', '/api/shop/tax-rates/x/restore', 'tax.manage'],
  ['get', '/api/staff', 'staff.view'],
  ['post', '/api/staff/invites', 'staff.manage', { email: 'nobody@test.repairos.dev', role: 'TECHNICIAN' }],
  ['post', '/api/staff/invites/x/resend', 'staff.manage'],
  ['post', '/api/staff/invites/x/revoke', 'staff.manage'],
  ['post', '/api/staff/invites/x/link', 'staff.manage'],
  ['patch', '/api/staff/x/role', 'staff.manage', { role: 'TECHNICIAN' }],
  ['post', '/api/staff/x/deactivate', 'staff.manage'],
  ['post', '/api/staff/x/reactivate', 'staff.manage'],
  ['get', '/api/timeclock/me', 'timeclock.self'],
  ['get', '/api/timesheets?from=2026-11-01&to=2026-11-07', 'timesheet.view'],
  ['get', '/api/timesheets/export.csv?from=2026-11-01&to=2026-11-07', 'timesheet.export'],
  ['post', '/api/time-entries', 'timesheet.edit', { userId: 'x', clockInAt: '2026-11-01T09:00:00Z', clockOutAt: '2026-11-01T10:00:00Z', reason: 'fix' }],
  ['patch', '/api/time-entries/x', 'timesheet.edit', { clockInAt: '2026-11-01T09:00:00Z', reason: 'fix' }],
  ['delete', '/api/time-entries/x', 'timesheet.edit', { reason: 'fix' }],
  ['get', '/api/audit-events?from=2026-11-01&to=2026-11-07', 'audit.view'],
  ['get', '/api/audit-events/x', 'audit.view'],
];

describe('permission denials per role', () => {
  let owner: OwnerWithShop;
  const people = {} as Record<Exclude<Role, 'OWNER'>, Member>;

  beforeAll(async () => {
    owner = await ownerWithShop(app);
    for (const role of ['MANAGER', 'FRONT_DESK', 'TECHNICIAN'] as const) people[role] = await addMember(app, adminDb, owner.shopId, role);
  });

  for (const role of ['MANAGER', 'FRONT_DESK', 'TECHNICIAN'] as const) {
    it(`${role}: 403 FORBIDDEN exactly on routes its role lacks`, async () => {
      for (const [method, path, permission, body] of ROUTES) {
        const agent = people[role].agent;
        const req = (agent as unknown as Record<string, (p: string) => { send: (b: unknown) => Promise<{ status: number; body: { code?: string; message?: string } }> }>)[method]!(path);
        const res = await req.send(body ?? {});
        if (hasPermission(role, permission)) {
          expect(res.status, `${role} ${method} ${path}`).not.toBe(403);
        } else {
          expect(res.status, `${role} ${method} ${path}`).toBe(403);
          expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: 'Your role does not allow this action' });
        }
      }
    });
  }

  it('GET /api/me returns the permission list for the active shop', async () => {
    for (const role of ['MANAGER', 'FRONT_DESK', 'TECHNICIAN'] as const) {
      const me = MeResponse.parse((await people[role].agent.get('/api/me').expect(200)).body);
      expect(me.role).toBe(role);
      expect(me.permissions).toEqual(permissionsFor(role));
      expect(me.memberships).toEqual([{ shopId: owner.shopId, shopName: expect.any(String), role, status: 'ACTIVE' }]);
      expect(me.accessRemoved).toBeNull();
    }
    const me = MeResponse.parse((await owner.agent.get('/api/me').expect(200)).body);
    expect(me.permissions).toEqual(permissionsFor('OWNER'));
  });

  it('a role change applies on the very next request', async () => {
    const tech = people.TECHNICIAN;
    expect((await tech.agent.get('/api/staff')).status).toBe(403);
    await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'MANAGER' }).expect(200);
    expect((await tech.agent.get('/api/staff')).status).toBe(200);
    await owner.agent.patch(`/api/staff/${tech.membershipId}/role`).send({ role: 'TECHNICIAN' }).expect(200);
    expect((await tech.agent.get('/api/staff')).status).toBe(403);
  });

  it('a signed-in user with no shop gets 403 on shop routes, 401 when signed out', async () => {
    const { agentFor, signUp } = await import('./helpers');
    const fresh = agentFor(app);
    await signUp(fresh);
    const res = await fresh.get('/api/timeclock/me');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/active shop/);
    const anon = agentFor(app);
    expect((await anon.get('/api/staff')).status).toBe(401);
  });
});
