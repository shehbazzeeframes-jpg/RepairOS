/**
 * Mock data and helpers for the check-in prototype (/prototype/check-in).
 *
 * Everything that is product data comes from `@repairos/contracts` (issue presets, checklist items,
 * accessories, the model catalogue, IMEI rules, quick-create splitting, due-date maths, money parsing),
 * and the mock records are parsed with the contract read schemas (`Device`, `CheckInContext`), so the
 * prototype breaks loudly when a contract changes. Only the customer search itself is faked here;
 * the real page calls GET /api/customers?q= (and the scanner path GET /api/devices/lookup).
 */
import {
  CheckInContext,
  DEFAULT_BUSINESS_HOURS,
  DEVICE_MODEL_CATALOGUE,
  Device,
  IMEI_ERROR,
  IMEI_LENGTH_HINT,
  ISSUE_LABELS,
  ISSUE_PRESETS_BY_DEVICE_TYPE,
  computeDefaultDueAt,
  isValidImei,
  normalizeImei,
  splitQuickCreateText,
  type CatalogueModel,
  type CountryCode,
  type CurrencyCode,
  type DeviceTypeValue,
  type IssueCode,
  type LockType,
} from '@repairos/contracts';

export interface MockCustomer {
  id: string;
  displayName: string;
  /** E.164 */
  primaryPhone: string;
  email: string | null;
  notes: string | null;
  archived: boolean;
  devices: Device[];
}

const T0 = '2026-01-10T10:00:00.000Z';

function device(
  id: string,
  customerId: string,
  d: {
    type: DeviceTypeValue;
    brand: string;
    model: string;
    colour?: string;
    imei?: string;
    lockType: LockType;
    lastTicketAt: string;
    openTicket?: { id: string; number: number };
  },
): Device {
  return Device.parse({
    id,
    customerId,
    type: d.type,
    brand: d.brand,
    model: d.model,
    colour: d.colour ?? null,
    imei: d.imei ?? null,
    serial: null,
    notes: null,
    lockType: d.lockType,
    passcodeOnFile: d.lockType === 'PIN' || d.lockType === 'PASSWORD' || d.lockType === 'PATTERN',
    passcodeSetAt: null,
    passcodeViewCount: 0,
    passcodeLastViewedAt: null,
    passcodeLastViewedBy: null,
    ticketCount: 1,
    openTicket: d.openTicket ? { ...d.openTicket, numberLabel: `T-${d.openTicket.number}` } : null,
    lastTicketAt: d.lastTicketAt,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

export const MOCK_CUSTOMERS: MockCustomer[] = [
  {
    id: 'cus_1',
    displayName: 'Ali Khan',
    primaryPhone: '+447400123456',
    email: 'ali.khan@example.com',
    notes: null,
    archived: false,
    devices: [
      device('dev_1', 'cus_1', {
        type: 'PHONE',
        brand: 'Apple',
        model: 'iPhone 13',
        colour: 'Blue',
        imei: '356938035643809',
        lockType: 'PIN',
        lastTicketAt: '2026-10-02T10:00:00.000Z',
      }),
      device('dev_2', 'cus_1', {
        type: 'TABLET',
        brand: 'Samsung',
        model: 'Galaxy Tab A8',
        lockType: 'NONE',
        lastTicketAt: '2025-06-14T10:00:00.000Z',
      }),
    ],
  },
  {
    id: 'cus_2',
    displayName: 'Sarah Jones',
    primaryPhone: '+447400555010',
    email: 'sarah@jonesandco.co.uk',
    notes: 'Prefers a call after 5pm. Business account: invoice to Jones & Co.',
    archived: false,
    devices: [
      device('dev_3', 'cus_2', {
        type: 'PHONE',
        brand: 'Apple',
        model: 'iPhone 15 Pro',
        colour: 'Natural Titanium',
        lockType: 'PIN',
        lastTicketAt: '2026-11-21T10:00:00.000Z',
        openTicket: { id: 'tkt_1040', number: 1040 },
      }),
    ],
  },
  {
    id: 'cus_3',
    displayName: 'Alina Kowalska',
    primaryPhone: '+447400777312',
    email: null,
    notes: null,
    archived: false,
    devices: [
      device('dev_4', 'cus_3', {
        type: 'LAPTOP',
        brand: 'Apple',
        model: 'MacBook Air M2',
        lockType: 'PASSWORD',
        lastTicketAt: '2026-09-11T10:00:00.000Z',
      }),
    ],
  },
  {
    id: 'cus_4',
    displayName: 'Khalid Mahmood',
    primaryPhone: '+923001234567',
    email: null,
    notes: null,
    archived: true,
    devices: [],
  },
];

export const MOCK_ASSIGNEES = [
  { userId: 'usr_2', name: 'Sam Patel', role: 'TECHNICIAN', isSelf: false },
  { userId: 'usr_3', name: 'Jo Reid', role: 'TECHNICIAN', isSelf: false },
  { userId: 'usr_1', name: 'Alex Morgan', role: 'OWNER', isSelf: true },
] as const;

/** What GET /api/tickets/check-in-context would return for the signed-in shop (mock hours: closed Sunday). */
export function mockCheckInContext(
  shop: {
    country: CountryCode;
    currency: CurrencyCode;
    locale: string;
    timezone: string;
    pricesIncludeTax: boolean;
  },
  now: Date = new Date(),
): CheckInContext {
  const due = computeDefaultDueAt(now, 2, DEFAULT_BUSINESS_HOURS, shop.timezone);
  return CheckInContext.parse({
    serverNow: now.toISOString(),
    country: shop.country,
    currency: shop.currency,
    locale: shop.locale,
    timezone: shop.timezone,
    pricesIncludeTax: shop.pricesIncludeTax,
    hours: DEFAULT_BUSINESS_HOURS,
    defaultTurnaroundDays: 2,
    numberPrefix: 'T-',
    defaultDue: { dueAt: due.dueAt, date: due.date, dueHasTime: false },
  });
}

// ---------- Helpers ----------

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface CustomerMatch {
  customer: MockCustomer;
  /** Set when the query was a full IMEI: check-in selects this device too (scanner path). */
  device?: Device;
}

/**
 * Stand-in for GET /api/customers?q= (CU5.2) and GET /api/devices/lookup?imei= on the mock records:
 * every name word contained (any order, accent-insensitive), 4+ digits as a phone substring (a
 * national number's leading 0 is dropped), email contains, or a full 15-digit IMEI.
 */
export function searchCustomers(
  query: string,
  customers = MOCK_CUSTOMERS,
  limit = 8,
): CustomerMatch[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const digits = digitsOf(q);
  const isDigitQuery = /^[\d\s()+\-./]+$/.test(q);
  const out: CustomerMatch[] = [];
  for (const customer of customers) {
    if (isDigitQuery && isValidImei(q)) {
      const match = customer.devices.find((d) => d.imei === normalizeImei(q));
      if (match) out.push({ customer, device: match });
      continue;
    }
    if (isDigitQuery) {
      const national = digits.replace(/^0+/, '');
      if (national.length >= 4 && digitsOf(customer.primaryPhone).includes(national))
        out.push({ customer });
      continue;
    }
    if (q.includes('@')) {
      if (customer.email?.toLowerCase().includes(q.toLowerCase())) out.push({ customer });
      continue;
    }
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hay = fold(`${customer.displayName} ${customer.email ?? ''}`);
    if (words.every((w) => hay.includes(w))) out.push({ customer });
  }
  return out.slice(0, limit);
}

export interface QuickCustomerSeed {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

/** TK2.1 via the contract's `splitQuickCreateText`, as the quick form's four fields. */
export function seedFromTyped(typed: string): QuickCustomerSeed {
  const seed = { firstName: '', lastName: '', phone: '', email: '' };
  if (!typed.trim()) return seed;
  const split = splitQuickCreateText(typed);
  if ('email' in split) return { ...seed, email: split.email };
  if ('phone' in split) return { ...seed, phone: split.phone };
  return { ...seed, firstName: split.firstName, lastName: split.lastName ?? '' };
}

/** Field message for the IMEI input (contract copy), null when empty or valid. */
export function imeiError(raw: string): string | null {
  const s = normalizeImei(raw);
  if (!s || isValidImei(s)) return null;
  return /^\d+$/.test(s) && (s.length === 14 || s.length === 16)
    ? `${IMEI_ERROR} ${IMEI_LENGTH_HINT}`
    : IMEI_ERROR;
}

/**
 * One-box model search over the whole catalogue ("iph 13" → Apple iPhone 13, Phone): every word must
 * appear in "brand model". Design recommendation R1 in the spec: the real page needs
 * `ModelSuggestionsQuery.type` to become optional (and items to carry type + brand) for this.
 */
export function searchModels(query: string, limit = 8): CatalogueModel[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // Shortest match first, so "iph 13" puts iPhone 13 above iPhone 13 mini / Pro (↵ takes the top row).
  return DEVICE_MODEL_CATALOGUE.map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      const hay = fold(`${m.brand} ${m.model}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.m.model.length - b.m.model.length || a.i - b.i)
    .slice(0, limit)
    .map(({ m }) => m);
}

/** Issue chips for a device type, matching the filter (word prefix first, then contains). */
export function filterIssues(query: string, type: DeviceTypeValue): IssueCode[] {
  const presets = ISSUE_PRESETS_BY_DEVICE_TYPE[type];
  const q = fold(query.trim());
  if (!q) return [...presets];
  const label = (c: IssueCode) => fold(ISSUE_LABELS[c]);
  const starts = presets.filter((c) =>
    label(c)
      .split(/[\s/]+/)
      .some((w) => w.startsWith(q)),
  );
  const contains = presets.filter((c) => !starts.includes(c) && label(c).includes(q));
  return [...starts, ...contains];
}
