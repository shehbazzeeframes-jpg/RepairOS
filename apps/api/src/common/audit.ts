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
 */
export async function lockShop(tx: ScopedTx, shopId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "shops" WHERE "id" = ${shopId} FOR UPDATE`;
}

/** Prisma unique-constraint violation (P2002), e.g. the partial unique indexes. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.name === 'PrismaClientKnownRequestError' && (err as { code?: string }).code === 'P2002';
}
