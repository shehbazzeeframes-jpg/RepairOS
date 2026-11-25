import { CHECK_IN_DRAFT_TTL_HOURS, checkInDraftKey, createTicketSchema } from '@repairos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_NEW_DEVICE,
  NEW_DEVICE,
  buildCreateTicketInput,
  checkInProblems,
  clearDraft,
  draftState,
  emptyCheckIn,
  filterIssues,
  firstEmptyQuickField,
  imeiError,
  isWorthDrafting,
  looksLikeImei,
  newIdempotencyKey,
  readDraft,
  seedFromTyped,
  writeDraft,
  type CheckInState,
} from './check-in';
import { memoryStorage } from './test-storage';

const returning = (): CheckInState => ({
  ...emptyCheckIn('2026-11-27'),
  customer: {
    id: 'cus_1',
    displayName: 'Ali Khan',
    primaryPhone: '+447400123456',
    email: null,
    archived: false,
  },
  customerDone: true,
  deviceChoice: 'dev_1',
  device: { id: 'dev_1', type: 'PHONE', brand: 'Apple', model: 'iPhone 13' },
  deviceDone: true,
  issues: ['SCREEN_CRACKED'],
});

const brandNew = (): CheckInState => ({
  ...emptyCheckIn('2026-11-27'),
  newCustomer: {
    firstName: 'Priya',
    lastName: 'Shah',
    phone: '07400 900123',
    email: '',
    consents: { SMS: true, EMAIL: false, WHATSAPP: false },
    consentSource: 'IN_STORE_SIGNED',
  },
  customerDone: true,
  deviceChoice: NEW_DEVICE,
  newDevice: {
    ...EMPTY_NEW_DEVICE,
    brand: 'Apple',
    model: 'iPhone 13',
    imei: '490154203237518',
    lockType: 'PIN',
    secret: '1234',
  },
  deviceDone: true,
  issues: ['BATTERY'],
  estimate: '129.5',
  accessories: ['CASE', 'OTHER'],
  accessoriesOther: 'Pen drive',
  assignee: 'usr_2',
  priority: 'URGENT',
});

describe('check-in body', () => {
  it('maps a returning customer and device onto ids (passes createTicketSchema)', () => {
    const body = buildCreateTicketInput(returning(), 'GBP');
    expect(body).toMatchObject({
      customerId: 'cus_1',
      deviceId: 'dev_1',
      issues: [{ code: 'SCREEN_CRACKED' }],
      dueDate: '2026-11-27',
      estimate: null,
    });
    expect(body).not.toHaveProperty('newCustomer');
    expect(createTicketSchema('GB').safeParse(body).success).toBe(true);
  });

  it('maps a new customer and device with passcode, consents, money in minor units', () => {
    const body = buildCreateTicketInput(brandNew(), 'GBP');
    expect(body.newCustomer).toMatchObject({
      firstName: 'Priya',
      phones: [{ number: '07400 900123', label: 'MOBILE' }],
      consents: [{ channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED' }],
    });
    expect(body.newDevice).toMatchObject({
      model: 'iPhone 13',
      imei: '490154203237518',
      passcode: { lockType: 'PIN', value: '1234' },
    });
    expect(body.estimate).toEqual({ amountMinor: 12950, currency: 'GBP' });
    expect(body).toMatchObject({
      accessoriesOther: 'Pen drive',
      assigneeUserId: 'usr_2',
      priority: 'URGENT',
    });
    expect(createTicketSchema('GB').safeParse(body).success).toBe(true);
  });

  it('rounds PKR estimates to whole rupees and sends a re-entered passcode for an existing device', () => {
    const s: CheckInState = {
      ...returning(),
      estimate: '4,999.6',
      devicePasscode: { lockType: 'PATTERN', secret: '', pattern: [1, 5, 9, 6] },
    };
    const body = buildCreateTicketInput(s, 'PKR');
    expect(body.estimate).toEqual({ amountMinor: 500000, currency: 'PKR' });
    expect(body.devicePasscode).toEqual({ lockType: 'PATTERN', pattern: [1, 5, 9, 6] });
  });

  it('adds the warranty link', () => {
    expect(
      buildCreateTicketInput({ ...returning(), warrantyOfTicketId: 'tkt_998' }, 'GBP')
        .warrantyOfTicketId,
    ).toBe('tkt_998');
  });

  it('lists what blocks Create in page order', () => {
    expect(checkInProblems(emptyCheckIn('2026-11-27')).map((p) => p.key)).toEqual([
      'customer',
      'device',
      'issues',
    ]);
    expect(checkInProblems({ ...returning(), issues: [], description: 'Screen flickers' })).toEqual(
      [],
    );
  });
});

describe('check-in draft (TK3)', () => {
  beforeEach(() => vi.stubGlobal('window', { localStorage: memoryStorage() }));
  afterEach(() => vi.unstubAllGlobals());

  it('never stores the PIN, password or pattern', () => {
    const { state, hadSecret } = draftState(brandNew());
    expect(hadSecret).toBe(true);
    expect(state.newDevice?.secret).toBe('');
    expect(JSON.stringify(state)).not.toContain('1234"');
  });

  it('round-trips under the user + shop key and expires after 24 hours', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    writeDraft('usr_1', 'shp_1', brandNew(), 'key-1', now);
    const raw = window.localStorage.getItem(checkInDraftKey('usr_1', 'shp_1')) ?? '';
    expect(raw).not.toContain('"secret":"1234"');
    expect(readDraft('usr_1', 'shp_2', now.getTime())).toBeNull();
    const back = readDraft('usr_1', 'shp_1', now.getTime() + 3_600_000);
    expect(back?.idempotencyKey).toBe('key-1');
    expect(back?.state.newCustomer?.firstName).toBe('Priya');
    expect(
      readDraft('usr_1', 'shp_1', now.getTime() + (CHECK_IN_DRAFT_TTL_HOURS + 1) * 3_600_000),
    ).toBeNull();
    writeDraft('usr_1', 'shp_1', brandNew(), 'key-1', now);
    clearDraft('usr_1', 'shp_1');
    expect(readDraft('usr_1', 'shp_1', now.getTime())).toBeNull();
  });

  it('only drafts something worth keeping', () => {
    expect(isWorthDrafting(emptyCheckIn('2026-11-27'))).toBe(false);
    expect(isWorthDrafting(returning())).toBe(true);
  });

  it('makes uuid idempotency keys', () => {
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('check-in search helpers', () => {
  it('places typed text into the quick form (TK2.1) and focuses the first empty field', () => {
    expect(seedFromTyped('Priya Shah')).toEqual({
      firstName: 'Priya',
      lastName: 'Shah',
      phone: '',
      email: '',
    });
    expect(seedFromTyped('0300 1234567').phone).toBe('0300 1234567');
    expect(seedFromTyped('a@b.co').email).toBe('a@b.co');
    expect(firstEmptyQuickField(seedFromTyped('Priya Shah'))).toBe('Phone');
    expect(firstEmptyQuickField(seedFromTyped('07400 900123'))).toBe('First name');
  });

  it('uses the contract IMEI copy and spots a scanned IMEI', () => {
    expect(imeiError('')).toBeNull();
    expect(imeiError('356938035643809')).toBeNull();
    expect(imeiError('356938035643808')).toMatch(/^This IMEI isn't valid/);
    expect(imeiError('35693803564380')).toMatch(/IMEI has 15 digits$/);
    expect(looksLikeImei('35-693803-564380-9')).toBe(true);
    expect(looksLikeImei('07400 123456')).toBe(false);
  });

  it('filters issue chips by word prefix first', () => {
    expect(filterIssues('scr', 'PHONE')[0]).toBe('SCREEN_CRACKED');
    expect(filterIssues('', 'CONSOLE')).toContain('CONTROLLER_DRIFT');
  });
});
