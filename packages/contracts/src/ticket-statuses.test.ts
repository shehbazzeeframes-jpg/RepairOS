import { describe, expect, it } from 'vitest';
import {
  CreateTicketStatusInput,
  DEFAULT_TICKET_STATUSES,
  ReorderTicketStatusesInput,
  UpdateTicketStatusInput,
  allowedTargetStatuses,
  canTransition,
  checkStatusCreate,
  checkStatusUpdate,
  permissionsFor,
  withinReopenWindow,
  type Role,
  type StatusCategory,
} from './index';

const statuses = DEFAULT_TICKET_STATUSES.map((s, i) => ({
  ...s,
  id: s.name.toLowerCase().replace(/\s+/g, '_'),
  position: i,
  isHidden: false,
  ticketCount: 0,
}));
const byId = (id: string) => statuses.find((s) => s.id === id)!;
const perms = (role: Role) => ({ permissions: permissionsFor(role) });

describe('default statuses (§3, A8)', () => {
  it('nine statuses, system roles, Unrepairable is READY and needs a note', () => {
    expect(statuses.map((s) => `${s.name}:${s.category}`)).toEqual([
      'Received:OPEN', 'Diagnosing:OPEN', 'Awaiting approval:WAITING', 'Awaiting parts:WAITING', 'In repair:OPEN',
      'Ready for pickup:READY', 'Unrepairable:READY', 'Collected:CLOSED', 'Cancelled:CLOSED',
    ]);
    expect(statuses.filter((s) => s.systemRole).map((s) => s.systemRole)).toEqual(['INITIAL', 'COLLECTED', 'CANCELLED']);
    expect(statuses.filter((s) => s.notifyCustomer).map((s) => s.name)).toEqual([
      'Received', 'Awaiting approval', 'Ready for pickup', 'Unrepairable',
    ]);
    expect(statuses.filter((s) => s.requiresNote).map((s) => s.name)).toEqual(['Unrepairable']);
  });
});

describe('canTransition matrix (§5.4, A3, A7)', () => {
  const nonClosed: StatusCategory[] = ['OPEN', 'WAITING', 'READY'];

  it('open/waiting/ready → any visible open/waiting/ready with tickets.edit (Technician included)', () => {
    for (const from of nonClosed) {
      for (const to of statuses.filter((s) => s.category !== 'CLOSED')) {
        const r = canTransition(from, to, perms('TECHNICIAN'));
        expect(r, `${from}→${to.name}`).toMatchObject({ ok: true, permission: 'tickets.edit', closes: false });
      }
    }
  });
  it('same status is a rejected no-op', () => {
    expect(canTransition(byId('diagnosing'), byId('diagnosing'), perms('OWNER'))).toMatchObject({ ok: false, code: 'TRANSITION_NOT_ALLOWED' });
  });
  it('Unrepairable requires a note', () => {
    expect(canTransition('OPEN', byId('unrepairable'), perms('FRONT_DESK'))).toMatchObject({ ok: true, requiresNote: true });
    expect(canTransition('OPEN', byId('ready_for_pickup'), perms('FRONT_DESK'))).toMatchObject({ ok: true, requiresNote: false });
  });
  it('Collected only from READY, with tickets.cancel', () => {
    expect(canTransition('READY', byId('collected'), perms('FRONT_DESK'))).toMatchObject({ ok: true, permission: 'tickets.cancel', closes: true });
    expect(canTransition(byId('unrepairable'), byId('collected'), perms('MANAGER')).ok).toBe(true);
    for (const from of ['OPEN', 'WAITING'] as const) {
      const r = canTransition(from, byId('collected'), perms('OWNER'));
      expect(r).toMatchObject({ ok: false, code: 'TRANSITION_NOT_ALLOWED' });
      expect(!r.ok && r.message).toMatch(/Ready for pickup first/);
    }
    expect(canTransition('READY', byId('collected'), perms('TECHNICIAN'))).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
  it('Cancelled / custom closed only via Cancel ticket, with tickets.cancel', () => {
    const customClosed = { id: 'void', category: 'CLOSED' as const, systemRole: null, isHidden: false };
    for (const from of nonClosed) {
      expect(canTransition(from, byId('cancelled'), perms('OWNER')).ok).toBe(false);
      expect(canTransition(from, byId('cancelled'), { ...perms('FRONT_DESK'), via: 'cancel' })).toMatchObject({ ok: true, closes: true });
      expect(canTransition(from, customClosed, { ...perms('FRONT_DESK'), via: 'cancel' }).ok).toBe(true);
      expect(canTransition(from, byId('cancelled'), { ...perms('TECHNICIAN'), via: 'cancel' })).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(canTransition(from, byId('collected'), { ...perms('OWNER'), via: 'cancel' }).ok).toBe(false);
      expect(canTransition(from, byId('in_repair'), { ...perms('OWNER'), via: 'cancel' }).ok).toBe(false);
    }
  });
  it('closed → nothing via the status menu or cancel; only Reopen within 7 days', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    for (const to of statuses) {
      expect(canTransition('CLOSED', to, perms('OWNER'))).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
      expect(canTransition('CLOSED', to, { ...perms('OWNER'), via: 'cancel' })).toMatchObject({ ok: false, code: 'TICKET_CLOSED' });
    }
    const reopen = { ...perms('FRONT_DESK'), via: 'reopen' as const, now };
    expect(canTransition('CLOSED', byId('in_repair'), { ...reopen, closedAt: '2026-11-18T12:00:00Z' })).toMatchObject({ ok: true, permission: 'tickets.cancel' });
    expect(canTransition('CLOSED', byId('in_repair'), { ...reopen, closedAt: '2026-11-18T11:59:59Z' })).toMatchObject({ ok: false, code: 'REOPEN_WINDOW_PASSED' });
    expect(canTransition('CLOSED', byId('cancelled'), { ...reopen, closedAt: '2026-11-24T00:00:00Z' }).ok).toBe(false);
    expect(canTransition('CLOSED', byId('in_repair'), { ...perms('TECHNICIAN'), via: 'reopen', now, closedAt: '2026-11-24T00:00:00Z' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(canTransition('OPEN', byId('in_repair'), { ...reopen, closedAt: '2026-11-24T00:00:00Z' }).ok).toBe(false);
  });
  it('hidden target → STATUS_HIDDEN for every route', () => {
    const hidden = { ...byId('diagnosing'), isHidden: true };
    expect(canTransition('OPEN', hidden, perms('OWNER'))).toEqual({ ok: false, code: 'STATUS_HIDDEN' });
  });
  it('accepts a role instead of a permission list', () => {
    expect(canTransition('READY', byId('collected'), { role: 'FRONT_DESK' }).ok).toBe(true);
    expect(canTransition('READY', byId('collected'), { role: 'TECHNICIAN' }).ok).toBe(false);
  });
  it('allowedTargetStatuses: Technician menu from READY has no closed statuses; FD gets Collected', () => {
    const from = byId('ready_for_pickup');
    const tech = allowedTargetStatuses(from, statuses, perms('TECHNICIAN')).map((s) => s.name);
    expect(tech).toEqual(['Received', 'Diagnosing', 'Awaiting approval', 'Awaiting parts', 'In repair', 'Unrepairable']);
    const fd = allowedTargetStatuses(from, statuses, perms('FRONT_DESK')).map((s) => s.name);
    expect(fd).toContain('Collected');
    expect(fd).not.toContain('Cancelled');
  });
  it('reopen window helper', () => {
    expect(withinReopenWindow('2026-11-18T12:00:00Z', new Date('2026-11-25T12:00:00Z'))).toBe(true);
    expect(withinReopenWindow(new Date('2026-11-18T11:00:00Z'), new Date('2026-11-25T12:00:00Z'))).toBe(false);
  });
});

describe('status configuration rules (ST1, A9, §5.12)', () => {
  it('create: unique name case-insensitively, max 20', () => {
    expect(checkStatusCreate(statuses, { name: 'in REPAIR' })).toEqual({ ok: false, code: 'STATUS_NAME_TAKEN' });
    expect(checkStatusCreate(statuses, { name: 'Quality check' })).toEqual({ ok: true });
    const many = Array.from({ length: 20 }, (_, i) => ({ ...statuses[0]!, id: `s${i}`, name: `S${i}` }));
    expect(checkStatusCreate(many, { name: 'New' })).toEqual({ ok: false, code: 'STATUS_LIMIT_REACHED' });
    expect(CreateTicketStatusInput.parse({ name: ' QC ', category: 'OPEN', colour: 'teal' })).toEqual({
      name: 'QC', category: 'OPEN', colour: 'teal', notifyCustomer: false, requiresNote: false,
    });
    expect(CreateTicketStatusInput.safeParse({ name: 'x'.repeat(31), category: 'OPEN', colour: 'teal' }).success).toBe(false);
    expect(CreateTicketStatusInput.safeParse({ name: 'X', category: 'OPEN', colour: '#ff0000' }).success).toBe(false);
  });
  it('system statuses: rename/recolour yes, hide or re-categorise no', () => {
    expect(checkStatusUpdate(statuses, 'received', { name: 'Checked in', colour: 'blue' })).toEqual({ ok: true });
    expect(checkStatusUpdate(statuses, 'collected', { isHidden: true })).toEqual({ ok: false, code: 'SYSTEM_STATUS_LOCKED' });
    expect(checkStatusUpdate(statuses, 'received', { category: 'WAITING' })).toEqual({ ok: false, code: 'SYSTEM_STATUS_LOCKED' });
    expect(checkStatusUpdate(statuses, 'received', { category: 'OPEN' })).toEqual({ ok: true });
  });
  it('rename clash, in-use closed moves, last visible open/ready', () => {
    expect(checkStatusUpdate(statuses, 'diagnosing', { name: 'Received' })).toEqual({ ok: false, code: 'STATUS_NAME_TAKEN' });
    expect(checkStatusUpdate(statuses, 'diagnosing', { name: 'DIAGNOSING' })).toEqual({ ok: true });
    const busy = statuses.map((s) => (s.id === 'diagnosing' ? { ...s, ticketCount: 12 } : s));
    expect(checkStatusUpdate(busy, 'diagnosing', { category: 'WAITING' })).toEqual({ ok: true });
    expect(checkStatusUpdate(busy, 'diagnosing', { category: 'CLOSED' })).toEqual({ ok: false, code: 'STATUS_IN_USE' });
    expect(checkStatusUpdate(statuses, 'diagnosing', { category: 'CLOSED' })).toEqual({ ok: true });
    const oneReady = statuses.map((s) => (s.id === 'unrepairable' ? { ...s, isHidden: true } : s));
    expect(checkStatusUpdate(oneReady, 'ready_for_pickup', { isHidden: true })).toMatchObject({ ok: false, code: 'LAST_VISIBLE_STATUS', vars: { category: 'ready' } });
    expect(checkStatusUpdate(oneReady, 'ready_for_pickup', { category: 'OPEN' })).toMatchObject({ ok: false, code: 'LAST_VISIBLE_STATUS' });
    expect(checkStatusUpdate(statuses, 'nope', { name: 'X' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
  it('patch and reorder shapes', () => {
    expect(UpdateTicketStatusInput.safeParse({}).success).toBe(false);
    expect(UpdateTicketStatusInput.safeParse({ systemRole: 'INITIAL' }).success).toBe(false);
    expect(ReorderTicketStatusesInput.safeParse({ ids: ['a', 'b', 'a'] }).success).toBe(false);
    expect(ReorderTicketStatusesInput.safeParse({ ids: ['a', 'b'] }).success).toBe(true);
  });
});
