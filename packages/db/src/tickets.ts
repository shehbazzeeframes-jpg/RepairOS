import { Prisma } from '@prisma/client';

/**
 * The raw-SQL part of a transaction client: `tenantDb(...).tx(fn)`'s `tx`, or a base `Prisma.TransactionClient`
 * (seed, scripts). Helpers below take this so they always run inside the caller's transaction.
 */
export type RawSqlTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** tickets."statusCategory" / ticket_statuses.category (text + CHECK, see schema.prisma). Same as contracts STATUS_CATEGORIES. */
export const TICKET_STATUS_CATEGORIES = ['OPEN', 'WAITING', 'READY', 'CLOSED'] as const;
export type TicketStatusCategory = (typeof TICKET_STATUS_CATEGORIES)[number];

export class TicketSettingsMissingError extends Error {
  override name = 'TicketSettingsMissingError';
}

/**
 * Gapless ticket numbers (A4, TK4). Takes the shop's next number and increments the counter with a single
 * `UPDATE ... RETURNING` on shop_ticket_settings. Call it INSIDE the transaction that creates the ticket:
 *  - the row lock serialises concurrent check-ins for the shop until their transactions end (short: one insert);
 *  - if the transaction rolls back (validation, FK, anything), the increment rolls back too, so there are no gaps;
 *  - unique (shopId, number) on tickets is the backstop against duplicates (e.g. a settings edit racing).
 *
 *   await db.tx(async (tx) => {
 *     const number = await nextTicketNumber(tx, shopId);
 *     await tx.ticket.create({ data: { shopId, number, ... } });
 *   });
 */
export async function nextTicketNumber(tx: RawSqlTx, shopId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ number: number }[]>`
    UPDATE "shop_ticket_settings"
       SET "nextNumber" = "nextNumber" + 1, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "shopId" = ${shopId}
    RETURNING "nextNumber" - 1 AS "number"`;
  const n = rows[0]?.number;
  if (n === undefined) throw new TicketSettingsMissingError(`No ticket settings for shop ${shopId} (run ensureTicketDefaults)`);
  return Number(n);
}

/**
 * Seeds the default ticket statuses (contracts DEFAULT_TICKET_STATUSES, mirrored in SQL by
 * app_ensure_ticket_defaults) and the ShopTicketSettings row for a shop, if missing. Idempotent.
 * Call it in the shop-creation transaction (RLS: the transaction's shop must be `shopId`).
 */
export async function ensureTicketDefaults(tx: RawSqlTx, shopId: string): Promise<void> {
  // $executeRaw: the function returns void, which $queryRaw cannot deserialise.
  await tx.$executeRaw`SELECT app_ensure_ticket_defaults(${shopId})`;
}

/**
 * What TicketEvent.data stores per type. Ids only, resolved at read time into the contract's
 * `TicketTimelineItem` (StatusRef, UserRef, TicketLink, ...) so renames show everywhere and erased customers show as
 * "Erased customer". Never store customer names/phones/emails, IMEI/serial or a passcode here: the timeline is
 * append-only and is kept on erasure.
 */
export interface TicketEventDataByType {
  created: { statusId: string; warrantyOfTicketId: string | null };
  /** `TicketEvent.noteId` holds the note when one was required/added with the change. */
  status_changed: { fromStatusId: string; toStatusId: string; notifyPending: boolean };
  assigned: { fromUserId: string | null; toUserId: string | null };
  /** field ∈ contracts TICKET_EDITABLE_FIELDS; checklist changes are listed per item ("checklist.SCREEN"). */
  fields_changed: { changes: { field: string; before: unknown; after: unknown }[] };
  /** Device label ("Apple iPhone 13") is snapshotted: brand/model survive erasure. */
  device_changed: { from: { deviceId: string; label: string }; to: { deviceId: string; label: string } };
  /** Customer names are resolved at read time (never snapshotted). */
  customer_changed: { fromCustomerId: string; toCustomerId: string };
  /** `TicketEvent.noteId` = the note. */
  note_added: Record<string, never>;
  note_edited: Record<string, never>;
  cancelled: { statusId: string; reason: string; note: string | null; returnedConfirmed: boolean };
  reopened: { fromStatusId: string; toStatusId: string; reason: string; passcodeWasDeleted: boolean };
  warranty_linked: { ticketId: string; role: 'warranty' | 'original' };
  passcode_deleted: { reason: 'closed' };
  /** Reserved (Sprint 3 photos). */
  attachment_added: { attachmentId: string; kind: 'photo'; fileName: string | null };
  message_sent: Record<string, unknown>;
  approval_requested: Record<string, unknown>;
  approval_decided: Record<string, unknown>;
  item_added: Record<string, unknown>;
  item_removed: Record<string, unknown>;
  payment_recorded: Record<string, unknown>;
}
export type TicketEventKind = keyof TicketEventDataByType;
