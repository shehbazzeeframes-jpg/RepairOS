-- Check-in idempotency keys (Sprint 2 §5.1 edge case: Idempotency-Key header on POST /api/tickets).
CREATE TABLE "ticket_idempotency_keys" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_idempotency_keys_shopId_userId_key_key" ON "ticket_idempotency_keys"("shopId", "userId", "key");

ALTER TABLE "ticket_idempotency_keys" ADD CONSTRAINT "ticket_idempotency_keys_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_idempotency_keys" ADD CONSTRAINT "ticket_idempotency_keys_shopId_ticketId_fkey" FOREIGN KEY ("shopId", "ticketId") REFERENCES "tickets"("shopId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (same policy as every tenant table).
ALTER TABLE "ticket_idempotency_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_idempotency_keys_tenant ON "ticket_idempotency_keys"
  USING ("shopId" = app_current_shop_id()) WITH CHECK ("shopId" = app_current_shop_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket_idempotency_keys" TO repairos_app;
