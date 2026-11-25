/**
 * Display rules for ticket statuses and due dates (Sprint 2 story §3, §5.5), on top of the contracts:
 * `StatusCategory`/`StatusColour` (Astryx badge tones), `STATUS_CATEGORY_LABELS` and `isOverdue`.
 */
import {
  DUE_TRACKED_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  isOverdue,
  type StatusCategory,
  type StatusColour,
} from '@repairos/contracts';
import { formatLocalDate, formatTime, todayInZone, type ShopClock } from './timezone';

export type { StatusCategory, StatusColour };

/**
 * Tone per category when a status has no colour of its own. Seeded statuses always carry a colour
 * (`DEFAULT_TICKET_STATUSES`); this is the fallback for a `StatusRef` built without one.
 */
export const CATEGORY_TONE: Record<StatusCategory, StatusColour> = {
  OPEN: 'info',
  WAITING: 'warning',
  READY: 'success',
  CLOSED: 'neutral',
};

/** "In progress", "Waiting", "Ready", "Closed" (contract labels). */
export const CATEGORY_LABEL = STATUS_CATEGORY_LABELS;

export function statusTone(category: StatusCategory, colour?: StatusColour | null): StatusColour {
  return colour ?? CATEGORY_TONE[category];
}

/** Overdue applies to open and waiting tickets only (DU1.2); ready and closed are never late. */
export function canBeOverdue(category: StatusCategory): boolean {
  return DUE_TRACKED_CATEGORIES.includes(category);
}

export type DueTone = 'overdue' | 'today' | 'normal';

export interface DueDescription {
  /** Short relative text for lists and chips: "Today 17:00", "Tomorrow", "2 days overdue". */
  label: string;
  /** Full shop-time date (and time when set), for the tooltip and screen readers. */
  absolute: string;
  tone: DueTone;
  isOverdue: boolean;
}

export interface DueInput {
  /** UTC instant. */
  dueAt: string;
  /** false = only the date was chosen; the time is the shop's closing time and is not shown. */
  hasTime: boolean;
  category: StatusCategory;
}

const DAY_MS = 86_400_000;

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * Relative + absolute due text in the shop's time zone and locale.
 * `now` is injectable so lists render one consistent clock and tests are deterministic.
 */
export function describeDue(
  input: DueInput,
  shop: ShopClock,
  now: number = Date.now(),
): DueDescription {
  const dueMs = Date.parse(input.dueAt);
  const today = todayInZone(shop.timezone, now);
  const dueDate = todayInZone(shop.timezone, dueMs);
  const diff = daysBetween(today, dueDate);
  const time = formatTime(input.dueAt, shop);
  const withTime = (text: string) => (input.hasTime ? `${text} ${time}` : text);
  const absoluteDate = formatLocalDate(dueDate, shop.locale, true);
  const absolute = input.hasTime ? `${absoluteDate}, ${time}` : absoluteDate;

  const overdue = isOverdue({ statusCategory: input.category, dueAt: input.dueAt }, new Date(now));
  if (overdue) {
    const late = -diff;
    let label: string;
    if (late <= 0) label = input.hasTime ? `Overdue since ${time}` : 'Overdue today';
    else if (late === 1) label = '1 day overdue';
    else label = `${late} days overdue`;
    return { label, absolute, tone: 'overdue', isOverdue: true };
  }

  let label: string;
  if (diff === 0) label = withTime('Today');
  else if (diff === 1) label = withTime('Tomorrow');
  else if (diff === -1) label = withTime('Yesterday');
  else if (diff > 1 && diff < 7) {
    const weekday = new Intl.DateTimeFormat(shop.locale, {
      timeZone: 'UTC',
      weekday: 'short',
    }).format(new Date(`${dueDate}T12:00:00Z`));
    label = withTime(weekday);
  } else {
    const sameYear = dueDate.slice(0, 4) === today.slice(0, 4);
    label = withTime(
      new Intl.DateTimeFormat(shop.locale, {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
      }).format(new Date(`${dueDate}T12:00:00Z`)),
    );
  }
  const tone: DueTone = diff === 0 && canBeOverdue(input.category) ? 'today' : 'normal';
  return { label, absolute, tone, isOverdue: false };
}
