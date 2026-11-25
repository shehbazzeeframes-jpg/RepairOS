/**
 * Display rules for ticket statuses and due dates (Sprint 2 story §3, §5.5).
 *
 * Contract-independent on purpose: the Zod contracts for statuses are written in parallel, so the
 * category and tone unions are declared here with the story's values. When `packages/contracts`
 * exports `STATUS_CATEGORIES` / the badge-tone enum, replace these two types with imports; the
 * values are the same, so nothing else changes.
 */
import { formatLocalDate, formatTime, todayInZone, type ShopClock } from './timezone';

export const STATUS_CATEGORIES = ['OPEN', 'WAITING', 'READY', 'CLOSED'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** The Astryx Badge variants a status may be coloured with (story ST1: "fixed set of badge tones"). */
export const STATUS_TONES = [
  'neutral',
  'info',
  'success',
  'warning',
  'error',
  'blue',
  'cyan',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'teal',
  'yellow',
] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** Default tone per category, used when a status has no colour of its own. */
export const CATEGORY_TONE: Record<StatusCategory, StatusTone> = {
  OPEN: 'info',
  WAITING: 'warning',
  READY: 'success',
  CLOSED: 'neutral',
};

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  OPEN: 'Open',
  WAITING: 'Waiting',
  READY: 'Ready',
  CLOSED: 'Closed',
};

export function statusTone(category: StatusCategory, colour?: StatusTone | null): StatusTone {
  return colour ?? CATEGORY_TONE[category];
}

/** Overdue applies to open and waiting tickets only (DU1.2); ready and closed are never late. */
export function canBeOverdue(category: StatusCategory): boolean {
  return category === 'OPEN' || category === 'WAITING';
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
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS);
}

/**
 * Relative + absolute due text in the shop's time zone and locale.
 * `now` is injectable so lists render one consistent clock and tests are deterministic.
 */
export function describeDue(input: DueInput, shop: ShopClock, now: number = Date.now()): DueDescription {
  const dueMs = Date.parse(input.dueAt);
  const today = todayInZone(shop.timezone, now);
  const dueDate = todayInZone(shop.timezone, dueMs);
  const diff = daysBetween(today, dueDate);
  const time = formatTime(input.dueAt, shop);
  const withTime = (text: string) => (input.hasTime ? `${text} ${time}` : text);
  const absoluteDate = formatLocalDate(dueDate, shop.locale, true);
  const absolute = input.hasTime ? `${absoluteDate}, ${time}` : absoluteDate;

  const isOverdue = canBeOverdue(input.category) && dueMs < now;
  if (isOverdue) {
    const late = -diff;
    let label: string;
    if (late <= 0) label = input.hasTime ? `Overdue since ${time}` : 'Overdue today';
    else if (late === 1) label = '1 day overdue';
    else label = `${late} days overdue`;
    return { label, absolute, tone: 'overdue', isOverdue };
  }

  let label: string;
  if (diff === 0) label = withTime('Today');
  else if (diff === 1) label = withTime('Tomorrow');
  else if (diff === -1) label = withTime('Yesterday');
  else if (diff > 1 && diff < 7) {
    const weekday = new Intl.DateTimeFormat(shop.locale, { timeZone: 'UTC', weekday: 'short' }).format(
      new Date(`${dueDate}T12:00:00Z`),
    );
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
  return { label, absolute, tone, isOverdue };
}
