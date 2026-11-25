/**
 * Resets the test database once per `vitest run`: drop + recreate schema `public`, apply all
 * migrations (including RLS + repairos_app grants), then set the app role password.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@repairos/db';

const dbPkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/db');

export default async function setup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL_TEST;
  const appUrl = process.env.APP_DATABASE_URL_TEST;
  if (!adminUrl || !appUrl) throw new Error('DATABASE_URL_TEST and APP_DATABASE_URL_TEST must be set (see .env.example)');
  const dbName = new URL(adminUrl).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset "${dbName}": test database name must end in _test`);

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: adminUrl, APP_DATABASE_URL: appUrl };
  const bin = resolve(dbPkg, 'node_modules/.bin');
  execFileSync(resolve(bin, 'prisma'), ['migrate', 'deploy'], { cwd: dbPkg, env, stdio: 'pipe' });
  execFileSync(resolve(bin, 'tsx'), ['scripts/sync-app-role.ts'], { cwd: dbPkg, env, stdio: 'pipe' });
}
