import type { Permission } from '@repairos/contracts';

export interface SettingsNavItem {
  href: string;
  label: string;
  /** Permission needed to see the page at all. */
  permission: Permission;
}

/** Settings → secondary nav, in display order. */
export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { href: '/settings/general', label: 'General', permission: 'settings.view' },
  { href: '/settings/tax', label: 'Tax', permission: 'settings.view' },
  { href: '/settings/hours', label: 'Business hours', permission: 'settings.view' },
  { href: '/settings/staff', label: 'Staff', permission: 'staff.view' },
  { href: '/settings/timesheets', label: 'Timesheets', permission: 'timesheet.view' },
  { href: '/settings/audit', label: 'Audit log', permission: 'audit.view' },
];

/** `me.permissions` check. The UI never derives access from the role. */
export function can(permissions: readonly Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}

export function visibleSettingsNav(permissions: readonly Permission[]): SettingsNavItem[] {
  return SETTINGS_NAV.filter((item) => can(permissions, item.permission));
}

/** Where `/settings` should land, or null when no settings page is visible. */
export function settingsHome(permissions: readonly Permission[]): string | null {
  return visibleSettingsNav(permissions)[0]?.href ?? null;
}

/** The settings item that owns a pathname. */
export function settingsItemFor(pathname: string): SettingsNavItem | undefined {
  return SETTINGS_NAV.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}

/** Main side-nav hrefs to hide for these permissions (Settings needs at least one settings page). */
export function hiddenMainNav(permissions: readonly Permission[]): Set<string> {
  const hidden = new Set<string>();
  if (visibleSettingsNav(permissions).length === 0) hidden.add('/settings');
  return hidden;
}
