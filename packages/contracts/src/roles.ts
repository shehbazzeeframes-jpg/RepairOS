import { z } from 'zod';

export const Role = z.enum(['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN']);
export type Role = z.infer<typeof Role>;

/** Display/sort order: Owners, Managers, Front desk, Technicians. */
export const ROLE_ORDER: readonly Role[] = ['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN'];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  FRONT_DESK: 'Front desk',
  TECHNICIAN: 'Technician',
};
