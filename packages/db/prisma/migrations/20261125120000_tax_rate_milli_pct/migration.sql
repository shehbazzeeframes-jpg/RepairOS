-- D2: tax rates move from basis points (2000 = 20.00%) to thousandths of a percent (20000 = 20%, 8875 = 8.875%).
ALTER TABLE "tax_rates" RENAME COLUMN "rateBps" TO "rateMilliPct";
UPDATE "tax_rates" SET "rateMilliPct" = "rateMilliPct" * 10;
