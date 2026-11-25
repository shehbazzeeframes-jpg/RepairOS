# RepairOS: project rules for every agent

Repair-shop management SaaS (phone & computer repair), $50/store/month.
Read before work: `docs/PRODUCT.md` (scope), `docs/MARKETS.md` (US/UK/PK rules), `docs/ARCHITECTURE.md` (stack and rules), `docs/ROADMAP.md` (current sprint), `docs/TEAM.md` (who owns what).

## Stack
pnpm + Turborepo · TypeScript strict · Next.js App Router + React 19 + **Astryx** design system · NestJS · Prisma + PostgreSQL 16 · Better Auth · BullMQ + Redis · Zod contracts · Stripe · Twilio · Resend · Vitest / Supertest / Playwright.

## Non-negotiables
1. **Astryx only for UI.** Before building any UI piece run `npx @astryxdesign/cli search <thing>` / `component <Name>` / `template --list`. Use tokens, never raw colours or pixel values. Do not run unscoped `npx astryx` before the CLI is installed (it resolves to an unrelated package).
2. **Tenant safety.** Every tenant table has `shopId`; queries go through the scoped Prisma client; add an isolation test for each new table.
3. **Contracts first.** Zod schemas in `packages/contracts` before API or UI.
4. **Money** = integer minor units + currency. Invoices/payments/refunds are immutable; corrections are new records.
5. **Stock** only changes through `StockMovement`.
6. Secrets never in code or commits; use `.env` (gitignored) and `.env.example`.
7. Keep to your owned folders (see `docs/TEAM.md`); ask the tech lead to change another area.
8. Done = typecheck + lint + tests pass, plus the Definition of Done in `docs/ROADMAP.md`.

## Commands (after Sprint 0)
`pnpm dev` · `pnpm test` · `pnpm lint` · `pnpm typecheck` · `pnpm db:migrate` · `pnpm db:seed` · `pnpm e2e`
