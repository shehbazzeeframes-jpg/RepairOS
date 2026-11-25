import { describe, expect, it } from 'vitest';
import {
  AppendConsentsInput,
  ConsentChangeInput,
  CustomerListQuery,
  CustomerTags,
  DuplicateCheckQuery,
  EraseCustomerInput,
  GlobalSearchQuery,
  SearchCustomerResult,
  createCustomerSchema,
  currentConsent,
  customerDisplayName,
  customerExportFilename,
  customerRecordIssues,
  defaultPreferredChannel,
  effectiveConsentChanges,
  showTcpaWarning,
  splitQuickCreateText,
  updateCustomerSchema,
  whatsappLink,
} from './index';

describe('create customer (CU1, A2)', () => {
  it('PK: phones normalise to E.164, first is primary + WhatsApp, preferred defaults to WhatsApp', () => {
    const c = createCustomerSchema('PK').parse({
      firstName: ' Ali ',
      phones: [{ number: '0300-1234567' }, { number: '+92 321 7654321', label: 'WORK' }],
    });
    expect(c.displayName).toBe('Ali');
    expect(c.kind).toBe('PERSON');
    expect(c.preferredChannel).toBe('WHATSAPP');
    expect(c.phones).toEqual([
      { e164: '+923001234567', label: 'MOBILE', isPrimary: true, isWhatsapp: true, position: 0 },
      { e164: '+923217654321', label: 'WORK', isPrimary: false, isWhatsapp: false, position: 1 },
    ]);
  });
  it.each(['0300 1234567', '3001234567', '923001234567', '+92-300-1234567'])('PK %s → +923001234567', (number) => {
    expect(createCustomerSchema('PK').parse({ firstName: 'A', phones: [{ number }] }).phones[0]?.e164).toBe('+923001234567');
  });
  it('US/UK default SMS; email-only defaults to Email', () => {
    expect(createCustomerSchema('US').parse({ firstName: 'Sam', phones: [{ number: '(212) 555-0142' }] }).preferredChannel).toBe('SMS');
    expect(createCustomerSchema('GB').parse({ firstName: 'Sam', email: 'SAM@X.COM' })).toMatchObject({ preferredChannel: 'EMAIL', email: 'sam@x.com', phones: [] });
    expect(defaultPreferredChannel('PK')).toBe('WHATSAPP');
  });
  it('choosing another primary / WhatsApp number moves the flag', () => {
    const c = createCustomerSchema('GB').parse({
      firstName: 'Jo',
      phones: [{ number: '07911 123456' }, { number: '020 7946 0018', label: 'LANDLINE', isPrimary: true }, { number: '07400 123456', isWhatsapp: true }],
    });
    expect(c.phones.map((p) => [p.isPrimary, p.isWhatsapp])).toEqual([[false, false], [true, false], [false, true]]);
  });
  it('rejects invalid and repeated numbers, two primaries, more than 3 phones', () => {
    const s = createCustomerSchema('GB');
    const bad = s.safeParse({ firstName: 'Jo', phones: [{ number: '12' }] });
    expect(!bad.success && bad.error.issues[0]).toMatchObject({ path: ['phones', 0, 'number'], message: 'Enter a valid phone number' });
    expect(s.safeParse({ firstName: 'Jo', phones: [{ number: '07911 123456' }, { number: '+447911123456' }] }).success).toBe(false);
    expect(s.safeParse({ firstName: 'Jo', phones: [{ number: '07911 123456', isPrimary: true }, { number: '07400 123456', isPrimary: true }] }).success).toBe(false);
    expect(s.safeParse({ firstName: 'Jo', phones: Array.from({ length: 4 }, (_, i) => ({ number: `0791112345${i}` })) }).success).toBe(false);
  });
  it('international numbers are accepted in any shop', () => {
    expect(createCustomerSchema('GB').parse({ firstName: 'A', phones: [{ number: '+92 300 1234567' }] }).phones[0]?.e164).toBe('+923001234567');
  });
  it('needs a first name (person) or business name, and a phone or email', () => {
    const s = createCustomerSchema('US');
    expect(s.safeParse({ email: 'a@b.co' }).success).toBe(false);
    expect(s.safeParse({ firstName: 'A' }).success).toBe(false);
    expect(s.safeParse({ kind: 'BUSINESS', firstName: 'A', email: 'a@b.co' }).success).toBe(false);
    const biz = s.parse({ kind: 'BUSINESS', businessName: 'Acme Ltd', email: 'a@b.co' });
    expect(biz.displayName).toBe('Acme Ltd');
    expect(customerDisplayName({ kind: 'PERSON', firstName: 'Ali', lastName: 'Khan' })).toBe('Ali Khan');
    expect(customerRecordIssues({ kind: 'PERSON', firstName: 'A', phones: [], email: 'a@b.co', preferredChannel: 'SMS' })).toEqual([
      { path: ['preferredChannel'], message: 'Add a phone number for this contact method' },
    ]);
  });
  it('validates address for the shop country and normalises it', () => {
    const c = createCustomerSchema('GB').parse({ firstName: 'A', email: 'a@b.co', postcode: 'sw1a1aa' });
    expect(c.postcode).toBe('SW1A 1AA');
    expect(createCustomerSchema('US').safeParse({ firstName: 'A', email: 'a@b.co', region: 'XX' }).success).toBe(false);
  });
  it('tags: trimmed, case-insensitive dedupe keeping first casing, max 10', () => {
    expect(CustomerTags.parse([' VIP ', 'vip', 'Trade'])).toEqual(['VIP', 'Trade']);
    expect(CustomerTags.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(false);
    expect(CustomerTags.safeParse(['x'.repeat(31)]).success).toBe(false);
  });
  it('initial consents: only granted ones are kept', () => {
    const c = createCustomerSchema('GB').parse({
      firstName: 'A',
      email: 'a@b.co',
      consents: [
        { channel: 'EMAIL', state: 'GRANTED', source: 'ONLINE_FORM' },
        { channel: 'SMS', state: 'WITHDRAWN' },
      ],
    });
    expect(c.consents).toEqual([{ channel: 'EMAIL', purpose: 'MARKETING', state: 'GRANTED', source: 'ONLINE_FORM', note: null }]);
  });
});

describe('update customer (CU3)', () => {
  it('requires version; absent fields stay undefined; "" clears', () => {
    const s = updateCustomerSchema('US');
    expect(s.safeParse({ firstName: 'A' }).success).toBe(false);
    const p = s.parse({ version: 3, notes: '', city: 'Austin' });
    expect(p).toMatchObject({ version: 3, notes: null, city: 'Austin' });
    expect(p.phones).toBeUndefined();
    expect(p.email).toBeUndefined();
    expect(s.parse({ version: 1, phones: [{ id: 'ph1', number: '(212) 555-0142' }] }).phones?.[0]).toMatchObject({ id: 'ph1', e164: '+12125550142' });
  });
});

describe('consent (CU4, A17)', () => {
  it('granting needs a source; withdrawing defaults to Customer request', () => {
    expect(ConsentChangeInput.safeParse({ channel: 'SMS', state: 'GRANTED' }).success).toBe(false);
    expect(ConsentChangeInput.parse({ channel: 'SMS', state: 'WITHDRAWN' }).source).toBe('CUSTOMER_REQUEST');
    expect(ConsentChangeInput.safeParse({ channel: 'SMS', state: 'GRANTED', source: 'IMPORT', note: 'x'.repeat(201) }).success).toBe(false);
    expect(AppendConsentsInput.safeParse({ changes: [] }).success).toBe(false);
    expect(
      AppendConsentsInput.safeParse({ changes: [{ channel: 'SMS', state: 'WITHDRAWN' }, { channel: 'SMS', state: 'WITHDRAWN' }] }).success,
    ).toBe(false);
  });
  it('current consent = latest event per channel; withdrawn then granted again keeps both', () => {
    const by = { userId: 'u', name: 'Sam' };
    const events = [
      { channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_VERBAL', createdAt: '2026-03-12T10:00:00.000Z', recordedBy: by },
      { channel: 'SMS', state: 'WITHDRAWN', source: 'CUSTOMER_REQUEST', createdAt: '2026-04-01T10:00:00.000Z', recordedBy: by },
      { channel: 'EMAIL', state: 'GRANTED', source: 'ONLINE_FORM', createdAt: '2026-04-02T10:00:00.000Z', recordedBy: null },
      { channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED', createdAt: '2026-05-01T10:00:00.000Z', recordedBy: by },
    ] as const;
    const c = currentConsent(events);
    expect(c.SMS).toEqual({ granted: true, since: '2026-05-01T10:00:00.000Z', source: 'IN_STORE_SIGNED', recordedByName: 'Sam' });
    expect(c.EMAIL.granted).toBe(true);
    expect(c.WHATSAPP).toEqual({ granted: false, since: null, source: null, recordedByName: null });
    expect(currentConsent([...events].reverse()).SMS.source).toBe('IN_STORE_SIGNED');
  });
  it('no-op changes are dropped', () => {
    const c = currentConsent([{ channel: 'SMS', state: 'GRANTED', source: 'IMPORT', createdAt: '2026-01-01T00:00:00.000Z', recordedBy: null }]);
    const changes = [
      { channel: 'SMS', state: 'GRANTED' },
      { channel: 'EMAIL', state: 'WITHDRAWN' },
      { channel: 'WHATSAPP', state: 'GRANTED' },
    ] as const;
    expect(effectiveConsentChanges(c, changes)).toEqual([{ channel: 'WHATSAPP', state: 'GRANTED' }]);
  });
  it('TCPA warning only for US + SMS + granted verbally', () => {
    expect(showTcpaWarning('US', { channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_VERBAL' })).toBe(true);
    expect(showTcpaWarning('US', { channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED' })).toBe(false);
    expect(showTcpaWarning('GB', { channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_VERBAL' })).toBe(false);
    expect(showTcpaWarning('US', { channel: 'EMAIL', state: 'GRANTED', source: 'IN_STORE_VERBAL' })).toBe(false);
  });
});

describe('customer queries and helpers', () => {
  it('list query: defaults, multi-value params, archived off by default', () => {
    const q = CustomerListQuery.parse({ tags: 'VIP,trade', consent: ['SMS', 'EMAIL'] });
    expect(q).toMatchObject({ sort: 'name', limit: 25, archived: false, tags: ['VIP', 'trade'], consent: ['SMS', 'EMAIL'] });
    expect(q.hasOpen).toBeUndefined();
    expect(CustomerListQuery.safeParse({ q: 'a' }).success).toBe(false);
    expect(CustomerListQuery.safeParse({ limit: '30' }).success).toBe(false);
    expect(CustomerListQuery.parse({ limit: '100', hasOpen: 'true' })).toMatchObject({ limit: 100, hasOpen: true });
    expect(CustomerListQuery.safeParse({ consent: 'FAX' }).success).toBe(false);
    expect(CustomerListQuery.safeParse({ createdFrom: '2026-02-02', createdTo: '2026-02-01' }).success).toBe(false);
  });
  it('duplicate check needs a phone or email', () => {
    expect(DuplicateCheckQuery.safeParse({}).success).toBe(false);
    expect(DuplicateCheckQuery.safeParse({ phone: '0300 1234567' }).success).toBe(true);
  });
  it('erase requires typing ERASE', () => {
    expect(EraseCustomerInput.safeParse({ confirm: 'ERASE' }).success).toBe(true);
    expect(EraseCustomerInput.safeParse({ confirm: 'erase' }).success).toBe(false);
  });
  it('quick-create text split (TK2.1)', () => {
    expect(splitQuickCreateText('ali khan jr')).toEqual({ firstName: 'ali', lastName: 'khan jr' });
    expect(splitQuickCreateText('Ali')).toEqual({ firstName: 'Ali', lastName: null });
    expect(splitQuickCreateText('0300-1234567')).toEqual({ phone: '0300-1234567' });
    expect(splitQuickCreateText('+44 (7911) 123456')).toEqual({ phone: '+44 (7911) 123456' });
    expect(splitQuickCreateText('sam@x.com')).toEqual({ email: 'sam@x.com' });
  });
  it('links and filenames', () => {
    expect(whatsappLink('+923001234567')).toBe('https://wa.me/923001234567');
    expect(customerExportFilename('c1', '2026-11-25')).toBe('customer-c1-2026-11-25.json');
  });
});

describe('R5: archived customers in check-in search', () => {
  it('GlobalSearchQuery.includeArchived and CustomerListQuery.archived default to false', () => {
    expect(GlobalSearchQuery.parse({ q: 'ali' }).includeArchived).toBe(false);
    expect(GlobalSearchQuery.parse({ q: 'ali', includeArchived: 'true' }).includeArchived).toBe(true);
    expect(CustomerListQuery.parse({}).archived).toBe(false);
    expect(CustomerListQuery.parse({ archived: '1' }).archived).toBe(true);
    const archivedAt = '2026-11-25T09:00:00.000Z';
    expect(SearchCustomerResult.parse({ id: 'c', kind: 'PERSON', displayName: 'A', primaryPhone: null, email: null, archivedAt }).archivedAt).toBe(
      archivedAt,
    );
  });
});
