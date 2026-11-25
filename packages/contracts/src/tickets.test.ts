import { describe, expect, it } from 'vitest';
import {
  AssignTicketInput,
  CancelTicketInput,
  ChangeTicketStatusInput,
  CreateTicketNoteInput,
  EstimateInput,
  GlobalSearchQuery,
  ReopenTicketInput,
  TicketListQuery,
  TicketTimelineItem,
  UpdateTicketInput,
  UpdateTicketSettingsInput,
  accessoriesSummary,
  canEditNote,
  checklistKeyProblems,
  completeChecklist,
  createTicketSchema,
  defaultTicketView,
  formatTicketNumber,
  isValidNextNumber,
  parseMajorAmount,
  parseTicketNumberQuery,
  ticketInView,
  ticketPath,
  toTicketIssues,
} from './index';

describe('ticket numbers (TK4, A4)', () => {
  it('formats prefix + number', () => {
    expect(formatTicketNumber('T-', 1042)).toBe('T-1042');
    expect(formatTicketNumber('', 1042)).toBe('1042');
  });
  it.each([
    ['T-1042', 1042],
    ['t1042', 1042],
    ['1042', 1042],
    ['#1042', 1042],
    [' t - 1042 ', 1042],
  ])('parses %s', (q, n) => {
    expect(parseTicketNumberQuery(q, 'T-')).toBe(n);
  });
  it('rejects other prefixes, phones, words and zero', () => {
    expect(parseTicketNumberQuery('X-1042', 'T-')).toBeNull();
    expect(parseTicketNumberQuery('X-1042')).toBe(1042); // no prefix given: any letters
    expect(parseTicketNumberQuery('0300 1234567', 'T-')).toBeNull();
    expect(parseTicketNumberQuery('+923001234567', 'T-')).toBeNull();
    expect(parseTicketNumberQuery('ali', 'T-')).toBeNull();
    expect(parseTicketNumberQuery('0', 'T-')).toBeNull();
    expect(parseTicketNumberQuery('RO-77', 'RO-')).toBe(77);
  });
  it('next number only above the highest used; prefix 0–5 [A-Z-]', () => {
    expect(isValidNextNumber(1001, null)).toBe(true);
    expect(isValidNextNumber(1042, 1042)).toBe(false);
    expect(isValidNextNumber(1043, 1042)).toBe(true);
    expect(UpdateTicketSettingsInput.parse({ numberPrefix: 'rep-' })).toEqual({ numberPrefix: 'REP-' });
    expect(UpdateTicketSettingsInput.safeParse({ numberPrefix: 'REPAIR' }).success).toBe(false);
    expect(UpdateTicketSettingsInput.safeParse({ numberPrefix: 'T1' }).success).toBe(false);
    expect(UpdateTicketSettingsInput.parse({ numberPrefix: '' })).toEqual({ numberPrefix: '' });
    expect(UpdateTicketSettingsInput.safeParse({ defaultTurnaroundDays: 31 }).success).toBe(false);
    expect(UpdateTicketSettingsInput.safeParse({}).success).toBe(false);
  });
});

describe('money', () => {
  it('parses typed amounts into minor units; PKR whole rupees', () => {
    expect(parseMajorAmount('129.5', 'USD')).toBe(12950);
    expect(parseMajorAmount('$1,299.99', 'USD')).toBe(129999);
    expect(parseMajorAmount('0.005', 'GBP')).toBe(1);
    expect(parseMajorAmount('Rs 4,999.6', 'PKR')).toBe(500000);
    expect(parseMajorAmount('4999.4', 'PKR')).toBe(499900);
    expect(parseMajorAmount('abc', 'USD')).toBeNull();
    expect(parseMajorAmount('', 'USD')).toBeNull();
  });
  it('estimate: 0..1,000,000 major, whole PKR', () => {
    expect(EstimateInput.safeParse({ amountMinor: 0, currency: 'USD' }).success).toBe(true);
    expect(EstimateInput.safeParse({ amountMinor: 100_000_000, currency: 'GBP' }).success).toBe(true);
    expect(EstimateInput.safeParse({ amountMinor: 100_000_001, currency: 'GBP' }).success).toBe(false);
    expect(EstimateInput.safeParse({ amountMinor: -1, currency: 'GBP' }).success).toBe(false);
    expect(EstimateInput.safeParse({ amountMinor: 12.5, currency: 'GBP' }).success).toBe(false);
    expect(EstimateInput.safeParse({ amountMinor: 499950, currency: 'PKR' }).success).toBe(false);
    expect(EstimateInput.safeParse({ amountMinor: 500000, currency: 'PKR' }).success).toBe(true);
  });
});

describe('check-in input (TK1–TK2)', () => {
  const s = createTicketSchema('PK');
  const returning = { customerId: 'c1', deviceId: 'd1', issues: [{ code: 'SCREEN_CRACKED' }] };

  it('returning customer + device with defaults', () => {
    expect(s.parse(returning)).toMatchObject({
      customerId: 'c1',
      deviceId: 'd1',
      priority: 'NORMAL',
      accessories: [],
      checklist: {},
      estimate: null,
      assigneeUserId: null,
      dueTime: null,
      description: null,
    });
  });
  it('new customer + new device in one request, normalised', () => {
    const t = s.parse({
      newCustomer: { firstName: 'Ali', lastName: 'Khan', phones: [{ number: '0300 1234567' }] },
      newDevice: { type: 'PHONE', brand: 'Infinix', model: 'Hot 40', passcode: { lockType: 'PATTERN', pattern: [1, 5, 9, 6] } },
      description: 'Fell in water',
      checklist: { POWERS_ON: 'FAIL' },
      accessories: ['SIM_CARD', 'SIM_CARD', 'CASE'],
      estimate: { amountMinor: 500000, currency: 'PKR' },
      dueDate: '2026-11-30',
      priority: 'URGENT',
    });
    expect(t.newCustomer).toMatchObject({ displayName: 'Ali Khan', preferredChannel: 'WHATSAPP', phones: [{ e164: '+923001234567' }] });
    expect(t.accessories).toEqual(['SIM_CARD', 'CASE']);
  });
  it('nested customer errors keep their path', () => {
    const r = s.safeParse({ newCustomer: { firstName: 'Ali', phones: [{ number: '12' }] }, newDevice: { type: 'PHONE', brand: 'X', model: 'Y' }, description: 'x' });
    expect(!r.success && r.error.issues[0]?.path).toEqual(['newCustomer', 'phones', 0, 'number']);
  });
  it('exactly one customer and one device source; new customer needs a new device', () => {
    expect(s.safeParse({ ...returning, customerId: undefined }).success).toBe(false);
    expect(s.safeParse({ ...returning, newDevice: { type: 'PHONE', brand: 'A', model: 'B' } }).success).toBe(false);
    expect(s.safeParse({ newCustomer: { firstName: 'A', email: 'a@b.co' }, deviceId: 'd1', description: 'x' }).success).toBe(false);
  });
  it('needs an issue or description; max 10 issues; checklist keys must fit the new device type', () => {
    expect(s.safeParse({ ...returning, issues: [] }).success).toBe(false);
    expect(s.safeParse({ ...returning, issues: [], description: 'Broken' }).success).toBe(true);
    expect(s.safeParse({ ...returning, issues: Array.from({ length: 11 }, (_, i) => ({ label: `i${i}` })) }).success).toBe(false);
    const laptopWithFaceId = { customerId: 'c1', newDevice: { type: 'LAPTOP', brand: 'Dell', model: 'XPS 13' }, description: 'x', checklist: { BIOMETRICS: 'PASS' } };
    const r = s.safeParse(laptopWithFaceId);
    expect(!r.success && r.error.issues[0]?.path).toEqual(['checklist', 'BIOMETRICS']);
  });
  it('passcode for an existing device goes in devicePasscode; Other accessory needs text; time needs date', () => {
    expect(s.safeParse({ ...returning, devicePasscode: { lockType: 'PIN', value: '0000' } }).success).toBe(true);
    expect(s.safeParse({ ...returning, accessories: ['OTHER'] }).success).toBe(false);
    expect(s.safeParse({ ...returning, accessories: ['OTHER'], accessoriesOther: 'Pen drive' }).success).toBe(true);
    expect(s.safeParse({ ...returning, dueTime: '17:00' }).success).toBe(false);
    expect(s.safeParse({ ...returning, dueDate: '2026-11-30', dueTime: '17:07' }).success).toBe(true);
    expect(s.safeParse({ ...returning, unknown: 1 }).success).toBe(false);
  });
});

describe('issues, checklist and accessories data', () => {
  it('issues: label snapshot and dedupe', () => {
    expect(toTicketIssues([{ code: 'BATTERY' }, { label: 'Bent frame' }, { code: 'BATTERY' }, { label: 'bent FRAME' }])).toEqual([
      { code: 'BATTERY', label: 'Battery' },
      { code: null, label: 'Bent frame' },
    ]);
  });
  it('checklist: unknown keys for the type; full list defaults to UNTESTED', () => {
    expect(checklistKeyProblems('PHONE', { POWERS_ON: 'PASS', KEYBOARD: 'FAIL' })).toEqual(['KEYBOARD']);
    const full = completeChecklist('CONSOLE', { POWERS_ON: 'PASS' });
    expect(full).toEqual({ POWERS_ON: 'PASS', DISPLAY_OUTPUT: 'UNTESTED', DISC_DRIVE: 'UNTESTED', CONTROLLERS: 'UNTESTED', PORTS: 'UNTESTED', LIQUID: 'UNTESTED' });
  });
  it('accessories summary', () => {
    expect(accessoriesSummary([])).toBe('Nothing left with device');
    expect(accessoriesSummary(['SIM_CARD', 'OTHER'], 'Pen drive')).toBe('SIM card, Other: Pen drive');
  });
});

describe('edits, status, cancel, reopen, notes', () => {
  it('PATCH requires version; device change with customer change', () => {
    expect(UpdateTicketInput.safeParse({ priority: 'URGENT' }).success).toBe(false);
    expect(UpdateTicketInput.parse({ version: 2, priority: 'URGENT' })).toEqual({ version: 2, priority: 'URGENT' });
    expect(UpdateTicketInput.safeParse({ version: 2, customerId: 'c2' }).success).toBe(false);
    expect(UpdateTicketInput.safeParse({ version: 2, customerId: 'c2', deviceId: 'd9' }).success).toBe(true);
    expect(UpdateTicketInput.safeParse({ version: 2, dueTime: '10:00' }).success).toBe(false);
    expect(UpdateTicketInput.parse({ version: 2, estimate: null })).toEqual({ version: 2, estimate: null });
  });
  it('status change note is optional in shape', () => {
    expect(ChangeTicketStatusInput.safeParse({ statusId: 's1' }).success).toBe(true);
    expect(ChangeTicketStatusInput.safeParse({ statusId: 's1', note: { body: '', visibility: 'CUSTOMER' } }).success).toBe(false);
    expect(AssignTicketInput.safeParse({ userId: null }).success).toBe(true);
    expect(AssignTicketInput.safeParse({}).success).toBe(false);
  });
  it('cancel: reason rules (TK-C)', () => {
    expect(CancelTicketInput.safeParse({ reason: 'CREATED_BY_MISTAKE' }).success).toBe(true);
    expect(CancelTicketInput.safeParse({ reason: 'DUPLICATE' }).success).toBe(true);
    expect(CancelTicketInput.safeParse({ reason: 'CUSTOMER_DECLINED' }).success).toBe(false);
    expect(CancelTicketInput.safeParse({ reason: 'CUSTOMER_TOOK_BACK', returnedConfirmed: true }).success).toBe(true);
    expect(CancelTicketInput.safeParse({ reason: 'OTHER', returnedConfirmed: true }).success).toBe(false);
    expect(CancelTicketInput.safeParse({ reason: 'OTHER', returnedConfirmed: true, note: 'ab' }).success).toBe(false);
    expect(CancelTicketInput.parse({ reason: 'OTHER', returnedConfirmed: true, note: ' Gone abroad ' }).note).toBe('Gone abroad');
    expect(CancelTicketInput.safeParse({ reason: 'DUPLICATE', note: 'x'.repeat(201) }).success).toBe(false);
  });
  it('reopen needs a 3–200 char reason', () => {
    expect(ReopenTicketInput.safeParse({ reason: 'no' }).success).toBe(false);
    expect(ReopenTicketInput.safeParse({ reason: 'Closed by mistake' }).success).toBe(true);
  });
  it('notes: internal by default, 1–2000 chars, editable by the author for 10 minutes', () => {
    expect(CreateTicketNoteInput.parse({ body: ' Hi ' })).toEqual({ body: 'Hi', visibility: 'INTERNAL' });
    expect(CreateTicketNoteInput.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    const note = { authorUserId: 'u1', createdAt: '2026-11-25T10:00:00.000Z' };
    expect(canEditNote(note, 'u1', new Date('2026-11-25T10:10:00.000Z'))).toBe(true);
    expect(canEditNote(note, 'u1', new Date('2026-11-25T10:10:01.000Z'))).toBe(false);
    expect(canEditNote(note, 'u2', new Date('2026-11-25T10:01:00.000Z'))).toBe(false);
  });
});

describe('list views and queries (TL1)', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const ctx = { userId: 'me', now };
  const t = (statusCategory: 'OPEN' | 'WAITING' | 'READY' | 'CLOSED', extra: object = {}) => ({
    statusCategory,
    assigneeUserId: null as string | null,
    dueAt: '2026-11-26T12:00:00Z',
    ...extra,
  });
  it('view membership', () => {
    expect(ticketInView(t('READY'), 'open', ctx)).toBe(true);
    expect(ticketInView(t('CLOSED'), 'open', ctx)).toBe(false);
    expect(ticketInView(t('READY', { assigneeUserId: 'me' }), 'mine', ctx)).toBe(true);
    expect(ticketInView(t('CLOSED', { assigneeUserId: 'me' }), 'mine', ctx)).toBe(false);
    expect(ticketInView(t('OPEN'), 'unassigned', ctx)).toBe(true);
    expect(ticketInView(t('WAITING', { assigneeUserId: 'sam', assigneeActive: false }), 'unassigned', ctx)).toBe(true);
    expect(ticketInView(t('WAITING', { assigneeUserId: 'sam', assigneeActive: true }), 'unassigned', ctx)).toBe(false);
    expect(ticketInView(t('READY'), 'unassigned', ctx)).toBe(false);
    expect(ticketInView(t('OPEN', { dueAt: '2026-11-25T11:59:59Z' }), 'overdue', ctx)).toBe(true);
    expect(ticketInView(t('READY', { dueAt: '2026-11-25T11:59:59Z' }), 'overdue', ctx)).toBe(false);
    expect(ticketInView(t('CLOSED'), 'closed', ctx)).toBe(true);
    expect(ticketInView(t('CLOSED'), 'all', ctx)).toBe(true);
  });
  it('technicians land on Mine', () => {
    expect(defaultTicketView('TECHNICIAN')).toBe('mine');
    expect(defaultTicketView('FRONT_DESK')).toBe('open');
  });
  it('query parsing', () => {
    const q = TicketListQuery.parse({ status: 's1,s2', assignee: ['unassigned', 'u1'], deviceType: 'PHONE', warranty: 'true', category: 'OPEN,WAITING' });
    expect(q).toMatchObject({ view: 'open', sort: 'default', limit: 25, status: ['s1', 's2'], assignee: ['unassigned', 'u1'], deviceType: ['PHONE'], warranty: true, category: ['OPEN', 'WAITING'] });
    expect(TicketListQuery.safeParse({ view: 'kanban' }).success).toBe(false);
    expect(TicketListQuery.safeParse({ dueFrom: '2026-11-30', dueTo: '2026-11-01' }).success).toBe(false);
    expect(GlobalSearchQuery.parse({ q: 'T-1042' })).toEqual({ q: 'T-1042', limit: 5, includeArchived: false });
    expect(GlobalSearchQuery.safeParse({ q: 'x' }).success).toBe(false);
    expect(ticketPath('status', { id: 'abc' })).toBe('/api/tickets/abc/status');
  });
});

describe('timeline union', () => {
  const base = { id: 'e1', createdAt: '2026-11-25T10:00:00.000Z', actor: null };
  it('parses known types and the reserved photo kind', () => {
    expect(TicketTimelineItem.safeParse({ ...base, type: 'passcode_deleted', data: { reason: 'closed' } }).success).toBe(true);
    expect(
      TicketTimelineItem.safeParse({ ...base, type: 'attachment_added', data: { attachmentId: 'a', kind: 'photo', fileName: null, thumbnailUrl: null } }).success,
    ).toBe(true);
    expect(TicketTimelineItem.safeParse({ ...base, type: 'payment_recorded', data: { amountMinor: 100 } }).success).toBe(true);
    expect(TicketTimelineItem.safeParse({ ...base, type: 'fields_changed', data: { changes: [] } }).success).toBe(false);
    expect(TicketTimelineItem.safeParse({ ...base, type: 'teleported', data: {} }).success).toBe(false);
  });
});
