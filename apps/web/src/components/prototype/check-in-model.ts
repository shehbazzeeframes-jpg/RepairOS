/**
 * Mock data and pure helpers for the check-in prototype (/prototype/check-in).
 *
 * Local stand-ins only: the real build takes customers/devices from the API and the constants
 * (issue presets, model catalogue, `isValidImei`) from `packages/contracts` once they land.
 * The helpers that encode story rules (TK2.1 placing typed text, DV2 IMEI) are unit-tested so the
 * real build can compare against them.
 */

export type DeviceType = 'PHONE' | 'TABLET' | 'LAPTOP' | 'DESKTOP' | 'CONSOLE' | 'WATCH' | 'OTHER';
export type LockType = 'NONE' | 'PIN' | 'PASSWORD' | 'PATTERN' | 'NOT_SHARED';

export interface MockDevice {
  id: string;
  type: DeviceType;
  brand: string;
  model: string;
  colour?: string;
  imei?: string;
  lockType: LockType;
  openTicket?: string;
  lastUsed: string;
}

export interface MockCustomer {
  id: string;
  name: string;
  phone: string; // E.164
  email?: string;
  note?: string;
  archived?: boolean;
  devices: MockDevice[];
}

export const MOCK_CUSTOMERS: MockCustomer[] = [
  {
    id: 'cus_1',
    name: 'Ali Khan',
    phone: '+447400123456',
    email: 'ali.khan@example.com',
    devices: [
      {
        id: 'dev_1',
        type: 'PHONE',
        brand: 'Apple',
        model: 'iPhone 13',
        colour: 'Blue',
        imei: '356938035643809',
        lockType: 'PIN',
        lastUsed: '2026-10-02',
      },
      {
        id: 'dev_2',
        type: 'TABLET',
        brand: 'Samsung',
        model: 'Galaxy Tab A8',
        lockType: 'NONE',
        lastUsed: '2025-06-14',
      },
    ],
  },
  {
    id: 'cus_2',
    name: 'Sarah Jones',
    phone: '+447400555010',
    email: 'sarah@jonesandco.co.uk',
    note: 'Prefers a call after 5pm. Business account: invoice to Jones & Co.',
    devices: [
      {
        id: 'dev_3',
        type: 'PHONE',
        brand: 'Apple',
        model: 'iPhone 15 Pro',
        colour: 'Natural Titanium',
        lockType: 'PIN',
        openTicket: 'T-1040',
        lastUsed: '2026-11-21',
      },
    ],
  },
  {
    id: 'cus_3',
    name: 'Alina Kowalska',
    phone: '+447400777312',
    devices: [
      {
        id: 'dev_4',
        type: 'LAPTOP',
        brand: 'Apple',
        model: 'MacBook Air M2',
        lockType: 'PASSWORD',
        lastUsed: '2026-09-11',
      },
    ],
  },
  {
    id: 'cus_4',
    name: 'Khalid Mahmood',
    phone: '+923001234567',
    archived: true,
    devices: [],
  },
];

/** A slice of the DV1 seed catalogue: enough to prove "one search fills type, brand and model". */
export const MODEL_CATALOGUE: { type: DeviceType; brand: string; model: string }[] = [
  ...['iPhone 11', 'iPhone 12', 'iPhone 13', 'iPhone 13 mini', 'iPhone 14', 'iPhone 14 Pro', 'iPhone 15', 'iPhone 15 Pro', 'iPhone 15 Pro Max', 'iPhone 16', 'iPhone SE (3rd gen)'].map(
    (model) => ({ type: 'PHONE' as const, brand: 'Apple', model }),
  ),
  ...['Galaxy S23', 'Galaxy S24', 'Galaxy S24 Ultra', 'Galaxy A15', 'Galaxy A55'].map((model) => ({
    type: 'PHONE' as const,
    brand: 'Samsung',
    model,
  })),
  ...['Pixel 8', 'Pixel 8 Pro', 'Pixel 9'].map((model) => ({ type: 'PHONE' as const, brand: 'Google', model })),
  ...['Redmi Note 13', 'Redmi Note 12'].map((model) => ({ type: 'PHONE' as const, brand: 'Xiaomi', model })),
  ...['Hot 40', 'Note 30'].map((model) => ({ type: 'PHONE' as const, brand: 'Infinix', model })),
  ...['iPad (10th gen)', 'iPad Air', 'iPad Pro 11"'].map((model) => ({ type: 'TABLET' as const, brand: 'Apple', model })),
  ...['MacBook Air M2', 'MacBook Pro 14" M3'].map((model) => ({ type: 'LAPTOP' as const, brand: 'Apple', model })),
  { type: 'CONSOLE', brand: 'Sony', model: 'PlayStation 5' },
  { type: 'CONSOLE', brand: 'Nintendo', model: 'Switch OLED' },
  { type: 'WATCH', brand: 'Apple', model: 'Watch Series 9' },
];

export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  PHONE: 'Phone',
  TABLET: 'Tablet',
  LAPTOP: 'Laptop',
  DESKTOP: 'Desktop',
  CONSOLE: 'Console',
  WATCH: 'Watch',
  OTHER: 'Other',
};

export const LOCK_LABEL: Record<LockType, string> = {
  NONE: 'None',
  PIN: 'PIN',
  PASSWORD: 'Password',
  PATTERN: 'Pattern',
  NOT_SHARED: "Won't share",
};

export const PHONE_ISSUES = [
  'Screen cracked',
  'Display/touch not working',
  'Battery',
  'Charging port',
  'Back glass',
  'Camera',
  'Speaker/mic',
  'Water damage',
  "Won't turn on",
  'Software/updates',
  'Data recovery',
  'Buttons',
] as const;

export const ACCESSORIES = [
  'SIM card',
  'SIM tray',
  'Memory card',
  'Case',
  'Charger',
  'Cable',
  'Stylus',
  'Box',
] as const;

export const CHECKLIST = [
  'Powers on',
  'Screen/touch',
  'Front camera',
  'Rear camera',
  'Buttons',
  'Face ID / Touch ID',
  'Speakers',
  'Microphone',
  'Charging',
  'Wi-Fi/Bluetooth',
  'Liquid indicators',
] as const;

export const TECHNICIANS = [
  { id: 'usr_2', name: 'Sam Patel', role: 'Technician' },
  { id: 'usr_3', name: 'Jo Reid', role: 'Technician' },
  { id: 'usr_1', name: 'Alex Morgan', role: 'Owner' },
];

// ---------- Pure helpers ----------

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export interface CustomerMatch {
  customer: MockCustomer;
  /** Set when the query was a full IMEI: check-in selects this device too (scanner path). */
  device?: MockDevice;
}

/**
 * CU5.2-style matching on mock data: every name word contained (any order, accent-insensitive),
 * 4+ digits as a phone substring, email contains, or a full 15-digit IMEI. Archived customers are
 * returned (shown with "Restore and use"); erased ones never exist here.
 */
export function searchCustomers(query: string, customers = MOCK_CUSTOMERS, limit = 8): CustomerMatch[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const digits = digitsOf(q);
  const isDigitQuery = /^[\d\s()+\-./]+$/.test(q);
  const out: CustomerMatch[] = [];
  for (const customer of customers) {
    if (isDigitQuery && digits.length === 15) {
      const device = customer.devices.find((d) => d.imei === digits);
      if (device) out.push({ customer, device });
      continue;
    }
    if (isDigitQuery) {
      // A national number typed with its leading 0 ("07400 123456") still matches the stored E.164.
      const national = digits.replace(/^0+/, '');
      if (national.length >= 4 && digitsOf(customer.phone).includes(national)) out.push({ customer });
      continue;
    }
    if (q.includes('@')) {
      if (customer.email?.toLowerCase().includes(q.toLowerCase())) out.push({ customer });
      continue;
    }
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hay = fold(`${customer.name} ${customer.email ?? ''}`);
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

/** TK2.1: digits → phone, contains @ → email, else first word first name, the rest last name. */
export function seedFromTyped(typed: string): QuickCustomerSeed {
  const t = typed.trim();
  const seed = { firstName: '', lastName: '', phone: '', email: '' };
  if (!t) return seed;
  if (t.includes('@')) return { ...seed, email: t };
  if (/^[\d\s()+\-./]+$/.test(t) && digitsOf(t).length >= 4) return { ...seed, phone: t };
  const [first, ...rest] = t.split(/\s+/);
  return { ...seed, firstName: first ?? '', lastName: rest.join(' ') };
}

/** DV2: strip spaces/dashes/slashes; exactly 15 digits passing Luhn. */
export function normalizeImei(raw: string): string {
  return raw.replace(/[\s\-/]/g, '');
}

export function isValidImei(raw: string): boolean {
  const s = normalizeImei(raw);
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(s[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function imeiError(raw: string): string | null {
  const s = normalizeImei(raw);
  if (!s) return null;
  if (isValidImei(s)) return null;
  const base = "This IMEI isn't valid. Check the 15 digits (dial *#06# on the phone).";
  return /^\d+$/.test(s) && (s.length === 14 || s.length === 16) ? `${base} IMEI has 15 digits.` : base;
}

/** Catalogue search for the one-box model field: every word must appear in "brand model". */
export function searchModels(query: string, limit = 8) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return MODEL_CATALOGUE.filter((m) => {
    const hay = fold(`${m.brand} ${m.model}`);
    return words.every((w) => hay.includes(w));
  }).slice(0, limit);
}

/** Issue chips matching the filter text (prefix of any word first, then contains). */
export function filterIssues(query: string, issues: readonly string[] = PHONE_ISSUES): string[] {
  const q = fold(query.trim());
  if (!q) return [...issues];
  const starts = issues.filter((i) => fold(i).split(/[\s/]+/).some((w) => w.startsWith(q)));
  const contains = issues.filter((i) => !starts.includes(i) && fold(i).includes(q));
  return [...starts, ...contains];
}
