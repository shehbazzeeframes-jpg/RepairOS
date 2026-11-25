import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export * from './erase';
export * from './maintenance';
export * from './field-crypto';
export * from './models';
export * from './scope-args';
export * from './search';
export * from './tenant';
export * from './tickets';

/**
 * Creates a Prisma client. Pass the app-role URL (APP_DATABASE_URL) in the API so RLS applies;
 * migrations and seed use DATABASE_URL (table owner).
 */
export function createPrismaClient(url?: string, options: { log?: ('query' | 'info' | 'warn' | 'error')[] } = {}) {
  return new PrismaClient({ datasourceUrl: url, log: options.log ?? ['warn', 'error'] });
}
