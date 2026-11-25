import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  assertAppRole,
  createPrismaClient,
  tenantDb,
  userTx,
  type Prisma,
  type PrismaClient,
  type Role,
  type TenantContext,
  type TenantDb,
} from '@repairos/db';
import { CONFIG, type AppConfig } from '../config';

/**
 * Owns the Prisma connection (as repairos_app) and hands out scoped access.
 * Tenant data must be read/written through `forShop()`; `base` is only for auth tables
 * (users/sessions/...) and health checks.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly base: PrismaClient;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.base = createPrismaClient(config.databaseUrl);
  }

  /** Fails startup if the connection would bypass RLS (superuser, BYPASSRLS or table owner). */
  async onModuleInit(): Promise<void> {
    await assertAppRole(this.base);
  }

  forShop(ctx: TenantContext): TenantDb {
    return tenantDb(this.base, ctx);
  }

  forUser<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return userTx(this.base, userId, fn);
  }

  async findMembership(userId: string, shopId: string): Promise<{ shopId: string; role: Role } | null> {
    return this.forUser(userId, (tx) =>
      tx.membership.findUnique({
        where: { userId_shopId: { userId, shopId } },
        select: { shopId: true, role: true },
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }
}
