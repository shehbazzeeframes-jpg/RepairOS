import type { Page, Request, Route } from '@playwright/test';
import {
  AssigneesResponse,
  CheckInContext,
  ConsentHistoryResponse,
  CustomerDetail,
  CustomerListItem,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_TICKET_STATUSES,
  DEVICE_MODEL_CATALOGUE,
  DashboardSummary,
  Device,
  DeviceLookupResponse,
  GlobalSearchResponse,
  ISSUE_LABELS,
  SHOP_ID_HEADER,
  TicketCounts,
  TicketDetail,
  TicketListItem,
  TicketSettings,
  TicketStatus,
  TimelineResponse,
  computeDefaultDueAt,
  deviceLabel,
  normalizeImei,
  ticketInView,
  type CreateTicketInput,
  type IssueCode,
  type MeResponse,
  type StatusRef,
  type TicketTimelineItem,
  type TicketView,
} from '@repairos/contracts';
import { SHOP, USER, apiError, mockApi, type MockApiState } from './mock-api';

/**
 * A small in-memory fake of the Sprint 2 API for the mocked e2e suite. Every fixture and every
 * response body is parsed with the contract schema, so a contract change breaks the mocks loudly.
 * R1 (model suggestions `{ type, brand, model }`) and R5 (`archived=true` in check-in search) are
 * mocked to the shapes in backend commit 2367930.
 */

const T0 = '2026-01-10T10:00:00.000Z';
const DAY = 86_400_000;
const isoIn = (days: number, hourUtc = 17) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

export const ST = {
  received: 'st_received',
  diagnosing: 'st_diagnosing',
  approval: 'st_approval',
  parts: 'st_parts',
  inRepair: 'st_in_repair',
  ready: 'st_ready',
  unrepairable: 'st_unrepairable',
  collected: 'st_collected',
  cancelled: 'st_cancelled',
} as const;
const STATUS_IDS = Object.values(ST);

export function statusList(): TicketStatus[] {
  return DEFAULT_TICKET_STATUSES.map((s, i) =>
    TicketStatus.parse({
      ...s,
      id: STATUS_IDS[i],
      position: i,
      isHidden: false,
      ticketCount: 0,
      createdAt: T0,
      updatedAt: T0,
    }),
  );
}

export const ref = (s: TicketStatus): StatusRef => ({
  id: s.id,
  name: s.name,
  category: s.category,
  colour: s.colour,
  systemRole: s.systemRole,
});

function device(
  id: string,
  customerId: string,
  d: Partial<Device> & Pick<Device, 'type' | 'brand' | 'model'>,
): Device {
  return Device.parse({
    id,
    customerId,
    colour: null,
    imei: null,
    serial: null,
    notes: null,
    lockType: 'NONE',
    passcodeOnFile: false,
    passcodeSetAt: null,
    passcodeViewCount: 0,
    passcodeLastViewedAt: null,
    passcodeLastViewedBy: null,
    ticketCount: 1,
    openTicket: null,
    lastTicketAt: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...d,
  });
}

const none = { granted: false, since: null, source: null, recordedByName: null };

function customer(
  c: Partial<CustomerDetail> & Pick<CustomerDetail, 'id' | 'displayName'>,
): CustomerDetail {
  return CustomerDetail.parse({
    kind: 'PERSON',
    businessContactName: null,
    primaryPhone: null,
    email: null,
    tags: [],
    openTicketCount: 0,
    lastVisitAt: null,
    createdAt: T0,
    archivedAt: null,
    firstName: null,
    lastName: null,
    businessName: null,
    phones: [],
    whatsappPhoneId: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postcode: null,
    notes: null,
    preferredChannel: 'SMS',
    serviceOptOutSms: false,
    serviceOptOutEmail: false,
    serviceOptOutWhatsapp: false,
    consent: { SMS: none, EMAIL: none, WHATSAPP: none },
    ticketCount: 0,
    deviceCount: 0,
    version: 1,
    createdBy: { userId: USER.id, name: USER.name },
    updatedAt: T0,
    ...c,
  });
}

export const ALI = customer({
  id: 'cus_1',
  displayName: 'Ali Khan',
  firstName: 'Ali',
  lastName: 'Khan',
  primaryPhone: '+447400123456',
  email: 'ali.khan@example.com',
  phones: [{ id: 'ph_1', e164: '+447400123456', label: 'MOBILE', isPrimary: true, position: 0 }],
  whatsappPhoneId: 'ph_1',
  tags: ['Regular'],
  openTicketCount: 1,
  lastVisitAt: '2026-10-02T10:00:00.000Z',
  ticketCount: 3,
  deviceCount: 2,
  consent: {
    SMS: {
      granted: true,
      since: '2026-03-12T10:00:00.000Z',
      source: 'IN_STORE_SIGNED',
      recordedByName: USER.name,
    },
    EMAIL: none,
    WHATSAPP: none,
  },
});
export const SARAH = customer({
  id: 'cus_2',
  displayName: 'Sarah Jones',
  firstName: 'Sarah',
  lastName: 'Jones',
  primaryPhone: '+447400555010',
  email: 'sarah@jonesandco.co.uk',
  phones: [{ id: 'ph_2', e164: '+447400555010', label: 'MOBILE', isPrimary: true, position: 0 }],
  whatsappPhoneId: 'ph_2',
  notes: 'Prefers a call after 5pm. Business account: invoice to Jones & Co.',
  openTicketCount: 1,
  ticketCount: 1,
  deviceCount: 1,
});
export const KHALID = customer({
  id: 'cus_4',
  displayName: 'Khalid Mahmood',
  firstName: 'Khalid',
  lastName: 'Mahmood',
  primaryPhone: '+447400777999',
  phones: [{ id: 'ph_4', e164: '+447400777999', label: 'MOBILE', isPrimary: true, position: 0 }],
  archivedAt: '2026-06-01T10:00:00.000Z',
});

export const IPHONE = device('dev_1', 'cus_1', {
  type: 'PHONE',
  brand: 'Apple',
  model: 'iPhone 13',
  colour: 'Blue',
  imei: '356938035643809',
  lockType: 'PIN',
  passcodeOnFile: true,
  passcodeViewCount: 2,
  passcodeLastViewedAt: '2026-11-20T10:00:00.000Z',
  passcodeLastViewedBy: { userId: 'usr_2', name: 'Sam Patel' },
  lastTicketAt: '2026-10-02T10:00:00.000Z',
  ticketCount: 2,
});
export const TABLET = device('dev_2', 'cus_1', {
  type: 'TABLET',
  brand: 'Samsung',
  model: 'Galaxy Tab A8',
  lastTicketAt: '2025-06-14T10:00:00.000Z',
});
export const SARAH_PHONE = device('dev_3', 'cus_2', {
  type: 'PHONE',
  brand: 'Apple',
  model: 'iPhone 15 Pro',
  colour: 'Natural Titanium',
  lockType: 'PIN',
  passcodeOnFile: true,
  lastTicketAt: '2026-11-21T10:00:00.000Z',
  openTicket: { id: 'tkt_1040', number: 1040, numberLabel: 'T-1040' },
});

export const ASSIGNEES = AssigneesResponse.parse({
  items: [
    { userId: 'usr_2', name: 'Sam Patel', role: 'TECHNICIAN', isSelf: false },
    { userId: 'usr_3', name: 'Jo Reid', role: 'TECHNICIAN', isSelf: false },
    { userId: USER.id, name: USER.name, role: 'OWNER', isSelf: true },
  ],
});

export function checkInContext(): CheckInContext {
  const due = computeDefaultDueAt(new Date(), 2, DEFAULT_BUSINESS_HOURS, SHOP.timezone);
  return CheckInContext.parse({
    serverNow: new Date().toISOString(),
    country: SHOP.country,
    currency: SHOP.currency,
    locale: SHOP.locale,
    timezone: SHOP.timezone,
    pricesIncludeTax: true,
    hours: DEFAULT_BUSINESS_HOURS,
    defaultTurnaroundDays: 2,
    numberPrefix: 'T-',
    defaultDue: { dueAt: due.dueAt, date: due.date, dueHasTime: false },
  });
}

const STATUSES = statusList();
const statusById = (id: string) => STATUSES.find((s) => s.id === id)!;

export function ticket(
  t: Partial<TicketDetail> & Pick<TicketDetail, 'id' | 'number'> & { statusId?: string },
): TicketDetail {
  const { statusId, ...rest } = t;
  const status = ref(statusById(statusId ?? ST.received));
  const closed = status.category === 'CLOSED';
  return TicketDetail.parse({
    numberLabel: `T-${t.number}`,
    status,
    statusChangedAt: isoIn(-1),
    statusBeforeClose: closed ? ref(statusById(ST.ready)) : null,
    priority: 'NORMAL',
    customer: {
      id: ALI.id,
      kind: 'PERSON',
      displayName: ALI.displayName,
      phones: ALI.phones,
      whatsappPhoneId: ALI.whatsappPhoneId,
      email: ALI.email,
      preferredChannel: 'SMS',
      notes: null,
      archived: false,
      erased: false,
    },
    device: { ...IPHONE, previousTicketCount: 1 },
    assignee: null,
    issues: [{ code: 'SCREEN_CRACKED', label: 'Screen cracked' }],
    description: 'Dropped it on the pavement.',
    checklist: {},
    conditionNotes: null,
    accessories: ['CASE'],
    accessoriesOther: null,
    estimate: { amountMinor: 12900, currency: 'GBP' },
    estimateIncludesTax: true,
    dueAt: isoIn(1),
    dueHasTime: false,
    isOverdue: false,
    warrantyOf: null,
    warrantyTickets: [],
    closedAt: closed ? isoIn(-1) : null,
    cancelReason: null,
    cancelNote: null,
    reopenCount: 0,
    reopenableUntil: closed ? isoIn(6) : null,
    version: 3,
    createdBy: { userId: USER.id, name: USER.name },
    createdAt: isoIn(-2, 10),
    updatedAt: isoIn(-1, 10),
    ...rest,
  });
}

export function listItem(t: TicketDetail): TicketListItem {
  return TicketListItem.parse({
    id: t.id,
    number: t.number,
    numberLabel: t.numberLabel,
    isWarranty: !!t.warrantyOf,
    customer: {
      id: t.customer.id,
      displayName: t.customer.displayName,
      primaryPhone: t.customer.phones.find((p) => p.isPrimary)?.e164 ?? null,
      erased: t.customer.erased,
    },
    device: { id: t.device.id, type: t.device.type, brand: t.device.brand, model: t.device.model },
    issues: t.issues.map((i) => i.label),
    description: t.description,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    dueAt: t.dueAt,
    dueHasTime: t.dueHasTime,
    isOverdue: t.isOverdue,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: t.closedAt,
  });
}

export function defaultTickets(): TicketDetail[] {
  return [
    ticket({
      id: 'tkt_1042',
      number: 1042,
      statusId: ST.inRepair,
      assignee: { userId: USER.id, name: USER.name, active: true },
      priority: 'URGENT',
      dueAt: isoIn(0, 23),
      checklist: { POWERS_ON: 'PASS', SCREEN: 'FAIL' },
    }),
    ticket({
      id: 'tkt_1040',
      number: 1040,
      statusId: ST.parts,
      customer: {
        ...ticket({ id: 'x', number: 1 }).customer,
        id: SARAH.id,
        displayName: SARAH.displayName,
        phones: SARAH.phones,
        whatsappPhoneId: 'ph_2',
        email: SARAH.email,
        notes: SARAH.notes,
      },
      device: { ...SARAH_PHONE, previousTicketCount: 0 },
      issues: [{ code: 'BATTERY', label: 'Battery' }],
      dueAt: isoIn(-3),
      isOverdue: true,
    }),
    ticket({
      id: 'tkt_1041',
      number: 1041,
      statusId: ST.ready,
      device: { ...TABLET, previousTicketCount: 0 },
      issues: [{ code: 'CHARGING_PORT', label: 'Charging port' }],
    }),
    ticket({
      id: 'tkt_1039',
      number: 1039,
      statusId: ST.received,
      issues: [
        { code: 'BACK_GLASS', label: 'Back glass' },
        { code: 'CAMERA', label: 'Camera' },
        { code: 'SPEAKER_MIC', label: 'Speaker/mic' },
      ],
    }),
    ticket({ id: 'tkt_1030', number: 1030, statusId: ST.collected }),
  ];
}

export function timelineFor(t: TicketDetail): TicketTimelineItem[] {
  return TimelineResponse.parse({
    olderCursor: null,
    items: [
      {
        id: `${t.id}_e1`,
        type: 'created',
        createdAt: t.createdAt,
        actor: { userId: USER.id, name: USER.name, active: true },
        data: { status: ref(statusById(ST.received)), warrantyOf: null },
      },
      {
        id: `${t.id}_e2`,
        type: 'status_changed',
        createdAt: t.statusChangedAt,
        actor: { userId: 'usr_2', name: 'Sam Patel', active: true },
        data: {
          from: ref(statusById(ST.received)),
          to: t.status,
          notifyPending: false,
          noteId: null,
        },
      },
      {
        id: `${t.id}_e3`,
        type: 'note_added',
        createdAt: t.statusChangedAt,
        actor: { userId: 'usr_2', name: 'Sam Patel', active: true },
        data: {
          note: {
            id: 'note_1',
            body: 'Ordered a new screen, arrives tomorrow.',
            visibility: 'INTERNAL',
            author: { userId: 'usr_2', name: 'Sam Patel', active: true },
            createdAt: t.statusChangedAt,
            editedAt: null,
            canEdit: false,
          },
        },
      },
      {
        id: `${t.id}_e4`,
        type: 'note_added',
        createdAt: t.updatedAt,
        actor: { userId: USER.id, name: USER.name, active: true },
        data: {
          note: {
            id: 'note_2',
            body: 'We will call you when it is ready.',
            visibility: 'CUSTOMER',
            author: { userId: USER.id, name: USER.name, active: true },
            createdAt: t.updatedAt,
            editedAt: null,
            canEdit: false,
          },
        },
      },
    ],
  }).items;
}

export const TICKET_SETTINGS = TicketSettings.parse({
  defaultTurnaroundDays: 2,
  numberPrefix: 'T-',
  nextNumber: 1043,
  highestUsedNumber: 1042,
  deletePasscodeOnClose: true,
  updatedAt: T0,
});

/** R1 mock: one-box ranking (exact, shortest, catalogue order) over the contract catalogue. */
export function modelSuggestions(q: string, type?: string | null, brand?: string | null) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const ql = q.trim().toLowerCase();
  return DEVICE_MODEL_CATALOGUE.map((m, i) => ({ m, i }))
    .filter(
      ({ m }) =>
        (!type || m.type === type) && (!brand || m.brand.toLowerCase() === brand.toLowerCase()),
    )
    .filter(({ m }) => words.every((w) => `${m.brand} ${m.model}`.toLowerCase().includes(w)))
    .sort((a, b) => {
      const ea = a.m.model.toLowerCase() === ql ? 0 : 1;
      const eb = b.m.model.toLowerCase() === ql ? 0 : 1;
      return ea - eb || a.m.model.length - b.m.model.length || a.i - b.i;
    })
    .slice(0, 8)
    .map(({ m }) => ({
      type: m.type,
      brand: m.brand,
      model: m.model,
      source: 'catalogue' as const,
      useCount: 0,
    }));
}

function toListItem(c: CustomerDetail): CustomerListItem {
  return CustomerListItem.parse(c);
}

type Handler = (route: Route, request: Request) => Promise<void> | void;

export interface FakeApi {
  /** The /api/me body served to every page sharing this world (two-tab tests change it). */
  me: MeResponse;
  /** Calls seen by the last page installed. */
  state: MockApiState;
  tickets: TicketDetail[];
  customers: CustomerDetail[];
  devices: Device[];
  statuses: TicketStatus[];
  /** POST /api/tickets bodies with their headers. */
  created: { body: CreateTicketInput; idempotencyKey: string | null; shopId: string | null }[];
  /** Every write with the X-Shop-Id it carried. */
  writes: { method: string; path: string; shopId: string | null }[];
  /** The shop the "session" is in (for ACTIVE_SHOP_CHANGED). */
  activeShopId: string;
}

export interface FakeOptions {
  me: MeResponse;
  /** Extra or overriding handlers ("METHOD /path"). */
  handlers?: Record<string, Handler>;
  tickets?: TicketDetail[];
  /** Shared world for two-tab tests. */
  world?: FakeApi;
}

export function newWorld(me: MeResponse, tickets = defaultTickets()): FakeApi {
  return {
    me,
    state: { me, calls: [] },
    tickets,
    customers: [ALI, SARAH, KHALID],
    devices: [IPHONE, TABLET, SARAH_PHONE],
    statuses: statusList(),
    created: [],
    writes: [],
    activeShopId: me.activeShop?.id ?? SHOP.id,
  };
}

/** Installs the fake on a page (on top of mockApi's /api/me, timeclock and auth defaults). */
export async function mockSprint2(page: Page, options: FakeOptions): Promise<FakeApi> {
  const world = options.world ?? newWorld(options.me, options.tickets);
  // Shop-scoped responses echo the session's active shop (A13).
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, json: body, headers: { [SHOP_ID_HEADER]: world.activeShopId } });
  const counts = () => {
    const now = new Date();
    const inView = (v: TicketView) =>
      world.tickets.filter((t) =>
        ticketInView(
          {
            statusCategory: t.status.category,
            assigneeUserId: t.assignee?.userId ?? null,
            assigneeActive: t.assignee?.active,
            dueAt: t.dueAt,
          },
          v,
          { userId: USER.id, now },
        ),
      );
    return TicketCounts.parse({
      open: inView('open').length,
      mine: inView('mine').length,
      unassigned: inView('unassigned').length,
      ready: inView('ready').length,
      overdue: inView('overdue').length,
      dueToday: 1,
      openAndWaiting: world.tickets.filter(
        (t) => t.status.category === 'OPEN' || t.status.category === 'WAITING',
      ).length,
      serverNow: now.toISOString(),
    });
  };
  const idOf = (req: Request, i = 3) => new URL(req.url()).pathname.split('/')[i]!;
  const shopIdOf = (req: Request) => req.headers()[SHOP_ID_HEADER.toLowerCase()] ?? null;
  const guard = async (route: Route, req: Request): Promise<boolean> => {
    const sent = shopIdOf(req);
    world.writes.push({ method: req.method(), path: new URL(req.url()).pathname, shopId: sent });
    if (sent && sent !== world.activeShopId) {
      await json(
        route,
        409,
        apiError(409, 'ACTIVE_SHOP_CHANGED', 'You switched shop in another tab.'),
      );
      return false;
    }
    return true;
  };
  const findTicket = (id: string) => world.tickets.find((t) => t.id === id);
  const replaceTicket = (t: TicketDetail) => {
    world.tickets = world.tickets.map((x) => (x.id === t.id ? t : x));
    return t;
  };

  const handlers: Record<string, Handler> = {
    'GET /api/me': (route) => route.fulfill({ status: 200, json: world.me }),
    'GET /api/tickets/check-in-context': (route) => json(route, 200, checkInContext()),
    'GET /api/assignees': (route) => json(route, 200, ASSIGNEES),
    'GET /api/ticket-statuses': (route) => json(route, 200, { items: world.statuses }),
    'PUT /api/ticket-statuses/order': async (route, req) => {
      if (!(await guard(route, req))) return;
      const { ids } = req.postDataJSON() as { ids: string[] };
      world.statuses = ids.map((id, position) => ({
        ...world.statuses.find((s) => s.id === id)!,
        position,
      }));
      return json(route, 200, { items: world.statuses });
    },
    'POST /api/ticket-statuses': async (route, req) => {
      if (!(await guard(route, req))) return;
      const b = req.postDataJSON() as Partial<TicketStatus>;
      const s = TicketStatus.parse({
        notifyCustomer: false,
        requiresNote: false,
        ...b,
        id: `st_${world.statuses.length}`,
        systemRole: null,
        position: world.statuses.length,
        isHidden: false,
        ticketCount: 0,
        createdAt: T0,
        updatedAt: T0,
      });
      world.statuses.push(s);
      return json(route, 201, s);
    },
    'PATCH /api/ticket-statuses/:id': async (route, req) => {
      if (!(await guard(route, req))) return;
      const id = idOf(req);
      const s = TicketStatus.parse({
        ...world.statuses.find((x) => x.id === id),
        ...(req.postDataJSON() as object),
      });
      world.statuses = world.statuses.map((x) => (x.id === id ? s : x));
      return json(route, 200, s);
    },
    'GET /api/shop/ticket-settings': (route) => json(route, 200, TICKET_SETTINGS),
    'PATCH /api/shop/ticket-settings': async (route, req) => {
      if (!(await guard(route, req))) return;
      const b = req.postDataJSON() as { nextNumber?: number };
      if (b.nextNumber !== undefined && b.nextNumber <= (TICKET_SETTINGS.highestUsedNumber ?? 0)) {
        return json(
          route,
          409,
          apiError(
            409,
            'TICKET_NUMBER_TOO_LOW',
            'The next number must be higher than 1042, the highest number used.',
          ),
        );
      }
      return json(
        route,
        200,
        TicketSettings.parse({ ...TICKET_SETTINGS, ...b, updatedAt: new Date().toISOString() }),
      );
    },

    // ---- Customers ----
    'GET /api/customers': (route, req) => {
      const u = new URL(req.url());
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const archived = u.searchParams.get('archived') === 'true';
      const digits = q.replace(/\D/g, '').replace(/^0+/, '');
      const items = world.customers
        .filter((c) => archived || !c.archivedAt)
        .filter(
          (c) =>
            !q ||
            c.displayName.toLowerCase().includes(q) ||
            (digits.length >= 4 && (c.primaryPhone ?? '').includes(digits)) ||
            (c.email ?? '').includes(q),
        )
        .map(toListItem);
      return json(route, 200, { items, nextCursor: null, total: items.length, totalCapped: false });
    },
    'GET /api/customers/tags': (route) => json(route, 200, { tags: ['Regular', 'Trade', 'VIP'] }),
    'GET /api/customers/duplicates': (route, req) => {
      const u = new URL(req.url());
      const phone = (u.searchParams.get('phone') ?? '').replace(/\D/g, '').replace(/^0+/, '');
      const email = (u.searchParams.get('email') ?? '').toLowerCase();
      const items = world.customers
        .filter(
          (c) =>
            (phone.length >= 6 && (c.primaryPhone ?? '').endsWith(phone)) ||
            (email && c.email === email),
        )
        .slice(0, 3)
        .map((c) => ({
          id: c.id,
          displayName: c.displayName,
          primaryPhone: c.primaryPhone,
          email: c.email,
          lastVisitAt: c.lastVisitAt,
          openTicketCount: c.openTicketCount,
          archived: !!c.archivedAt,
          matchedOn: ['phone'],
        }));
      return json(route, 200, { items, more: 0 });
    },
    'POST /api/customers': async (route, req) => {
      if (!(await guard(route, req))) return;
      const b = req.postDataJSON() as {
        firstName?: string;
        lastName?: string;
        email?: string | null;
      };
      const c = customer({
        id: 'cus_new',
        displayName: [b.firstName, b.lastName].filter(Boolean).join(' '),
        firstName: b.firstName ?? null,
        lastName: b.lastName ?? null,
        email: b.email ?? null,
      });
      world.customers.push(c);
      return json(route, 201, c);
    },
    'GET /api/customers/:id': (route, req) => {
      const c = world.customers.find((x) => x.id === idOf(req));
      return c ? json(route, 200, c) : json(route, 404, apiError(404, 'NOT_FOUND', 'Not found'));
    },
    'PATCH /api/customers/:id': async (route, req) => {
      if (!(await guard(route, req))) return;
      const c = world.customers.find((x) => x.id === idOf(req))!;
      const b = req.postDataJSON() as { version: number };
      if (b.version !== c.version)
        return json(
          route,
          409,
          apiError(
            409,
            'STALE_RECORD',
            'Someone else changed this customer. Reload to see their changes.',
          ),
        );
      return json(route, 200, { ...c, version: c.version + 1 });
    },
    'GET /api/customers/:id/devices': (route, req) =>
      json(route, 200, { items: world.devices.filter((d) => d.customerId === idOf(req)) }),
    'POST /api/customers/:id/devices': async (route, req) => {
      if (!(await guard(route, req))) return;
      const b = req.postDataJSON() as {
        type: Device['type'];
        brand: string;
        model: string;
        imei?: string | null;
      };
      const d = device(`dev_${world.devices.length + 10}`, idOf(req), {
        type: b.type,
        brand: b.brand,
        model: b.model,
        imei: b.imei ?? null,
        ticketCount: 0,
      });
      world.devices.push(d);
      return json(route, 201, d);
    },
    'GET /api/customers/:id/consents': (route) =>
      json(
        route,
        200,
        ConsentHistoryResponse.parse({
          items: [
            {
              id: 'ce_1',
              channel: 'SMS',
              purpose: 'MARKETING',
              state: 'GRANTED',
              source: 'IN_STORE_SIGNED',
              note: null,
              recordedBy: { userId: USER.id, name: USER.name },
              createdAt: '2026-03-12T10:00:00.000Z',
            },
          ],
        }),
      ),
    'POST /api/customers/:id/consents': async (route, req) => {
      if (!(await guard(route, req))) return;
      return json(
        route,
        200,
        world.customers.find((x) => x.id === idOf(req)),
      );
    },
    'POST /api/customers/:id/restore': async (route, req) => {
      if (!(await guard(route, req))) return;
      const c = { ...world.customers.find((x) => x.id === idOf(req))!, archivedAt: null };
      world.customers = world.customers.map((x) => (x.id === c.id ? c : x));
      return json(route, 200, c);
    },
    'POST /api/customers/:id/archive': async (route, req) => {
      if (!(await guard(route, req))) return;
      const c = world.customers.find((x) => x.id === idOf(req))!;
      if (c.openTicketCount > 0)
        return json(
          route,
          409,
          apiError(
            409,
            'CUSTOMER_HAS_OPEN_TICKETS',
            `Close or cancel this customer's ${c.openTicketCount} open tickets first.`,
          ),
        );
      return json(route, 200, { ...c, archivedAt: new Date().toISOString() });
    },
    'POST /api/customers/:id/erase': async (route, req) => {
      if (!(await guard(route, req))) return;
      const c = world.customers.find((x) => x.id === idOf(req))!;
      if (c.openTicketCount > 0)
        return json(
          route,
          409,
          apiError(
            409,
            'CUSTOMER_HAS_OPEN_TICKETS',
            `Close or cancel this customer's ${c.openTicketCount} open tickets first.`,
          ),
        );
      return json(route, 200, {
        id: c.id,
        erasedAt: new Date().toISOString(),
        counts: { phones: 1, devices: 0, tickets: 0, consentEvents: 0 },
      });
    },
    'GET /api/customers/:id/export': (route, req) =>
      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="customer-${idOf(req)}-2026-11-25.json"`,
        },
        body: JSON.stringify({ exportedAt: new Date().toISOString() }),
      }),

    // ---- Devices ----
    'GET /api/devices/lookup': (route, req) => {
      const imei = normalizeImei(new URL(req.url()).searchParams.get('imei') ?? '');
      const matches = world.devices
        .filter((d) => d.imei === imei)
        .map((d) => {
          const c = world.customers.find((x) => x.id === d.customerId)!;
          return {
            deviceId: d.id,
            customerId: c.id,
            customerDisplayName: c.displayName,
            customerArchived: !!c.archivedAt,
            sameCustomer: false,
            type: d.type,
            brand: d.brand,
            model: d.model,
            lastTicket: { id: 'tkt_1033', number: 1033, numberLabel: 'T-1033' },
          };
        });
      return json(route, 200, DeviceLookupResponse.parse({ matches }));
    },
    'GET /api/devices/model-suggestions': (route, req) => {
      const u = new URL(req.url());
      return json(route, 200, {
        items: modelSuggestions(
          u.searchParams.get('q') ?? '',
          u.searchParams.get('type'),
          u.searchParams.get('brand'),
        ),
      });
    },
    'PATCH /api/devices/:id': async (route, req) => {
      if (!(await guard(route, req))) return;
      return json(
        route,
        200,
        world.devices.find((d) => d.id === idOf(req)),
      );
    },

    // ---- Tickets ----
    'GET /api/tickets/counts': (route) => json(route, 200, counts()),
    'GET /api/tickets': (route, req) => {
      const u = new URL(req.url());
      const view = (u.searchParams.get('view') ?? 'open') as TicketView;
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const customerId = u.searchParams.get('customerId');
      const now = new Date();
      const items = world.tickets
        .filter((t) =>
          ticketInView(
            {
              statusCategory: t.status.category,
              assigneeUserId: t.assignee?.userId ?? null,
              assigneeActive: t.assignee?.active,
              dueAt: t.dueAt,
            },
            view,
            { userId: USER.id, now },
          ),
        )
        .filter((t) => !customerId || t.customer.id === customerId)
        .filter(
          (t) =>
            !q ||
            t.numberLabel.toLowerCase().includes(q) ||
            t.customer.displayName.toLowerCase().includes(q),
        )
        .map(listItem);
      return json(route, 200, {
        items,
        nextCursor: null,
        total: items.length,
        totalCapped: false,
        serverNow: now.toISOString(),
      });
    },
    'POST /api/tickets': async (route, req) => {
      const body = req.postDataJSON() as CreateTicketInput;
      world.created.push({
        body,
        idempotencyKey: req.headers()['idempotency-key'] ?? null,
        shopId: shopIdOf(req),
      });
      if (!(await guard(route, req))) return;
      const issues = (body.issues ?? []).map((i) =>
        'code' in i
          ? { code: i.code, label: ISSUE_LABELS[i.code as IssueCode] }
          : { code: null, label: i.label },
      );
      const c = body.customerId ? world.customers.find((x) => x.id === body.customerId)! : null;
      const d = body.deviceId ? world.devices.find((x) => x.id === body.deviceId)! : null;
      const base = ticket({ id: 'tkt_1043', number: 1043 });
      const t = TicketDetail.parse({
        ...base,
        issues,
        description: body.description ?? null,
        customer: c
          ? {
              ...base.customer,
              id: c.id,
              displayName: c.displayName,
              phones: c.phones,
              whatsappPhoneId: c.whatsappPhoneId,
              email: c.email,
            }
          : {
              ...base.customer,
              id: 'cus_new',
              displayName: [body.newCustomer?.firstName, body.newCustomer?.lastName]
                .filter(Boolean)
                .join(' '),
              phones: [],
              whatsappPhoneId: null,
              email: null,
            },
        device: d
          ? { ...d, previousTicketCount: d.ticketCount }
          : {
              ...base.device,
              id: 'dev_new',
              brand: body.newDevice?.brand ?? '',
              model: body.newDevice?.model ?? '',
              type: body.newDevice?.type ?? 'PHONE',
              imei: body.newDevice?.imei ?? null,
              lockType: body.newDevice?.passcode?.lockType ?? 'NONE',
              passcodeOnFile: ['PIN', 'PASSWORD', 'PATTERN'].includes(
                body.newDevice?.passcode?.lockType ?? '',
              ),
              previousTicketCount: 0,
            },
      });
      world.tickets = [t, ...world.tickets];
      return json(route, 201, t);
    },
    'GET /api/tickets/:id': (route, req) => {
      const t = findTicket(idOf(req));
      return t ? json(route, 200, t) : json(route, 404, apiError(404, 'NOT_FOUND', 'Not found'));
    },
    'PATCH /api/tickets/:id': async (route, req) => {
      if (!(await guard(route, req))) return;
      const t = findTicket(idOf(req))!;
      const b = req.postDataJSON() as { version: number; priority?: TicketDetail['priority'] };
      if (b.version !== t.version)
        return json(
          route,
          409,
          apiError(409, 'STALE_RECORD', 'This ticket changed since you opened it.'),
        );
      return json(
        route,
        200,
        replaceTicket({
          ...t,
          ...(b.priority ? { priority: b.priority } : {}),
          version: t.version + 1,
        }),
      );
    },
    'POST /api/tickets/:id/status': async (route, req) => {
      if (!(await guard(route, req))) return;
      const t = findTicket(idOf(req))!;
      const { statusId } = req.postDataJSON() as { statusId: string };
      const to = world.statuses.find((s) => s.id === statusId)!;
      if (to.systemRole === 'COLLECTED' && t.status.category !== 'READY') {
        return json(
          route,
          409,
          apiError(409, 'TRANSITION_NOT_ALLOWED', "This ticket can't move to that status."),
        );
      }
      return json(
        route,
        200,
        replaceTicket({
          ...t,
          status: ref(to),
          closedAt: to.category === 'CLOSED' ? new Date().toISOString() : null,
        }),
      );
    },
    'POST /api/tickets/:id/assign': async (route, req) => {
      if (!(await guard(route, req))) return;
      const t = findTicket(idOf(req))!;
      const { userId } = req.postDataJSON() as { userId: string | null };
      const a = ASSIGNEES.items.find((x) => x.userId === userId);
      return json(
        route,
        200,
        replaceTicket({
          ...t,
          assignee: a ? { userId: a.userId, name: a.name, active: true } : null,
        }),
      );
    },
    'POST /api/tickets/:id/cancel': async (route, req) => {
      if (!(await guard(route, req))) return;
      const t = findTicket(idOf(req))!;
      return json(
        route,
        200,
        replaceTicket({
          ...t,
          status: ref(statusById(ST.cancelled)),
          closedAt: new Date().toISOString(),
          reopenableUntil: isoIn(7),
        }),
      );
    },
    'POST /api/tickets/:id/reopen': async (route, req) => {
      if (!(await guard(route, req))) return;
      const t = findTicket(idOf(req))!;
      return json(
        route,
        200,
        replaceTicket({
          ...t,
          status: ref(statusById(ST.ready)),
          closedAt: null,
          reopenableUntil: null,
          reopenCount: 1,
        }),
      );
    },
    'GET /api/tickets/:id/timeline': (route, req) => {
      const t = findTicket(idOf(req));
      return json(route, 200, { items: t ? timelineFor(t) : [], olderCursor: null });
    },
    'POST /api/tickets/:id/notes': async (route, req) => {
      if (!(await guard(route, req))) return;
      const b = req.postDataJSON() as { body: string; visibility: 'INTERNAL' | 'CUSTOMER' };
      return json(route, 201, {
        id: 'note_new',
        body: b.body,
        visibility: b.visibility,
        author: { userId: USER.id, name: USER.name, active: true },
        createdAt: new Date().toISOString(),
        editedAt: null,
        canEdit: true,
      });
    },
    'POST /api/tickets/:id/passcode/reveal': async (route, req) => {
      if (!(await guard(route, req))) return;
      return json(route, 200, {
        lockType: 'PIN',
        value: '482913',
        viewCount: 3,
        revealedAt: new Date().toISOString(),
      });
    },

    // ---- Dashboard & search ----
    'GET /api/dashboard': (route) => {
      const mine = world.tickets
        .filter((t) => t.assignee?.userId === USER.id && t.status.category !== 'CLOSED')
        .map(listItem);
      const unassigned = mine.length
        ? []
        : world.tickets
            .filter(
              (t) =>
                !t.assignee && (t.status.category === 'OPEN' || t.status.category === 'WAITING'),
            )
            .slice(0, 5)
            .map(listItem);
      return json(
        route,
        200,
        DashboardSummary.parse({
          counts: counts(),
          myQueue: mine,
          myQueueTotal: mine.length,
          unassigned,
        }),
      );
    },
    'GET /api/search': (route, req) => {
      const q = (new URL(req.url()).searchParams.get('q') ?? '').toLowerCase();
      const tickets = world.tickets.filter(
        (t) =>
          t.numberLabel.toLowerCase().includes(q) ||
          t.customer.displayName.toLowerCase().includes(q),
      );
      const customers = world.customers.filter(
        (c) => !c.archivedAt && c.displayName.toLowerCase().includes(q),
      );
      return json(
        route,
        200,
        GlobalSearchResponse.parse({
          tickets: tickets.map((t) => ({
            id: t.id,
            numberLabel: t.numberLabel,
            customerDisplayName: t.customer.displayName,
            deviceLabel: deviceLabel(t.device),
            status: t.status,
          })),
          customers: customers.map((c) => ({
            id: c.id,
            kind: c.kind,
            displayName: c.displayName,
            primaryPhone: c.primaryPhone,
            email: c.email,
          })),
          devices: [],
          exactMatch:
            tickets.length === 1 && tickets[0]!.numberLabel.toLowerCase() === q
              ? { kind: 'ticket', ticketId: tickets[0]!.id }
              : null,
        }),
      );
    },
    ...options.handlers,
  };

  world.state = await mockApi(page, { me: world.me, handlers });
  return world;
}
