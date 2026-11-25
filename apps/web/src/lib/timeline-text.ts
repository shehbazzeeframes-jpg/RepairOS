/**
 * Words for ticket timeline rows (spec §7.4). `before`/`after` in `fields_changed` are raw stored
 * values (estimate as Money, due as { dueAt, dueHasTime }, checklist results, issue labels); this
 * formats them for people. Unknown shapes fall back to plain text, never a crash.
 */
import {
  ACCESSORY_LABELS,
  AccessoryCode,
  CANCEL_REASON_LABELS,
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CHECKLIST_RESULT_LABELS,
  ChecklistResult,
  CurrencyCode,
  TICKET_PRIORITY_LABELS,
  TicketPriority,
  type TicketTimelineItem,
} from '@repairos/contracts';
import { formatMoney } from './format';
import { formatDateTime, formatLongDate, type ShopClock } from './timezone';

export const FIELD_LABELS: Record<string, string> = {
  issues: 'issues',
  description: 'description',
  checklist: 'checklist',
  conditionNotes: 'condition notes',
  accessories: 'accessories',
  accessoriesOther: 'other accessories',
  estimate: 'estimate',
  due: 'due',
  priority: 'priority',
};

const CHECKLIST_LABEL = new Map<string, string>(
  Object.values(CHECKLIST_ITEMS_BY_DEVICE_TYPE)
    .flat()
    .map((i) => [i.key, i.label]),
);

export function fieldLabel(field: string): string {
  if (field.startsWith('checklist.')) {
    const key = field.slice('checklist.'.length);
    return CHECKLIST_LABEL.get(key) ?? key;
  }
  return FIELD_LABELS[field] ?? field;
}

export function formatFieldValue(
  field: string,
  value: unknown,
  shop: ShopClock & { locale: string },
): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (field === 'estimate' && typeof value === 'object' && value !== null) {
    const m = value as { amountMinor?: unknown; currency?: unknown };
    const currency = CurrencyCode.safeParse(m.currency);
    if (typeof m.amountMinor === 'number' && currency.success) {
      return formatMoney(m.amountMinor, { currency: currency.data, locale: shop.locale });
    }
  }
  if (field === 'due' && typeof value === 'object' && value !== null) {
    const d = value as { dueAt?: unknown; dueHasTime?: unknown };
    if (typeof d.dueAt === 'string') {
      return d.dueHasTime ? formatDateTime(d.dueAt, shop) : formatLongDate(d.dueAt, shop);
    }
  }
  if (field === 'priority') {
    const p = TicketPriority.safeParse(value);
    if (p.success) return TICKET_PRIORITY_LABELS[p.data];
  }
  if (field.startsWith('checklist.')) {
    const r = ChecklistResult.safeParse(value);
    if (r.success) return CHECKLIST_RESULT_LABELS[r.data];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value
      .map((v) => {
        const a = AccessoryCode.safeParse(v);
        return field === 'accessories' && a.success ? ACCESSORY_LABELS[a.data] : String(v);
      })
      .join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The contract's reserved event types use `z.literal(type)` with the whole union, so a plain
 * `switch (item.type)` does not narrow; this picks the variant for a known type.
 */
export type TimelineItemOf<K extends TicketTimelineItem['type']> = Extract<
  TicketTimelineItem,
  { type: K }
>;
export function asItem<K extends TicketTimelineItem['type']>(
  item: TicketTimelineItem,
  type: K,
): TimelineItemOf<K> | null {
  return item.type === type ? (item as TimelineItemOf<K>) : null;
}

/** Plain sentence for every non-note, non-status item (status rows render badges). */
export function timelineSentence(
  item: TicketTimelineItem,
  shop: ShopClock & { locale: string },
): string {
  const actor = item.actor?.name ?? 'RepairOS';
  switch (item.type) {
    case 'created': {
      const it = item as TimelineItemOf<'created'>;
      return it.data.warrantyOf
        ? `Checked in by ${actor} as a warranty ticket for ${it.data.warrantyOf.numberLabel}`
        : `Checked in by ${actor}`;
    }
    case 'status_changed': {
      const it = item as TimelineItemOf<'status_changed'>;
      return `${actor} changed status from ${it.data.from.name} to ${it.data.to.name}`;
    }
    case 'assigned': {
      const it = item as TimelineItemOf<'assigned'>;
      if (it.data.to) return `${actor} assigned it to ${it.data.to.name}`;
      return it.data.from
        ? `${actor} unassigned it (was ${it.data.from.name})`
        : `${actor} unassigned it`;
    }
    case 'fields_changed': {
      const it = item as TimelineItemOf<'fields_changed'>;
      return `${actor} edited ${it.data.changes
        .map(
          (c) =>
            `${fieldLabel(c.field)}: ${formatFieldValue(c.field, c.before, shop)} → ${formatFieldValue(c.field, c.after, shop)}`,
        )
        .join('; ')}`;
    }
    case 'device_changed': {
      const it = item as TimelineItemOf<'device_changed'>;
      return `${actor} changed the device: ${it.data.from.label} → ${it.data.to.label}`;
    }
    case 'customer_changed': {
      const it = item as TimelineItemOf<'customer_changed'>;
      return `${actor} changed the customer: ${it.data.from.displayName} → ${it.data.to.displayName}`;
    }
    case 'note_added':
      return `${actor} added a note`;
    case 'note_edited':
      return `${actor} edited a note`;
    case 'cancelled': {
      const it = item as TimelineItemOf<'cancelled'>;
      return `${actor} cancelled it: ${CANCEL_REASON_LABELS[it.data.reason]}${it.data.note ? ` — ${it.data.note}` : ''}`;
    }
    case 'reopened': {
      const it = item as TimelineItemOf<'reopened'>;
      return `${actor} reopened it to ${it.data.to.name}: ${it.data.reason}`;
    }
    case 'warranty_linked': {
      const it = item as TimelineItemOf<'warranty_linked'>;
      return it.data.role === 'warranty'
        ? `Warranty ticket ${it.data.ticket.numberLabel} opened`
        : `Linked to ${it.data.ticket.numberLabel}`;
    }
    case 'passcode_deleted':
      return 'Passcode deleted on close';
    default:
      return 'Activity';
  }
}
