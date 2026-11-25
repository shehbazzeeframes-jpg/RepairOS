-- Sprint 1: shop & people. Membership status, invitations, business hours, time entries, tax defaults/archive.
-- Generated DDL first, then hand-written partial indexes, backfills, RLS and the invite token lookup function.

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "InviteEmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "TimeEntrySource" AS ENUM ('SELF', 'MANUAL');

-- CreateEnum
CREATE TYPE "TimeEntryClosedReason" AS ENUM ('DEACTIVATED');

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedByUserId" TEXT,
ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isDefaultGoods" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDefaultServices" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByUserId" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "emailStatus" "InviteEmailStatus" NOT NULL DEFAULT 'QUEUED',
    "linkCopiedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_hours" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "isOpen" BOOLEAN NOT NULL,
    "opensAt" TEXT,
    "closesAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "closedReason" "TimeEntryClosedReason",
    "source" "TimeEntrySource" NOT NULL,
    "createdByUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedByUserId" TEXT,
    "editReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_shopId_status_idx" ON "invitations"("shopId", "status");

-- CreateIndex
CREATE INDEX "invitations_shopId_createdAt_idx" ON "invitations"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "business_hours_shopId_weekday_key" ON "business_hours"("shopId", "weekday");

-- CreateIndex
CREATE INDEX "time_entries_shopId_clockInAt_idx" ON "time_entries"("shopId", "clockInAt");

-- CreateIndex
CREATE INDEX "time_entries_shopId_userId_clockInAt_idx" ON "time_entries"("shopId", "userId", "clockInAt");

-- CreateIndex
CREATE INDEX "audit_logs_shopId_actorUserId_createdAt_idx" ON "audit_logs"("shopId", "actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_shopId_action_createdAt_idx" ON "audit_logs"("shopId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "memberships_shopId_status_role_idx" ON "memberships"("shopId", "status", "role");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- Partial unique indexes (not expressible in the Prisma schema; keep them when editing migrations) ----------
-- One PENDING invite per (shop, email). Emails are stored lower-cased; lower() makes it robust anyway.
CREATE UNIQUE INDEX "invitations_pending_email_key" ON "invitations" ("shopId", lower("email")) WHERE "status" = 'PENDING';
-- At most one open time entry per person per shop.
CREATE UNIQUE INDEX "time_entries_one_open_key" ON "time_entries" ("shopId", "userId") WHERE "clockOutAt" IS NULL;
-- At most one default goods rate and one default services rate per shop (D1).
CREATE UNIQUE INDEX "tax_rates_default_goods_key" ON "tax_rates" ("shopId") WHERE "isDefaultGoods";
CREATE UNIQUE INDEX "tax_rates_default_services_key" ON "tax_rates" ("shopId") WHERE "isDefaultServices";

-- ---------- Backfills ----------
-- Tax defaults (D1): the oldest rate that can serve each kind becomes its default
-- (US/GB: the single "all" rate is both; PK: GST for goods, the services rate for services).
UPDATE "tax_rates" SET "isDefaultGoods" = true
WHERE "id" IN (
  SELECT DISTINCT ON ("shopId") "id" FROM "tax_rates"
  WHERE "appliesTo" IN ('all', 'goods') AND "archivedAt" IS NULL
  ORDER BY "shopId", "createdAt", "id"
);
UPDATE "tax_rates" SET "isDefaultServices" = true
WHERE "id" IN (
  SELECT DISTINCT ON ("shopId") "id" FROM "tax_rates"
  WHERE "appliesTo" IN ('all', 'services') AND "archivedAt" IS NULL
  ORDER BY "shopId", "createdAt", "id"
);

-- Business hours (D9): Mon–Sat 10:00–19:00, Sunday closed, for every existing shop.
INSERT INTO "business_hours" ("id", "shopId", "weekday", "isOpen", "opensAt", "closesAt", "updatedAt")
SELECT gen_random_uuid()::text, s."id", d.wd, d.wd <> 0,
       CASE WHEN d.wd = 0 THEN NULL ELSE '10:00' END,
       CASE WHEN d.wd = 0 THEN NULL ELSE '19:00' END,
       CURRENT_TIMESTAMP
FROM "shops" s CROSS JOIN generate_series(0, 6) AS d(wd)
ON CONFLICT ("shopId", "weekday") DO NOTHING;

-- ---------- Row-Level Security for the new tenant tables ----------
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON "invitations"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "business_hours" ENABLE ROW LEVEL SECURITY;
CREATE POLICY business_hours_tenant ON "business_hours"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY time_entries_tenant ON "time_entries"
  USING ("shopId" = app_current_shop_id())
  WITH CHECK ("shopId" = app_current_shop_id());

-- Risk #1: a user may read a shop's row through a membership only while that membership is ACTIVE.
-- memberships_self_read stays: a user still sees their own DEACTIVATED membership rows (GET /api/me needs
-- them for `accessRemoved`), but no longer that shop's details.
DROP POLICY shops_member_read ON "shops";
CREATE POLICY shops_member_read ON "shops" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "memberships" m
    WHERE m."shopId" = "shops"."id" AND m."userId" = app_current_user_id() AND m."status" = 'ACTIVE'
  ));

-- ---------- Invite token lookup ----------
-- The public invite page has no shop context, so RLS hides every invitation. This SECURITY DEFINER function
-- (owned by the migration role, which bypasses RLS as table owner) maps a token hash to (id, shopId) and
-- nothing else; the API then reads the invite through the scoped client for that shop.
CREATE OR REPLACE FUNCTION app_invitation_by_token_hash(p_token_hash text)
  RETURNS TABLE ("id" text, "shopId" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT i."id", i."shopId" FROM "invitations" i WHERE i."tokenHash" = p_token_hash $$;
REVOKE ALL ON FUNCTION app_invitation_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_invitation_by_token_hash(text) TO repairos_app;
