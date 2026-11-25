import { z } from 'zod';
import { IsoDateTime, LocalDate, daysInRange } from './common';

/**
 * Audit log (Sprint 1 story §6). Events are written in the same transaction as the change; before/after hold
 * changed fields only and never tokens, token hashes, passwords or session ids. Read-only: no write API.
 */

/** The 22 Sprint 1 audit actions. */
export const AUDIT_ACTIONS = [
  'shop.created',
  'shop.updated',
  'shop.tax_settings_updated',
  'shop.hours_updated',
  'tax_rate.created',
  'tax_rate.updated',
  'tax_rate.archived',
  'tax_rate.restored',
  'tax_rate.default_changed',
  'invite.created',
  'invite.resent',
  'invite.revoked',
  'invite.link_copied',
  'invite.accepted',
  'member.role_changed',
  'member.deactivated',
  'member.reactivated',
  'time_entry.created',
  'time_entry.updated',
  'time_entry.deleted',
  'time_entry.auto_closed',
  'timesheet.exported',
] as const;

export const AuditAction = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntityType = z.enum(['Shop', 'TaxRate', 'Invitation', 'Membership', 'TimeEntry']);
export type AuditEntityType = z.infer<typeof AuditEntityType>;

export const AuditActionGroup = z.enum(['shop_settings', 'tax', 'business_hours', 'staff', 'timesheets']);
export type AuditActionGroup = z.infer<typeof AuditActionGroup>;

export const AUDIT_ACTION_GROUP_LABELS: Record<AuditActionGroup, string> = {
  shop_settings: 'Shop settings',
  tax: 'Tax',
  business_hours: 'Business hours',
  staff: 'Staff & invites',
  timesheets: 'Timesheets',
};

export const AUDIT_ACTION_META: Record<AuditAction, { label: string; group: AuditActionGroup; entityType: AuditEntityType }> = {
  'shop.created': { label: 'Created shop', group: 'shop_settings', entityType: 'Shop' },
  'shop.updated': { label: 'Updated shop details', group: 'shop_settings', entityType: 'Shop' },
  'shop.tax_settings_updated': { label: 'Changed tax settings', group: 'tax', entityType: 'Shop' },
  'shop.hours_updated': { label: 'Changed business hours', group: 'business_hours', entityType: 'Shop' },
  'tax_rate.created': { label: 'Added tax rate', group: 'tax', entityType: 'TaxRate' },
  'tax_rate.updated': { label: 'Edited tax rate', group: 'tax', entityType: 'TaxRate' },
  'tax_rate.archived': { label: 'Archived tax rate', group: 'tax', entityType: 'TaxRate' },
  'tax_rate.restored': { label: 'Restored tax rate', group: 'tax', entityType: 'TaxRate' },
  'tax_rate.default_changed': { label: 'Changed default tax rate', group: 'tax', entityType: 'TaxRate' },
  'invite.created': { label: 'Invited', group: 'staff', entityType: 'Invitation' },
  'invite.resent': { label: 'Resent invite', group: 'staff', entityType: 'Invitation' },
  'invite.revoked': { label: 'Revoked invite', group: 'staff', entityType: 'Invitation' },
  'invite.link_copied': { label: 'Copied invite link', group: 'staff', entityType: 'Invitation' },
  'invite.accepted': { label: 'Accepted invite', group: 'staff', entityType: 'Invitation' },
  'member.role_changed': { label: 'Changed role', group: 'staff', entityType: 'Membership' },
  'member.deactivated': { label: 'Deactivated', group: 'staff', entityType: 'Membership' },
  'member.reactivated': { label: 'Reactivated', group: 'staff', entityType: 'Membership' },
  'time_entry.created': { label: 'Added time entry', group: 'timesheets', entityType: 'TimeEntry' },
  'time_entry.updated': { label: 'Fixed time entry', group: 'timesheets', entityType: 'TimeEntry' },
  'time_entry.deleted': { label: 'Deleted time entry', group: 'timesheets', entityType: 'TimeEntry' },
  'time_entry.auto_closed': { label: 'Closed time entry on deactivation', group: 'timesheets', entityType: 'TimeEntry' },
  'timesheet.exported': { label: 'Exported timesheet', group: 'timesheets', entityType: 'Shop' },
};

export function auditActionsInGroup(group: AuditActionGroup): AuditAction[] {
  return AUDIT_ACTIONS.filter((a) => AUDIT_ACTION_META[a].group === group);
}

export const AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_RANGE_DAYS = 366;

/**
 * GET /api/audit-events?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&action=&actionGroup=&cursor=&limit=
 * · permission `audit.view` → 200 `AuditEventListResponse`, newest first.
 * `from`/`to`: inclusive shop-local dates, max 1 year (366 days); web default = last 7 days.
 * `userId` filters by actor; `action` and `actionGroup` may be combined (AND).
 * `cursor`: opaque, from the previous page's `nextCursor`. `limit` default 50, max 100.
 * Errors: 400 VALIDATION_FAILED (bad range or cursor).
 */
export const AuditEventListQuery = z
  .object({
    from: LocalDate,
    to: LocalDate,
    userId: z.string().min(1).optional(),
    action: AuditAction.optional(),
    actionGroup: AuditActionGroup.optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(AUDIT_PAGE_SIZE),
  })
  .superRefine((v, ctx) => {
    if (v.to < v.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'End date must be on or after start date' });
    } else if (daysInRange(v.from, v.to) > MAX_AUDIT_RANGE_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Choose a range of one year or less' });
    }
  });
export type AuditEventListQuery = z.infer<typeof AuditEventListQuery>;

const AuditActor = z.object({
  userId: z.string(),
  /** Deactivated people are still named. */
  name: z.string(),
});

export const AuditEventSummary = z.object({
  id: z.string(),
  createdAt: IsoDateTime,
  action: AuditAction,
  /** null = "System" */
  actor: AuditActor.nullable(),
  entityType: AuditEntityType,
  entityId: z.string(),
  /** e.g. "Sam Lee" (Membership), "VAT" (TaxRate), "sam@x.com" (Invitation); null when not resolvable. */
  entityLabel: z.string().nullable(),
});
export type AuditEventSummary = z.infer<typeof AuditEventSummary>;

export const AuditEventListResponse = z.object({
  items: z.array(AuditEventSummary),
  /** null = end of list */
  nextCursor: z.string().nullable(),
});
export type AuditEventListResponse = z.infer<typeof AuditEventListResponse>;

/**
 * GET /api/audit-events/:id · permission `audit.view` → 200 `AuditEventDetail`. 404 NOT_FOUND.
 * `before`/`after` are changed fields only (created = only after, deleted = only before), raw stored values
 * (instants as ISO UTC, rates as rateMilliPct, roles as enum); the web formats them.
 */
export const AuditEventDetail = AuditEventSummary.extend({
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
});
export type AuditEventDetail = z.infer<typeof AuditEventDetail>;
