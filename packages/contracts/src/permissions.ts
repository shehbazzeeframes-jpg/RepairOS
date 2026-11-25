import { z } from 'zod';
import { Role } from './roles';

/**
 * Fixed role × permission matrix (Sprint 1 story §1, tech-lead decision D3).
 * The API guard (`@RequirePermission`) and the web UI both read this; nothing else decides access.
 * Not editable per shop in the MVP.
 */
export const PERMISSIONS = [
  'settings.view',
  'settings.manage',
  'tax.manage',
  'staff.view',
  'staff.manage',
  'timeclock.self',
  'timesheet.view',
  'timesheet.edit',
  'timesheet.export',
  'audit.view',
  'billing.manage',
  'shop.delete',
  'statuses.manage',
  'tickets.view',
  'tickets.create',
  'tickets.edit',
  'tickets.cancel',
  'tickets.view_passcode',
  'customers.view',
  'customers.manage',
  'customers.export_delete',
  'pricelist.manage',
  'notifications.manage',
  'inventory.view',
  'inventory.view_cost',
  'inventory.manage',
  'inventory.adjust',
  'inventory.use_parts',
  'purchasing.manage',
  'pos.sell',
  'pos.discount',
  'pos.refund',
  'register.operate',
  'reports.view',
  'reports.export',
  'data.import',
] as const;

export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

/** Keys whose routes/screens are enforced in Sprint 1. Later keys exist so the UI/API can be written against them. */
export const SPRINT1_ENFORCED_PERMISSIONS = [
  'settings.view',
  'settings.manage',
  'tax.manage',
  'staff.view',
  'staff.manage',
  'timeclock.self',
  'timesheet.view',
  'timesheet.edit',
  'timesheet.export',
  'audit.view',
] as const satisfies readonly Permission[];

const MANAGER: readonly Permission[] = PERMISSIONS.filter((p) => p !== 'billing.manage' && p !== 'shop.delete');

const FRONT_DESK: readonly Permission[] = [
  'timeclock.self',
  'tickets.view',
  'tickets.create',
  'tickets.edit',
  'tickets.cancel',
  'tickets.view_passcode',
  'customers.view',
  'customers.manage',
  'inventory.view',
  'inventory.use_parts',
  'pos.sell',
  'register.operate',
];

const TECHNICIAN: readonly Permission[] = [
  'timeclock.self',
  'tickets.view',
  'tickets.edit',
  'tickets.view_passcode',
  'customers.view',
  'inventory.view',
  'inventory.use_parts',
];

/** OWNER always has every key, including keys added later. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: PERMISSIONS,
  MANAGER,
  FRONT_DESK,
  TECHNICIAN,
};

/** True when `role` grants `permission`. OWNER is treated as "all". A null role (no active shop) has nothing. */
export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  if (role === 'OWNER') return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Alias used in the story text. */
export const can = hasPermission;

/** Permission list for `GET /api/me` (in `PERMISSIONS` order). */
export function permissionsFor(role: Role | null | undefined): Permission[] {
  return role ? PERMISSIONS.filter((p) => hasPermission(role, p)) : [];
}

/**
 * Roles an actor may invite, assign, change from/to, deactivate or reactivate (still requires `staff.manage`).
 * OWNER → all four; MANAGER → FRONT_DESK and TECHNICIAN; others → none.
 * A role change needs BOTH the target's current role and the new role to be in this list.
 * Self-changes are never allowed regardless (`CANNOT_CHANGE_SELF`).
 */
export function manageableRoles(actorRole: Role | null | undefined): Role[] {
  switch (actorRole) {
    case 'OWNER':
      return ['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN'];
    case 'MANAGER':
      return ['FRONT_DESK', 'TECHNICIAN'];
    default:
      return [];
  }
}

/** True when the actor may manage a member whose role is `targetRole` (and, for role changes, assign `newRole`). */
export function canManageRole(actorRole: Role | null | undefined, targetRole: Role, newRole?: Role): boolean {
  const roles = manageableRoles(actorRole);
  return roles.includes(targetRole) && (newRole === undefined || roles.includes(newRole));
}

/**
 * D5: who may create/edit/delete a time entry belonging to `entryOwnerRole`.
 * OWNER: anyone's, including own. MANAGER: Front desk, Technician and other Managers, never own and never an Owner's.
 */
export function canEditTimeEntry(
  actorRole: Role | null | undefined,
  entryOwnerRole: Role,
  isOwnEntry: boolean,
): boolean {
  if (!hasPermission(actorRole, 'timesheet.edit')) return false;
  if (actorRole === 'OWNER') return true;
  return !isOwnEntry && entryOwnerRole !== 'OWNER';
}
