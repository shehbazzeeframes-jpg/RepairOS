/**
 * Sprint 2 demo data for the dev seed: customers (with phones and consent), devices and tickets across every
 * status category, with issues, checklist, accessories, notes and timeline events. Deterministic (seeded PRNG).
 *
 * Re-running replaces ALL customers, devices and tickets of the seeded shops and resets the ticket counter to
 * 1001 (dev data only; the seed refuses NODE_ENV=production).
 *
 * Passcodes: when FIELD_ENCRYPTION_KEY is a valid key, a few devices get an encrypted PIN/pattern so "Show passcode"
 * can be tried on an open ticket; otherwise those devices are "Customer won't share".
 */
import type { CountryCode, Prisma, PrismaClient } from '@prisma/client';
import {
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  formatTicketNumber,
  ISSUE_LABELS,
  ISSUE_PRESETS_BY_DEVICE_TYPE,
} from '@repairos/contracts';
import { encryptField, type FieldKeyring, isFieldKeyUnset, parseFieldKeyring, passcodeAad, passcodeColumns } from './field-crypto';
import { ensureTicketDefaults, nextTicketNumber } from './tickets';

/** Tiny deterministic PRNG (mulberry32), so every seed run produces the same demo data. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof prng>;

/** 15-digit IMEI with a valid Luhn check digit. */
export function makeImei(rng: Rng, tac = '35'): string {
  let body = tac;
  while (body.length < 14) body += String(rng.int(0, 9));
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

function makeSerial(rng: Rng, prefix: string, len = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = prefix;
  while (s.length < len) s += chars[rng.int(0, chars.length - 1)];
  return s;
}

interface MarketData {
  firstNames: readonly string[];
  lastNames: readonly string[];
  businesses: readonly string[];
  phone: (rng: Rng, i: number) => string;
  streets: readonly string[];
  city: string;
  region: string | null;
  postcodes: readonly string[];
  emailDomains: readonly string[];
  devices: readonly { type: 'PHONE' | 'TABLET' | 'LAPTOP' | 'CONSOLE' | 'WATCH'; brand: string; model: string }[];
}

const MARKETS: Partial<Record<CountryCode, MarketData>> = {
  US: {
    firstNames: ['James', 'Maria', 'Robert', 'Jennifer', 'Michael', 'Linda', 'David', 'Sofia', 'Daniel', 'Aisha', 'Kevin', 'Emily', 'Carlos', 'Grace', 'Tyler', 'Nicole', 'Brandon', 'Hannah', 'Marcus', 'Olivia', 'José', 'Chloé'],
    lastNames: ['Smith', 'Johnson', 'Williams', 'Brown', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Lee', 'Walker', 'Nguyen', 'Patel', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Peña'],
    businesses: ['Brooklyn Bagel Co', 'Hudson Realty Group', 'PS 87 Front Office', 'Midtown Dental Care', 'Liberty Courier LLC'],
    // 555-0100..0199 is reserved for fiction; libphonenumber accepts these for NYC area codes.
    phone: (rng, i) => `+1${rng.pick(['212', '646', '718', '917'])}5550${String(100 + (i % 100)).padStart(3, '0')}`,
    streets: ['W 23rd St', 'Broadway', 'Atlantic Ave', 'Lexington Ave', 'Bedford Ave', 'Amsterdam Ave'],
    city: 'New York',
    region: 'NY',
    postcodes: ['10001', '10011', '10023', '11201', '11217', '10128'],
    emailDomains: ['gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com'],
    devices: [
      { type: 'PHONE', brand: 'Apple', model: 'iPhone 13' },
      { type: 'PHONE', brand: 'Apple', model: 'iPhone 14 Pro' },
      { type: 'PHONE', brand: 'Apple', model: 'iPhone 15' },
      { type: 'PHONE', brand: 'Apple', model: 'iPhone SE (3rd generation)' },
      { type: 'PHONE', brand: 'Samsung', model: 'Galaxy S23' },
      { type: 'PHONE', brand: 'Samsung', model: 'Galaxy A54' },
      { type: 'PHONE', brand: 'Google', model: 'Pixel 8' },
      { type: 'PHONE', brand: 'Motorola', model: 'moto g (2023)' },
      { type: 'TABLET', brand: 'Apple', model: 'iPad (10th generation)' },
      { type: 'LAPTOP', brand: 'Apple', model: 'MacBook Air M2' },
      { type: 'LAPTOP', brand: 'Dell', model: 'XPS 13' },
      { type: 'CONSOLE', brand: 'Nintendo', model: 'Switch OLED' },
      { type: 'CONSOLE', brand: 'Sony', model: 'PlayStation 5' },
      { type: 'WATCH', brand: 'Apple', model: 'Apple Watch Series 8' },
    ],
  },
  PK: {
    firstNames: ['Ali', 'Ayesha', 'Usman', 'Fatima', 'Hamza', 'Zainab', 'Bilal', 'Sana', 'Imran', 'Hira'],
    lastNames: ['Khan', 'Ahmed', 'Malik', 'Butt', 'Chaudhry', 'Qureshi', 'Sheikh', 'Raza'],
    businesses: ['Hafeez Centre Mobiles', 'Lahore Grammar School Admin'],
    phone: (rng) => `+923${rng.pick(['00', '01', '21', '33', '45'])}${String(rng.int(1000000, 9999999))}`,
    streets: ['Main Boulevard Gulberg', 'MM Alam Road', 'Ferozepur Road', 'Model Town Link Road'],
    city: 'Lahore',
    region: 'Punjab',
    postcodes: ['54000', '54660', '54700'],
    emailDomains: ['gmail.com', 'yahoo.com', 'hotmail.com'],
    devices: [
      { type: 'PHONE', brand: 'Samsung', model: 'Galaxy A34' },
      { type: 'PHONE', brand: 'Infinix', model: 'Hot 30' },
      { type: 'PHONE', brand: 'Tecno', model: 'Spark 10 Pro' },
      { type: 'PHONE', brand: 'Xiaomi', model: 'Redmi Note 12' },
      { type: 'PHONE', brand: 'Apple', model: 'iPhone 11' },
      { type: 'PHONE', brand: 'Vivo', model: 'Y36' },
      { type: 'LAPTOP', brand: 'HP', model: 'EliteBook 840 G5' },
    ],
  },
};

const ACCESSORIES = ['SIM_CARD', 'CASE', 'CHARGER', 'CABLE'] as const;

/** Status name → how many tickets of the US shop sit there (PK gets a smaller mix). */
const STATUS_MIX_US: Record<string, number> = {
  Received: 6,
  Diagnosing: 4,
  'Awaiting approval': 3,
  'Awaiting parts': 3,
  'In repair': 5,
  'Ready for pickup': 5,
  Unrepairable: 1,
  Collected: 14,
  Cancelled: 3,
};
const STATUS_MIX_PK: Record<string, number> = { Received: 2, 'In repair': 2, 'Ready for pickup': 1, Collected: 3, Cancelled: 1 };

export interface SeedTicketShop {
  id: string;
  country: CountryCode;
  currency: 'USD' | 'GBP' | 'PKR';
  /** User ids of active staff who can be assigned (first = default creator). */
  staff: string[];
  /** A deactivated member still assigned to a ticket ("Unassigned" view case), if any. */
  formerStaff?: string | null;
  customerCount: number;
}

function keyringFromEnv(): FieldKeyring | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (isFieldKeyUnset(raw)) return null;
  try {
    return parseFieldKeyring(raw);
  } catch {
    return null;
  }
}

const DAY = 24 * 3600 * 1000;

interface SeedDevice {
  id: string;
  label: string;
  type: keyof typeof CHECKLIST_ITEMS_BY_DEVICE_TYPE;
}

export async function seedCustomersAndTickets(prisma: PrismaClient, shop: SeedTicketShop): Promise<void> {
  const m = MARKETS[shop.country];
  if (!m) return;
  const rng = prng(shop.country === 'US' ? 20261201 : 92001);
  const keyring = keyringFromEnv();
  const now = Date.now();
  const creator = shop.staff[0]!;

  await prisma.$transaction(
    async (tx) => {
      // Replace all Sprint 2 data of this (seed) shop.
      await tx.ticketEvent.deleteMany({ where: { shopId: shop.id } });
      await tx.ticketNote.deleteMany({ where: { shopId: shop.id } });
      await tx.ticket.updateMany({ where: { shopId: shop.id }, data: { warrantyOfTicketId: null } });
      await tx.ticket.deleteMany({ where: { shopId: shop.id } });
      await tx.device.deleteMany({ where: { shopId: shop.id } });
      await tx.customer.deleteMany({ where: { shopId: shop.id } });
      await ensureTicketDefaults(tx, shop.id);
      await tx.shopTicketSettings.update({ where: { shopId: shop.id }, data: { nextNumber: 1001 } });

      const statuses = await tx.ticketStatus.findMany({ where: { shopId: shop.id }, orderBy: { position: 'asc' } });
      const byName = new Map(statuses.map((s) => [s.name, s]));
      const received = statuses.find((s) => s.systemRole === 'INITIAL')!;

      // ---------- customers, phones, consent ----------
      const customers: { id: string; displayName: string; devices: SeedDevice[] }[] = [];
      for (let i = 0; i < shop.customerCount; i++) {
        const isBusiness = i % 9 === 4 && m.businesses.length > 0;
        const first = m.firstNames[i % m.firstNames.length]!;
        const last = rng.chance(shop.country === 'PK' ? 0.7 : 0.9) ? m.lastNames[(i * 7) % m.lastNames.length]! : null;
        const businessName = isBusiness ? m.businesses[Math.floor(i / 9) % m.businesses.length]! : null;
        const displayName = businessName ?? [first, last].filter(Boolean).join(' ');
        const id = `seed_cust_${shop.country.toLowerCase()}_${String(i + 1).padStart(3, '0')}`;
        const createdAt = new Date(now - rng.int(20, 400) * DAY);
        const hasEmail = rng.chance(0.6);
        const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
        const email = hasEmail ? `${ascii(first)}.${ascii(last ?? 'shop')}${i}@${rng.pick(m.emailDomains)}` : null;
        const smsConsent = rng.chance(0.3);
        await tx.customer.create({
          data: {
            id,
            shopId: shop.id,
            kind: isBusiness ? 'BUSINESS' : 'PERSON',
            firstName: isBusiness ? null : first,
            lastName: isBusiness ? null : last,
            businessName,
            businessContactName: isBusiness ? `${first} ${m.lastNames[i % m.lastNames.length]}` : null,
            displayName,
            email,
            addressLine1: rng.chance(0.4) ? `${rng.int(10, 999)} ${rng.pick(m.streets)}` : null,
            city: m.city,
            region: m.region,
            postcode: rng.pick(m.postcodes),
            notes: i === 2 ? 'Prefers a call after 5 pm. Has a second phone at the shop for repair.' : null,
            tags: i % 5 === 0 ? ['VIP'] : isBusiness ? ['Business account'] : [],
            preferredChannel: shop.country === 'PK' ? 'WHATSAPP' : 'SMS',
            marketingSmsAt: smsConsent ? createdAt : null,
            createdByUserId: creator,
            createdAt,
          },
        });
        const e164 = m.phone(rng, i);
        await tx.customerPhone.create({
          data: { shopId: shop.id, customerId: id, e164, digits: e164.slice(1), label: 'MOBILE', isPrimary: true, isWhatsapp: true, position: 0 },
        });
        if (i % 6 === 1) {
          const second = m.phone(rng, i + 50);
          if (second !== e164) {
            await tx.customerPhone.create({
              data: { shopId: shop.id, customerId: id, e164: second, digits: second.slice(1), label: 'WORK', position: 1 },
            });
          }
        }
        if (smsConsent) {
          await tx.customerConsentEvent.create({
            data: { shopId: shop.id, customerId: id, channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED', recordedByUserId: creator, createdAt },
          });
        }

        // ---------- devices ----------
        const devices: SeedDevice[] = [];
        const deviceCount = rng.chance(0.25) ? 2 : 1;
        for (let d = 0; d < deviceCount; d++) {
          const spec = rng.pick(m.devices);
          const deviceId = `${id}_dev_${d + 1}`;
          const withImei = spec.type === 'PHONE' || spec.type === 'TABLET' || spec.type === 'WATCH';
          let lock: Prisma.DeviceUncheckedCreateInput['lockType'] = rng.pick(['NONE', 'PIN', 'PIN', 'PATTERN', 'NOT_SHARED'] as const);
          let passcode: ReturnType<typeof passcodeColumns> | null = null;
          if (lock === 'PIN' || lock === 'PATTERN') {
            if (keyring) {
              const secret = lock === 'PIN' ? String(rng.int(0, 999999)).padStart(6, '0') : '1-5-9-6';
              passcode = passcodeColumns(encryptField(keyring, secret, passcodeAad(shop.id, deviceId)));
            } else {
              lock = 'NOT_SHARED';
            }
          }
          await tx.device.create({
            data: {
              id: deviceId,
              shopId: shop.id,
              customerId: id,
              type: spec.type,
              brand: spec.brand,
              model: spec.model,
              colour: rng.pick(['Black', 'White', 'Silver', 'Blue', 'Gold', null]),
              imei: withImei && rng.chance(0.8) ? makeImei(rng) : null,
              serial: !withImei || rng.chance(0.3) ? makeSerial(rng, spec.brand === 'Apple' ? 'C02' : 'SN') : null,
              lockType: lock,
              ...(passcode ?? {}),
              passcodeSetAt: passcode ? createdAt : null,
              createdByUserId: creator,
              createdAt,
            },
          });
          devices.push({ id: deviceId, label: `${spec.brand} ${spec.model}`, type: spec.type });
        }
        customers.push({ id, displayName, devices });
      }

      // ---------- tickets ----------
      const mix = shop.country === 'US' ? STATUS_MIX_US : STATUS_MIX_PK;
      const plan = Object.entries(mix).flatMap(([name, n]) => Array.from({ length: n }, () => name));
      // Oldest first so numbers grow with creation time: closed ones are older.
      plan.sort((a, b) => Number(byName.get(b)!.category === 'CLOSED') - Number(byName.get(a)!.category === 'CLOSED'));
      const openCount = new Map<string, number>();
      const lastVisit = new Map<string, Date>();
      let firstCollected: { id: string; number: number; customerIdx: number; deviceIdx: number } | null = null;
      const prefix = 'T-';

      for (let k = 0; k < plan.length; k++) {
        const status = byName.get(plan[k]!)!;
        const closed = status.category === 'CLOSED';
        const ci = (k * 5) % customers.length;
        const cust = customers[ci]!;
        const di = k % cust.devices.length;
        const dev = cust.devices[di]!;
        const ageDays = closed ? rng.int(8, 60) : rng.int(0, 6);
        const createdAt = new Date(now - ageDays * DAY - rng.int(0, 8) * 3600 * 1000);
        // Due: 2 days after check-in; a few open ones are already overdue.
        const dueAt = new Date(createdAt.getTime() + (status.category === 'OPEN' && k % 4 === 0 ? 1 : 2) * DAY);
        const number = await nextTicketNumber(tx, shop.id);
        const ticketId = `seed_tkt_${shop.country.toLowerCase()}_${number}`;
        const assignee =
          status.name === 'Received' && k % 2 === 0
            ? null
            : shop.formerStaff && status.category === 'WAITING' && k % 3 === 0
              ? shop.formerStaff
              : shop.staff[k % shop.staff.length]!;
        const closedAt = closed ? new Date(createdAt.getTime() + rng.int(1, 5) * DAY) : null;
        const isWarranty = !!firstCollected && status.name === 'Received' && k % 3 === 1 && shop.country === 'US';
        const warrantyOf = isWarranty ? firstCollected : null;
        const tCust = warrantyOf ? customers[warrantyOf.customerIdx]! : cust;
        const tDev = warrantyOf ? tCust.devices[warrantyOf.deviceIdx]! : dev;
        const issueCode = rng.pick(ISSUE_PRESETS_BY_DEVICE_TYPE[tDev.type]);
        const cancelled = status.systemRole === 'CANCELLED';
        const estimate = rng.chance(0.7) ? (shop.currency === 'PKR' ? rng.int(25, 400) * 10000 : rng.int(49, 349) * 100) : null;

        await tx.ticket.create({
          data: {
            id: ticketId,
            shopId: shop.id,
            number,
            statusId: status.id,
            statusCategory: status.category,
            statusChangedAt: closedAt ?? new Date(createdAt.getTime() + 3600 * 1000),
            statusIdBeforeClose: closed ? (cancelled ? received.id : byName.get('Ready for pickup')!.id) : null,
            priority: k % 7 === 3 ? 'URGENT' : 'NORMAL',
            customerId: tCust.id,
            deviceId: tDev.id,
            assigneeUserId: assignee,
            description: k % 4 === 0 ? 'Dropped yesterday, screen flickers and touch is unresponsive at the bottom.' : null,
            conditionNotes: k % 5 === 0 ? 'Scratches on back, small dent near the camera.' : null,
            estimateMinor: estimate,
            currency: shop.currency,
            dueAt,
            dueHasTime: false,
            warrantyOfTicketId: warrantyOf?.id ?? null,
            cancelReason: cancelled ? 'CUSTOMER_DECLINED' : null,
            cancelNote: cancelled ? 'Too expensive for an older phone.' : null,
            returnedConfirmed: cancelled,
            closedAt,
            createdByUserId: creator,
            createdAt,
          },
        });
        await tx.ticketIssue.create({ data: { shopId: shop.id, ticketId, code: issueCode, label: ISSUE_LABELS[issueCode], position: 0 } });
        await tx.ticketChecklistItem.createMany({
          data: CHECKLIST_ITEMS_BY_DEVICE_TYPE[tDev.type].map((item, position) => ({
            shopId: shop.id,
            ticketId,
            itemKey: item.key,
            position,
            result: position === 1 && issueCode === 'SCREEN_CRACKED' ? 'FAIL' : rng.chance(0.7) ? 'PASS' : 'UNTESTED',
          })),
        });
        if (rng.chance(0.5)) {
          await tx.ticketAccessory.create({ data: { shopId: shop.id, ticketId, code: rng.pick(ACCESSORIES) } });
        }

        // Timeline: created, then status changes up to the current status.
        const events: Prisma.TicketEventCreateManyInput[] = [
          { shopId: shop.id, ticketId, actorUserId: creator, type: 'created', data: { statusId: received.id, warrantyOfTicketId: warrantyOf?.id ?? null }, createdAt },
        ];
        if (warrantyOf) {
          events.push({
            shopId: shop.id,
            ticketId: warrantyOf.id,
            actorUserId: creator,
            type: 'warranty_linked',
            data: { ticketId, role: 'warranty' },
            createdAt,
          });
        }
        if (assignee) {
          events.push({ shopId: shop.id, ticketId, actorUserId: creator, type: 'assigned', data: { fromUserId: null, toUserId: assignee }, createdAt });
        }
        if (status.id !== received.id) {
          const from = closed ? (cancelled ? received : byName.get('Ready for pickup')!) : received;
          if (closed && !cancelled) {
            events.push({
              shopId: shop.id,
              ticketId,
              actorUserId: assignee ?? creator,
              type: 'status_changed',
              data: { fromStatusId: received.id, toStatusId: from.id, notifyPending: from.notifyCustomer },
              createdAt: new Date(createdAt.getTime() + 3600 * 1000),
            });
          }
          events.push(
            cancelled
              ? {
                  shopId: shop.id,
                  ticketId,
                  actorUserId: creator,
                  type: 'cancelled',
                  data: { statusId: status.id, reason: 'CUSTOMER_DECLINED', note: 'Too expensive for an older phone.', returnedConfirmed: true },
                  createdAt: closedAt!,
                }
              : {
                  shopId: shop.id,
                  ticketId,
                  actorUserId: assignee ?? creator,
                  type: 'status_changed',
                  data: { fromStatusId: from.id, toStatusId: status.id, notifyPending: status.notifyCustomer },
                  createdAt: closedAt ?? new Date(createdAt.getTime() + 3600 * 1000),
                },
          );
        }
        if (closed && !cancelled && rng.chance(0.5)) {
          events.push({ shopId: shop.id, ticketId, actorUserId: null, type: 'passcode_deleted', data: { reason: 'closed' }, createdAt: closedAt! });
        }
        await tx.ticketEvent.createMany({ data: events });

        // A couple of notes (one customer-visible), each with its note_added event.
        if (k % 3 === 0) {
          const noteAt = new Date(createdAt.getTime() + 2 * 3600 * 1000);
          const customerVisible = status.name === 'Unrepairable' || k % 6 === 0;
          const note = await tx.ticketNote.create({
            data: {
              shopId: shop.id,
              ticketId,
              authorUserId: assignee ?? creator,
              visibility: customerVisible ? 'CUSTOMER' : 'INTERNAL',
              body:
                status.name === 'Unrepairable'
                  ? 'The logic board is water damaged beyond repair. We recommend data recovery before recycling.'
                  : warrantyOf
                    ? `Warranty for ${formatTicketNumber(prefix, warrantyOf.number)}: same fault came back after the screen replacement.`
                    : customerVisible
                      ? 'Part ordered, expected in 2 working days.'
                      : 'Tested with a known-good battery: still drains fast. Checking the charging IC.',
              createdAt: noteAt,
            },
          });
          await tx.ticketEvent.create({
            data: { shopId: shop.id, ticketId, actorUserId: note.authorUserId, type: 'note_added', data: {}, noteId: note.id, createdAt: noteAt },
          });
        }

        if (!closed) openCount.set(tCust.id, (openCount.get(tCust.id) ?? 0) + 1);
        if (!lastVisit.has(tCust.id) || lastVisit.get(tCust.id)! < createdAt) lastVisit.set(tCust.id, createdAt);
        if (!firstCollected && status.systemRole === 'COLLECTED') firstCollected = { id: ticketId, number, customerIdx: ci, deviceIdx: di };
      }

      for (const c of customers) {
        await tx.customer.update({
          where: { id: c.id },
          data: { openTicketCount: openCount.get(c.id) ?? 0, lastVisitAt: lastVisit.get(c.id) ?? null },
        });
      }
      const settings = await tx.shopTicketSettings.findUniqueOrThrow({ where: { shopId: shop.id } });
      console.log(
        `[seed]   ${customers.length} customers, ${customers.reduce((n, c) => n + c.devices.length, 0)} devices, ` +
          `${plan.length} tickets (${formatTicketNumber(settings.numberPrefix, 1001)}–${formatTicketNumber(settings.numberPrefix, settings.nextNumber - 1)})` +
          `${keyring ? '' : '; FIELD_ENCRYPTION_KEY not set, so no passcodes on file'}`,
      );
    },
    { timeout: 60_000 },
  );
}
