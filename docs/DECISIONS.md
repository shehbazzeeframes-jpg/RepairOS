# Decision Log

Decisions made by the tech lead under the product owner's standing instruction to "move forward with best approaches". Pricing is confirmed with the product owner before launch.

| Date | Decision | Reason | Revisit |
|---|---|---|---|
| 2026-11-25 | Launch segment: phone & computer repair; markets US, UK, Pakistan | Product owner | — |
| 2026-11-25 | Standard plan $50/store/month (£40 UK), 5 users, 300 SMS | Product owner | — |
| 2026-11-25 | Pakistan working price **PKR 5,999/month**, WhatsApp messages instead of SMS; stored as configuration | $50 is too high for most PK shops | **Confirm with product owner before the PK beta** |
| 2026-11-25 | Keep Astryx **neutral** theme; brand colour and logo applied as theme tokens in Sprint 7 | Lets features ship now; re-theming is a token change | Sprint 7 |
| 2026-11-25 | Sprint 1 D1–D10 (tax defaults per goods/services, rates in thousandths of a percent, fixed role matrix, forgot password, file outbox in dev, invite link copy for WhatsApp, …) | See `docs/stories/sprint1-shop-and-people.md` | — |
| 2026-11-25 | Mailpit removed; dev emails go to a file outbox shown at `/dev/outbox` | Works without Docker; one mechanism | — |
| 2026-11-25 | Sprint 2 data layer: child tables for issues/checklist/accessories; gapless counter in `ShopTicketSettings.nextNumber`; 1–2 letter name search is word-prefix (not substring) for speed; ticket search joins customer/device search instead of a stored search column | Performance and erase safety (no stale copies of personal data) | — |
| 2026-11-25 | After a customer erase, old index entries are cleared by autovacuum, not immediately | GDPR requires erasure "without undue delay"; the values are already gone from every table and query result | If a regulator or customer contract requires immediate purge, add an owner-side VACUUM job |
| 2026-11-25 | Sprint 2 API: the passcode reveal limit (30/user/hour) is counted from `device.passcode_viewed` audit rows of the active shop, under a per-user advisory lock | Survives restarts and multiple API processes without Redis; the audit row is written anyway | If a user works in several shops at once and abuse shows up, count across shops |
| 2026-11-25 | Sprint 2 API: idempotent check-in uses a `ticket_idempotency_keys` table (insert-first, `ON CONFLICT DO NOTHING`), not Redis | Same transaction as the ticket: a failed check-in frees the key, concurrent repeats wait and get the same ticket | — |
| 2026-11-25 | Sprint 2 API: every ticket mutation (edit, status, assign, cancel, reopen) bumps `version`; notes do not | The edit form shows status/assignee too, so it should reload after any change; status/assign themselves need no version (guards re-check under a row lock) | If staff find the stale-edit banner too frequent |
| 2026-11-25 | Sprint 2 API: passcode deleted on close keeps the device's `lockType` (only the secret is cleared) | The device card still says "PIN – no passcode on file, ask again" | — |
| 2026-11-25 | Sprint 2 API: `customers.openTicketCount` / `lastVisitAt` are recomputed from tickets (one UPDATE) in every ticket transaction that can change them, without bumping the customer `version` | Always correct, cheap per customer; a check-in must not make an open customer form stale | — |
| 2026-11-25 | Erase replaces the customer's identifiers in ticket free text, notes, timeline and audit with `[erased]`; audit payloads hold no free text | A11 promise of "no name, phone, email or address anywhere" | — |
| 2026-11-25 | Customer export includes customer, device and internal ticket notes (no passcodes) | GDPR right of access covers internal notes about the person | — |
| 2026-11-25 | Warranty tickets must reference a Collected ticket for the same device | Prevents linking to another customer's repair | — |
| 2026-11-25 | One lock order for every Sprint 2 write: shop → status → customer → ticket → device → ticket counter, rows of one level sorted by id (`packages/db/README.md`, "Lock order") | Erase and reopen (and a status change vs a status re-categorisation) locked rows in opposite orders and could deadlock or hit an FK error → 500 | — |
| 2026-11-25 | Shop transactions are retried at most twice (jittered) on Postgres 40P01/40001; side effects only after commit (`afterCommit`) | Safety net for a cycle the lock order misses; a lost race becomes a short wait, a 409 if it persists | If retries show up in the logs, fix the lock order of that path |
