import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  AUDIT_ACTIONS,
  AUDIT_ACTION_META,
  ApiErrorCode,
  AuditEventListQuery,
  BusinessHoursWeek,
  CreateInviteInput,
  CreateTimeEntryInput,
  DEFAULT_BUSINESS_HOURS,
  InvitePreview,
  InviteToken,
  MeResponse,
  PasswordSchema,
  SPRINT1_AUDIT_ACTIONS,
  SPRINT2_AUDIT_ACTIONS,
  StaffListQuery,
  TimesheetQuery,
  UpdateTimeEntryInput,
  auditActionsInGroup,
  csvCell,
  decimalHours,
  formatDuration,
  timesheetCsvFilename,
} from './index';

describe('business hours', () => {
  it('default is Mon–Sat 10:00–19:00, Sunday closed (D9)', () => {
    expect(BusinessHoursWeek.parse(DEFAULT_BUSINESS_HOURS)).toEqual(DEFAULT_BUSINESS_HOURS);
    expect(DEFAULT_BUSINESS_HOURS[0]).toEqual({ weekday: 0, isOpen: false, opensAt: null, closesAt: null });
    expect(DEFAULT_BUSINESS_HOURS[1]).toEqual({ weekday: 1, isOpen: true, opensAt: '10:00', closesAt: '19:00' });
  });
  it('requires closes after opens, 15-minute steps, 7 distinct days', () => {
    const week = (patch: object) => DEFAULT_BUSINESS_HOURS.map((d) => (d.weekday === 1 ? { ...d, ...patch } : d));
    expect(BusinessHoursWeek.safeParse(week({ closesAt: '10:00' })).success).toBe(false);
    expect(BusinessHoursWeek.safeParse(week({ opensAt: '10:10' })).success).toBe(false);
    expect(BusinessHoursWeek.safeParse(week({ opensAt: null })).success).toBe(false);
    expect(BusinessHoursWeek.safeParse(DEFAULT_BUSINESS_HOURS.slice(1)).success).toBe(false);
    const dup = DEFAULT_BUSINESS_HOURS.map((d) => ({ ...d, weekday: d.weekday === 6 ? 5 : d.weekday }));
    expect(BusinessHoursWeek.safeParse(dup).success).toBe(false);
  });
  it('closed days drop their times and the week is sorted', () => {
    const input = [...DEFAULT_BUSINESS_HOURS].reverse().map((d) => (d.weekday === 3 ? { ...d, isOpen: false } : d));
    const out = BusinessHoursWeek.parse(input);
    expect(out.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out[3]).toEqual({ weekday: 3, isOpen: false, opensAt: null, closesAt: null });
  });
});

describe('staff & invites', () => {
  it('invite emails are trimmed and lower-cased', () => {
    expect(CreateInviteInput.parse({ email: '  Sam@Shop.COM ', role: 'TECHNICIAN' }).email).toBe('sam@shop.com');
    expect(CreateInviteInput.safeParse({ email: 'nope', role: 'TECHNICIAN' }).success).toBe(false);
  });
  it('staff status filter defaults to ACTIVE,INVITED', () => {
    expect(StaffListQuery.parse({}).status).toEqual(['ACTIVE', 'INVITED']);
    expect(StaffListQuery.parse({ status: 'DEACTIVATED' }).status).toEqual(['DEACTIVATED']);
    expect(StaffListQuery.safeParse({ status: 'REVOKED' }).success).toBe(false);
  });
  it('invite tokens are 43-char base64url', () => {
    expect(InviteToken.safeParse('a'.repeat(43)).success).toBe(true);
    expect(InviteToken.safeParse('a'.repeat(42)).success).toBe(false);
    expect(InviteToken.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
  });
  it('revoked preview carries no shop details', () => {
    expect(InvitePreview.parse({ state: 'REVOKED', shopName: 'X' })).toEqual({ state: 'REVOKED' });
  });
});

describe('me', () => {
  it('requires permissions and accessRemoved', () => {
    const base = { user: { id: 'u', name: 'U', email: 'u@x.com' }, memberships: [], activeShop: null, role: null };
    expect(MeResponse.safeParse(base).success).toBe(false);
    expect(MeResponse.safeParse({ ...base, permissions: [], accessRemoved: { shopId: 's', shopName: 'S' } }).success).toBe(true);
  });
});

describe('timesheets', () => {
  it('range is inclusive and at most 93 days', () => {
    expect(TimesheetQuery.safeParse({ from: '2026-01-01', to: '2026-04-03' }).success).toBe(true); // 93 days
    expect(TimesheetQuery.safeParse({ from: '2026-01-01', to: '2026-04-04' }).success).toBe(false); // 94
    expect(TimesheetQuery.safeParse({ from: '2026-02-02', to: '2026-02-01' }).success).toBe(false);
    expect(TimesheetQuery.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(TimesheetQuery.parse({ from: '2026-01-01', to: '2026-01-07', needsReview: 'true' }).needsReview).toBe(true);
  });
  it('manual entries need out after in, ≤ 24h and a 3–200 char reason', () => {
    const ok = { userId: 'u', clockInAt: '2026-03-01T09:00:00.000Z', clockOutAt: '2026-03-01T17:00:00.000Z', reason: 'Forgot to clock in' };
    expect(CreateTimeEntryInput.safeParse(ok).success).toBe(true);
    expect(CreateTimeEntryInput.safeParse({ ...ok, reason: 'no' }).success).toBe(false);
    expect(CreateTimeEntryInput.safeParse({ ...ok, clockOutAt: '2026-03-01T08:00:00.000Z' }).success).toBe(false);
    expect(CreateTimeEntryInput.safeParse({ ...ok, clockOutAt: '2026-03-02T09:00:01.000Z' }).success).toBe(false);
    expect(UpdateTimeEntryInput.safeParse({ reason: 'Fix it please' }).success).toBe(false);
    expect(UpdateTimeEntryInput.safeParse({ clockOutAt: ok.clockOutAt }).success).toBe(false);
  });
  it('formats durations and CSV cells', () => {
    expect(formatDuration(472)).toBe('7h 52m');
    expect(decimalHours(472)).toBe('7.87');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('Lee, "Sam"')).toBe('"Lee, ""Sam"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(7.5)).toBe('7.5');
    expect(timesheetCsvFilename('Fix It Fast!', '2026-03-02', '2026-03-08')).toBe('timesheet-fix-it-fast-2026-03-02-2026-03-08.csv');
  });
});

describe('audit', () => {
  it('has the 22 Sprint 1 + 12 Sprint 2 actions, each in a group', () => {
    expect(SPRINT1_AUDIT_ACTIONS).toHaveLength(22);
    expect(SPRINT2_AUDIT_ACTIONS).toHaveLength(12);
    expect(AUDIT_ACTIONS).toHaveLength(34);
    expect(new Set(AUDIT_ACTIONS).size).toBe(34);
    expect(Object.keys(AUDIT_ACTION_META).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(auditActionsInGroup('business_hours')).toEqual(['shop.hours_updated']);
    expect(auditActionsInGroup('tickets')).toEqual(['ticket.cancelled', 'ticket.reopened']);
    expect(auditActionsInGroup('ticket_settings')).toEqual([
      'ticket_status.created',
      'ticket_status.updated',
      'ticket_status.reordered',
      'shop.ticket_settings_updated',
    ]);
    expect(auditActionsInGroup('customers')).toHaveLength(6);
  });
  it('query range max one year, limit defaults to 50', () => {
    expect(AuditEventListQuery.parse({ from: '2026-01-01', to: '2026-01-07' }).limit).toBe(50);
    expect(AuditEventListQuery.safeParse({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(false);
    expect(AuditEventListQuery.safeParse({ from: '2026-01-01', to: '2026-01-07', action: 'nope' }).success).toBe(false);
  });
});

describe('errors and auth', () => {
  it('every error code has an HTTP status', () => {
    for (const code of ApiErrorCode.options) expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
  it('password policy is 8–128', () => {
    expect(PasswordSchema.safeParse('a'.repeat(7)).success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(PasswordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(PasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});
