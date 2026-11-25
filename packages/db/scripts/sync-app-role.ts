/**
 * Sets the login password of the `repairos_app` role (created without one by the
 * `rls_app_role` migration) from APP_DATABASE_URL, so the password lives only in .env.
 * Runs with DATABASE_URL (needs a superuser or CREATEROLE). Skips when APP_DATABASE_URL is unset.
 */
import { PrismaClient } from '@prisma/client';

export const APP_ROLE = 'repairos_app';

export async function syncAppRole(adminUrl: string, appUrl: string | undefined): Promise<void> {
  if (!appUrl) {
    console.warn('[sync-app-role] APP_DATABASE_URL is not set; skipping (the app role keeps its current password).');
    return;
  }
  const url = new URL(appUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user !== APP_ROLE) {
    throw new Error(`[sync-app-role] APP_DATABASE_URL must connect as "${APP_ROLE}" (got "${user}")`);
  }
  if (!password) throw new Error('[sync-app-role] APP_DATABASE_URL has no password');

  const prisma = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const literal = `'${password.replace(/'/g, "''")}'`;
    await prisma.$executeRawUnsafe(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${literal}`);
    console.log(`[sync-app-role] ${APP_ROLE} password set from APP_DATABASE_URL`);
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const admin = process.env.DATABASE_URL;
  if (!admin) throw new Error('DATABASE_URL is required');
  syncAppRole(admin, process.env.APP_DATABASE_URL).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
