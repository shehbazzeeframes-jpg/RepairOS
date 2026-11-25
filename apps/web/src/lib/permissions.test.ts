import { permissionsFor } from '@repairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  can,
  hiddenMainNav,
  settingsHome,
  settingsItemFor,
  visibleSettingsNav,
} from './permissions';

const labels = (perms: ReturnType<typeof permissionsFor>) =>
  visibleSettingsNav(perms).map((i) => i.label);

describe('settings nav by permission', () => {
  it('shows every settings page to owners and managers', () => {
    const all = ['General', 'Tax', 'Business hours', 'Staff', 'Timesheets', 'Audit log'];
    expect(labels(permissionsFor('OWNER'))).toEqual(all);
    expect(labels(permissionsFor('MANAGER'))).toEqual(all);
  });

  it('hides settings from front desk and technicians', () => {
    expect(labels(permissionsFor('FRONT_DESK'))).toEqual([]);
    expect(labels(permissionsFor('TECHNICIAN'))).toEqual([]);
    expect(settingsHome(permissionsFor('TECHNICIAN'))).toBeNull();
    expect(hiddenMainNav(permissionsFor('FRONT_DESK')).has('/settings')).toBe(true);
    expect(hiddenMainNav(permissionsFor('OWNER')).has('/settings')).toBe(false);
  });

  it('shows only the pages a partial permission set allows', () => {
    expect(labels(['staff.view', 'audit.view'])).toEqual(['Staff', 'Audit log']);
    expect(settingsHome(['audit.view'])).toBe('/settings/audit');
  });

  it('reads permissions, not roles', () => {
    expect(can(['timeclock.self'], 'timeclock.self')).toBe(true);
    expect(can([], 'timeclock.self')).toBe(false);
  });

  it('maps a pathname to its settings item', () => {
    expect(settingsItemFor('/settings/staff')?.label).toBe('Staff');
    expect(settingsItemFor('/settings/audit/x')?.label).toBe('Audit log');
    expect(settingsItemFor('/settings')).toBeUndefined();
  });
});
