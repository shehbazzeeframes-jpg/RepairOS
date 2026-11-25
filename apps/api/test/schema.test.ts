/**
 * Guards the database schema itself (runs against the migrated test database):
 * every tenant table must have RLS enabled and at least one policy.
 */
import { PrismaClient, TENANT_MODELS } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../src/common/api-error.filter';

let admin: PrismaClient;
beforeAll(() => {
  admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});
afterAll(async () => {
  await admin?.$disconnect();
});

interface TableRow {
  table: string;
  rls: boolean;
  policies: number;
}

describe('schema: row-level security', () => {
  it('every public table with a shopId / shop_id column (and shops) has RLS and a policy', async () => {
    const rows = await admin.$queryRaw<TableRow[]>`
      SELECT c.relname AS "table", c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
        AND (c.relname = 'shops' OR EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname IN ('shopId', 'shop_id') AND NOT a.attisdropped))
      ORDER BY 1`;
    const missing = rows.filter((r) => !r.rls || r.policies === 0).map((r) => r.table);
    expect(missing).toEqual([]);
    // Sanity: one table per tenant model, plus shops.
    expect(rows.length).toBe(TENANT_MODELS.length + 1);
  });

  it('the app role is not privileged and cannot delete shops', async () => {
    const [role] = await admin.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; can_delete: boolean }[]>`
      SELECT rolsuper, rolbypassrls, has_table_privilege('repairos_app', 'public.shops', 'DELETE') AS can_delete
      FROM pg_roles WHERE rolname = 'repairos_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, can_delete: false });
  });
});

describe('error mapping', () => {
  it('maps a Postgres 42501 (RLS / privilege) error to 404 NOT_FOUND', () => {
    const modelErr = Object.assign(
      new Error('ConnectorError { kind: QueryError(PostgresError { code: "42501", message: "new row violates row-level security policy" }) }'),
      { name: 'PrismaClientUnknownRequestError' },
    );
    const rawErr = Object.assign(new Error('Raw query failed. Code: `42501`.'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { code: '42501' },
    });
    for (const e of [modelErr, rawErr]) {
      expect(toApiError(e)).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Not found' });
    }
  });
});
