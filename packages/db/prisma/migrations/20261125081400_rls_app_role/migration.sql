-- Runtime role + Row-Level Security for tenant tables. See packages/db/README.md.
--
-- The API connects as `repairos_app` (non-superuser, no BYPASSRLS, not the table owner), so the
-- policies below apply to it. Migrations and seed run as the table owner, which RLS skips.
-- The role is created WITHOUT a password; `pnpm db:migrate` sets it from APP_DATABASE_URL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repairos_app') THEN
    CREATE ROLE repairos_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO repairos_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO repairos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO repairos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO repairos_app;
-- Tables created by later migrations (run by the same owner role) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO repairos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO repairos_app;
-- Conditional: `prisma migrate dev` replays migrations in a shadow database that has no _prisma_migrations.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM repairos_app;
  END IF;
END
$$;

-- Audit log is append-only for the app.
REVOKE UPDATE, DELETE ON "audit_logs" FROM repairos_app;

-- Request context, set per transaction by the scoped Prisma client with set_config(..., true) (= SET LOCAL).
-- NULLIF: an unset or reset custom setting reads as '' and must match nothing.
CREATE OR REPLACE FUNCTION app_current_shop_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.shop_id', true), '') $$;
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- ---------- shops (tenant root, keyed by id) ----------
ALTER TABLE "shops" ENABLE ROW LEVEL SECURITY;
CREATE POLICY shops_tenant ON "shops"
  USING ("id" = app_current_shop_id())
  WITH CHECK ("id" = app_current_shop_id());
-- A user may read the shops they are a member of (for /me and the shop switcher).
CREATE POLICY shops_member_read ON "shops" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "memberships" m
    WHERE m."shopId" = "shops"."id" AND m."userId" = app_current_user_id()
  ));

-- ---------- memberships ----------
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON "memberships"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());
CREATE POLICY memberships_self_read ON "memberships" FOR SELECT
  USING ("userId" = app_current_user_id());

-- ---------- plain tenant tables ----------
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY locations_tenant ON "locations"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_rates_tenant ON "tax_rates"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant ON "audit_logs"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());
