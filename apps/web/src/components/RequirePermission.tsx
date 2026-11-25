'use client';

import type { Permission } from '@repairos/contracts';
import type { ReactNode } from 'react';
import { can } from '@/lib/permissions';
import { useSession } from '@/lib/shop-context';
import { NoAccess } from './PageStates';

/** Renders children only with the permission; otherwise the "no access" state (direct URL visits). */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { me } = useSession();
  return can(me.permissions, permission) ? children : <NoAccess />;
}

/** `me.permissions` check for the active shop. */
export function useCan(): (permission: Permission) => boolean {
  const { me } = useSession();
  return (permission) => can(me.permissions, permission);
}
