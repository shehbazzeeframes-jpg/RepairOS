-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_shopId_fkey";

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The app may never delete a shop (that would cascade away its data). Shop removal is an
-- owner-role / support operation; audit_logs above now blocks it while history exists.
REVOKE DELETE ON "shops" FROM repairos_app;
