# MVP Roadmap (2-week sprints, ~16 weeks to paid launch)

| Sprint | Goal | Main deliverables | Agents |
|---|---|---|---|
| **0: Foundation** (wk 1–2) | Running skeleton | Monorepo, Docker (Postgres, Redis), Next.js + Astryx + brand theme, NestJS, Prisma + tenant extension + RLS, Better Auth, CI, preview deploys, app shell (sidebar, top bar, global search placeholder) | architect, devops, backend, frontend |
| **1: Shop & people** (wk 3–4) | A shop can sign up and invite staff | Sign-up/onboarding wizard, shop settings (tax, currency, logo), roles and permissions, clock in/out, audit log | backend, frontend, designer |
| **2: Customers & tickets I** (wk 5–6) | Check in a device | Customers + devices, ticket create (fast intake), ticket list with filters, ticket detail, statuses, notes, assignment, photos | all |
| **3: Tickets II & notifications** (wk 7–8) | Customer stays informed | Price list/services, line items, checklist, signature, SMS/email templates and sending (worker), public status page, estimate approval link, print intake receipt and label | backend, integrations, frontend |
| **4: Inventory** (wk 9–10) | Know what's in stock | Products, CSV import, barcode, stock movements, parts used on tickets, low-stock alerts, suppliers, simple purchase orders | backend, frontend |
| **5: POS & money** (wk 11–12) | Get paid | Checkout (ticket + retail), discounts, tax, split payments, refunds, register open/close, invoices (print/email), warranty tickets | all |
| **6: Reports, billing, polish** (wk 13–14) | Ready to charge | Reports + CSV export, Stripe Billing ($50 plan, trial, SMS bundles, customer portal), dashboard, empty states, performance, accessibility | backend, integrations, frontend, QA |
| **7: Beta & launch** (wk 15–16) | 10 pilot shops live | Security review, load test, data import help, onboarding videos, help center, bug fixes, marketing site + pricing page | QA, devops, all |

## Definition of Done (every story)
- Acceptance criteria from the story are met and demoed.
- Contracts (Zod) updated; API has integration tests; UI has at least one Playwright happy path.
- Tenant isolation test exists for any new tenant table.
- Uses Astryx components only; passes axe a11y check; works at 1024px (tablet) width.
- Typecheck, lint and tests pass in CI; reviewed by the code-reviewer agent.
- Docs or changelog updated.

## Phase 2 (after launch, by revenue impact)
1. Integrated card payments (Stripe Terminal + Connect platform fee)
2. Online booking widget
3. Google review requests
4. Multi-location + stock transfers (unlocks a higher tier)
5. QuickBooks/Xero sync
6. Trade-in/buyback, loyalty, gift cards
7. AI phone receptionist, unified inbox
