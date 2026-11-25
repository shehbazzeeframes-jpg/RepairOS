import {
  AuditEventDetail,
  AuditEventListResponse,
  DEFAULT_BUSINESS_HOURS,
  InvitePreview,
  MeResponse,
  ShopSettingsResponse,
  StaffListItem,
  StaffListResponse,
  TaxRate,
  TaxRateListResponse,
  TimeEntry,
  TimesheetResponse,
  permissionsFor,
  type Role,
} from '@repairos/contracts';
import { SHOP, USER } from './mock-api';

/** "Now" for date-dependent tests: Wednesday 25 Nov 2026, 15:00 in London. */
export const NOW = new Date('2026-11-25T15:00:00.000Z');

export function meAs(role: Role, extra: Partial<MeResponse> = {}): MeResponse {
  return MeResponse.parse({
    user: USER,
    memberships: [{ shopId: SHOP.id, shopName: SHOP.name, role, status: 'ACTIVE' }],
    activeShop: SHOP,
    role,
    permissions: permissionsFor(role),
    accessRemoved: null,
    ...extra,
  });
}

export const SHOP_SETTINGS = ShopSettingsResponse.parse({
  shop: {
    ...SHOP,
    addressLine1: '12 High Street',
    addressLine2: null,
    city: 'London',
    region: 'Greater London',
    postcode: 'SW1A 1AA',
    updatedAt: '2026-11-21T10:00:00.000Z',
  },
  hours: DEFAULT_BUSINESS_HOURS,
});

const stamp = '2026-11-20T09:00:00.000Z';

export const VAT = TaxRate.parse({
  id: 'tax_vat',
  name: 'VAT',
  rateMilliPct: 20000,
  appliesTo: 'all',
  isDefaultGoods: true,
  isDefaultServices: true,
  archivedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
});

export const ZERO = TaxRate.parse({
  ...VAT,
  id: 'tax_zero',
  name: 'Zero rated',
  rateMilliPct: 0,
  isDefaultGoods: false,
  isDefaultServices: false,
});

export const TAX_RATES = TaxRateListResponse.parse({ items: [VAT, ZERO] });

function staffRow(
  row: Partial<StaffListItem> & Pick<StaffListItem, 'id' | 'email' | 'role'>,
): StaffListItem {
  return StaffListItem.parse({
    kind: 'MEMBER',
    userId: `usr_${row.id}`,
    name: null,
    status: 'ACTIVE',
    isSelf: false,
    clockedIn: false,
    lastClockInAt: null,
    deactivatedAt: null,
    inviteExpiresAt: null,
    inviteExpired: false,
    inviteEmailStatus: null,
    inviteLinkCopiedAt: null,
    ...row,
  });
}

export const ME_ROW = staffRow({
  id: 'mem_me',
  userId: USER.id,
  name: USER.name,
  email: USER.email,
  role: 'OWNER',
  isSelf: true,
  lastClockInAt: '2026-11-25T08:58:00.000Z',
  clockedIn: true,
});
export const SAM = staffRow({
  id: 'mem_sam',
  name: 'Sam Lee',
  email: 'sam@fixitphones.co.uk',
  role: 'TECHNICIAN',
  lastClockInAt: '2026-11-24T09:05:00.000Z',
});
export const PRIYA = staffRow({
  id: 'mem_priya',
  name: 'Priya Shah',
  email: 'priya@fixitphones.co.uk',
  role: 'MANAGER',
  lastClockInAt: '2026-11-25T09:30:00.000Z',
  clockedIn: true,
});
export const INVITE_JO = staffRow({
  kind: 'INVITE',
  id: 'inv_jo',
  userId: null,
  email: 'jo@example.com',
  role: 'FRONT_DESK',
  status: 'INVITED',
  inviteExpiresAt: '2026-12-02T09:00:00.000Z',
  inviteEmailStatus: 'FAILED',
});
export const INVITE_OLD = staffRow({
  kind: 'INVITE',
  id: 'inv_old',
  userId: null,
  email: 'old@example.com',
  role: 'TECHNICIAN',
  status: 'INVITED',
  inviteExpiresAt: '2026-11-10T09:00:00.000Z',
  inviteExpired: true,
  inviteEmailStatus: 'SENT',
});

export function staffList(items: StaffListItem[], used = 4): StaffListResponse {
  return StaffListResponse.parse({ items, seats: { used, limit: 5 } });
}

function entry(
  e: Partial<TimeEntry> & Pick<TimeEntry, 'id' | 'userId' | 'clockInAt' | 'localDate'>,
): TimeEntry {
  return TimeEntry.parse({
    clockOutAt: null,
    durationMinutes: 0,
    source: 'SELF',
    closedReason: null,
    flaggedLong: false,
    stillOpen: false,
    edited: null,
    ...e,
  });
}

export const SAM_ENTRIES = [
  entry({
    id: 'te_1',
    userId: 'usr_mem_sam',
    clockInAt: '2026-11-23T09:00:00.000Z',
    clockOutAt: '2026-11-23T17:30:00.000Z',
    localDate: '2026-11-23',
    durationMinutes: 510,
  }),
  entry({
    id: 'te_2',
    userId: 'usr_mem_sam',
    clockInAt: '2026-11-24T09:05:00.000Z',
    clockOutAt: '2026-11-24T23:40:00.000Z',
    localDate: '2026-11-24',
    durationMinutes: 875,
    flaggedLong: true,
    edited: {
      at: '2026-11-25T10:00:00.000Z',
      byUserId: USER.id,
      byName: USER.name,
      reason: 'Forgot to clock out',
    },
  }),
];

export const TIMESHEET = TimesheetResponse.parse({
  from: '2026-11-23',
  to: '2026-11-29',
  timezone: 'Europe/London',
  serverNow: NOW.toISOString(),
  staff: [
    {
      userId: USER.id,
      name: USER.name,
      email: USER.email,
      role: 'OWNER',
      status: 'ACTIVE',
      totalMinutes: 362,
      days: [
        {
          date: '2026-11-25',
          totalMinutes: 362,
          entries: [
            entry({
              id: 'te_me',
              userId: USER.id,
              clockInAt: '2026-11-25T08:58:00.000Z',
              localDate: '2026-11-25',
              durationMinutes: 362,
            }),
          ],
        },
      ],
    },
    {
      userId: 'usr_mem_sam',
      name: 'Sam Lee',
      email: 'sam@fixitphones.co.uk',
      role: 'TECHNICIAN',
      status: 'ACTIVE',
      totalMinutes: 1385,
      days: [
        { date: '2026-11-23', totalMinutes: 510, entries: [SAM_ENTRIES[0]] },
        { date: '2026-11-24', totalMinutes: 875, entries: [SAM_ENTRIES[1]] },
      ],
    },
  ],
  needsReviewCount: 1,
});

export const EMPTY_TIMESHEET = TimesheetResponse.parse({
  ...TIMESHEET,
  staff: [],
  needsReviewCount: 0,
});

const actor = { userId: USER.id, name: USER.name };

export const AUDIT_PAGE_1 = AuditEventListResponse.parse({
  items: [
    {
      id: 'ev_1',
      createdAt: '2026-11-25T10:00:00.000Z',
      action: 'tax_rate.updated',
      actor,
      entityType: 'TaxRate',
      entityId: 'tax_vat',
      entityLabel: 'VAT',
    },
    {
      id: 'ev_2',
      createdAt: '2026-11-25T09:40:00.000Z',
      action: 'member.role_changed',
      actor,
      entityType: 'Membership',
      entityId: 'mem_sam',
      entityLabel: 'Sam Lee',
    },
    {
      id: 'ev_3',
      createdAt: '2026-11-24T16:12:00.000Z',
      action: 'invite.created',
      actor: { userId: 'usr_mem_priya', name: 'Priya Shah' },
      entityType: 'Invitation',
      entityId: 'inv_jo',
      entityLabel: 'jo@example.com',
    },
  ],
  nextCursor: 'cursor_2',
});

export const AUDIT_PAGE_2 = AuditEventListResponse.parse({
  items: [
    {
      id: 'ev_4',
      createdAt: '2026-11-20T09:00:00.000Z',
      action: 'shop.created',
      actor: null,
      entityType: 'Shop',
      entityId: SHOP.id,
      entityLabel: SHOP.name,
    },
  ],
  nextCursor: null,
});

export const AUDIT_DETAIL = AuditEventDetail.parse({
  ...AUDIT_PAGE_1.items[0],
  before: { rateMilliPct: 20000, name: 'VAT', appliesTo: 'all' },
  after: { rateMilliPct: 17500, name: 'VAT', appliesTo: 'goods' },
});

/** 43-char base64url tokens. */
export const TOKEN = 'tok_valid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 43);
export const TOKEN_EXPIRED = 'tok_expired_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 43);

export const INVITE_VALID = InvitePreview.parse({
  state: 'VALID',
  shopName: 'Fix It Phones',
  inviterName: 'Priya Shah',
  role: 'FRONT_DESK',
  email: 'jo@example.com',
  expiresAt: '2026-12-02T09:00:00.000Z',
});

export const INVITE_EXPIRED = InvitePreview.parse({
  ...INVITE_VALID,
  state: 'EXPIRED',
  expiresAt: '2026-11-10T09:00:00.000Z',
});

export const JO = { id: 'usr_jo', name: 'Jo Bloggs', email: 'jo@example.com' };
