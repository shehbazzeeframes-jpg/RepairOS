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
};

/** Standard error body for every non-2xx response. `code` is an `ApiErrorCode` (kept as string for forward compatibility). */
export const ApiError = z.object({
  statusCode: z.number(),
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
