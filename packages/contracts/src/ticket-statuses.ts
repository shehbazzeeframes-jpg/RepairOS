import { z } from 'zod';
import { IsoDateTime } from './common';
import type { ApiErrorCode } from './errors';
import { COLLECT_NOT_READY_MESSAGE } from './errors';
import { hasPermission, type Permission } from './permissions';
import type { Role } from './roles';

/**
 * Configurable ticket statuses (Sprint 2 story §3, §5.4, decisions A7, A8, A9).
 * Categories drive everything: OPEN = being worked on, WAITING = blocked on customer/parts, READY = waiting for
 * pickup, CLOSED = device has left / ticket finished. Tickets store `statusCategory` denormalised.
 */

export const STATUS_CATEGORIES = ['OPEN', 'WAITING', 'READY', 'CLOSED'] as const;
export const StatusCategory = z.enum(STATUS_CATEGORIES);
export type StatusCategory = z.infer<typeof StatusCategory>;

export const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
  OPEN: 'In progress',
  WAITING: 'Waiting',
  READY: 'Ready',
  CLOSED: 'Closed',
};

/** Categories a ticket counts as "open" in (everything but CLOSED). */
export const NON_CLOSED_CATEGORIES: readonly StatusCategory[] = ['OPEN', 'WAITING', 'READY'];
/** Categories that can be overdue / due today (DU1.2–3). */
export const DUE_TRACKED_CATEGORIES: readonly StatusCategory[] = ['OPEN', 'WAITING'];

export const StatusSystemRole = z.enum(['INITIAL', 'COLLECTED', 'CANCELLED']);
export type StatusSystemRole = z.infer<typeof StatusSystemRole>;

/** Astryx Badge variants (the fixed set of tones a status may use). */
export const STATUS_COLOURS = [
  'neutral', 'info', 'success', 'warning', 'error', 'blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'yellow',
] as const;
export const StatusColour = z.enum(STATUS_COLOURS);
export type StatusColour = z.infer<typeof StatusColour>;

export const MAX_TICKET_STATUSES = 20;

export const StatusName = z.string().trim().min(1, 'Enter a name').max(30, 'Use 30 characters or fewer');

/**
 * A status as returned by GET /api/ticket-statuses (all, including hidden, sorted by `position`).
 * `requiresNote`: moving a ticket into it needs a note (seeded true for Unrepairable; see decisions in the report).
 */
export const TicketStatus = z.object({
  id: z.string(),
  name: z.string(),
  category: StatusCategory,
  systemRole: StatusSystemRole.nullable(),
  colour: StatusColour,
  position: z.number().int().min(0),
  isHidden: z.boolean(),
  /** Stored now, used by Sprint 3 notifications; recorded on status events as `notifyPending`. */
  notifyCustomer: z.boolean(),
  requiresNote: z.boolean(),
  /** Tickets currently in this status. */
  ticketCount: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TicketStatus = z.infer<typeof TicketStatus>;

/** Compact status embedded in tickets and timeline events (resolved at read time: renames show everywhere). */
export const StatusRef = z.object({
  id: z.string(),
  name: z.string(),
  category: StatusCategory,
  colour: StatusColour,
  systemRole: StatusSystemRole.nullable(),
});
export type StatusRef = z.infer<typeof StatusRef>;

export interface DefaultTicketStatus {
  name: string;
  category: StatusCategory;
  systemRole: StatusSystemRole | null;
  colour: StatusColour;
  notifyCustomer: boolean;
  requiresNote: boolean;
}

/** Seeded for every new shop and migrated into existing shops, positions 0..8 in this order (§3). */
export const DEFAULT_TICKET_STATUSES: readonly DefaultTicketStatus[] = [
  { name: 'Received', category: 'OPEN', systemRole: 'INITIAL', colour: 'info', notifyCustomer: true, requiresNote: false },
  { name: 'Diagnosing', category: 'OPEN', systemRole: null, colour: 'blue', notifyCustomer: false, requiresNote: false },
  { name: 'Awaiting approval', category: 'WAITING', systemRole: null, colour: 'warning', notifyCustomer: true, requiresNote: false },
  { name: 'Awaiting parts', category: 'WAITING', systemRole: null, colour: 'orange', notifyCustomer: false, requiresNote: false },
  { name: 'In repair', category: 'OPEN', systemRole: null, colour: 'purple', notifyCustomer: false, requiresNote: false },
  { name: 'Ready for pickup', category: 'READY', systemRole: null, colour: 'success', notifyCustomer: true, requiresNote: false },
  { name: 'Unrepairable', category: 'READY', systemRole: null, colour: 'error', notifyCustomer: true, requiresNote: true },
  { name: 'Collected', category: 'CLOSED', systemRole: 'COLLECTED', colour: 'neutral', notifyCustomer: false, requiresNote: false },
  { name: 'Cancelled', category: 'CLOSED', systemRole: 'CANCELLED', colour: 'neutral', notifyCustomer: false, requiresNote: false },
];

// ---------- Settings → Ticket statuses ----------

/**
 * GET /api/ticket-statuses · permission `tickets.view` → 200 `TicketStatusListResponse` (all statuses incl. hidden,
 * by position). Used for pickers, badges and the settings page.
 */
export const TicketStatusListResponse = z.object({ items: z.array(TicketStatus) });
export type TicketStatusListResponse = z.infer<typeof TicketStatusListResponse>;

/**
 * POST /api/ticket-statuses · permission `statuses.manage` → 201 `TicketStatus` (appended last).
 * New statuses are custom (no system role); a custom CLOSED status is reachable only through Cancel ticket.
 * Audits `ticket_status.created`.
 * Errors: 400 VALIDATION_FAILED, 409 STATUS_NAME_TAKEN (case-insensitive), 409 STATUS_LIMIT_REACHED (20).
 */
export const CreateTicketStatusInput = z
  .object({
    name: StatusName,
    category: StatusCategory,
    colour: StatusColour,
    notifyCustomer: z.boolean().default(false),
    requiresNote: z.boolean().default(false),
  })
  .strict();
export type CreateTicketStatusInput = z.input<typeof CreateTicketStatusInput>;

/**
 * PATCH /api/ticket-statuses/:id · permission `statuses.manage` → 200 `TicketStatus`.
 * Rename / recolour / category / notify / hide / requiresNote. A category change moves every ticket in the status to
 * the new `statusCategory` in the same transaction (web confirms with `ticketCount`). Audits `ticket_status.updated`
 * (changed fields before/after). Use `checkStatusUpdate` for the rules.
 * Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND, 409 STATUS_NAME_TAKEN, 409 SYSTEM_STATUS_LOCKED (hide or
 * re-categorise a system status), 409 STATUS_IN_USE (category to/from CLOSED while it holds tickets),
 * 409 LAST_VISIBLE_STATUS (would leave OPEN or READY with no visible status).
 */
export const UpdateTicketStatusInput = z
  .object({
    name: StatusName.optional(),
    category: StatusCategory.optional(),
    colour: StatusColour.optional(),
    notifyCustomer: z.boolean().optional(),
    isHidden: z.boolean().optional(),
    requiresNote: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');
export type UpdateTicketStatusInput = z.infer<typeof UpdateTicketStatusInput>;

/**
 * PUT /api/ticket-statuses/order · permission `statuses.manage` → 200 `TicketStatusListResponse`.
 * `ids` = every status id of the shop exactly once, in the new order (positions 0..n-1).
 * Audits `ticket_status.reordered` (entity Shop, before/after `{ order }`).
 * Errors: 400 VALIDATION_FAILED (missing, unknown or repeated ids).
 */
export const ReorderTicketStatusesInput = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(MAX_TICKET_STATUSES) })
  .strict()
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: 'Each status once', path: ['ids'] });
export type ReorderTicketStatusesInput = z.infer<typeof ReorderTicketStatusesInput>;

export const TICKET_STATUS_PATHS = {
  list: '/api/ticket-statuses',
  create: '/api/ticket-statuses',
  update: '/api/ticket-statuses/:id',
  order: '/api/ticket-statuses/order',
} as const;

type StatusLike = Pick<TicketStatus, 'id' | 'name' | 'category' | 'systemRole' | 'isHidden'> & { ticketCount?: number };

export type StatusRuleResult = { ok: true } | { ok: false; code: ApiErrorCode; vars?: Record<string, string> };

/** Rules for creating a status (name unique case-insensitively, max 20). */
export function checkStatusCreate(existing: readonly StatusLike[], input: { name: string }): StatusRuleResult {
  if (existing.length >= MAX_TICKET_STATUSES) return { ok: false, code: 'STATUS_LIMIT_REACHED' };
  const n = input.name.trim().toLowerCase();
  if (existing.some((s) => s.name.trim().toLowerCase() === n)) return { ok: false, code: 'STATUS_NAME_TAKEN' };
  return { ok: true };
}

/**
 * Rules for PATCH (A9, ST1.3–6, §5.12): unique name; system statuses can't be hidden or change category;
 * a status holding tickets can't move to or from CLOSED; at least one visible OPEN and one visible READY remain.
 * `ticketCount` on the target is required for the in-use rule.
 */
export function checkStatusUpdate(
  existing: readonly StatusLike[],
  id: string,
  patch: UpdateTicketStatusInput,
): StatusRuleResult {
  const target = existing.find((s) => s.id === id);
  if (!target) return { ok: false, code: 'NOT_FOUND' };
  if (patch.name !== undefined) {
    const n = patch.name.trim().toLowerCase();
    if (existing.some((s) => s.id !== id && s.name.trim().toLowerCase() === n)) return { ok: false, code: 'STATUS_NAME_TAKEN' };
  }
  const categoryChanges = patch.category !== undefined && patch.category !== target.category;
  if (target.systemRole && (categoryChanges || patch.isHidden === true)) return { ok: false, code: 'SYSTEM_STATUS_LOCKED' };
  if (categoryChanges && (target.ticketCount ?? 0) > 0 && (patch.category === 'CLOSED' || target.category === 'CLOSED')) {
    return { ok: false, code: 'STATUS_IN_USE' };
  }
  const after = existing.map((s) =>
    s.id === id ? { ...s, category: patch.category ?? s.category, isHidden: patch.isHidden ?? s.isHidden } : s,
  );
  for (const category of ['OPEN', 'READY'] as const) {
    if (!after.some((s) => s.category === category && !s.isHidden)) {
      return { ok: false, code: 'LAST_VISIBLE_STATUS', vars: { category: STATUS_CATEGORY_LABELS[category].toLowerCase() } };
    }
  }
  return { ok: true };
}

// ---------- Transitions (§5.4, A7) ----------

/** Reopen window after closing (A10). */
export const REOPEN_WINDOW_DAYS = 7;

/** True when a ticket closed at `closedAt` can still be reopened at `now`. */
export function withinReopenWindow(closedAt: string | Date, now: Date = new Date()): boolean {
  const closed = typeof closedAt === 'string' ? Date.parse(closedAt) : closedAt.getTime();
  return now.getTime() - closed <= REOPEN_WINDOW_DAYS * 86_400_000;
}

/**
 * How the move is requested:
 * - `status`: the Change status menu / POST /api/tickets/:id/status (incl. Collect).
 * - `cancel`: Cancel ticket (POST /api/tickets/:id/cancel) into CANCELLED or a custom CLOSED status.
 * - `reopen`: Reopen (POST /api/tickets/:id/reopen) from a CLOSED status.
 */
export type TransitionVia = 'status' | 'cancel' | 'reopen';

export interface TransitionContext {
  /** The actor's permissions (`MeResponse.permissions`), or their role. */
  permissions?: readonly Permission[];
  role?: Role | null;
  via?: TransitionVia;
  /** Needed for `reopen`: when the ticket was closed. */
  closedAt?: string | Date | null;
  now?: Date;
}

type TransitionTarget = Pick<StatusRef, 'id' | 'category' | 'systemRole'> & { isHidden: boolean; requiresNote?: boolean };
type TransitionFrom = StatusCategory | (Pick<StatusRef, 'category'> & { id?: string });

export type TransitionResult =
  | {
      ok: true;
      /** Permission the API guard checks for this move. */
      permission: Permission;
      /** A note must accompany the change (target `requiresNote`, e.g. Unrepairable). */
      requiresNote: boolean;
      /** Entering CLOSED: set closedAt, run passcode-deletion rule (DV5). */
      closes: boolean;
    }
  | { ok: false; code: ApiErrorCode; message?: string };

function allowed(ctx: TransitionContext, p: Permission): boolean {
  if (ctx.permissions) return ctx.permissions.includes(p);
  return hasPermission(ctx.role ?? null, p);
}

/**
 * The single source of truth for status moves, shared by the API (guards inside the transaction) and the web
 * (which statuses to offer). Pure.
 *
 * | From            | To                               | Via     | Permission       | Result |
 * |-----------------|----------------------------------|---------|------------------|--------|
 * | any             | hidden status                    | any     | —                | STATUS_HIDDEN |
 * | X               | X (same status)                  | status  | —                | TRANSITION_NOT_ALLOWED (no-op) |
 * | open/wait/ready | open/wait/ready                  | status  | tickets.edit     | ok (+ note if target requiresNote) |
 * | ready           | COLLECTED                        | status  | tickets.cancel   | ok, closes |
 * | open/wait       | COLLECTED                        | status  | —                | TRANSITION_NOT_ALLOWED (COLLECT_NOT_READY_MESSAGE) |
 * | open/wait/ready | CANCELLED / custom closed        | status  | —                | TRANSITION_NOT_ALLOWED (use Cancel ticket) |
 * | open/wait/ready | CANCELLED / custom closed        | cancel  | tickets.cancel   | ok, closes |
 * | open/wait/ready | anything else                    | cancel  | —                | TRANSITION_NOT_ALLOWED |
 * | closed          | anything                         | status/cancel | —          | TICKET_CLOSED |
 * | closed          | open/wait/ready (≤ 7 days)       | reopen  | tickets.cancel   | ok |
 * | closed          | open/wait/ready (> 7 days)       | reopen  | tickets.cancel   | REOPEN_WINDOW_PASSED |
 * | open/wait/ready | anything                         | reopen  | —                | TRANSITION_NOT_ALLOWED |
 * Missing permission → FORBIDDEN (checked after the structural rules, so the UI can tell "never" from "not you").
 */
export function canTransition(from: TransitionFrom, to: TransitionTarget, ctx: TransitionContext = {}): TransitionResult {
  const via = ctx.via ?? 'status';
  const fromCategory = typeof from === 'string' ? from : from.category;
  const fromId = typeof from === 'string' ? undefined : from.id;
  if (to.isHidden) return { ok: false, code: 'STATUS_HIDDEN' };

  const ok = (permission: Permission, closes: boolean): TransitionResult =>
    allowed(ctx, permission)
      ? { ok: true, permission, requiresNote: !!to.requiresNote && via === 'status', closes }
      : { ok: false, code: 'FORBIDDEN' };

  if (fromCategory === 'CLOSED') {
    if (via !== 'reopen') return { ok: false, code: 'TICKET_CLOSED' };
    if (to.category === 'CLOSED') return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };
    if (!ctx.closedAt || !withinReopenWindow(ctx.closedAt, ctx.now)) return { ok: false, code: 'REOPEN_WINDOW_PASSED' };
    return ok('tickets.cancel', false);
  }

  if (via === 'reopen') return { ok: false, code: 'TRANSITION_NOT_ALLOWED', message: 'Only closed tickets can be reopened.' };

  if (via === 'cancel') {
    if (to.category !== 'CLOSED' || to.systemRole === 'COLLECTED') return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };
    return ok('tickets.cancel', true);
  }

  // via === 'status'
  if (fromId !== undefined && fromId === to.id) {
    return { ok: false, code: 'TRANSITION_NOT_ALLOWED', message: 'The ticket is already in this status.' };
  }
  if (to.category !== 'CLOSED') return ok('tickets.edit', false);
  if (to.systemRole === 'COLLECTED') {
    if (fromCategory !== 'READY') return { ok: false, code: 'TRANSITION_NOT_ALLOWED', message: COLLECT_NOT_READY_MESSAGE };
    return ok('tickets.cancel', true);
  }
  return { ok: false, code: 'TRANSITION_NOT_ALLOWED', message: 'Use Cancel ticket to close it with a reason.' };
}

/**
 * Statuses to offer in a menu: those for which `canTransition` is ok (hidden excluded), in position order.
 * `via` 'status' → Change status menu; 'cancel' → Cancel dialog's closed-status choice; 'reopen' → Reopen target.
 */
export function allowedTargetStatuses<T extends TransitionTarget & { position?: number }>(
  from: TransitionFrom,
  statuses: readonly T[],
  ctx: TransitionContext = {},
): T[] {
  return statuses
    .filter((s) => canTransition(from, s, ctx).ok)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}
