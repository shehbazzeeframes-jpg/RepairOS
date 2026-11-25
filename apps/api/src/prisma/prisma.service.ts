import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  assertAppRole,
  createPrismaClient,
  tenantDb,
  userTx,
  type MembershipStatus,
  type Prisma,
  type PrismaClient,
  type Role,
  type TenantContext,
  type TenantDb,
  type TxRetryInfo,
} from '@repairos/db';
import { CONFIG, type AppConfig } from '../config';

export interface MembershipRef {
  shopId: string;
  role: Role;
  status: MembershipStatus;
  createdAt: Date;
  deactivatedAt: Date | null;
}

/**
 * Owns the Prisma connection (as repairos_app) and hands out scoped access.
 * Tenant data must be read/written through `forShop()`; `base` is only for auth tables
 * (users/sessions/...) and health checks.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base: PrismaClient;
  private readonly logger = new Logger('Transactions');

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.base = createPrismaClient(config.databaseUrl);
  }

  /** Fails startup if the connection would bypass RLS (superuser, BYPASSRLS or table owner). */
  async onModuleInit(): Promise<void> {
    await assertAppRole(this.base);
  }

  /**
   * Scoped access for one shop. Its `tx()` is retried (at most twice, with jitter) when Postgres aborts it with a
   * deadlock (40P01) or serialization failure (40001): every attempt is a fresh transaction, so the Idempotency-Key
   * row, ticket number and audit rows of a failed attempt roll back with it. Side effects outside the database go
   * after `tx()` returns or in `afterCommit` (@repairos/db), never inside `fn`.
   */
  forShop(ctx: TenantContext): TenantDb {
    return tenantDb(this.base, ctx, { retry: { onRetry: (info) => this.logTxRetry(ctx, info) } });
  }

  private logTxRetry(ctx: TenantContext, info: TxRetryInfo): void {
    const what = info.sqlState === '40P01' ? 'deadlock' : info.sqlState === '40001' ? 'serialization failure' : 'rows changed before they were locked';
    this.logger.warn(
      `Transaction retry ${info.attempt}/${info.maxRetries} after ${what} (${info.sqlState}) shop=${ctx.shopId} user=${ctx.userId ?? '-'} in ${info.delayMs}ms`,
    );
  }

  forUser<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return userTx(this.base, userId, fn);
  }

  /** All of a user's memberships (any status), oldest first. Callers decide what DEACTIVATED means. */
  async membershipsOf(userId: string): Promise<MembershipRef[]> {
    return this.forUser(userId, (tx) =>
      tx.membership.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { shopId: true, role: true, status: true, createdAt: true, deactivatedAt: true },
      }),
    );
  }

  /** The user's ACTIVE membership in a shop, or null (deactivated memberships never count: Risk #1). */
  async findActiveMembership(userId: string, shopId: string): Promise<{ shopId: string; role: Role } | null> {
    return this.forUser(userId, (tx) =>
      tx.membership.findFirst({
        where: { userId, shopId, status: 'ACTIVE' },
        select: { shopId: true, role: true },
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
