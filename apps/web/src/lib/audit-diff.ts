import {
  AUDIT_ACTION_META,
  ROLE_LABELS,
  Role,
  TAX_APPLIES_TO_LABELS,
  TaxAppliesTo,
  WEEKDAY_LABELS,
  formatRate,
  timezoneLabel,
  type AuditEntityType,
  type AuditEventDetail,
} from '@repairos/contracts';
import { formatDateTime, type ShopClock } from './timezone';

/** Field labels for the before/after diff; unknown keys are humanised. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  phone: 'Phone',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  region: 'Region',
  postcode: 'Postcode',
  timezone: 'Time zone',
  country: 'Country',
  currency: 'Currency',
  pricesIncludeTax: 'Prices include tax',
  rateMilliPct: 'Rate',
  appliesTo: 'Applies to',
  isDefaultGoods: 'Default for goods',
  isDefaultServices: 'Default for services',
  archivedAt: 'Archived',
  email: 'Email',
  role: 'Role',
  status: 'Status',
  expiresAt: 'Expires',
  membershipId: 'Membership',
  emailVerified: 'Email verified',
  clockInAt: 'Clock in',
  clockOutAt: 'Clock out',
  closedReason: 'Closed because',
  reason: 'Reason',
  days: 'Hours',
  week: 'Hours',
  from: 'From',
  to: 'To',
  userId: 'Staff',
  needsReview: 'Needs review only',
};

export const ENTITY_LABELS: Record<AuditEntityType, string> = {
  Shop: 'Shop',
  TaxRate: 'Tax rate',
  Invitation: 'Invite',
  Membership: 'Staff',
  TimeEntry: 'Time entry',
};

export function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

interface HoursDay {
  weekday: number;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

function isHoursWeek(value: unknown): value is HoursDay[] {
  return (
    Array.isArray(value) &&
    value.every(
      (d) => d && typeof d === 'object' && 'weekday' in d && 'isOpen' in d,
    )
  );
}

function formatHours(days: HoursDay[]): string {
  return [...days]
    .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))
    .map((d) => {
      const day = (WEEKDAY_LABELS[d.weekday] ?? '?').slice(0, 3);
      return d.isOpen ? `${day} ${d.opensAt ?? '?'}–${d.closesAt ?? '?'}` : `${day} closed`;
    })
    .join(', ');
}

/** One stored value as readable text. */
export function formatAuditValue(key: string, value: unknown, shop: ShopClock): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'rateMilliPct' && typeof value === 'number') return formatRate(value, shop.locale);
  if (key === 'role' && Role.safeParse(value).success) return ROLE_LABELS[value as Role];
  if (key === 'appliesTo' && TaxAppliesTo.safeParse(value).success)
    return TAX_APPLIES_TO_LABELS[value as TaxAppliesTo];
  if (key === 'timezone' && typeof value === 'string') return timezoneLabel(value);
  if (key === 'closedReason' && value === 'DEACTIVATED') return 'Closed on deactivation';
  if (key === 'status' && typeof value === 'string')
    return value.charAt(0) + value.slice(1).toLowerCase();
  if (typeof value === 'string' && ISO_INSTANT.test(value)) return formatDateTime(value, shop);
  if (isHoursWeek(value)) return formatHours(value);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export interface DiffRow {
  key: string;
  label: string;
  /** null = no "before" column value (created) */
  before: string | null;
  /** null = no "after" column value (deleted) */
  after: string | null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Readable field diff for an audit event. Unchanged fields are hidden; a created event has only
 * "after", a deleted one only "before".
 */
export function auditDiff(
  event: Pick<AuditEventDetail, 'before' | 'after'>,
  shop: ShopClock,
): DiffRow[] {
  const before = event.before ?? null;
  const after = event.after ?? null;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const rows: DiffRow[] = [];
  for (const key of keys) {
    const b = before ? before[key] : undefined;
    const a = after ? after[key] : undefined;
    if (before && after && same(a, b)) continue;
    rows.push({
      key,
      label: fieldLabel(key),
      before: before ? formatAuditValue(key, b, shop) : null,
      after: after ? formatAuditValue(key, a, shop) : null,
    });
  }
  return rows;
}

/** "Changed role" etc. */
export function auditActionLabel(action: AuditEventDetail['action']): string {
  return AUDIT_ACTION_META[action].label;
}

/** "Tax rate: VAT" / "Staff: Sam Lee" */
export function auditEntityText(
  event: Pick<AuditEventDetail, 'entityType' | 'entityLabel'>,
): string {
  const type = ENTITY_LABELS[event.entityType];
  return event.entityLabel ? `${type}: ${event.entityLabel}` : type;
}
