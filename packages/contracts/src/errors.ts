import { z } from 'zod';

/**
 * Every `ApiError.code` the API may return. Generic codes first, then Sprint 1 domain codes.
 * The HTTP status each code is used with is in `API_ERROR_STATUS`.
 */
export const ApiErrorCode = z.enum([
  // generic (Sprint 0)
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  // shops (§7)
  'SHOP_LIMIT_REACHED',
  // staff (§2)
  'SEAT_LIMIT_REACHED',
  'ALREADY_MEMBER',
  'MEMBER_DEACTIVATED',
  'INVITE_PENDING',
  'CANNOT_CHANGE_SELF',
  'LAST_OWNER',
  'INVITE_NOT_PENDING',
  // invites (§3)
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_EMAIL_MISMATCH',
  // tax (§4.2)
  'TAX_RATE_IS_DEFAULT',
  'LAST_TAX_RATE',
  'TAX_RATE_NAME_TAKEN',
  'TAX_RATE_ARCHIVED',
  // time clock (§5)
  'ALREADY_CLOCKED_IN',
  'NOT_CLOCKED_IN',
  'TIME_ENTRY_OVERLAP',
  // Sprint 2: cross-cutting (§8.1, optimistic concurrency)
  'ACTIVE_SHOP_CHANGED',
  'STALE_RECORD',
  // Sprint 2: customers (§1)
  'CUSTOMER_HAS_OPEN_TICKETS',
  'CUSTOMER_ARCHIVED',
  'CUSTOMER_ERASED',
  // Sprint 2: devices & passcodes (§2)
  'DEVICE_HAS_OPEN_TICKETS',
  'PASSCODE_NOT_AVAILABLE',
  'PASSCODE_UNREADABLE',
  // Sprint 2: ticket statuses & settings (§3, §4)
  'STATUS_NAME_TAKEN',
  'STATUS_LIMIT_REACHED',
  'SYSTEM_STATUS_LOCKED',
  'STATUS_IN_USE',
  'LAST_VISIBLE_STATUS',
  'TICKET_NUMBER_TOO_LOW',
  // Sprint 2: tickets (§5)
  'TRANSITION_NOT_ALLOWED',
  'STATUS_HIDDEN',
  'REOPEN_WINDOW_PASSED',
  'TICKET_CLOSED',
  'ASSIGNEE_NOT_ACTIVE',
  'NOTE_EDIT_WINDOW_PASSED',
  'WARRANTY_NOT_ALLOWED',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** HTTP status per code. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SHOP_LIMIT_REACHED: 403,
  SEAT_LIMIT_REACHED: 403,
  ALREADY_MEMBER: 409,
  MEMBER_DEACTIVATED: 409,
  INVITE_PENDING: 409,
  CANNOT_CHANGE_SELF: 403,
  LAST_OWNER: 409,
  INVITE_NOT_PENDING: 409,
  INVITE_INVALID: 404,
  INVITE_EXPIRED: 410,
  INVITE_REVOKED: 410,
  INVITE_EMAIL_MISMATCH: 403,
  TAX_RATE_IS_DEFAULT: 409,
  LAST_TAX_RATE: 409,
  TAX_RATE_NAME_TAKEN: 409,
  TAX_RATE_ARCHIVED: 409,
  ALREADY_CLOCKED_IN: 409,
  NOT_CLOCKED_IN: 409,
  TIME_ENTRY_OVERLAP: 409,
  ACTIVE_SHOP_CHANGED: 409,
  STALE_RECORD: 409,
  CUSTOMER_HAS_OPEN_TICKETS: 409,
  CUSTOMER_ARCHIVED: 409,
  CUSTOMER_ERASED: 409,
  DEVICE_HAS_OPEN_TICKETS: 409,
  PASSCODE_NOT_AVAILABLE: 403,
  PASSCODE_UNREADABLE: 500,
  STATUS_NAME_TAKEN: 409,
  STATUS_LIMIT_REACHED: 409,
  SYSTEM_STATUS_LOCKED: 409,
  STATUS_IN_USE: 409,
  LAST_VISIBLE_STATUS: 409,
  TICKET_NUMBER_TOO_LOW: 409,
  TRANSITION_NOT_ALLOWED: 409,
  STATUS_HIDDEN: 409,
  REOPEN_WINDOW_PASSED: 409,
  TICKET_CLOSED: 409,
  ASSIGNEE_NOT_ACTIVE: 409,
  NOTE_EDIT_WINDOW_PASSED: 409,
  WARRANTY_NOT_ALLOWED: 409,
};

/** Default user-facing messages (the API may substitute {placeholders} with real values). */
export const API_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  FORBIDDEN: 'Your role does not allow this action',
  SHOP_LIMIT_REACHED: 'You can own up to 3 shops for now. Contact support if you need more.',
  SEAT_LIMIT_REACHED: 'Your plan includes 5 users. Extra users are $5/month; billing arrives later.',
  ALREADY_MEMBER: '{email} is already on your team.',
  MEMBER_DEACTIVATED: '{name} was deactivated. Reactivate them instead.',
  INVITE_PENDING: 'An invite was already sent to {email}.',
  CANNOT_CHANGE_SELF: "You can't change your own role.",
  LAST_OWNER: 'A shop needs at least one active owner.',
  INVITE_NOT_PENDING: 'This invite was already accepted or revoked.',
  INVITE_INVALID: "This invite link isn't valid.",
  INVITE_EXPIRED: 'This invite has expired. Ask the shop to send a new one.',
  INVITE_REVOKED: 'This invite is no longer valid. Ask the shop for a new invite.',
  INVITE_EMAIL_MISMATCH: "This invite is for {inviteEmail}, but you're signed in as {email}.",
  TAX_RATE_IS_DEFAULT: 'Choose another default first.',
  LAST_TAX_RATE: 'Your shop needs at least one active tax rate.',
  TAX_RATE_NAME_TAKEN: 'A tax rate with this name already exists.',
  TAX_RATE_ARCHIVED: 'Restore this tax rate before changing it.',
  ALREADY_CLOCKED_IN: "You're already clocked in.",
  NOT_CLOCKED_IN: "You're not clocked in.",
  TIME_ENTRY_OVERLAP: 'This entry overlaps another entry for the same person.',
  ACTIVE_SHOP_CHANGED: 'You switched shop in another tab.',
  /** Customer: "Someone else changed this customer. Reload to see their changes."; ticket: "This ticket changed since you opened it." */
  STALE_RECORD: 'Someone else changed this record. Reload to see their changes.',
  CUSTOMER_HAS_OPEN_TICKETS: "Close or cancel this customer's {n} open tickets first.",
  CUSTOMER_ARCHIVED: 'This customer is archived. Restore them first.',
  CUSTOMER_ERASED: 'This customer was erased.',
  DEVICE_HAS_OPEN_TICKETS: 'This device has an open ticket. Close or cancel it first.',
  PASSCODE_NOT_AVAILABLE: 'Passcodes can be viewed only on an open ticket.',
  PASSCODE_UNREADABLE: "This passcode can't be read. Ask the customer again.",
  STATUS_NAME_TAKEN: 'A status with this name already exists.',
  STATUS_LIMIT_REACHED: 'You can have up to 20 statuses.',
  SYSTEM_STATUS_LOCKED: "Received, Collected and Cancelled can be renamed and recoloured, but not hidden or moved to another category.",
  STATUS_IN_USE: 'Move its tickets first.',
  LAST_VISIBLE_STATUS: 'Keep at least one visible {category} status.',
  TICKET_NUMBER_TOO_LOW: 'The next number must be higher than {highest}, the highest number used.',
  TRANSITION_NOT_ALLOWED: "This ticket can't move to that status.",
  STATUS_HIDDEN: 'This status is hidden. Choose another one.',
  REOPEN_WINDOW_PASSED: 'Tickets can be reopened only within 7 days of closing.',
  TICKET_CLOSED: 'This ticket is closed. Reopen it to make changes.',
  ASSIGNEE_NOT_ACTIVE: "{name} isn't an active member of this shop.",
  NOTE_EDIT_WINDOW_PASSED: 'Notes can be edited only within 10 minutes of posting.',
  WARRANTY_NOT_ALLOWED: 'A warranty ticket can be created only for a collected ticket.',
};

/** Message for 409 TRANSITION_NOT_ALLOWED when trying to collect an open/waiting ticket (§5.4). */
export const COLLECT_NOT_READY_MESSAGE =
  'Mark it Ready for pickup first, or cancel it if the customer took it back unrepaired.';
/** STALE_RECORD message variants. */
export const STALE_CUSTOMER_MESSAGE = 'Someone else changed this customer. Reload to see their changes.';
export const STALE_TICKET_MESSAGE = 'This ticket changed since you opened it.';

/** Standard error body for every non-2xx response. `code` is an `ApiErrorCode` (kept as string for forward compatibility). */
export const ApiError = z.object({
  statusCode: z.number(),
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
