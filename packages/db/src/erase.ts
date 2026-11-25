import type { RawSqlTx } from './tickets';

/** Display name stored on an erased customer (same as contracts ERASED_CUSTOMER_NAME). */
export const ERASED_CUSTOMER_DISPLAY_NAME = 'Erased customer';

export type EraseCustomerErrorCode = 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_ERASED' | 'CUSTOMER_HAS_OPEN_TICKETS';

export class EraseCustomerError extends Error {
  override name = 'EraseCustomerError';
  constructor(
    readonly code: EraseCustomerErrorCode,
    /** Tickets in open/waiting/ready (CUSTOMER_HAS_OPEN_TICKETS only). */
    readonly openTickets?: number,
  ) {
    super(code);
  }
}

/** Counts for the `customer.erased` audit event (no personal data). */
export interface EraseCustomerCounts {
  phones: number;
  consentEvents: number;
  devices: number;
  tickets: number;
  auditRowsRedacted: number;
}

const CODES: readonly EraseCustomerErrorCode[] = ['CUSTOMER_HAS_OPEN_TICKETS', 'CUSTOMER_ERASED', 'CUSTOMER_NOT_FOUND'];

/**
 * Erases (anonymises) a customer of the transaction's shop (CU9, A11 + tech lead clarification) by calling the
 * database function app_erase_customer. See its comment in the Sprint 2 migration for exactly what is cleared,
 * deleted and kept (tickets, ticket notes and the timeline are kept; audit payloads holding the customer's
 * personal values are redacted).
 *
 * Run it inside `tenantDb(...).tx(...)`, together with the `customer.erased` audit event (counts only):
 *
 *   await db.tx(async (tx) => {
 *     const counts = await eraseCustomer(tx, customerId);
 *     await writeAudit(tx, { ..., action: 'customer.erased', after: counts });
 *   });
 *
 * Throws EraseCustomerError. After a database error the transaction is aborted: let it roll back.
 */
export async function eraseCustomer(tx: RawSqlTx, customerId: string): Promise<EraseCustomerCounts> {
  // Friendly pre-check for the count in the 409 message; the function re-checks under the customer row lock.
  const [open] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "tickets"
    WHERE "customerId" = ${customerId} AND "statusCategory" <> 'CLOSED' AND "shopId" = app_current_shop_id()`;
  if ((open?.n ?? 0) > 0) throw new EraseCustomerError('CUSTOMER_HAS_OPEN_TICKETS', open!.n);
  try {
    const [row] = await tx.$queryRaw<{ counts: EraseCustomerCounts }[]>`SELECT app_erase_customer(${customerId}) AS counts`;
    return row!.counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = CODES.find((c) => message.includes(c));
    if (code) throw new EraseCustomerError(code);
    throw err;
  }
}
