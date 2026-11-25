import {
  GlobalSearchResponse,
  createCustomerSchema,
  permissionsFor,
  type ConsentSummary,
} from '@repairos/contracts';
import { describe, expect, it } from 'vitest';
import { searchItems } from './CommandSearch';
import {
  consentChangesFrom,
  consentValueFrom,
  missingConsentSources,
} from './customers/ConsentEditor';
import { customerBody, formValuesFrom } from './customers/CustomerForm';
import { lockProblem } from './devices/LockFields';
import { moveId } from './settings/TicketStatusesPage';
import { collectBlockedReason, statusMenuTargets } from './tickets/status-change';

const none = { granted: false, since: null, source: null, recordedByName: null };
const SMS_ON: ConsentSummary = {
  SMS: {
    granted: true,
    since: '2026-03-12T10:00:00.000Z',
    source: 'IN_STORE_SIGNED',
    recordedByName: 'Sam',
  },
  EMAIL: none,
  WHATSAPP: none,
};

describe('consent editor', () => {
  it('sends only effective changes: a new grant with its source, a withdrawal', () => {
    const v = consentValueFrom(SMS_ON);
    expect(consentChangesFrom(SMS_ON, v)).toEqual([]);
    v.SMS.on = false;
    v.EMAIL = { on: true, source: 'ONLINE_FORM', note: ' signed up ' };
    expect(consentChangesFrom(SMS_ON, v)).toEqual([
      { channel: 'SMS', state: 'WITHDRAWN', source: 'CUSTOMER_REQUEST', note: null },
      { channel: 'EMAIL', state: 'GRANTED', source: 'ONLINE_FORM', note: 'signed up' },
    ]);
  });

  it('asks for a source only for new grants', () => {
    const v = consentValueFrom(SMS_ON);
    v.WHATSAPP.on = true;
    expect(missingConsentSources(SMS_ON, v)).toEqual(['WHATSAPP']);
  });
});

describe('customer form body', () => {
  it('drops empty phone rows, clears business fields for a person and passes the contract', () => {
    const v = formValuesFrom(null, 'GB');
    v.firstName = 'Priya';
    v.phones = [
      { number: '07400 900123', label: 'MOBILE', isPrimary: true, isWhatsapp: true },
      { number: ' ', label: 'WORK', isPrimary: false, isWhatsapp: false },
      { number: '020 7946 0000', label: 'LANDLINE', isPrimary: false, isWhatsapp: true },
    ];
    v.businessName = 'leftover';
    const body = customerBody(v);
    expect(body.phones).toHaveLength(2);
    expect(body.phones[1]).toMatchObject({ label: 'LANDLINE', isWhatsapp: false });
    expect(body.businessName).toBeNull();
    expect(createCustomerSchema('GB').safeParse(body).success).toBe(true);
  });
});

describe('lock fields', () => {
  it('uses the contract rules', () => {
    expect(lockProblem({ lockType: 'PIN', secret: '12', pattern: [] })).toBe('Use 4–16 digits');
    expect(lockProblem({ lockType: 'PIN', secret: '0042', pattern: [] })).toBeNull();
    expect(lockProblem({ lockType: 'PATTERN', secret: '', pattern: [1, 2] })).toBe(
      'Connect at least 4 dots',
    );
    expect(lockProblem({ lockType: 'NOT_SHARED', secret: '', pattern: [] })).toBeNull();
  });
});

describe('status reorder', () => {
  it('moves an id to an index', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 'b', 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b'], 'a', 9)).toEqual(['b', 'a']);
  });
});

describe('status menu', () => {
  const T = '2026-01-01T00:00:00.000Z';
  const s = (
    id: string,
    category: 'OPEN' | 'WAITING' | 'READY' | 'CLOSED',
    systemRole: 'INITIAL' | 'COLLECTED' | 'CANCELLED' | null = null,
    extra = {},
  ) => ({
    id,
    name: id,
    category,
    systemRole,
    colour: 'info' as const,
    position: 0,
    isHidden: false,
    notifyCustomer: false,
    requiresNote: false,
    ticketCount: 0,
    createdAt: T,
    updatedAt: T,
    ...extra,
  });
  const all = [
    s('received', 'OPEN', 'INITIAL'),
    s('ready', 'READY'),
    s('hidden', 'OPEN', null, { isHidden: true }),
    s('collected', 'CLOSED', 'COLLECTED'),
    s('cancelled', 'CLOSED', 'CANCELLED'),
  ];

  it('offers allowed, visible targets; Collected only from READY with tickets.cancel', () => {
    const from = { ...all[0]!, colour: 'info' as const };
    expect(statusMenuTargets(from, all, permissionsFor('OWNER')).map((x) => x.id)).toEqual([
      'ready',
    ]);
    expect(collectBlockedReason(from, all, permissionsFor('OWNER'))?.message).toMatch(
      /Mark it Ready for pickup first/,
    );
    const ready = { ...all[1]! };
    expect(statusMenuTargets(ready, all, permissionsFor('OWNER')).map((x) => x.id)).toEqual([
      'received',
      'collected',
    ]);
    expect(statusMenuTargets(ready, all, permissionsFor('TECHNICIAN')).map((x) => x.id)).toEqual([
      'received',
    ]);
  });
});

describe('global search rows', () => {
  const r = GlobalSearchResponse.parse({
    tickets: [
      {
        id: 't1',
        numberLabel: 'T-1040',
        customerDisplayName: 'Sarah',
        deviceLabel: 'iPhone',
        status: {
          id: 's',
          name: 'Received',
          category: 'OPEN',
          colour: 'info',
          systemRole: 'INITIAL',
        },
      },
    ],
    customers: [
      {
        id: 'c1',
        kind: 'PERSON',
        displayName: 'Sarah',
        primaryPhone: null,
        email: 's@x.co',
        archivedAt: null,
      },
    ],
    devices: [
      {
        id: 'd1',
        type: 'PHONE',
        label: 'iPhone',
        imei: '356938035643809',
        serial: null,
        customer: { id: 'c1', displayName: 'Sarah' },
        latestTicket: { id: 't1', numberLabel: 'T-1040' },
      },
    ],
    exactMatch: { kind: 'device', deviceId: 'd1', customerId: 'c1', ticketId: 't1' },
  });

  it('puts the exact match first and groups by permission', () => {
    const items = searchItems('3569', r, { canTickets: true, canCustomers: true });
    expect(items[0]).toMatchObject({
      id: 'device:d1',
      auxiliaryData: { href: '/tickets/t1', group: 'Devices' },
    });
    expect(items.at(-1)).toMatchObject({
      label: 'See all ticket results',
      auxiliaryData: { href: '/tickets?view=all&q=3569' },
    });
    expect(
      searchItems('sa', r, { canTickets: false, canCustomers: true }).some((i) =>
        i.id.startsWith('ticket'),
      ),
    ).toBe(false);
  });
});
