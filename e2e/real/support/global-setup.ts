import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readEnv(): Record<string, string> {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) throw new Error(`Real-stack suite needs ${file}`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return env;
}

/**
 * Resets the QA database to the seed: truncates every table (except Prisma's migration table, so the
 * running API keeps its connections and plans) and re-runs `pnpm db:seed`. Clears the file outbox.
 * Refuses to touch a database called plain `repairos` (the shared dev database) unless REAL_ALLOW_RESET=1.
 * REAL_SKIP_RESET=1 skips the reset entirely.
 */
export default async function globalSetup() {
  const base = process.env.REAL_BASE_URL ?? 'http://localhost:3200';
  const health = await fetch(`${base}/api/health`).catch(() => null);
  if (!health?.ok)
    throw new Error(
      `The real stack is not reachable at ${base}/api/health. Start API, worker and web first.`,
    );

  if (process.env.REAL_SKIP_RESET === '1') return;
  const env = readEnv();
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing from .env');
  const dbName = new URL(url).pathname.slice(1);
  if (dbName === 'repairos' && process.env.REAL_ALLOW_RESET !== '1') {
    throw new Error(
      'Refusing to truncate the shared "repairos" database. Point DATABASE_URL at a QA database.',
    );
  }
  const sql = `DO $$ DECLARE t text; BEGIN
    SELECT string_agg(format('%I', tablename), ', ') INTO t FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
    IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;
  END $$;`;
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'inherit' });
  execSync('pnpm db:seed', { cwd: ROOT, stdio: 'ignore' });
  const outbox = env.EMAIL_OUTBOX_DIR || join(ROOT, '.outbox');
  rmSync(outbox, { recursive: true, force: true });
}
