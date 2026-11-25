import { z } from 'zod';
import {
  CursorQuery,
  IdParam,
  IsoDateTime,
  LocalDate,
  OptionalQueryBoolean,
  PageSizeQuery,
  Reason,
  RecordVersion,
  SearchText,
  UserRef,
  queryList,
} from './common';
import { CreateCustomerInput, CustomerKind, CustomerPhone, PreferredChannel, createCustomerSchema } from './customers';
import { CreateDeviceInput, Device, DeviceType, PasscodeInput } from './devices';
import { CountryCode } from './markets';
import { EstimateInput, Money } from './money';
import { Role } from './roles';
import {
  AccessoryCode,
  CANCEL_REASONS_REQUIRING_RETURN,
  CancelReason,
  ChecklistInput,
  ChecklistItemKey,
  ChecklistResult,
  MAX_TICKET_ISSUES,
  TicketIssue,
  TicketIssueInput,
  checklistKeyProblems,
} from './ticket-presets';
import { StatusCategory, StatusRef } from './ticket-statuses';
import { optionalText } from './validators';

/**
 * Tickets (Sprint 2 story §5). One device per ticket (A21). Every change writes a timeline event (§5.8, A12);
 * cancel/reopen are also audited. Tickets from another shop are 404 NOT_FOUND, never 403.
 * `numberLabel` = `formatTicketNumber(shop prefix, number)` is computed by the API on every read.
 */

export const TicketPriority = z.enum(['NORMAL', 'URGENT']);
export type TicketPriority = z.infer<typeof TicketPriority>;
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = { NORMAL: 'Normal', URGENT: 'Urgent' };

export const NoteVisibility = z.enum(['INTERNAL', 'CUSTOMER']);
export type NoteVisibility = z.infer<typeof NoteVisibility>;
export const NOTE_VISIBILITY_LABELS: Record<NoteVisibility, string> = { INTERNAL: 'Internal', CUSTOMER: 'Visible to customer' };

/** Due time input "HH:mm" (any minute). */
export const DueTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const TicketLink = z.object({ id: z.string(), number: z.number().int(), numberLabel: z.string() });
export type TicketLink = z.infer<typeof TicketLink>;

const NoteBody = z.string().trim().min(1, 'Write a note').max(2000, 'Use 2000 characters or fewer');

/** A note to add along with an action (status change requiring a note). */
export const InlineNoteInput = z
  .object({ body: NoteBody, visibility: NoteVisibility })
  .strict();
export type InlineNoteInput = z.infer<typeof InlineNoteInput>;

const AccessoriesInput = z
  .array(AccessoryCode)
  .max(9)
  .transform((a) => [...new Set(a)]);

const accessoriesRule = (v: { accessories?: string[]; accessoriesOther?: string | null }, ctx: z.RefinementCtx) => {
  if (v.accessories?.includes('OTHER') && !v.accessoriesOther) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessoriesOther'], message: 'Say what else was left' });
  }
};

// ---------- Check-in (create) ----------

/**
 * Shape of POST /api/tickets (check-in, TK1–TK4, TK-W). Parse with `createTicketSchema(shop.country)` (normalises a
 * nested `newCustomer`).
 *
 * POST /api/tickets · header `Idempotency-Key: <uuid>` (optional; see `IDEMPOTENCY_KEY_HEADER`)
 * · permission `tickets.create`, plus `customers.manage` when `newCustomer`/`newDevice`/`devicePasscode` is given
 * → 201 `TicketDetail` (200 with the same ticket for an idempotent repeat).
 * One transaction: optional new customer → optional new device → passcode → gapless number → ticket in the INITIAL
 * status → `created` timeline event (and `warranty_linked` on the original) → customer `openTicketCount`/`lastVisitAt`.
 * - Exactly one of `customerId` / `newCustomer`; exactly one of `deviceId` / `newDevice`. A new customer needs a new device.
 * - `deviceId` must belong to the customer. `devicePasscode` (existing device only) sets/replaces its passcode
 *   (audits `device.passcode_changed`).
 * - At least one issue or a description. Checklist keys must belong to the device type.
 * - `estimate.currency` must be the shop currency. Due omitted → `computeDefaultDueAt`; given → `dueAtFor` and
 *   `dueInputProblem` (past → 400). `assigneeUserId` must be an ACTIVE member.
 * - `warrantyOfTicketId`: original must be closed through COLLECTED; the stored link points at the ROOT original
 *   (if the original is itself a warranty ticket, its original). Priority defaults NORMAL.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND (customer/device/original/assignee not in shop),
 * 409 CUSTOMER_ARCHIVED ("Restore and use"), 409 CUSTOMER_ERASED, 409 ASSIGNEE_NOT_ACTIVE,
 * 409 WARRANTY_NOT_ALLOWED, 409 ACTIVE_SHOP_CHANGED.
 */
export const CreateTicketInput = z
  .object({
    customerId: IdParam.optional(),
    newCustomer: CreateCustomerInput.optional(),
    deviceId: IdParam.optional(),
    newDevice: CreateDeviceInput.optional(),
    devicePasscode: PasscodeInput.optional(),
    issues: z.array(TicketIssueInput).max(MAX_TICKET_ISSUES, `Choose up to ${MAX_TICKET_ISSUES} issues`).default([]),
    description: optionalText(1000),
    checklist: ChecklistInput.default({}),
    conditionNotes: optionalText(1000),
    accessories: AccessoriesInput.default([]),
    accessoriesOther: optionalText(100),
    estimate: EstimateInput.nullish().transform((v) => v ?? null),
    dueDate: LocalDate.optional(),
    dueTime: DueTime.nullish().transform((v) => v ?? null),
    priority: TicketPriority.default('NORMAL'),
    assigneeUserId: IdParam.nullish().transform((v) => v ?? null),
    warrantyOfTicketId: IdParam.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (!!v.customerId === !!v.newCustomer) issue(['customerId'], 'Choose a customer or add a new one');
    if (!!v.deviceId === !!v.newDevice) issue(['deviceId'], 'Choose a device or add a new one');
    if (v.newCustomer && v.deviceId) issue(['deviceId'], 'Add a device for the new customer');
    if (v.devicePasscode && !v.deviceId) issue(['devicePasscode'], 'Set the passcode on the new device instead');
    if (v.issues.length === 0 && !v.description) issue(['issues'], 'Choose an issue or describe the problem');
    if (v.newDevice) for (const k of checklistKeyProblems(v.newDevice.type, v.checklist)) issue(['checklist', k], 'Not on this device’s checklist');
    if (v.dueTime && !v.dueDate) issue(['dueDate'], 'Choose a due date');
    accessoriesRule(v, ctx);
  });
export type CreateTicketInput = z.input<typeof CreateTicketInput>;

/** Country-aware check-in schema: `newCustomer` comes out normalised (`CreateCustomerData`). */
export function createTicketSchema(country: CountryCode) {
  const customerSchema = createCustomerSchema(country);
  return CreateTicketInput.transform((v, ctx) => {
    if (!v.newCustomer) return { ...v, newCustomer: undefined };
    const parsed = customerSchema.safeParse(v.newCustomer);
    if (!parsed.success) {
      for (const i of parsed.error.issues) ctx.addIssue({ ...i, path: ['newCustomer', ...i.path] });
      return z.NEVER;
    }
    return { ...v, newCustomer: parsed.data };
  });
}
export type CreateTicketData = z.output<ReturnType<typeof createTicketSchema>>;

// ---------- Reads ----------

export const TicketCustomer = z.object({
  id: z.string(),
  kind: CustomerKind,
  /** "Erased customer" for erased customers (no contact details then). */
  displayName: z.string(),
  phones: z.array(CustomerPhone),
  whatsappPhoneId: z.string().nullable(),
  email: z.string().nullable(),
  preferredChannel: PreferredChannel.nullable(),
  /** Customer note callout. */
  notes: z.string().nullable(),
  archived: z.boolean(),
  erased: z.boolean(),
});
export type TicketCustomer = z.infer<typeof TicketCustomer>;

/** Device card on the ticket ("3 previous tickets"). Never the passcode. */
export const TicketDevice = Device.extend({ previousTicketCount: z.number().int().min(0) });
export type TicketDevice = z.infer<typeof TicketDevice>;

export const TicketListItem = z.object({
  id: z.string(),
  number: z.number().int(),
  numberLabel: z.string(),
  /** Warranty badge */
  isWarranty: z.boolean(),
  customer: z.object({ id: z.string(), displayName: z.string(), primaryPhone: z.string().nullable(), erased: z.boolean() }),
  device: z.object({ id: z.string(), type: DeviceType, brand: z.string(), model: z.string() }),
  /** All issue labels in order (the list shows the first 2 + "+n"); description used when there are none. */
  issues: z.array(z.string()),
  description: z.string().nullable(),
  status: StatusRef,
  /** null = Unassigned. `active: false` = deactivated ("Sam (deactivated)"), still counted in Unassigned. */
  assignee: UserRef.nullable(),
  priority: TicketPriority,
  dueAt: IsoDateTime,
  dueHasTime: z.boolean(),
  /** `isOverdue` at the server's `now`. */
  isOverdue: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});
export type TicketListItem = z.infer<typeof TicketListItem>;

/**
 * GET /api/tickets/:id · permission `tickets.view` → 200 `TicketDetail`. 404 NOT_FOUND (incl. other shop).
 * Also the response of every ticket mutation (create, PATCH, status, assign, cancel, reopen).
 */
export const TicketDetail = z.object({
  id: z.string(),
  number: z.number().int(),
  numberLabel: z.string(),
  status: StatusRef,
  statusChangedAt: IsoDateTime,
  /** Status before the ticket was closed: the Reopen dialog's default target. null unless closed. */
  statusBeforeClose: StatusRef.nullable(),
  priority: TicketPriority,
  customer: TicketCustomer,
  device: TicketDevice,
  assignee: UserRef.nullable(),
  issues: z.array(TicketIssue),
  description: z.string().nullable(),
  /** Every item of the device type's checklist (UNTESTED by default), in `CHECKLIST_ITEMS_BY_DEVICE_TYPE` order. */
  checklist: z.record(ChecklistItemKey, ChecklistResult),
  conditionNotes: z.string().nullable(),
  accessories: z.array(AccessoryCode),
  accessoriesOther: z.string().nullable(),
  /** Currency is the shop currency snapshotted at check-in. */
  estimate: Money.nullable(),
  /** Shop's prices-include-tax setting: label "incl. tax" / "excl. tax". */
  estimateIncludesTax: z.boolean(),
  dueAt: IsoDateTime,
  dueHasTime: z.boolean(),
  isOverdue: z.boolean(),
  /** "Warranty for T-0998" (root original). */
  warrantyOf: TicketLink.nullable(),
  /** "Warranty ticket: T-1101" (newest first). */
  warrantyTickets: z.array(TicketLink),
  closedAt: IsoDateTime.nullable(),
  cancelReason: CancelReason.nullable(),
  cancelNote: z.string().nullable(),
  reopenCount: z.number().int().min(0),
  /** closedAt + 7 days while closed (Reopen offered until then); null when not closed. */
  reopenableUntil: IsoDateTime.nullable(),
  version: RecordVersion,
  createdBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TicketDetail = z.infer<typeof TicketDetail>;

// ---------- List, views, counts ----------

/**
 * Views (TL1.1). `all` is any category (used by "See all ticket results", a customer's Tickets tab and device
 * history).
 * - open: OPEN, WAITING, READY · mine: assignee = me and not CLOSED · unassigned: OPEN/WAITING with no assignee or a
 *   deactivated assignee · ready: READY · overdue: OPEN/WAITING and dueAt < now · closed: CLOSED · all: everything.
 */
export const TICKET_VIEWS = ['open', 'mine', 'unassigned', 'ready', 'overdue', 'closed', 'all'] as const;
export const TicketView = z.enum(TICKET_VIEWS);
export type TicketView = z.infer<typeof TicketView>;
export const TICKET_VIEW_LABELS: Record<TicketView, string> = {
  open: 'All open',
  mine: 'Mine',
  unassigned: 'Unassigned',
  ready: 'Ready for pickup',
  overdue: 'Overdue',
  closed: 'Closed',
  all: 'All tickets',
};

/** Technicians land on Mine, everyone else on All open (TL1.2, TQ1.1). */
export function defaultTicketView(role: Role | null | undefined): TicketView {
  return role === 'TECHNICIAN' ? 'mine' : 'open';
}

export interface ViewTicketLike {
  statusCategory: StatusCategory;
  assigneeUserId: string | null;
  /** false when the assignee is deactivated in this shop */
  assigneeActive?: boolean;
  dueAt: string | Date;
}

/** Pure view membership (same definition as the API's SQL; used in tests and optimistic UI updates). */
export function ticketInView(t: ViewTicketLike, view: TicketView, ctx: { userId: string; now: Date }): boolean {
  const c = t.statusCategory;
  const tracked = c === 'OPEN' || c === 'WAITING';
  switch (view) {
    case 'open':
      return c !== 'CLOSED';
    case 'mine':
      return c !== 'CLOSED' && t.assigneeUserId === ctx.userId;
    case 'unassigned':
      return tracked && (t.assigneeUserId === null || t.assigneeActive === false);
    case 'ready':
      return c === 'READY';
    case 'overdue':
      return tracked && new Date(t.dueAt).getTime() < ctx.now.getTime();
    case 'closed':
      return c === 'CLOSED';
    case 'all':
      return true;
  }
}

/**
 * - `default`: open views → Urgent first, then due soonest, then number; `closed` view → closed newest.
 * - `due` (soonest), `created` (newest), `updated` (newest), `number` (highest), `closed` (closed newest),
 *   `open_first` (non-closed first, then newest; the customer page's Tickets tab).
 */
export const TicketSort = z.enum(['default', 'due', 'created', 'updated', 'number', 'closed', 'open_first']);
export type TicketSort = z.infer<typeof TicketSort>;

/** Assignee filter value meaning "no assignee (or deactivated)". */
export const UNASSIGNED = 'unassigned';

/**
 * GET /api/tickets?view&status&assignee&priority&createdFrom&createdTo&dueFrom&dueTo&deviceType&warranty
 *   &customerId&deviceId&q&sort&cursor&limit · permission `tickets.view` → 200 `TicketListResponse`.
 * Filters combine with the view (AND). Multi-value params accept repeats or commas.
 * - `status`: status ids; `category`: status categories; `assignee`: user ids and/or "unassigned"; `deviceType`: DeviceType values.
 * - Date ranges are inclusive shop-local dates. `warranty=true` → warranty tickets only.
 * - `q` (2–100): exact ticket number (`parseTicketNumberQuery` with the shop prefix), customer name, phone (any
 *   format, as customer search), email, IMEI (full or last ≥ 4 digits), serial (contains).
 * - Keyset cursor; `total` capped at 10,000 (`totalCapped`).
 * Errors: 400 VALIDATION_FAILED (incl. bad cursor).
 */
export const TicketListQuery = z
  .object({
    view: TicketView.default('open'),
    status: queryList(z.string().min(1).max(64), 20),
    category: queryList(StatusCategory, 4),
    assignee: queryList(z.string().min(1).max(64), 50),
    priority: TicketPriority.optional(),
    createdFrom: LocalDate.optional(),
    createdTo: LocalDate.optional(),
    dueFrom: LocalDate.optional(),
    dueTo: LocalDate.optional(),
    deviceType: queryList(DeviceType, 7),
    warranty: OptionalQueryBoolean,
    customerId: IdParam.optional(),
    deviceId: IdParam.optional(),
    q: SearchText.optional(),
    sort: TicketSort.default('default'),
    cursor: CursorQuery,
    limit: PageSizeQuery,
  })
  .superRefine((v, ctx) => {
    if (v.createdFrom && v.createdTo && v.createdTo < v.createdFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['createdTo'], message: 'End date must be on or after start date' });
    }
    if (v.dueFrom && v.dueTo && v.dueTo < v.dueFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueTo'], message: 'End date must be on or after start date' });
    }
  });
export type TicketListQuery = z.infer<typeof TicketListQuery>;

export const TicketListResponse = z.object({
  items: z.array(TicketListItem),
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0),
  totalCapped: z.boolean(),
  serverNow: IsoDateTime,
});
export type TicketListResponse = z.infer<typeof TicketListResponse>;

/**
 * GET /api/tickets/counts · permission `tickets.view` → 200 `TicketCounts`. One grouped query over non-closed
 * tickets; filters are NOT applied (view totals). The dashboard tiles use the same numbers (DB1.5):
 * Open tickets = `openAndWaiting`, Ready for pickup = `ready`, Overdue = `overdue`, Due today = `dueToday`.
 * No count for `closed` / `all`.
 */
export const TicketCounts = z.object({
  open: z.number().int().min(0),
  mine: z.number().int().min(0),
  unassigned: z.number().int().min(0),
  ready: z.number().int().min(0),
  overdue: z.number().int().min(0),
  /** OPEN or WAITING due on today's shop-local date (incl. overdue today). */
  dueToday: z.number().int().min(0),
  /** OPEN + WAITING categories (dashboard "Open tickets" tile). */
  openAndWaiting: z.number().int().min(0),
  serverNow: IsoDateTime,
});
export type TicketCounts = z.infer<typeof TicketCounts>;

/** Refresh interval for counts/tiles (TL1.9, DB1.4), plus on window focus. */
export const TICKET_COUNTS_REFRESH_MS = 60_000;

/**
 * GET /api/assignees · permission `tickets.view` → 200 `AssigneesResponse`: ACTIVE members of the shop, Technicians
 * first then by name. Deactivated members are never offered.
 */
export const AssigneesResponse = z.object({
  items: z.array(z.object({ userId: z.string(), name: z.string(), role: Role, isSelf: z.boolean() })),
});
export type AssigneesResponse = z.infer<typeof AssigneesResponse>;

// ---------- Edit ----------

/**
 * PATCH /api/tickets/:id · permission `tickets.edit` (+ `customers.manage` when `deviceId`/`customerId` change)
 * → 200 `TicketDetail`. Non-closed tickets only (409 TICKET_CLOSED). `version` required (409 STALE_RECORD with
 * `STALE_TICKET_MESSAGE`). Writes ONE `fields_changed` event listing old → new per field (checklist per item);
 * device/customer changes write `device_changed` / `customer_changed`.
 * - `checklist` is merged per item (send only changed items); keys must belong to the device type.
 * - Due: `dueDate` (+ optional `dueTime`, null = date-only); validated with `dueInputProblem`.
 * - `customerId` change requires `deviceId` (a device of that customer); `deviceId` alone must belong to the
 *   current customer.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND, 409 STALE_RECORD, 409 TICKET_CLOSED,
 * 409 CUSTOMER_ARCHIVED, 409 CUSTOMER_ERASED.
 */
export const UpdateTicketInput = z
  .object({
    version: RecordVersion,
    issues: z.array(TicketIssueInput).max(MAX_TICKET_ISSUES).optional(),
    description: optionalText(1000).optional(),
    checklist: ChecklistInput.optional(),
    conditionNotes: optionalText(1000).optional(),
    accessories: AccessoriesInput.optional(),
    accessoriesOther: optionalText(100).optional(),
    estimate: EstimateInput.nullable().optional(),
    dueDate: LocalDate.optional(),
    dueTime: DueTime.nullable().optional(),
    priority: TicketPriority.optional(),
    customerId: IdParam.optional(),
    deviceId: IdParam.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.dueTime !== undefined && !v.dueDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: 'Choose a due date' });
    }
    if (v.customerId && !v.deviceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deviceId'], message: 'Choose a device of the new customer' });
    }
    if (v.issues && v.issues.length === 0 && v.description === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['issues'], message: 'Choose an issue or describe the problem' });
    }
    accessoriesRule(v, ctx);
  });
export type UpdateTicketInput = z.input<typeof UpdateTicketInput>;

/**
 * POST /api/tickets/:id/status · permission per `canTransition(..., { via: 'status' })`: `tickets.edit` within
 * OPEN/WAITING/READY, `tickets.cancel` to COLLECTED → 200 `TicketDetail`. No `version` needed; the guard re-checks
 * the current status inside the transaction. `note` is REQUIRED when the target `requiresNote` (e.g. Unrepairable,
 * prompt "Why can't it be repaired?", default visibility CUSTOMER); optional otherwise (posted as a note).
 * Sets statusId/statusCategory/statusChangedAt; entering CLOSED sets closedAt and runs passcode deletion (DV5,
 * `passcode_deleted` event); records `notifyPending` = target.notifyCustomer on the `status_changed` event.
 * Errors: 400 VALIDATION_FAILED (missing required note), 403 FORBIDDEN, 404 NOT_FOUND (ticket or status),
 * 409 STATUS_HIDDEN, 409 TRANSITION_NOT_ALLOWED, 409 TICKET_CLOSED.
 */
export const ChangeTicketStatusInput = z.object({ statusId: IdParam, note: InlineNoteInput.optional() }).strict();
export type ChangeTicketStatusInput = z.infer<typeof ChangeTicketStatusInput>;

/**
 * POST /api/tickets/:id/assign · permission `tickets.edit` → 200 `TicketDetail`. `userId: null` unassigns; "Take" =
 * own userId. Doesn't change status. Writes `assigned` (unchanged → 200, no event). Closed tickets → 409 TICKET_CLOSED.
 * Errors: 403 FORBIDDEN, 404 NOT_FOUND, 409 ASSIGNEE_NOT_ACTIVE, 409 TICKET_CLOSED.
 */
export const AssignTicketInput = z.object({ userId: IdParam.nullable() }).strict();
export type AssignTicketInput = z.infer<typeof AssignTicketInput>;

/**
 * POST /api/tickets/:id/cancel · permission `tickets.cancel` → 200 `TicketDetail`.
 * Moves a non-closed ticket to `statusId` (a CANCELLED or custom CLOSED status; default: the CANCELLED system
 * status). `reason` required; `note` 3–200 required for OTHER, optional (≤ 200) otherwise; `returnedConfirmed` must
 * be true for CUSTOMER_DECLINED / CUSTOMER_TOOK_BACK / OTHER. Audits `ticket.cancelled`; timeline `cancelled`.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND, 409 TICKET_CLOSED, 409 STATUS_HIDDEN,
 * 409 TRANSITION_NOT_ALLOWED (target not a cancel-type closed status).
 */
export const CancelTicketInput = z
  .object({
    statusId: IdParam.optional(),
    reason: CancelReason,
    note: z
      .string()
      .trim()
      .max(200, 'Use 200 characters or fewer')
      .nullish()
      .transform((v) => (v ? v : null)),
    returnedConfirmed: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.reason === 'OTHER' && (!v.note || v.note.length < 3)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'Say why (at least 3 characters)' });
    }
    if (CANCEL_REASONS_REQUIRING_RETURN.includes(v.reason) && !v.returnedConfirmed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returnedConfirmed'], message: 'Confirm the device and accessories were returned' });
    }
  });
export type CancelTicketInput = z.input<typeof CancelTicketInput>;

/**
 * POST /api/tickets/:id/reopen · permission `tickets.cancel` → 200 `TicketDetail`.
 * Closed ≤ 7 days ago only (`withinReopenWindow`). `statusId` = target OPEN/WAITING/READY status (default:
 * `statusBeforeClose`). Clears closedAt, increments reopenCount, audits `ticket.reopened`, timeline `reopened`.
 * A passcode deleted on close is not restored ("Ask the customer for the passcode again").
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND, 409 REOPEN_WINDOW_PASSED, 409 STATUS_HIDDEN,
 * 409 TRANSITION_NOT_ALLOWED (ticket not closed, or target closed).
 */
export const ReopenTicketInput = z.object({ statusId: IdParam.optional(), reason: Reason }).strict();
export type ReopenTicketInput = z.infer<typeof ReopenTicketInput>;

export const TICKET_PATHS = {
  list: '/api/tickets',
  create: '/api/tickets',
  counts: '/api/tickets/counts',
  checkInContext: '/api/tickets/check-in-context',
  detail: '/api/tickets/:id',
  status: '/api/tickets/:id/status',
  assign: '/api/tickets/:id/assign',
  cancel: '/api/tickets/:id/cancel',
  reopen: '/api/tickets/:id/reopen',
  timeline: '/api/tickets/:id/timeline',
  notes: '/api/tickets/:id/notes',
  note: '/api/tickets/:id/notes/:noteId',
  passcodeReveal: '/api/tickets/:id/passcode/reveal',
  assignees: '/api/assignees',
} as const;

/** Fills `:param` placeholders, e.g. `ticketPath('status', { id })` → "/api/tickets/abc/status". */
export function ticketPath(key: keyof typeof TICKET_PATHS, params: Record<string, string> = {}): string {
  return TICKET_PATHS[key].replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? `:${k}`));
}

// ---------- Notes ----------

/** Author may edit their own note within this many minutes (A20). No deletion; visibility fixed after posting. */
export const NOTE_EDIT_WINDOW_MINUTES = 10;

/** True when `userId` may still edit the note at `now`. */
export function canEditNote(note: { authorUserId: string; createdAt: string | Date }, userId: string, now: Date = new Date()): boolean {
  const created = typeof note.createdAt === 'string' ? Date.parse(note.createdAt) : note.createdAt.getTime();
  return note.authorUserId === userId && now.getTime() - created <= NOTE_EDIT_WINDOW_MINUTES * 60_000;
}

export const TicketNote = z.object({
  id: z.string(),
  body: z.string(),
  visibility: NoteVisibility,
  author: UserRef,
  createdAt: IsoDateTime,
  /** "edited" marker */
  editedAt: IsoDateTime.nullable(),
  /** For the viewer: author and still within 10 minutes (`canEditNote`). */
  canEdit: z.boolean(),
});
export type TicketNote = z.infer<typeof TicketNote>;

/**
 * POST /api/tickets/:id/notes · permission `tickets.edit` → 201 `TicketNote`. Allowed on closed tickets too (TE1.3).
 * Writes `note_added`. Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 404 NOT_FOUND.
 */
export const CreateTicketNoteInput = z.object({ body: NoteBody, visibility: NoteVisibility.default('INTERNAL') }).strict();
export type CreateTicketNoteInput = z.input<typeof CreateTicketNoteInput>;

/**
 * PATCH /api/tickets/:id/notes/:noteId · permission `tickets.edit` → 200 `TicketNote`. Own note, ≤ 10 minutes
 * (`canEditNote`); body only. Sets editedAt; writes `note_edited`.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN (not the author), 404 NOT_FOUND, 409 NOTE_EDIT_WINDOW_PASSED.
 */
export const UpdateTicketNoteInput = z.object({ body: NoteBody }).strict();
export type UpdateTicketNoteInput = z.infer<typeof UpdateTicketNoteInput>;

// ---------- Timeline ----------

export const TIMELINE_EVENT_TYPES = [
  'created',
  'status_changed',
  'assigned',
  'fields_changed',
  'device_changed',
  'customer_changed',
  'note_added',
  'note_edited',
  'cancelled',
  'reopened',
  'warranty_linked',
  'passcode_deleted',
  // reserved for later sprints (S3 photos/messages/approvals, S3–S4 items, S5 payments)
  'attachment_added',
  'message_sent',
  'approval_requested',
  'approval_decided',
  'item_added',
  'item_removed',
  'payment_recorded',
] as const;
export const TimelineEventType = z.enum(TIMELINE_EVENT_TYPES);
export type TimelineEventType = z.infer<typeof TimelineEventType>;

/** Types written in Sprint 2. */
export const SPRINT2_TIMELINE_EVENT_TYPES = TIMELINE_EVENT_TYPES.slice(0, 12) as readonly TimelineEventType[];

/** Fields that `fields_changed` can list. Checklist items appear as `checklist.<ITEM_KEY>`. */
export const TICKET_EDITABLE_FIELDS = [
  'issues',
  'description',
  'checklist',
  'conditionNotes',
  'accessories',
  'accessoriesOther',
  'estimate',
  'due',
  'priority',
] as const;

const DeviceSnapshot = z.object({ deviceId: z.string(), label: z.string() });
const CustomerSnapshot = z.object({ customerId: z.string(), displayName: z.string() });

const base = {
  id: z.string(),
  createdAt: IsoDateTime,
  /** null = system (e.g. passcode deleted on close) */
  actor: UserRef.nullable(),
};

const reserved = (type: TimelineEventType) => z.object({ ...base, type: z.literal(type), data: z.record(z.unknown()) });

/**
 * One timeline item. Values in `before`/`after` are raw stored values (instants ISO UTC, estimate as Money, due as
 * `{ dueAt, dueHasTime }`, checklist results, issue labels); the web formats them. Never contains passcodes.
 * Unknown/reserved types must be rendered generically by the web.
 */
export const TicketTimelineItem = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('created'), data: z.object({ status: StatusRef, warrantyOf: TicketLink.nullable() }) }),
  z.object({
    ...base,
    type: z.literal('status_changed'),
    data: z.object({
      from: StatusRef,
      to: StatusRef,
      /** Target status had notifyCustomer on: Sprint 3 will send; nothing is sent in Sprint 2. */
      notifyPending: z.boolean(),
      /** Note posted with the change (also present as its own `note_added` item). */
      noteId: z.string().nullable(),
    }),
  }),
  z.object({ ...base, type: z.literal('assigned'), data: z.object({ from: UserRef.nullable(), to: UserRef.nullable() }) }),
  z.object({
    ...base,
    type: z.literal('fields_changed'),
    data: z.object({ changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })).min(1) }),
  }),
  z.object({ ...base, type: z.literal('device_changed'), data: z.object({ from: DeviceSnapshot, to: DeviceSnapshot }) }),
  z.object({ ...base, type: z.literal('customer_changed'), data: z.object({ from: CustomerSnapshot, to: CustomerSnapshot }) }),
  z.object({ ...base, type: z.literal('note_added'), data: z.object({ note: TicketNote }) }),
  z.object({ ...base, type: z.literal('note_edited'), data: z.object({ noteId: z.string() }) }),
  z.object({
    ...base,
    type: z.literal('cancelled'),
    data: z.object({ status: StatusRef, reason: CancelReason, note: z.string().nullable(), returnedConfirmed: z.boolean() }),
  }),
  z.object({
    ...base,
    type: z.literal('reopened'),
    data: z.object({ from: StatusRef, to: StatusRef, reason: z.string(), passcodeWasDeleted: z.boolean() }),
  }),
  z.object({
    ...base,
    type: z.literal('warranty_linked'),
    /** On the original: "Warranty ticket T-1101 opened" (role `warranty`). */
    data: z.object({ ticket: TicketLink, role: z.enum(['warranty', 'original']) }),
  }),
  z.object({ ...base, type: z.literal('passcode_deleted'), data: z.object({ reason: z.literal('closed') }) }),
  z.object({
    ...base,
    type: z.literal('attachment_added'),
    /** Reserved (Sprint 3 photos). */
    data: z.object({ attachmentId: z.string(), kind: z.enum(['photo']), fileName: z.string().nullable(), thumbnailUrl: z.string().nullable() }),
  }),
  reserved('message_sent'),
  reserved('approval_requested'),
  reserved('approval_decided'),
  reserved('item_added'),
  reserved('item_removed'),
  reserved('payment_recorded'),
]);
export type TicketTimelineItem = z.infer<typeof TicketTimelineItem>;

export const TimelineFilter = z.enum(['all', 'notes', 'status']);
export type TimelineFilter = z.infer<typeof TimelineFilter>;

/** Types included by each timeline filter. `all` = every type except `note_edited` (the note shows "edited"). */
export const TIMELINE_FILTER_TYPES: Record<TimelineFilter, readonly TimelineEventType[]> = {
  all: TIMELINE_EVENT_TYPES.filter((t) => t !== 'note_edited'),
  notes: ['note_added'],
  status: ['created', 'status_changed', 'cancelled', 'reopened'],
};

export const TIMELINE_PAGE_SIZE = 50;

/**
 * GET /api/tickets/:id/timeline?filter=&cursor=&limit= · permission `tickets.view` → 200 `TimelineResponse`.
 * Items are oldest → newest (newest at the bottom). The first page is the NEWEST `limit` items; `olderCursor`
 * loads the page before them. Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND.
 */
export const TimelineQuery = z.object({
  filter: TimelineFilter.default('all'),
  cursor: CursorQuery,
  limit: z.coerce.number().int().min(1).max(100).default(TIMELINE_PAGE_SIZE),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const TimelineResponse = z.object({
  items: z.array(TicketTimelineItem),
  /** null = no older items */
  olderCursor: z.string().nullable(),
});
export type TimelineResponse = z.infer<typeof TimelineResponse>;

/** Draft storage key for check-in (TK3): this user + shop, 24 h, never the passcode. */
export function checkInDraftKey(userId: string, shopId: string): string {
  return `repairos:checkin-draft:${userId}:${shopId}`;
}
export const CHECK_IN_DRAFT_TTL_HOURS = 24;
