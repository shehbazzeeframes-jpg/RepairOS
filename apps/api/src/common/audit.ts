import { AUDIT_ACTION_META, type AuditAction } from '@repairos/contracts';
import { Prisma, type ScopedTx } from '@repairos/db';

export type AuditValues = Record<string, unknown>;

export interface AuditEvent {
  shopId: string;
  /** null = "System" */
  actorUserId: string | null;
  action: AuditAction;
  entityId: string;
  before?: AuditValues | null;
  after?: AuditValues | null;
}

/** JSON-safe copy: Dates become ISO strings, undefined keys are dropped. */
function toJson(values: AuditValues | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!values) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(values)) as Prisma.InputJsonValue;
}

/**
 * Writes one audit event. Always call it with the transaction client of the change it records, so the event
 * commits or rolls back with it. Never pass tokens, token hashes, passwords or session ids.
 */
export async function writeAudit(tx: ScopedTx, e: AuditEvent): Promise<void> {
  await tx.auditLog.create({
    data: {
      shopId: e.shopId,
      actorUserId: e.actorUserId,
      action: e.action,
      entityType: AUDIT_ACTION_META[e.action].entityType,
      entityId: e.entityId,
      before: toJson(e.before),
      after: toJson(e.after),
    },
  });
}

/** Fields of `after` whose value differs from `before`, as { before, after } holding only those fields. */
export function changedFields<T extends AuditValues>(before: T, after: Partial<T>): { before: AuditValues; after: AuditValues } | null {
  const b: AuditValues = {};
  const a: AuditValues = {};
  for (const key of Object.keys(after)) {
    const next = after[key];
    if (next === undefined) continue;
    const prev = before[key];
    if (JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null)) {
      b[key] = prev ?? null;
      a[key] = next ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

/**
 * Row lock on the shop (SELECT … FOR UPDATE) for the rest of the transaction. Every staff/seat/owner invariant
 * (seat limit, last active owner, duplicate invites, overlapping manual time entries) is checked under it, so
 * concurrent requests for the same shop serialise.
 *
 * `noKeyUpdate` (ticket status configuration): FOR NO KEY UPDATE still serialises with every other lockShop, but not
 * with the KEY SHARE lock that every insert of a tenant row takes on its shop through the foreign key. A status
 * change waits for tickets (its cascade), so it must not also block ticket writes at the shop row (lock order,
 * packages/db/README.md).
 */
export async function lockShop(tx: ScopedTx, shopId: string, opts: { noKeyUpdate?: boolean } = {}): Promise<void> {
  if (opts.noKeyUpdate) await tx.$queryRaw`SELECT "id" FROM "shops" WHERE "id" = ${shopId} FOR NO KEY UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "shops" WHERE "id" = ${shopId} FOR UPDATE`;
}

/**
 * Postgres CHECK violation (SQLSTATE 23514) of one of `constraints`. Prisma reports it as a known or (from a cascaded
 * update) unknown request error; both carry the constraint name in the message.
 */
export function isCheckViolation(err: unknown, constraints: readonly string[]): boolean {
  if (!(err instanceof Error)) return false;
  const name = /violates check constraint \\?"([A-Za-z0-9_]+)\\?"/.exec(err.message)?.[1];
  return name !== undefined && constraints.includes(name);
}

/**
 * Postgres foreign-key violation (SQLSTATE 23503) of one of `constraints`: Prisma P2003 (constraint in the message or
 * `meta.field_name`) or, from raw SQL / cascades, an error whose message holds the Postgres text.
 */
export function isForeignKeyViolation(err: unknown, constraints: readonly string[]): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: unknown; meta?: Record<string, unknown> };
  const text = `${e.message} ${JSON.stringify(e.meta ?? {})}`;
  const isFk = e.code === 'P2003' || (e.meta?.code as unknown) === '23503' || /foreign key constraint/i.test(e.message);
  return isFk && constraints.some((c) => text.includes(c));
}

/** Prisma unique-constraint violation (P2002), e.g. the partial unique indexes. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.name === 'PrismaClientKnownRequestError' && (err as { code?: string }).code === 'P2002';
}
