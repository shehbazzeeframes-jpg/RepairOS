import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  Role,
  SPRINT1_ENFORCED_PERMISSIONS,
  SPRINT2_ENFORCED_PERMISSIONS,
  canEditTimeEntry,
  canManageRole,
  hasPermission,
  manageableRoles,
  permissionsFor,
} from './index';

describe('permission matrix', () => {
  it('has the 36 keys from the story, no duplicates', () => {
    expect(PERMISSIONS).toHaveLength(36);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('matches the reviewed snapshot (any change must be a deliberate diff)', () => {
    expect(ROLE_PERMISSIONS).toMatchSnapshot();
  });

  it('OWNER has every key', () => {
    for (const p of PERMISSIONS) expect(hasPermission('OWNER', p)).toBe(true);
    expect(permissionsFor('OWNER')).toEqual([...PERMISSIONS]);
    expect([...ROLE_PERMISSIONS.OWNER]).toEqual([...PERMISSIONS]);
  });

  it('MANAGER has everything except billing and shop deletion', () => {
    expect(PERMISSIONS.filter((p) => !hasPermission('MANAGER', p))).toEqual(['billing.manage', 'shop.delete']);
  });

  it('only Owner and Manager see or change settings, tax, staff, timesheets and audit', () => {
    const managerial = SPRINT1_ENFORCED_PERMISSIONS.filter((p) => p !== 'timeclock.self');
    for (const p of managerial) {
      expect(hasPermission('FRONT_DESK', p), p).toBe(false);
      expect(hasPermission('TECHNICIAN', p), p).toBe(false);
      expect(hasPermission('MANAGER', p), p).toBe(true);
    }
  });

  it('everyone can clock themselves in', () => {
    for (const r of Role.options) expect(hasPermission(r, 'timeclock.self')).toBe(true);
  });

  it('D3: Front desk sells but cannot discount or refund', () => {
    expect(hasPermission('FRONT_DESK', 'pos.sell')).toBe(true);
    expect(hasPermission('FRONT_DESK', 'register.operate')).toBe(true);
    expect(hasPermission('FRONT_DESK', 'pos.discount')).toBe(false);
    expect(hasPermission('FRONT_DESK', 'pos.refund')).toBe(false);
  });

  it('D3: Technicians cannot sell or create/cancel tickets', () => {
    for (const p of ['pos.sell', 'pos.discount', 'pos.refund', 'register.operate', 'tickets.create', 'tickets.cancel'] as const) {
      expect(hasPermission('TECHNICIAN', p), p).toBe(false);
    }
    expect(hasPermission('TECHNICIAN', 'tickets.edit')).toBe(true);
    expect(hasPermission('TECHNICIAN', 'inventory.use_parts')).toBe(true);
  });

  it('nobody but Owner/Manager sees cost price', () => {
    expect(hasPermission('FRONT_DESK', 'inventory.view_cost')).toBe(false);
    expect(hasPermission('TECHNICIAN', 'inventory.view_cost')).toBe(false);
  });

  it('no role means no permissions', () => {
    expect(hasPermission(null, 'timeclock.self')).toBe(false);
    expect(permissionsFor(null)).toEqual([]);
  });

  it('Sprint 1 enforces the 10 keys marked S1 in the story', () => {
    expect(SPRINT1_ENFORCED_PERMISSIONS).toHaveLength(10);
  });

  it('Sprint 2 enforces the 10 keys of story §0 with the grants in its table (no new keys)', () => {
    expect(SPRINT2_ENFORCED_PERMISSIONS).toHaveLength(10);
    const grants = (r: 'OWNER' | 'MANAGER' | 'FRONT_DESK' | 'TECHNICIAN') =>
      SPRINT2_ENFORCED_PERMISSIONS.filter((p) => hasPermission(r, p));
    expect(grants('OWNER')).toEqual([...SPRINT2_ENFORCED_PERMISSIONS]);
    expect(grants('MANAGER')).toEqual([...SPRINT2_ENFORCED_PERMISSIONS]);
    expect(grants('FRONT_DESK')).toEqual([
      'tickets.view', 'tickets.create', 'tickets.edit', 'tickets.cancel', 'tickets.view_passcode', 'customers.view', 'customers.manage',
    ]);
    expect(grants('TECHNICIAN')).toEqual(['tickets.view', 'tickets.edit', 'tickets.view_passcode', 'customers.view']);
  });
});

describe('manageableRoles', () => {
  it('Owner → all, Manager → FD and T, others → none', () => {
    expect(manageableRoles('OWNER')).toEqual(['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN']);
    expect(manageableRoles('MANAGER')).toEqual(['FRONT_DESK', 'TECHNICIAN']);
    expect(manageableRoles('FRONT_DESK')).toEqual([]);
    expect(manageableRoles('TECHNICIAN')).toEqual([]);
    expect(manageableRoles(null)).toEqual([]);
  });

  it('D3: only an Owner changes a Manager role, in either direction', () => {
    expect(canManageRole('MANAGER', 'MANAGER', 'TECHNICIAN')).toBe(false);
    expect(canManageRole('MANAGER', 'TECHNICIAN', 'MANAGER')).toBe(false);
    expect(canManageRole('MANAGER', 'TECHNICIAN', 'FRONT_DESK')).toBe(true);
    expect(canManageRole('MANAGER', 'OWNER')).toBe(false);
    expect(canManageRole('OWNER', 'MANAGER', 'OWNER')).toBe(true);
    expect(canManageRole('FRONT_DESK', 'TECHNICIAN')).toBe(false);
  });
});

describe('canEditTimeEntry (D5)', () => {
  it('Owner edits anyone, including own entries', () => {
    expect(canEditTimeEntry('OWNER', 'OWNER', true)).toBe(true);
    expect(canEditTimeEntry('OWNER', 'MANAGER', false)).toBe(true);
  });
  it('Manager edits FD, T and other Managers, not own and not an Owner', () => {
    expect(canEditTimeEntry('MANAGER', 'TECHNICIAN', false)).toBe(true);
    expect(canEditTimeEntry('MANAGER', 'MANAGER', false)).toBe(true);
    expect(canEditTimeEntry('MANAGER', 'MANAGER', true)).toBe(false);
    expect(canEditTimeEntry('MANAGER', 'OWNER', false)).toBe(false);
  });
  it('Front desk and Technicians edit nothing', () => {
    expect(canEditTimeEntry('FRONT_DESK', 'TECHNICIAN', false)).toBe(false);
    expect(canEditTimeEntry('TECHNICIAN', 'TECHNICIAN', true)).toBe(false);
  });
});
