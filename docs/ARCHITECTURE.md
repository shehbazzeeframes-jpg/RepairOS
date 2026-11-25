# Architecture & Tech Stack

## Decisions
| Area | Choice | Why |
|---|---|---|
| Language | **TypeScript (strict)** everywhere | One language for every agent; shared types end to end |
| Monorepo | **pnpm workspaces + Turborepo** | Shared packages, cached builds, parallel agent work |
| Web app | **Next.js (App Router) + React 19** | Required by Astryx (React ≥ 19); also serves public pages (ticket status, estimate approval) |
| Design system | **Astryx** (`@astryxdesign/core`, `@astryxdesign/theme-neutral` → custom brand theme, `@astryxdesign/cli`) | Mandated. Ships precompiled CSS, so no StyleX compiler unless we swizzle components or write StyleX ourselves |
| Data fetching / forms | TanStack Query, React Hook Form + Zod | Caching and optimistic updates for a busy front desk |
| API | **NestJS** (REST, OpenAPI generated) | Strong module conventions, so each agent owns clear domain modules; ready for a future mobile app and public API |
| Validation / contracts | **Zod** schemas in `packages/contracts`, shared by API and web | Single source of truth; generated typed client |
| Database | **PostgreSQL 16** | Relational data (tickets, stock, money) |
| ORM | **Prisma** | Typed queries, migrations |
| Multi-tenancy | Shared DB, `shop_id` on every tenant row, Prisma client extension that scopes queries + Postgres **Row-Level Security** as a backstop | Cheap to run, safe |
| Auth | **Better Auth** (email/password, magic link, organizations, roles), sessions in Postgres | Self-hosted, no per-user fees |
| Background jobs | **BullMQ + Redis** | SMS/email sending, reminders, low-stock alerts, report exports |
| SMS | **Twilio** (abstracted behind a `MessagingProvider` interface) | Swap providers per market later |
| Email | **Resend** (React Email templates) | |
| Subscription billing | **Stripe Billing** + Customer Portal; webhooks update `subscription_status` | $50/store/month, trial, usage add-ons (SMS) |
| Card payments at POS | Phase 2: Stripe Terminal + Connect (platform fee = revenue) | Highest revenue add-on |
| File storage | S3-compatible (**Cloudflare R2**), signed URLs | Device photos, logos, signatures |
| Printing | HTML/CSS print templates (80 mm thermal receipt, A4 invoice, 2"×1" label), barcodes via `bwip-js` | Works with any printer through the browser; PrintNode later |
| Search | Postgres full-text + trigram (customer name, phone, IMEI, ticket #) | No extra service for the MVP |
| Testing | Vitest (unit), Supertest (API integration against real Postgres in Docker), Playwright (E2E) | |
| Quality | ESLint, Prettier, `tsc --noEmit`, Astryx `is-my-code-good` review, axe accessibility checks | |
| CI/CD | GitHub Actions: lint → typecheck → test → build → preview deploy | |
| Hosting (MVP) | Web on **Vercel**; API, worker, Postgres, Redis on **Railway** (or Render). Move to AWS (ECS + RDS) after product-market fit | Low cost, fast setup |
| Observability | Sentry (errors), PostHog (product analytics, feature flags), structured logs (pino) | |

## Repository layout
```
repair-shop-mvp/
├─ apps/
│  ├─ web/            # Next.js + Astryx (staff app + public status/approval pages)
│  ├─ api/            # NestJS REST API
│  └─ worker/         # BullMQ job processors (messaging, alerts, exports)
├─ packages/
│  ├─ contracts/      # Zod schemas, DTO types, API client
│  ├─ db/             # Prisma schema, migrations, seed, tenant extension
│  ├─ ui/             # App-specific composites built ON Astryx (TicketStatusBadge, MoneyInput…)
│  ├─ print/          # Receipt / label / invoice templates
│  └─ config/         # eslint, tsconfig, prettier presets
├─ e2e/               # Playwright tests
├─ docs/              # Product, architecture, roadmap, team
└─ docker-compose.yml # postgres, redis (dev emails go to .outbox/, viewable at /dev/outbox)
```

## API modules (NestJS) → owner
`auth`, `shops` (settings, tax, statuses), `users` (roles, clock-in), `customers`, `devices`, `tickets` (items, status history, notes, attachments, checklist, signatures, approvals), `catalog` (products, services/price list), `inventory` (stock levels, movements, adjustments, purchase orders, suppliers), `sales` (invoices, payments, refunds, registers), `notifications` (templates, message log), `reports`, `billing` (Stripe), `public` (status page, estimate approval; token-based, no session), `audit`.

## Core data model (first cut)
- **Shop** (tenant) → **Location** (1 in MVP, ready for many)
- **User**, **Membership** (user ↔ shop, role), **TimeEntry**
- **Customer** → **Device** (type, brand, model, IMEI/serial, encrypted passcode)
- **Ticket** (number per shop, status, priority, assignee, due date, warranty_of) → **TicketItem** (service | part, qty, price, tax), **TicketStatusChange**, **TicketNote** (internal/public), **Attachment**, **ChecklistResult**, **Signature**, **Approval**
- **Product** (part/accessory, sku, barcode, cost, price, serialized?) → **StockLevel** (per location), **StockMovement** (reason, ref)
- **Service** (price list entry, device model, linked parts)
- **Supplier**, **PurchaseOrder** → **PurchaseOrderLine**
- **Invoice** → **InvoiceLine**, **Payment** (method, amount), **Refund**; **Register** → **RegisterSession** (opening/closing cash)
- **NotificationTemplate**, **MessageLog**
- **Subscription** (Stripe ids, status, seats, sms_quota)
- **AuditLog** (actor, action, entity, before/after)

Money is stored as integer minor units plus a currency code. All timestamps are UTC, displayed in the shop's time zone.

## Rules that prevent costly mistakes
1. Tenant scoping is never done by hand in a controller. It always goes through the scoped Prisma client.
2. Stock changes only via `StockMovement` (stock levels are derived/updated in the same transaction).
3. Money changes (invoice, payment, refund) are immutable records plus audit log, never edited in place.
4. Contracts first: a feature starts with Zod schemas in `packages/contracts`, then the API, then the UI.
5. UI uses Astryx components and tokens only. No hand-rolled buttons, inputs, tables or colours. Check `npx astryx search <thing>` before building any component.
