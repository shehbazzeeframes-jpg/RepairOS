-- Sprint 2: customers, devices, ticket statuses and settings, tickets (+ issues, checklist, accessories, notes,
-- timeline). See docs/stories/sprint2-customers-and-tickets.md, packages/db/README.md and packages/db/PERF.md.
--
-- Order: extensions + f_unaccent, generated DDL (enums, tables, Prisma indexes, FKs), then hand-written SQL:
-- generated search column, CHECK constraints, partial/expression/trigram indexes (each with the query it serves),
-- RLS, grants, functions (ticket defaults, search, erase) and the backfill of default statuses and settings.
--
-- Under RLS the planner only uses a WHERE condition as an index condition if its operator is LEAKPROOF.
-- texteq/int/timestamp comparisons are; enum `=`, LIKE/ILIKE and array operators are not. Hence:
--  * the filtered category columns (ticket_statuses.category, tickets."statusCategory") are text + CHECK;
--  * fuzzy search (trigram LIKE '%x%') runs in SECURITY DEFINER functions that filter by app_current_shop_id()
--    themselves (app_search_customers, app_search_devices).

-- ---------- Extensions (A14) ----------
-- Both are "trusted" extensions (PG13+): the database owner can install them without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- unaccent() is STABLE (it depends on the dictionary search path), so it cannot be used in an index or a generated
-- column. This wrapper pins the dictionary by schema-qualified name and is declared IMMUTABLE.
CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- CreateEnum
CREATE TYPE "CustomerKind" AS ENUM ('PERSON', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL', 'CALL');

-- CreateEnum
CREATE TYPE "PhoneLabel" AS ENUM ('MOBILE', 'LANDLINE', 'WORK', 'OTHER');

-- CreateEnum
CREATE TYPE "ConsentChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('MARKETING');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('IN_STORE_VERBAL', 'IN_STORE_SIGNED', 'ONLINE_FORM', 'IMPORT', 'CUSTOMER_REQUEST');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('PHONE', 'TABLET', 'LAPTOP', 'DESKTOP', 'CONSOLE', 'WATCH', 'OTHER');

-- CreateEnum
CREATE TYPE "LockType" AS ENUM ('NONE', 'PIN', 'PASSWORD', 'PATTERN', 'NOT_SHARED');

-- CreateEnum
CREATE TYPE "TicketStatusRole" AS ENUM ('INITIAL', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('CUSTOMER_DECLINED', 'CUSTOMER_TOOK_BACK', 'CREATED_BY_MISTAKE', 'DUPLICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChecklistResult" AS ENUM ('PASS', 'FAIL', 'UNTESTED');

-- CreateEnum
CREATE TYPE "NoteVisibility" AS ENUM ('INTERNAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "TicketEventType" AS ENUM ('created', 'status_changed', 'assigned', 'fields_changed', 'device_changed', 'customer_changed', 'note_added', 'note_edited', 'cancelled', 'reopened', 'warranty_linked', 'passcode_deleted', 'attachment_added', 'message_sent', 'approval_requested', 'approval_decided', 'item_added', 'item_removed', 'payment_recorded');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "CustomerKind" NOT NULL DEFAULT 'PERSON',
    "firstName" TEXT,
    "lastName" TEXT,
    "businessName" TEXT,
    "businessContactName" TEXT,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postcode" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredChannel" "ContactChannel",
    "serviceOptOutSms" BOOLEAN NOT NULL DEFAULT false,
    "serviceOptOutEmail" BOOLEAN NOT NULL DEFAULT false,
    "serviceOptOutWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "marketingSmsAt" TIMESTAMP(3),
    "marketingEmailAt" TIMESTAMP(3),
    "marketingWhatsappAt" TIMESTAMP(3),
    "lastVisitAt" TIMESTAMP(3),
    "openTicketCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "erasedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_phones" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "digits" TEXT NOT NULL,
    "label" "PhoneLabel" NOT NULL DEFAULT 'MOBILE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isWhatsapp" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_consent_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "ConsentChannel" NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL DEFAULT 'MARKETING',
    "state" "ConsentState" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "note" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "colour" TEXT,
    "imei" TEXT,
    "serial" TEXT,
    "lockType" "LockType" NOT NULL DEFAULT 'NONE',
    "passcodeCiphertext" BYTEA,
    "passcodeIv" BYTEA,
    "passcodeTag" BYTEA,
    "passcodeKeyVersion" INTEGER,
    "passcodeSetAt" TIMESTAMP(3),
    "passcodeViewCount" INTEGER NOT NULL DEFAULT 0,
    "passcodeLastViewedAt" TIMESTAMP(3),
    "passcodeLastViewedByUserId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_statuses" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "systemRole" "TicketStatusRole",
    "colour" TEXT NOT NULL DEFAULT 'neutral',
    "position" INTEGER NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT false,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_ticket_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1001,
    "numberPrefix" TEXT NOT NULL DEFAULT 'T-',
    "defaultTurnaroundDays" INTEGER NOT NULL DEFAULT 2,
    "deletePasscodeOnClose" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_ticket_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "statusId" TEXT NOT NULL,
    "statusCategory" TEXT NOT NULL,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusIdBeforeClose" TEXT,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "customerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "assigneeUserId" TEXT,
    "description" TEXT,
    "conditionNotes" TEXT,
    "accessoriesOther" TEXT,
    "estimateMinor" INTEGER,
    "currency" "CurrencyCode" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "dueHasTime" BOOLEAN NOT NULL DEFAULT false,
    "warrantyOfTicketId" TEXT,
    "cancelReason" "CancelReason",
    "cancelNote" TEXT,
    "returnedConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_issues" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_checklist_items" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "result" "ChecklistResult" NOT NULL DEFAULT 'UNTESTED',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_accessories" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_accessories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_notes" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'INTERNAL',
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "TicketEventType" NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "noteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_shopId_email_idx" ON "customers"("shopId", "email");

-- CreateIndex
CREATE INDEX "customers_shopId_createdAt_id_idx" ON "customers"("shopId", "createdAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_shopId_id_key" ON "customers"("shopId", "id");

-- CreateIndex
CREATE INDEX "customer_phones_shopId_e164_idx" ON "customer_phones"("shopId", "e164");

-- CreateIndex
CREATE INDEX "customer_phones_shopId_customerId_idx" ON "customer_phones"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_phones_customerId_e164_key" ON "customer_phones"("customerId", "e164");

-- CreateIndex
CREATE INDEX "customer_consent_events_shopId_customerId_channel_createdAt_idx" ON "customer_consent_events"("shopId", "customerId", "channel", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "devices_shopId_brand_model_idx" ON "devices"("shopId", "brand", "model");

-- CreateIndex
CREATE UNIQUE INDEX "devices_shopId_id_key" ON "devices"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_shopId_customerId_id_key" ON "devices"("shopId", "customerId", "id");

-- CreateIndex
CREATE INDEX "ticket_statuses_shopId_position_idx" ON "ticket_statuses"("shopId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_statuses_shopId_id_key" ON "ticket_statuses"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_statuses_shopId_id_category_key" ON "ticket_statuses"("shopId", "id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_statuses_shopId_systemRole_key" ON "ticket_statuses"("shopId", "systemRole");

-- CreateIndex
CREATE UNIQUE INDEX "shop_ticket_settings_shopId_key" ON "shop_ticket_settings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_shopId_id_key" ON "tickets"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_shopId_number_key" ON "tickets"("shopId", "number");

-- CreateIndex
CREATE INDEX "ticket_issues_shopId_ticketId_position_idx" ON "ticket_issues"("shopId", "ticketId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_checklist_items_shopId_ticketId_itemKey_key" ON "ticket_checklist_items"("shopId", "ticketId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_accessories_shopId_ticketId_code_key" ON "ticket_accessories"("shopId", "ticketId", "code");

-- CreateIndex
CREATE INDEX "ticket_notes_shopId_ticketId_createdAt_idx" ON "ticket_notes"("shopId", "ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_notes_shopId_id_key" ON "ticket_notes"("shopId", "id");

-- CreateIndex
CREATE INDEX "ticket_events_shopId_ticketId_createdAt_id_idx" ON "ticket_events"("shopId", "ticketId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "customers"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_consent_events" ADD CONSTRAINT "customer_consent_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_consent_events" ADD CONSTRAINT "customer_consent_events_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "customers"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "customers"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_statuses" ADD CONSTRAINT "ticket_statuses_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_ticket_settings" ADD CONSTRAINT "shop_ticket_settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_statusId_statusCategory_fkey" FOREIGN KEY ("shopId", "statusId", "statusCategory") REFERENCES "ticket_statuses"("shopId", "id", "category") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_statusIdBeforeClose_fkey" FOREIGN KEY ("shopId", "statusIdBeforeClose") REFERENCES "ticket_statuses"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "customers"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_customerId_deviceId_fkey" FOREIGN KEY ("shopId", "customerId", "deviceId") REFERENCES "devices"("shopId", "customerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigneeUserId_shopId_fkey" FOREIGN KEY ("assigneeUserId", "shopId") REFERENCES "memberships"("userId", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_shopId_warrantyOfTicketId_fkey" FOREIGN KEY ("shopId", "warrantyOfTicketId") REFERENCES "tickets"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_issues" ADD CONSTRAINT "ticket_issues_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_issues" ADD CONSTRAINT "ticket_issues_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_accessories" ADD CONSTRAINT "ticket_accessories_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_accessories" ADD CONSTRAINT "ticket_accessories_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_authorUserId_shopId_fkey" FOREIGN KEY ("authorUserId", "shopId") REFERENCES "memberships"("userId", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_shopId_noteId_fkey" FOREIGN KEY ("shopId", "noteId") REFERENCES "ticket_notes"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================================================
-- Hand-written below this line (not expressible in the Prisma schema; keep it if `prisma migrate dev`
-- proposes dropping any of it).
-- =====================================================================================================

-- ---------- Generated search column ----------
-- customers."searchText" = lower(unaccent(names + business + contact + email)), the column the trigram index
-- covers. Generated, so it can never drift from the source columns and erasure clears it automatically.
ALTER TABLE "customers" ADD COLUMN "searchText" TEXT GENERATED ALWAYS AS (
  lower(public.f_unaccent(
    coalesce("firstName", '') || ' ' || coalesce("lastName", '') || ' ' || coalesce("businessName", '') || ' ' ||
    coalesce("businessContactName", '') || ' ' || coalesce("email", '')
  ))
) STORED;

-- ---------- CHECK constraints ----------
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_open_ticket_count_check" CHECK ("openTicketCount" >= 0),
  ADD CONSTRAINT "customers_erased_archived_check" CHECK ("erasedAt" IS NULL OR "archivedAt" IS NOT NULL),
  ADD CONSTRAINT "customers_tags_check" CHECK (cardinality("tags") <= 10);

ALTER TABLE "customer_phones"
  ADD CONSTRAINT "customer_phones_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT "customer_phones_digits_check" CHECK ("digits" = substr("e164", 2));

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_imei_check" CHECK ("imei" ~ '^[0-9]{15}$'),
  ADD CONSTRAINT "devices_serial_check" CHECK ("serial" ~ '^[A-Z0-9]{4,30}$'),
  -- The encrypted passcode is all-or-nothing, and only for lock types that have a secret.
  ADD CONSTRAINT "devices_passcode_complete_check"
    CHECK (num_nonnulls("passcodeCiphertext", "passcodeIv", "passcodeTag", "passcodeKeyVersion") IN (0, 4)),
  ADD CONSTRAINT "devices_passcode_lock_type_check"
    CHECK ("passcodeCiphertext" IS NULL OR "lockType" IN ('PIN', 'PASSWORD', 'PATTERN')),
  ADD CONSTRAINT "devices_passcode_view_count_check" CHECK ("passcodeViewCount" >= 0);

ALTER TABLE "ticket_statuses"
  ADD CONSTRAINT "ticket_statuses_category_check" CHECK ("category" IN ('OPEN', 'WAITING', 'READY', 'CLOSED')),
  ADD CONSTRAINT "ticket_statuses_system_role_check" CHECK (
    "systemRole" IS NULL
    OR ("systemRole" = 'INITIAL' AND "category" = 'OPEN')
    OR ("systemRole" IN ('COLLECTED', 'CANCELLED') AND "category" = 'CLOSED')
  ),
  ADD CONSTRAINT "ticket_statuses_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 30);

ALTER TABLE "shop_ticket_settings"
  ADD CONSTRAINT "shop_ticket_settings_next_number_check" CHECK ("nextNumber" >= 1),
  ADD CONSTRAINT "shop_ticket_settings_prefix_check" CHECK ("numberPrefix" ~ '^[A-Z-]{0,5}$'),
  ADD CONSTRAINT "shop_ticket_settings_turnaround_check" CHECK ("defaultTurnaroundDays" BETWEEN 0 AND 30);

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_status_category_check" CHECK ("statusCategory" IN ('OPEN', 'WAITING', 'READY', 'CLOSED')),
  -- closedAt is set exactly while the ticket is in a closed status. This also blocks re-categorising an in-use
  -- status to/from CLOSED (the FK cascade would break it), backing the API's STATUS_IN_USE rule (§5.12).
  ADD CONSTRAINT "tickets_closed_at_check" CHECK (("statusCategory" = 'CLOSED') = ("closedAt" IS NOT NULL)),
  ADD CONSTRAINT "tickets_status_before_close_check" CHECK ("statusIdBeforeClose" IS NULL OR "closedAt" IS NOT NULL),
  ADD CONSTRAINT "tickets_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "tickets_estimate_check" CHECK ("estimateMinor" IS NULL OR "estimateMinor" >= 0),
  ADD CONSTRAINT "tickets_reopen_count_check" CHECK ("reopenCount" >= 0),
  ADD CONSTRAINT "tickets_warranty_self_check" CHECK ("warrantyOfTicketId" IS NULL OR "warrantyOfTicketId" <> "id");

ALTER TABLE "ticket_notes"
  ADD CONSTRAINT "ticket_notes_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000);

-- ---------- Partial / unique-expression indexes ----------
-- One primary phone and at most one WhatsApp number per customer (CU1.3, CU1.4).
CREATE UNIQUE INDEX "customer_phones_one_primary_key" ON "customer_phones" ("customerId") WHERE "isPrimary";
CREATE UNIQUE INDEX "customer_phones_one_whatsapp_key" ON "customer_phones" ("customerId") WHERE "isWhatsapp";
-- Status names are unique per shop, case-insensitively (ST1.2).
CREATE UNIQUE INDEX "ticket_statuses_name_key" ON "ticket_statuses" ("shopId", lower("name"));

-- ---------- Query indexes (§9). Every tenant index leads with "shopId" (RLS + scoped client) ----------
-- Customer list, default sort "Name A-Z" over non-archived customers (erased ones are archived too):
--   WHERE "shopId" = $1 AND "archivedAt" IS NULL ORDER BY "displayName", "id" LIMIT 25 (keyset on displayName, id)
CREATE INDEX "customers_active_name_idx" ON "customers" ("shopId", "displayName", "id") WHERE "archivedAt" IS NULL;
-- Customer list sorted by "Last visit (newest)":
--   WHERE "shopId" = $1 AND "archivedAt" IS NULL ORDER BY "lastVisitAt" DESC NULLS LAST, "id" LIMIT 25
CREATE INDEX "customers_active_last_visit_idx" ON "customers" ("shopId", "lastVisitAt" DESC NULLS LAST, "id")
  WHERE "archivedAt" IS NULL;
-- Name / business name / contact / email "contains" search (any word order): app_search_customers
--   WHERE "searchText" LIKE '%khan%' AND "searchText" LIKE ALL ('{%khan%,%ali%}')
-- (created here, after the generated column; also declared in schema.prisma)
CREATE INDEX "customers_search_trgm_idx" ON "customers" USING GIN ("searchText" gin_trgm_ops);
-- Phone substring search, 4+ digits ("4567" finds +92 300 1234567): app_search_customers
--   WHERE "digits" LIKE '%4567%'   (also declared in schema.prisma)
CREATE INDEX "customer_phones_digits_trgm_idx" ON "customer_phones" USING GIN ("digits" gin_trgm_ops);
-- Exact IMEI / serial (scanner input, "This IMEI is on {customer}'s device" lookup, global search jump):
--   WHERE "shopId" = $1 AND "imei" = $2   /   WHERE "shopId" = $1 AND "serial" = $2
CREATE INDEX "devices_imei_idx" ON "devices" ("shopId", "imei") WHERE "imei" IS NOT NULL;
CREATE INDEX "devices_serial_idx" ON "devices" ("shopId", "serial") WHERE "serial" IS NOT NULL;
-- Partial IMEI / serial search (last 4+ characters, contains): app_search_devices
--   WHERE "imei" LIKE '%4567%' OR "serial" LIKE '%F2LX%'
CREATE INDEX "devices_imei_trgm_idx" ON "devices" USING gin ("imei" gin_trgm_ops) WHERE "imei" IS NOT NULL;
CREATE INDEX "devices_serial_trgm_idx" ON "devices" USING gin ("serial" gin_trgm_ops) WHERE "serial" IS NOT NULL;

-- Ticket views and dashboard counts (§5.2, §6). Serves:
--   All open:  WHERE "shopId" = $1 AND "statusCategory" IN ('OPEN','WAITING','READY') ORDER BY priority DESC, "dueAt", number
--   Ready:     WHERE "shopId" = $1 AND "statusCategory" = 'READY' ...
--   Overdue / due today / due range: ... AND "statusCategory" IN ('OPEN','WAITING') AND "dueAt" < $2
--   Counts:    SELECT count(*) FILTER (WHERE ...) ... WHERE "shopId" = $1 AND "statusCategory" IN ('OPEN','WAITING','READY')
--              (the trailing assigneeUserId, priority make it an index-only scan for Mine / Unassigned / Urgent)
-- These ticket btree indexes are also declared in schema.prisma (same names), so `migrate dev` keeps them.
CREATE INDEX "tickets_status_due_idx" ON "tickets" ("shopId", "statusCategory", "dueAt", "id", "assigneeUserId", "priority");
-- Mine (technician queue, dashboard "My queue"):
--   WHERE "shopId" = $1 AND "assigneeUserId" = $2 AND "statusCategory" IN ('OPEN','WAITING','READY') ORDER BY ...
CREATE INDEX "tickets_assignee_idx" ON "tickets" ("shopId", "assigneeUserId", "statusCategory", "dueAt");
-- "Created (newest)" sort and the created-date filter:  WHERE "shopId" = $1 ORDER BY "createdAt" DESC, "id" LIMIT 25
CREATE INDEX "tickets_created_idx" ON "tickets" ("shopId", "createdAt" DESC, "id");
-- Closed view (history), default sort closed date newest:
--   WHERE "shopId" = $1 AND "statusCategory" = 'CLOSED' ORDER BY "closedAt" DESC, "id" LIMIT 25
CREATE INDEX "tickets_closed_idx" ON "tickets" ("shopId", "statusCategory", "closedAt" DESC, "id");
-- Customer's Tickets tab, ticket search by customer, open-ticket checks (archive/erase guards), FK checks:
--   WHERE "shopId" = $1 AND "customerId" = $2 ORDER BY "createdAt" DESC
CREATE INDEX "tickets_customer_idx" ON "tickets" ("shopId", "customerId", "createdAt" DESC);
-- Device history ("3 previous tickets", "T-1040 is still open for this device"), ticket search by IMEI/serial:
--   WHERE "shopId" = $1 AND "deviceId" = $2 ORDER BY "createdAt" DESC
CREATE INDEX "tickets_device_idx" ON "tickets" ("shopId", "deviceId", "createdAt" DESC);
-- Ticket count per status (settings page) and the ON UPDATE CASCADE of a status category change:
--   WHERE "shopId" = $1 AND "statusId" = $2
CREATE INDEX "tickets_status_idx" ON "tickets" ("shopId", "statusId");
-- Warranty links ("Warranty ticket: T-1101") and the "Warranty only" filter:
--   WHERE "shopId" = $1 AND "warrantyOfTicketId" = $2   /   ... AND "warrantyOfTicketId" IS NOT NULL
CREATE INDEX "tickets_warranty_idx" ON "tickets" ("shopId", "warrantyOfTicketId") WHERE "warrantyOfTicketId" IS NOT NULL;

-- ---------- Row-Level Security ----------
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON "customers"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "customer_phones" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_phones_tenant ON "customer_phones"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "customer_consent_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_consent_events_tenant ON "customer_consent_events"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY devices_tenant ON "devices"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_statuses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_statuses_tenant ON "ticket_statuses"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "shop_ticket_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_ticket_settings_tenant ON "shop_ticket_settings"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_tenant ON "tickets"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_issues" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_issues_tenant ON "ticket_issues"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_checklist_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_checklist_items_tenant ON "ticket_checklist_items"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_accessories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_accessories_tenant ON "ticket_accessories"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_notes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_notes_tenant ON "ticket_notes"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

ALTER TABLE "ticket_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_events_tenant ON "ticket_events"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

-- ---------- Grants ----------
-- New tables get SELECT/INSERT/UPDATE/DELETE for repairos_app from the default privileges (rls_app_role).
-- Re-grant explicitly in case this migration runs as a role other than the one that set those defaults.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customers", "customer_phones", "customer_consent_events", "devices", "ticket_statuses", "shop_ticket_settings",
  "tickets", "ticket_issues", "ticket_checklist_items", "ticket_accessories", "ticket_notes", "ticket_events"
  TO repairos_app;
-- Timeline is append-only (A12). Consent history is append-only, but erasure deletes it (CU9.2).
REVOKE UPDATE, DELETE ON "ticket_events" FROM repairos_app;
REVOKE UPDATE ON "customer_consent_events" FROM repairos_app;
-- The generated search column is never written by anyone.
-- (Postgres already rejects writes to generated columns; nothing to revoke.)

-- ---------- Default statuses and settings (§3, §4; A7-A9) ----------
-- Idempotent: inserts the 9 default statuses if the shop has none, and the settings row if missing.
-- SECURITY INVOKER: called by the API inside the shop's transaction, RLS limits it to that shop; the migration
-- backfill below runs it as the table owner for every existing shop.
CREATE OR REPLACE FUNCTION app_ensure_ticket_defaults(p_shop_id text) RETURNS void
  LANGUAGE sql VOLATILE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  -- Mirrors DEFAULT_TICKET_STATUSES in packages/contracts/src/ticket-statuses.ts exactly (positions 0..8 in that
  -- order); apps/api/test/sprint2-db.test.ts fails if the two drift apart.
  INSERT INTO public.ticket_statuses
    ("id", "shopId", "name", "category", "systemRole", "colour", "position", "isHidden", "notifyCustomer",
     "requiresNote", "updatedAt")
  SELECT gen_random_uuid()::text, p_shop_id, s.name, s.category, s.role::public."TicketStatusRole", s.colour, s.position,
         false, s.notify, s.requires_note, CURRENT_TIMESTAMP
  FROM (VALUES
    ('Received',          'OPEN',    'INITIAL',   'info',    0, true,  false),
    ('Diagnosing',        'OPEN',    NULL,        'blue',    1, false, false),
    ('Awaiting approval', 'WAITING', NULL,        'warning', 2, true,  false),
    ('Awaiting parts',    'WAITING', NULL,        'orange',  3, false, false),
    ('In repair',         'OPEN',    NULL,        'purple',  4, false, false),
    ('Ready for pickup',  'READY',   NULL,        'success', 5, true,  false),
    ('Unrepairable',      'READY',   NULL,        'error',   6, true,  true),
    ('Collected',         'CLOSED',  'COLLECTED', 'neutral', 7, false, false),
    ('Cancelled',         'CLOSED',  'CANCELLED', 'neutral', 8, false, false)
  ) AS s(name, category, role, colour, position, notify, requires_note)
  WHERE NOT EXISTS (SELECT 1 FROM public.ticket_statuses t WHERE t."shopId" = p_shop_id);

  INSERT INTO public.shop_ticket_settings ("id", "shopId", "updatedAt")
  VALUES (gen_random_uuid()::text, p_shop_id, CURRENT_TIMESTAMP)
  ON CONFLICT ("shopId") DO NOTHING;
$$;
REVOKE ALL ON FUNCTION app_ensure_ticket_defaults(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ensure_ticket_defaults(text) TO repairos_app;

-- Backfill every existing shop.
SELECT app_ensure_ticket_defaults("id") FROM "shops";

-- ---------- Search (A14) ----------
-- Escapes LIKE wildcards so user input only ever matches literally.
CREATE OR REPLACE FUNCTION app_like_escape(p text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- Customers matching a free-text query in the CURRENT shop (app.shop_id), never erased ones:
--   * every word of the query is contained in "searchText" (names, business, contact, email; case/accent-blind,
--     any word order), ranked: display name starts with the first word > better trigram similarity;
--   * p_e164 (the query normalised by the API with normalizePhone) equals one of their phones;
--   * 4+ digits of the query are contained in one of their phones (E.164 digits);
--   * with p_match_devices, 4+ letters/digits are contained in one of their devices' IMEI or serial.
-- SECURITY DEFINER because LIKE is not LEAKPROOF: under RLS the trigram indexes could not be used. It reads only
-- rows of app_current_shop_id() (no context = no rows) and returns ids and scores, nothing else.
CREATE OR REPLACE FUNCTION app_search_customers(
  p_query text,
  p_e164 text DEFAULT NULL,
  p_include_archived boolean DEFAULT false,
  p_limit integer DEFAULT NULL,
  p_match_devices boolean DEFAULT true
) RETURNS TABLE ("id" text, "score" real)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  ROWS 100
AS $$
#variable_conflict use_column
DECLARE
  v_shop   text := public.app_current_shop_id();
  v_norm   text := lower(public.f_unaccent(btrim(coalesce(p_query, ''))));
  v_terms  text[];
  v_first  text;
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_dev    text := upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF v_shop IS NULL THEN
    RETURN;
  END IF;
  -- Up to 8 words; the longest first (most selective: it drives the trigram index scan).
  SELECT array_agg('%' || public.app_like_escape(w) || '%' ORDER BY length(w) DESC, w)
    INTO v_terms
    FROM (SELECT w FROM regexp_split_to_table(v_norm, '\s+') AS w WHERE w <> '' LIMIT 8) AS words;
  v_first := public.app_like_escape(split_part(v_norm, ' ', 1)) || '%';

  RETURN QUERY
  SELECT h."customerId", max(h.score)::real
  FROM (
    SELECT c."id" AS "customerId",
           ((CASE WHEN lower(public.f_unaccent(c."displayName")) LIKE v_first THEN 1 ELSE 0 END)
             + public.similarity(c."searchText", v_norm))::real AS score
    FROM public.customers c
    WHERE char_length(replace(v_norm, ' ', '')) >= 2
      AND c."shopId" = v_shop
      AND c."searchText" LIKE v_terms[1]
      AND c."searchText" LIKE ALL (v_terms)
    UNION ALL
    SELECT p."customerId", 3::real
    FROM public.customer_phones p
    WHERE p_e164 IS NOT NULL AND p."shopId" = v_shop AND p."e164" = p_e164
    UNION ALL
    SELECT p."customerId", 2::real
    FROM public.customer_phones p
    WHERE char_length(v_digits) >= 4 AND p."shopId" = v_shop AND p."digits" LIKE '%' || v_digits || '%'
    UNION ALL
    SELECT d."customerId", (CASE WHEN d."imei" = v_dev OR d."serial" = v_dev THEN 3 ELSE 2 END)::real
    FROM public.devices d
    WHERE p_match_devices AND char_length(v_dev) >= 4 AND d."shopId" = v_shop
      AND (d."imei" LIKE '%' || v_dev || '%' OR d."serial" LIKE '%' || v_dev || '%')
  ) AS h
  JOIN public.customers c ON c."id" = h."customerId" AND c."shopId" = v_shop
  WHERE c."erasedAt" IS NULL AND (p_include_archived OR c."archivedAt" IS NULL)
  GROUP BY h."customerId"
  ORDER BY 2 DESC, 1
  LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION app_search_customers(text, text, boolean, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_search_customers(text, text, boolean, integer, boolean) TO repairos_app;

-- Devices of the CURRENT shop whose IMEI or serial equals (score 2) or contains (score 1, 4+ chars) the query,
-- normalised like the stored values (letters/digits only, upper case). Same SECURITY DEFINER reasoning as above.
CREATE OR REPLACE FUNCTION app_search_devices(p_query text, p_limit integer DEFAULT NULL)
  RETURNS TABLE ("id" text, "customerId" text, "score" real)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  ROWS 20
AS $$
#variable_conflict use_column
DECLARE
  v_shop text := public.app_current_shop_id();
  v_dev  text := upper(regexp_replace(coalesce(p_query, ''), '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF v_shop IS NULL OR char_length(v_dev) < 4 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d."id", d."customerId", (CASE WHEN d."imei" = v_dev OR d."serial" = v_dev THEN 2 ELSE 1 END)::real
  FROM public.devices d
  WHERE d."shopId" = v_shop AND (d."imei" LIKE '%' || v_dev || '%' OR d."serial" LIKE '%' || v_dev || '%')
  ORDER BY 3 DESC, d."updatedAt" DESC, 1
  LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION app_search_devices(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_search_devices(text, integer) TO repairos_app;

-- ---------- Erasure (CU9, A11 + tech lead clarification) ----------
-- Anonymises one customer of the CURRENT shop, in the caller's transaction:
--   * customer: names, email, address, notes, tags, preferred contact, consent state and service opt-outs cleared;
--     displayName "Erased customer"; erasedAt set; archived. "searchText" is generated, so it is cleared too;
--   * phones and consent history deleted;
--   * devices keep type, brand and model; IMEI, serial, colour, notes and the passcode are removed;
--   * audit_logs: the before/after payload of this shop's audit rows that contain one of the customer's personal
--     values is replaced by {"redacted": true}. Rows about the customer or their devices are checked for every
--     value (names, display name, email, address lines, phones, IMEI, serial); other rows only for the values that
--     identify the customer on their own (not a lone first or last name) of 4+ characters, so erasing "Ali Khan"
--     cannot redact a staff member Khan's audit rows. Customer audit payloads hold no personal data by design
--     (A12); this is the backstop;
--   * tickets, ticket notes and the timeline are kept (repair records, A11).
-- Raises CUSTOMER_NOT_FOUND, CUSTOMER_ERASED or CUSTOMER_HAS_OPEN_TICKETS (DETAIL = count). The customer row is
-- locked first, so a concurrent check-in for the same customer either finishes before (and is counted) or waits.
-- SECURITY DEFINER because the app role may not UPDATE audit_logs (append-only); every statement filters by
-- app_current_shop_id(). Returns counts only (for the customer.erased audit event).
CREATE OR REPLACE FUNCTION app_erase_customer(p_customer_id text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_shop      text := public.app_current_shop_id();
  c           public.customers%ROWTYPE;
  v_open      integer;
  v_tickets   integer;
  v_device_ids text[];
  v_values    text[];
  v_strong    text[];
  v_phones    integer;
  v_consents  integer;
  v_devices   integer;
  v_audit     integer;
BEGIN
  IF v_shop IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;
  SELECT * INTO c FROM public.customers WHERE "id" = p_customer_id AND "shopId" = v_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;
  IF c."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ERASED';
  END IF;
  SELECT count(*) FILTER (WHERE "statusCategory" <> 'CLOSED'), count(*)
    INTO v_open, v_tickets
    FROM public.tickets WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  IF v_open > 0 THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_TICKETS' USING DETAIL = v_open::text;
  END IF;

  SELECT coalesce(array_agg("id"), '{}') INTO v_device_ids
    FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id;

  -- Personal values to look for in audit payloads, in their JSON-escaped, lower-cased form. "Strong" values
  -- identify the customer on their own (full name, business name, email, address lines, phones, IMEI, serial);
  -- "weak" ones are single names, which may well belong to someone else (a staff member called Khan).
  SELECT coalesce(array_agg(DISTINCT lower(btrim(to_jsonb(v)::text, '"'))) FILTER (WHERE strong), '{}'),
         coalesce(array_agg(DISTINCT lower(btrim(to_jsonb(v)::text, '"'))), '{}')
    INTO v_strong, v_values
  FROM (
    SELECT x.v, x.strong
    FROM unnest(
      ARRAY[c."displayName", c."businessName", c."email", c."addressLine1", c."addressLine2",
            c."firstName", c."lastName", c."businessContactName"],
      -- A one-word display name ("Ali", a walk-in with a first name only) is as weak as a lone first name.
      ARRAY[c."kind" = 'BUSINESS' OR strpos(btrim(c."displayName"), ' ') > 0, true, true, true, true, false, false, false]
    ) AS x(v, strong)
    UNION ALL SELECT "e164", true FROM public.customer_phones WHERE "shopId" = v_shop AND "customerId" = p_customer_id
    UNION ALL SELECT "digits", true FROM public.customer_phones WHERE "shopId" = v_shop AND "customerId" = p_customer_id
    UNION ALL SELECT "imei", true FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id
    UNION ALL SELECT "serial", true FROM public.devices WHERE "shopId" = v_shop AND "customerId" = p_customer_id
  ) AS vals(v, strong)
  WHERE v IS NOT NULL AND btrim(v) <> '';

  -- Rows about this customer or their devices: any value. Any other row of the shop: strong values of 4+ chars.
  UPDATE public.audit_logs a
     SET "before" = CASE WHEN a."before" IS NULL THEN NULL ELSE '{"redacted": true}'::jsonb END,
         "after"  = CASE WHEN a."after"  IS NULL THEN NULL ELSE '{"redacted": true}'::jsonb END
   WHERE a."shopId" = v_shop
     AND (a."before" IS NOT NULL OR a."after" IS NOT NULL)
     AND EXISTS (
       SELECT 1
       FROM unnest(CASE
                     WHEN (a."entityType" = 'Customer' AND a."entityId" = p_customer_id)
                       OR (a."entityType" = 'Device' AND a."entityId" = ANY (v_device_ids)) THEN v_values
                     ELSE ARRAY(SELECT s FROM unnest(v_strong) AS s WHERE char_length(s) >= 4)
                   END) AS v
       WHERE strpos(lower(coalesce(a."before"::text, '') || ' ' || coalesce(a."after"::text, '')), v) > 0
     );
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  DELETE FROM public.customer_phones WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_phones = ROW_COUNT;
  DELETE FROM public.customer_consent_events WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_consents = ROW_COUNT;

  UPDATE public.devices
     SET "colour" = NULL, "imei" = NULL, "serial" = NULL, "notes" = NULL, "lockType" = 'NONE',
         "passcodeCiphertext" = NULL, "passcodeIv" = NULL, "passcodeTag" = NULL, "passcodeKeyVersion" = NULL,
         "passcodeSetAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "shopId" = v_shop AND "customerId" = p_customer_id;
  GET DIAGNOSTICS v_devices = ROW_COUNT;

  UPDATE public.customers
     SET "firstName" = NULL, "lastName" = NULL, "businessName" = NULL, "businessContactName" = NULL,
         "displayName" = 'Erased customer', "email" = NULL,
         "addressLine1" = NULL, "addressLine2" = NULL, "city" = NULL, "region" = NULL, "postcode" = NULL,
         "notes" = NULL, "tags" = '{}', "preferredChannel" = NULL,
         "serviceOptOutSms" = false, "serviceOptOutEmail" = false, "serviceOptOutWhatsapp" = false,
         "marketingSmsAt" = NULL, "marketingEmailAt" = NULL, "marketingWhatsappAt" = NULL,
         "erasedAt" = CURRENT_TIMESTAMP, "archivedAt" = coalesce("archivedAt", CURRENT_TIMESTAMP),
         "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = p_customer_id AND "shopId" = v_shop;

  RETURN jsonb_build_object('phones', v_phones, 'consentEvents', v_consents, 'devices', v_devices,
                            'tickets', v_tickets, 'auditRowsRedacted', v_audit);
END
$$;
REVOKE ALL ON FUNCTION app_erase_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erase_customer(text) TO repairos_app;
