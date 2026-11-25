# Product Brief — Repair Shop MVP

> Working name: **RepairOS** (placeholder, rename before launch)

## 1. Segment
Independent **cell phone, tablet and computer repair shops**: 1–3 locations, 1–8 staff.
Today they run on paper, Excel, WhatsApp or an expensive tool (RepairDesk $99, RepairShopr).

## 2. Promise
"Check in a device in under 60 seconds, keep the customer updated automatically, and get paid at the counter, for $50 a month."

## 3. Pricing (MVP)
| Plan | Price | Includes |
|---|---|---|
| **Standard** | **$50 / store / month** (annual: $480/yr, 20% off) | 1 location, up to 5 users, unlimited tickets, customers, inventory, POS, 300 SMS/month, email notifications, basic reports |
| Extra SMS | Bundles (e.g. 1,000 SMS = $15) | Margin over provider cost |
| Extra users | $5 / user / month | |
| Later | Card processing take rate, online booking, review requests, AI phone answering | Phase 2+ revenue |

14-day free trial, no card required. Billing through Stripe Billing.

## 4. Personas
- **Owner**: wants money in, no lost devices, numbers at a glance.
- **Front desk**: wants fast check-in, quick answers to "is my phone ready?", fast checkout.
- **Technician**: wants a clear queue, parts info, and notes, and to update status in one tap.
- **End customer** (not a user): wants a quote, updates, and a fair bill.

## 5. MVP scope (must-have)
1. **Onboarding**: sign up, create shop (name, address, currency, tax rate, logo), invite staff, import customers/products via CSV, start trial.
2. **Repair tickets**
   - Create ticket: find or create customer, device (type, brand, model, IMEI/serial, passcode/pattern stored securely, condition), problem, accessories left, pre-repair checklist, photos.
   - Line items: services (from a price list) + parts (from inventory).
   - Status workflow (configurable labels; default: Received → Diagnosing → Awaiting approval → Awaiting parts → In repair → Ready for pickup → Collected / Cancelled).
   - Assign technician, due date, priority, internal notes vs. customer-visible notes.
   - Estimate approval (customer approves via SMS/email link).
   - Customer signature on intake (on screen).
   - Print: intake receipt, device label (barcode), invoice.
   - Warranty period per service; reopen as a warranty ticket.
3. **Customers**: profile, devices, ticket history, invoices, notes, consent to marketing.
4. **Notifications**: automatic SMS + email on status change (editable templates with variables); public **ticket status page** (link with token).
5. **POS / checkout**: sell ticket and/or retail items, discounts, tax, split payment (cash, card on external terminal, other), refunds, receipts (print/email). Register open/close with cash count.
6. **Inventory**: products (parts & accessories), SKU/barcode, cost/price, stock per location, low-stock alerts, stock adjustments with reason, parts consumed by tickets, simple purchase orders (order → receive).
7. **Price list**: repair services by device model (e.g. "iPhone 13 screen" = $129), linked parts.
8. **Staff**: roles (Owner, Manager, Front desk, Technician), permissions, clock in/out.
9. **Reports**: sales by day/payment method, ticket counts and turnaround time, technician performance, inventory value, low stock, tax summary. CSV export.
10. **Settings & billing**: shop profile, tax, receipt templates, notification templates, statuses, subscription and invoices (Stripe customer portal).

## 6. Out of scope for MVP (Phase 2+)
Integrated card processing (Stripe Terminal), online booking widget, multiple locations and stock transfers, loyalty/gift cards/store credit, trade-in/buyback, Google review requests, QuickBooks/Xero sync, supplier catalog ordering, unified inbox, AI phone receptionist, mobile app, public API.

## 7. Success metrics (first 6 months after launch)
- Time to create a ticket: < 60s median.
- Trial → paid conversion ≥ 20%.
- 50 paying stores → $2.5k MRR; logo churn < 3%/month.
- Weekly active usage: ≥ 80% of paying stores create a ticket every week.

## 8. Non-functional requirements
- Web app, works on desktop and tablet (Chrome, Safari, Edge); front-desk friendly (keyboard and barcode scanner).
- p95 API latency < 300 ms; 99.5% uptime target for MVP.
- Every row is scoped to a shop (tenant); no data leaks between shops.
- Device passcodes encrypted at rest; audit log for money and stock changes.
- GDPR-ready: data export and deletion per customer.
- Currency, tax and date formats are configurable per shop (no market hard-coded). Launch markets: US, UK, Pakistan; see `docs/MARKETS.md`.
