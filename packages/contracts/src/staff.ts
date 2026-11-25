import { z } from 'zod';
import { EmailAddress, IsoDateTime } from './common';
import { Role } from './roles';

/**
 * Staff management and invites (Sprint 1 story §2, §3, D7, D10).
 * Every staff route requires `staff.manage` (writes) or `staff.view` (list) AND, for writes,
 * `canManageRole(actorRole, targetRole[, newRole])`; failing that → 403 FORBIDDEN.
 */

/** Seats included in the plan: ACTIVE memberships + PENDING unexpired invites ≤ 5. */
export const SEAT_LIMIT = 5;
export const INVITE_TTL_DAYS = 7;

export const StaffStatus = z.enum(['ACTIVE', 'INVITED', 'DEACTIVATED']);
export type StaffStatus = z.infer<typeof StaffStatus>;

export const InviteEmailStatus = z.enum(['QUEUED', 'SENT', 'FAILED']);
export type InviteEmailStatus = z.infer<typeof InviteEmailStatus>;

/**
 * One row of Settings → Staff: a membership (`kind: "MEMBER"`) or a pending/expired invite (`kind: "INVITE"`).
 * Accepted and revoked invites are never listed.
 */
export const StaffListItem = z.object({
  kind: z.enum(['MEMBER', 'INVITE']),
  /** Membership id for members (use in /api/staff/:membershipId/*), invitation id for invites (/api/staff/invites/:id/*). */
  id: z.string(),
  /** null for invites */
  userId: z.string().nullable(),
  /** null for invites (UI shows "—") */
  name: z.string().nullable(),
  email: z.string(),
  role: Role,
  status: StaffStatus,
  /** True for the caller's own row: UI shows "You" and offers no actions. */
  isSelf: z.boolean(),
  /** Member has an open time entry in this shop ("Clocked in now" badge). Always false for invites. */
  clockedIn: z.boolean(),
  /** Start of the member's latest time entry; null = "Never" (and for invites). */
  lastClockInAt: IsoDateTime.nullable(),
  deactivatedAt: IsoDateTime.nullable(),
  /** Invites only (null for members). */
  inviteExpiresAt: IsoDateTime.nullable(),
  /** Invites only: PENDING with expiresAt < now ("Expired on {date}", no seat held). */
  inviteExpired: z.boolean(),
  inviteEmailStatus: InviteEmailStatus.nullable(),
  /** Invites only: set once the link was copied (D10). */
  inviteLinkCopiedAt: IsoDateTime.nullable(),
});
export type StaffListItem = z.infer<typeof StaffListItem>;

export const SeatUsage = z.object({ used: z.number().int().min(0), limit: z.number().int().min(0) });
export type SeatUsage = z.infer<typeof SeatUsage>;

/**
 * GET /api/staff?status=ACTIVE,INVITED · permission `staff.view` → 200 `StaffListResponse`.
 * `status` is a comma-separated filter; default ACTIVE,INVITED.
 * Sorted: ACTIVE (Owners, Managers, Front desk, Technicians, then name), INVITED (by email), DEACTIVATED (by name).
 * `seats` counts the whole shop regardless of filter.
 */
export const StaffListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return ['ACTIVE', 'INVITED'] as StaffStatus[];
      const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
      const parsed = z.array(StaffStatus).min(1).safeParse(parts);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use ACTIVE, INVITED and/or DEACTIVATED' });
        return z.NEVER;
      }
      return parsed.data;
    }),
});
export type StaffListQuery = z.infer<typeof StaffListQuery>;

export const StaffListResponse = z.object({ items: z.array(StaffListItem), seats: SeatUsage });
export type StaffListResponse = z.infer<typeof StaffListResponse>;

/**
 * POST /api/staff/invites · permission `staff.manage` → 201 `StaffListItem` (the invite row; email is queued).
 * Audits `invite.created`. Rate limit: 20 invites per shop per day.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN (role not in manageableRoles), 403 SEAT_LIMIT_REACHED,
 * 409 ALREADY_MEMBER (active member, incl. your own email), 409 MEMBER_DEACTIVATED (body message names them),
 * 409 INVITE_PENDING, 429 RATE_LIMITED.
 */
export const CreateInviteInput = z.object({ email: EmailAddress, role: Role }).strict();
export type CreateInviteInput = z.infer<typeof CreateInviteInput>;

/**
 * POST /api/staff/invites/:id/resend · permission `staff.manage` → 200 `StaffListItem`.
 * New token (old link dies), expiresAt = now + 7 days, email re-queued, `linkCopiedAt` reset to null. Audits `invite.resent`.
 * Seat limit re-checked when the invite had expired. Rate limit: 1/min and 5/day per invite.
 * Errors: 403 FORBIDDEN, 403 SEAT_LIMIT_REACHED, 404 NOT_FOUND, 409 INVITE_NOT_PENDING, 429 RATE_LIMITED. No body.
 *
 * POST /api/staff/invites/:id/revoke · permission `staff.manage` → 204 No Content. Audits `invite.revoked`.
 * Errors: 403 FORBIDDEN, 404 NOT_FOUND, 409 INVITE_NOT_PENDING. No body. (Also used for "Remove" on expired invites.)
 */
export const STAFF_INVITE_ACTION_PATHS = {
  resend: '/api/staff/invites/:id/resend',
  revoke: '/api/staff/invites/:id/revoke',
  link: '/api/staff/invites/:id/link',
} as const;

/**
 * POST /api/staff/invites/:id/link · permission `staff.manage` → 200 `InviteLinkResponse` (D10 "Copy invite link").
 * Tokens are stored hashed, so this ROTATES the token like Resend (the previously emailed link stops working),
 * resets expiresAt to now + 7 days, sets `linkCopiedAt` (so accepting won't set emailVerified, D7) and sends no email.
 * Seat limit re-checked when the invite had expired. Audits `invite.link_copied` (never the token/url).
 * Same rate limit as resend. Errors: as resend. No body.
 */
export const InviteLinkResponse = z.object({ url: z.string().url(), expiresAt: IsoDateTime });
export type InviteLinkResponse = z.infer<typeof InviteLinkResponse>;

/**
 * PATCH /api/staff/:membershipId/role · permission `staff.manage` → 200 `StaffListItem`.
 * Both current and new role must be in `manageableRoles(actor)`. Audits `member.role_changed`. Same role → 200 no-op.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN, 403 CANNOT_CHANGE_SELF, 404 NOT_FOUND, 409 LAST_OWNER,
 * 409 MEMBER_DEACTIVATED (reactivate first).
 */
export const ChangeRoleInput = z.object({ role: Role }).strict();
export type ChangeRoleInput = z.infer<typeof ChangeRoleInput>;

/**
 * POST /api/staff/:membershipId/deactivate · permission `staff.manage` → 200 `StaffListItem`.
 * Closes an open time entry (closedReason DEACTIVATED, audits `time_entry.auto_closed`); audits `member.deactivated`.
 * Errors: 403 FORBIDDEN, 403 CANNOT_CHANGE_SELF, 404 NOT_FOUND, 409 LAST_OWNER. Already deactivated → 200 no-op. No body.
 *
 * POST /api/staff/:membershipId/reactivate · permission `staff.manage` → 200 `StaffListItem`. Same role as before.
 * Audits `member.reactivated`. Errors: 403 FORBIDDEN, 403 SEAT_LIMIT_REACHED, 404 NOT_FOUND. Already active → 200 no-op.
 */
export const STAFF_MEMBER_ACTION_PATHS = {
  role: '/api/staff/:membershipId/role',
  deactivate: '/api/staff/:membershipId/deactivate',
  reactivate: '/api/staff/:membershipId/reactivate',
} as const;

// ---------- Public invite flow ----------

/**
 * Invite token in the URL `/invite/:token`: 32 random bytes, base64url (43 chars).
 * A malformed token is answered like an unknown one (404 INVITE_INVALID), never 400, so tokens can't be probed.
 */
export const InviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * GET /api/invites/:token · public, rate limited per IP (30/min) → 200 `InvitePreview`.
 * - VALID / EXPIRED: details to render the page (EXPIRED: "This invite expired on {expiresAt}. Ask {inviterName}…").
 * - REVOKED: no details.
 * - ACCEPTED: only when the caller is signed in as the user who accepted it ("You've already joined {shopName}").
 * Errors: 404 INVITE_INVALID for unknown/malformed tokens and invites accepted by someone else (or when signed out).
 * The web app detects "wrong account" by comparing `email` with `MeResponse.user.email` (case-insensitive).
 */
export const InvitePreview = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('VALID'),
    shopName: z.string(),
    inviterName: z.string(),
    role: Role,
    email: z.string(),
    expiresAt: IsoDateTime,
  }),
  z.object({
    state: z.literal('EXPIRED'),
    shopName: z.string(),
    inviterName: z.string(),
    role: Role,
    email: z.string(),
    expiresAt: IsoDateTime,
  }),
  z.object({ state: z.literal('REVOKED') }),
  z.object({ state: z.literal('ACCEPTED'), shopId: z.string(), shopName: z.string() }),
]);
export type InvitePreview = z.infer<typeof InvitePreview>;
export type InviteState = InvitePreview['state'];

/**
 * POST /api/invites/:token/accept · signed in, no body → 200 `AcceptInviteResponse`.
 * In one transaction: invite → ACCEPTED, ACTIVE membership with the invite's role, emailVerified = true only when
 * `linkCopiedAt` is null (D7), session's active shop = this shop, audits `invite.accepted`.
 * Already an ACTIVE member (or already accepted by me): marks/keeps ACCEPTED, switches shop, `alreadyMember: true`.
 * A DEACTIVATED membership in that shop is reactivated with the invite's role.
 * Never fails on seats. Web refetches GET /api/me afterwards.
 * Errors: 401 UNAUTHENTICATED, 403 INVITE_EMAIL_MISMATCH (invite unchanged), 404 INVITE_INVALID,
 * 410 INVITE_EXPIRED, 410 INVITE_REVOKED.
 */
export const AcceptInviteResponse = z.object({
  shopId: z.string(),
  shopName: z.string(),
  role: Role,
  alreadyMember: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponse>;
