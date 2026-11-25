import {
  GlobalSearchResponse,
  createCustomerSchema,
  permissionsFor,
  type ConsentSummary,
  type CustomerDetail,
} from '@repairos/contracts';
import { describe, expect, it } from 'vitest';
import { searchItems } from './CommandSearch';
import {
  consentChangesFrom,
  consentValueFrom,
  missingConsentSources,
} from './customers/ConsentEditor';
import {
  customerBody,
  customerPatch,
  formValuesFrom,
  reloadCustomerValues,
} from './customers/CustomerForm';
import { lockProblem } from './devices/LockFields';
import { moveId } from './settings/TicketStatusesPage';
import { collectBlockedReason, statusMenuTargets } from './tickets/status-change';
import { statusColumnMinWidth } from './tickets/TicketTable';

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

describe('customer edit after a version conflict (BUG-02)', () => {
  // Only the fields the form reads.
  const ali = {
    id: 'cus_1',
    version: 4,
    kind: 'PERSON',
    displayName: 'Ali Khan',
    firstName: 'Ali',
    lastName: 'Khan',
    businessName: null,
    businessContactName: null,
    email: null,
    primaryPhone: '+447400123456',
    phones: [{ id: 'ph_1', e164: '+447400123456', label: 'MOBILE', isPrimary: true, position: 0 }],
    whatsappPhoneId: 'ph_1',
    preferredChannel: 'SMS',
    serviceOptOutSms: false,
    serviceOptOutEmail: false,
    serviceOptOutWhatsapp: false,
    tags: [],
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postcode: null,
    notes: null,
    consent: { SMS: none, EMAIL: none, WHATSAPP: none },
    openTicketCount: 0,
    ticketCount: 0,
    deviceCount: 0,
    lastVisitAt: null,
    archivedAt: null,
    erasedAt: null,
    createdAt: '2026-01-10T10:00:00.000Z',
    updatedAt: '2026-01-10T10:00:00.000Z',
  } as unknown as CustomerDetail;

  it('sends only the changed fields with the base version', () => {
    const v = formValuesFrom(ali, 'GB');
    v.lastName = 'Khan-Smith';
    expect(customerPatch(formValuesFrom(ali, 'GB'), v, ali.version)).toEqual({
      version: 4,
      lastName: 'Khan-Smith',
    });
  });

  it('Reload keeps my edit and takes the colleague’s note', () => {
    const mine = formValuesFrom(ali, 'GB');
    mine.lastName = 'Khan-Smith';
    const fresh = { ...ali, version: 5, notes: 'Prefers a call' };
    const merged = reloadCustomerValues(ali, mine, fresh, 'GB');
    expect(merged).toMatchObject({ version: 5, lastName: 'Khan-Smith', notes: 'Prefers a call' });
    expect(customerPatch(formValuesFrom(fresh, 'GB'), merged, 5)).toEqual({
      version: 5,
      lastName: 'Khan-Smith',
    });
  });
});

describe('ticket list status column (BUG-05)', () => {
  it('is wide enough for the longest status name', () => {
    expect(statusColumnMinWidth(['Received'])).toBe(128);
    expect(statusColumnMinWidth(['Received', 'Awaiting approval'])).toBeGreaterThan(180);
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
