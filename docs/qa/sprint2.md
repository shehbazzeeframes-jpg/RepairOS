# QA report: Sprint 2 (customers & tickets I), real stack

Tested `main` at `7bfccc6` on branch `qa/sprint2`, 2026-11-25. Source of truth: `docs/stories/sprint2-customers-and-tickets.md` (the binding tech lead tables at the end win, including A11-b/c/d and M2) and `docs/screens/sprint2.md`.

Like the Sprint 1 suite, this drives a production build of the web app against the real NestJS API, Postgres (RLS, as `repairos_app`), the BullMQ worker on Redis and the file outbox, with **no `page.route` mocks**. Specs are `e2e/real/13-…` to `22-…`; helpers in `e2e/real/support/sprint2.ts`. Almost every test creates its own owner and shop through the API (statuses and settings are the shop's real defaults), so tests don't depend on each other; the returning-customer check-in, isolation and a11y tests use the seed shops read-only (check-in adds one ticket).

## Summary

| Area | Spec | Tests | Pass | Expected fail |
| --- | --- | --- | --- | --- |
| Check-in: keyboard paths + timings, idempotency, duplicate, archived restore, IMEI scan, draft (§5.1, TK1–TK4) | `13-checkin` | 9 | 8 | 1 (BUG-01) |
| Ticket list views/counts/filters/search, Take, dashboard = lists (§5.2, §6) | `14-ticket-list` | 7 | 7 | 0 |
| Ticket detail: transitions, Unrepairable note, collect, cancel, reopen, warranty, assign, notes, version conflict (§5.3–5.6) | `15-ticket-detail` | 11 | 9 | 2 (BUG-02, KNOWN M2) |
| Passcodes: encryption, reveal 30 s, audit, technician, closed ticket, delete on close, rate limit (DV3–DV5) | `16-passcode` | 7 | 6 | 1 (KNOWN) |
| Customers US/UK/PK, consent/TCPA, list, archive/restore, export, erase, devices (§1, §2) | `17-customers` | 14 | 9 | 5 (BUG-01, BUG-03, BUG-04, 2 KNOWN) |
| Statuses and ticket settings, gapless numbering (§3, §4, TK4) | `18-settings` | 6 | 6 | 0 |
| Global search ⌘K, two-tab shop switch, X-Shop-Id (§7, §8.1) | `19-search-shops` | 4 | 4 | 0 |
| Permissions per role (nav, URL, API), tenant isolation (§0, DoD) | `20-permissions-isolation` | 4 | 4 | 0 |
| Due/overdue/due today in PK time, DST US/UK (DU1, A16) | `21-timezone` | 3 | 3 | 0 |
| axe on 22 pages/dialogs, layout 1024/1440 | `22-a11y-layout-s2` | 4 | 3 | 1 (BUG-05) |
| **Sprint 2 total** | | **69** | **59** | **10** |

Last full run (Sprint 1 + 2, fresh reset, `REAL_API_LOG` set): **125 tests, all as expected** (115 pass, 10 expected failures) in 6.5 min. The 56 Sprint 1 tests still pass after two test-only updates: four of them hard-coded `http://localhost:3200` (now `BASE`, so the suite runs on any port), and `ISO-01` sent a US `X-Shop-Id` from the PK session, which since A13 is correctly refused with `409 ACTIVE_SHOP_CHANGED` (the test now expects that).

Known bugs are marked `test.fail(true, 'BUG-xx …')` and known open items (already with the backend engineer) `test.fail(true, 'KNOWN (open item) …')`. The suite stays green while they are present; Playwright reports "expected to fail but passed" once fixed, so remove the marker then.

**No blockers.** One major bug (BUG-02, silent lost update after a version conflict) and four minor ones. All five known open items reproduce on `main` (see "Known open items"). **All five bugs and the four testable known items are fixed; see "Retest after fixes".**

## Check-in timings (TK1.11, TK2.4, DoD)

Measured on the real stack, keyboard only, headless Chromium at 1440×900. Keystrokes counted as the story does: search term separately, a chord (⌘↵) is one key, typed text one per character. Machine time = first keystroke → ticket page heading visible (real API, one DB transaction). The person estimate uses the keystroke-level model from the screen spec §2.6 (0.28 s/key, 1.35 s/decision, +3 s reading); the hallway test in the DoD replaces it with real medians.

| Path                                                                                                 | Keys after search                                                                         | Total keys | Machine time | KLM person estimate                | Budget            | Result |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- | ------------ | ---------------------------------- | ----------------- | ------ |
| Returning customer + known device, 1 issue, defaults (seed US shop, front desk, "linda c") — CI-01   | **7** (↵ customer · ↵ device · 3 letters · ↵ issue · ⌘↵)                                  | 14         | 1.2 s        | **≈ 12 s**                         | ≤ 15 keys, < 60 s | Pass   |
| New customer + new device, IMEI typed, **pattern** lock, 1 issue (fresh GB shop, front desk) — CI-02 | **51** (phone 12 · model "iph 13" · IMEI 15 · → → → Tab · pattern 1596 · ↵s · "scr" · ⌘↵) | 61         | 2.5–3.4 s    | **≈ 31 s** (≈ 27 s with a scanner) | < 90 s            | Pass   |

The new-customer path is 2 keys longer than the prototype's 49 because a pattern (3 arrow keys to reach "Pattern", 4 dots) replaces a PIN. Both are well inside the targets. A real-person median is still needed for the DoD hallway test.

## How to run

Prerequisites: local Postgres and Redis, Chromium from `PLAYWRIGHT_BROWSERS_PATH`. Never run `playwright install`.

1. Throwaway databases (here `repairos_s2qa` / `repairos_s2qa_test`, already created). Copy the main `.env` into the worktree and change:
   ```
   DATABASE_URL / APP_DATABASE_URL           → …/repairos_s2qa
   DATABASE_URL_TEST / APP_DATABASE_URL_TEST → …/repairos_s2qa_test
   REDIS_URL=redis://localhost:6379/8   PORT=4900   APP_URL=http://localhost:3900   API_URL=http://localhost:4900
   NODE_ENV=development  DEV_OUTBOX=1   (keep the real FIELD_ENCRYPTION_KEY)
   AUTH_RATE_LIMIT_MAX=1000  SHOP_CREATE_PER_HOUR=500  INVITE_PREVIEW_RATE_LIMIT=2000  PASSWORD_RESET_PER_EMAIL_HOUR=50
   ```
   then `pnpm install && pnpm db:migrate && pnpm db:seed`.
2. Build:
   ```
   pnpm --filter @repairos/contracts --filter @repairos/db --filter @repairos/email build
   pnpm --filter @repairos/api build && pnpm --filter @repairos/worker build
   API_URL=http://localhost:4900 NEXT_PUBLIC_DEV_OUTBOX=1 pnpm --filter @repairos/web build
   ```
3. Start: `(cd apps/api && pnpm start)`, `(cd apps/worker && pnpm start)`, `(cd apps/web && pnpm exec next start --port 3900)`.
4. Run everything (Sprint 1 + 2): `REAL_BASE_URL=http://localhost:3900 pnpm e2e:real`. Only Sprint 2: `… pnpm --filter @repairos/e2e test:real -- real/1[3-9] real/2[0-2]`. `REAL_SKIP_RESET=1` skips the truncate-and-reseed; `REAL_API_LOG=<api log>` turns on Sprint 1's SEC-01.

The suite is serial (`workers: 1`). Global setup truncates and re-seeds the database in `DATABASE_URL` and refuses the shared `repairos` database.

## Bugs (ranked)

### BUG-02: After a version conflict, "Reload" keeps stale copies of fields the user never touched, and the next save silently overwrites the other person's change (major) — **Fixed** (see Retest after fixes)

TE1.4 / screen spec §0.2: on `STALE_RECORD` "keep the user's input … Reload (refetch, form keeps values where unchanged)". The point of the version check is to stop lost updates; this path re-introduces them.

- **Steps:** two staff open the same ticket. A opens Edit details, sets Condition notes "Scratch on the back", saves. B (opened before A saved) opens Edit details, ticks Urgent and types a description, saves → banner "This ticket was changed by Fran Desk." → clicks **Reload** → **Save changes**.
- **Expected:** B's save keeps A's condition notes (B never touched that field; after Reload it should show A's value).
- **Actual:** after Reload, B's dialog still shows the old empty Condition notes; the save sends `conditionNotes: null` with the new version and the API accepts it. A's note is gone; the timeline shows B "changing" it. Cause: Reload refetches the ticket, but the dialog's form state is not re-derived, and `intakeChanges(newTicket, staleForm)` then diffs every field B didn't touch against the new server value (`apps/web/src/components/tickets/TicketDialogs.tsx`, `EditDetailsDialog` Reload handler and `intakeChanges`). Any field can be lost this way: issues, checklist items, accessories, estimate, due, priority.
- **Evidence:** `TD-09` in `e2e/real/15-ticket-detail.real.ts` (expected fail; the final `toMatchObject` shows `conditionNotes: null`). Screenshot `docs/qa/sprint2/td-09-stale.png`.
- **Suggested fix area (web):** on Reload, rebuild the form from the new ticket and re-apply only the fields the user changed (dirty fields), and diff against the new ticket.

### BUG-01: An invalid phone is not flagged when leaving the field; in check-in it even passes "Use this customer" and only fails at Create (minor) — **Fixed** (see Retest after fixes)

CU1.2: "When I leave the field, Then it is validated … An invalid number shows 'Enter a valid phone number' and blocks save." Screen spec §2.3: phone error "on blur".

- **Steps (check-in):** New ticket → type a name → "New customer" → Phone `07911 687612` (not an allocated UK mobile range) → ↵.
- **Expected:** the field shows "Enter a valid phone number" and focus stays.
- **Actual:** the Customer section collapses as **Done** ("Bad Phone (new)") and focus moves to Model. The error only appears after the whole check-in is filled in and ⌘↵ returns 400, which costs the person the time the 60-second target is about. Same on `/customers/new` and edit: no error on blur, only on Save (save is correctly blocked).
- **Evidence:** `CI-09` (`13-checkin.real.ts`) and `CU-02b` (`17-customers.real.ts`), both expected-fail. Screenshot `docs/qa/sprint2/ci-09-invalid-phone-accepted.png`.

### BUG-03: Customer list filters and search use history replace, so Back leaves the page instead of undoing a filter (minor) — **Fixed** (see Retest after fixes)

CU5.5: "Filters, search and sort live in the URL (shareable, back button works)."

- **Steps:** Dashboard → Customers → search "pena jose" → turn on Show archived → browser Back.
- **Expected:** back to `/customers?q=pena+jose` without `archived=true`.
- **Actual:** back to the dashboard (`/`); every list change replaced the history entry. The ticket list behaves the same (TL1.4 only says "in the URL", so it isn't filed there).
- **Evidence:** `CU-05b` (`17-customers.real.ts`), annotation `after Back: http://localhost:3900/`.

### BUG-04: A 14-digit IMEI shows no error on blur in the device dialog (minor) — **Fixed** (see Retest after fixes)

Screen spec §5: IMEI error `IMEI_ERROR` + `IMEI_LENGTH_HINT` "once 15+ digits or on blur". DV2.2.

- **Steps:** customer → Devices → Add device → model iPhone 13 → IMEI `35693803564380` (14 digits) → Tab.
- **Expected:** "This IMEI isn't valid … IMEI has 15 digits".
- **Actual:** nothing until "Add device" is pressed (then the error shows and save is blocked; the API also rejects bad IMEIs).
- **Evidence:** `CU-10b` (expected fail); `CU-10` annotation `14-digit IMEI error shown on blur: false`.

### BUG-05: Ticket list cuts off status names and assignee names, including the "(deactivated)" marker, even at 1440 (minor) — **Fixed** (see Retest after fixes)

- **Steps:** owner@demo.test, Tickets, at 1440×900 (and 1024×768).
- **Expected:** status badges ("Ready for pickup", "Awaiting approval") readable; a deactivated assignee shows "Fred Former (deactivated)" (AS1.2) so the reader knows the ticket needs picking up.
- **Actual:** "Ready for pic…", "Awaiting appr…", "Maria Mana…", "Fred Former…", "Hudson Realty G…" at 1440. The deactivated marker is never visible in the row. At 1024 the ticket-detail "Due" value in the Details card is also cut ("4 days overdue · Sat, No…"). No horizontal page scroll anywhere; tooltips exist.
- **Evidence:** `LAYOUT-S2-badges` (`22-a11y-layout-s2.real.ts`, expected fail; annotation lists the cut texts). Screenshots `docs/qa/sprint2/bug-05-truncated-status-1440.png`, `layout-1440-tickets-list.png`, `layout-1024-tickets-list.png`, `layout-1024-ticket-detail.png`.
- Same class as Sprint 1 BUG-05 (staff table at 1024); likely the `proportional(1, { minWidth })` floors.

## Known open items (confirmed, not re-filed)

| Item                                                         | Reproduced?                                                                                                                                                      | Evidence                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Passcode not deleted on concurrent close                     | **Yes, 5/5**: two open tickets on one device cancelled at the same moment by two users → ciphertext stays (sequential close deletes it correctly, PC-04)         | `PC-07` (`16-passcode.real.ts`)       |
| Erase leaves identifiers in ticket free text / notes / audit | **Yes**: name and phone (`917-555-0166`, `(917) 555-0166`) survive in `tickets.description`, note bodies, `ticket_events.data` (cancel note) after erase (A11-b) | `CU-09` (`17-customers.real.ts`)      |
| `openTicketCount` drift on concurrent close                  | Not separately probed (PC-07's concurrent cancels exercise the same path); single-threaded counts are right everywhere (TL-01, DB-01, CU-06)                     | —                                     |
| Warranty linking another customer's ticket (M2)              | **Yes**: warranty for a different device of the same customer → 201; for another customer's device → 201 (M2 requires 409 `WARRANTY_NOT_ALLOWED`)                | `TD-06b` (`15-ticket-detail.real.ts`) |
| Export missing notes (A11-c)                                 | **Yes**: customer-visible notes are exported, internal ticket notes are not                                                                                      | `CU-07b`; `CU-07` annotation          |

## Observations (not filed)

- The seed's closed tickets (T-1001…T-1017) still hold encrypted passcodes for devices that have no other open ticket; the seed writes them directly, bypassing DV5. Dev data only.
- `NumberInput` (Next ticket number) updates the "Next ticket:" preview on blur, not per keystroke. Fine.
- Dashboard tiles are `ClickableCard`s whose inner layout intercepts pointer events on the link element in Playwright; real clicks on the card work (mocked suite clicks the text). Tests navigate via the tile's `href`.
- Ticket list view tabs also use history replace (see BUG-03); the story only requires the URL state.
- `GET …/passcode/reveal` → 404 (route is POST only), `Cache-Control: no-store` on the POST: as A15 requires.

## Test cases by acceptance criterion

Status: **Pass**, **Fail (BUG-x / KNOWN)**, **Partial** (part covered here, rest in unit/mocked tests), **N/T** (not tested here; reason given).

### §0 Permissions

| AC                                                                                                                                         | Test case                                                                                                                                                                                                                | Test                                   | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------ |
| Matrix: T sees tickets/customers; cannot check in, edit customers/devices, collect, cancel, reopen, export/erase, manage statuses/settings | Nav + direct URLs → "You don't have access" for `/tickets/new`, `/customers/new`, `/customers/:id/edit`, `/settings/statuses`, `/settings/tickets`; 11 API calls → 403; allowed: status within non-closed, assign, notes | PERM-S2-01, TD-03, TD-04, TD-05, PC-05 | Pass   |
| FD: check-in + customers yes; export/erase, statuses, ticket settings no                                                                   | URLs + hidden menu items + API 403                                                                                                                                                                                       | PERM-S2-02, CU-08                      | Pass   |
| M: statuses, ticket settings, export                                                                                                       | URLs, settings nav, API 200                                                                                                                                                                                              | PERM-S2-03                             | Pass   |

### §1 Customers

| AC                                                                                                                                                         | Test case                                                                                                                                                                                                                | Test                                 | Status                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------ |
| CU1.1 Person/Business, name rules, phone or email                                                                                                          | Business with no contact; single-name person (PK)                                                                                                                                                                        | CU-02, CU-03                         | Pass                                 |
| CU1.2 Phone formats per country, E.164, national display, invalid blocks save                                                                              | US `(212) 555-0142`/`646.555.0199`; UK `07911 123456` + landline `020 7946 0018`; PK `0300-1234567`, `3001234567`, `+92 300 1234567`, `923001234567` → `+923001234567`; invalid blocks save                              | CU-01, CU-02, CU-03                  | Pass                                 |
| CU1.2 error "when I leave the field"                                                                                                                       | Blur on an invalid phone                                                                                                                                                                                                 | CU-02b, CI-09                        | **Fail (BUG-01)**                    |
| CU1.3 Up to 3 phones, labels, one primary                                                                                                                  | Two phones, first primary; Landline label                                                                                                                                                                                | CU-01, CU-02                         | Pass                                 |
| CU1.4 Preferred contact default (PK WhatsApp, US/UK SMS); WhatsApp link not for landlines                                                                  | Defaults; `wa.me` link for PK mobile; none for UK landline                                                                                                                                                               | CU-01, CU-02, CU-03                  | Pass                                 |
| CU1.5 Save → land on customer, toast                                                                                                                       | "Customer added" + detail URL                                                                                                                                                                                            | CU-01…03                             | Pass                                 |
| CU2.1–2.4 Duplicate warning (phone any format), Use this customer, never blocks                                                                            | `+92 3xx …` typed for a `0300…` customer → "Already a customer?" → Use this customer → device step; API allows the duplicate; duplicates endpoint lists both                                                             | CI-05                                | Pass                                 |
| CU2.2 "and {n} more"                                                                                                                                       | —                                                                                                                                                                                                                        | —                                    | N/T (needs 4+ matches; mocked suite) |
| CU3.2 STALE_RECORD on customer edit, input kept                                                                                                            | Two browser contexts                                                                                                                                                                                                     | CU-04                                | Pass                                 |
| CU4.1–4.3 Consent per channel, unticked, source, history append-only                                                                                       | Switches off by default; verbal SMS; withdraw (source defaults to Customer request) then grant → 3 events, current = last                                                                                                | CU-01, CU-03, CU-04                  | Pass                                 |
| CU4.4 TCPA warning for US verbal SMS                                                                                                                       | Warning shown, save allowed                                                                                                                                                                                              | CU-01                                | Pass                                 |
| CU4.5 Service-updates opt-out switches                                                                                                                     | Present on form                                                                                                                                                                                                          | CU-01 (axe/aria)                     | Partial                              |
| CU5.1–5.4 List, search (any word order, accents, phone formats, 4+ digit substring), filters, archived off                                                 | "pena jose" finds "José Peña"; tags filter; archived only with switch; PK phone formats + "4567"                                                                                                                         | CU-03, CU-05                         | Pass                                 |
| CU5.5 URL state, back button works                                                                                                                         | Back after a filter change                                                                                                                                                                                               | CU-05b                               | **Fail (BUG-03)**                    |
| CU6 Customer page: header links, actions by permission, tabs                                                                                               | tel:/wa.me/mailto links, Tickets/Devices/Details tabs, actions hidden for T/FD                                                                                                                                           | CU-01, CU-03, PERM-S2-01/02, A11Y-S2 | Pass                                 |
| CU7 Archive blocked with open tickets; archive/restore audited; hidden from search; Restore and use                                                        | 409 with count; audit `customer.archived/restored`; global search excludes; check-in "Restore and use"                                                                                                                   | CU-06, CI-06                         | Pass                                 |
| CU8 / A11-c Export: download JSON, filename, no passcodes, audited with counts only                                                                        | File `customer-{id}-{date}.json` downloaded and parsed: no PIN, `passcodeOnFile: true`, device/customer notes and customer-visible notes present; audit without name/phone                                               | CU-07, PC-05                         | Pass                                 |
| A11-c internal ticket notes in export                                                                                                                      | —                                                                                                                                                                                                                        | CU-07b                               | **Fail (KNOWN)**                     |
| CU9 Erase: FD 403; blocked with open tickets; type ERASE; anonymised; unfindable; ticket kept as "Erased customer"; erased can't be exported/restored/used | List/global search/duplicates/device lookup by name, phone (3 formats), email, IMEI all empty; DB rows hold no identifiers; ticket found by number shows "Erased customer"; export 404; new ticket 409 `CUSTOMER_ERASED` | CU-08                                | Pass                                 |
| A11-b redact identifiers in free text, notes, events, audit                                                                                                | —                                                                                                                                                                                                                        | CU-09                                | **Fail (KNOWN)**                     |

### §2 Devices

| AC                                                                                   | Test case                                                                       | Test         | Status            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------ | ----------------- |
| DV1 Add device, model suggestions fill brand/type                                    | Model "iphone 13" → Apple/Phone; "iph 13" → iPhone 13 first (R2)                | CU-10, CI-02 | Pass              |
| DV2.1–2.3 IMEI Luhn/15 digits, serial normalised                                     | Bad Luhn 400; 14 digits blocked on save; serial `' c02-xk 12ab '` → `C02XK12AB` | CU-10        | Pass              |
| DV2.2 IMEI error on blur                                                             | —                                                                               | CU-10b       | **Fail (BUG-04)** |
| DV2.5 IMEI on another customer's device warns, save allowed                          | "This IMEI is on First Owner's …", saved                                        | CU-10        | Pass              |
| DV3 Lock types, pattern by keyboard, encrypted at rest, reads never return it        | Pattern 1-5-9-6 by keys; raw DB has ciphertext only; detail JSON has no value   | CI-02, PC-01 | Pass              |
| DV3.5 Passcode change audited without value; T can't change                          | `device.passcode_changed`; T → 403                                              | PC-05        | Pass              |
| DV4.1 Reveal: POST, no-store, 30 s then hidden, audited with ticketId                | Clock-controlled 31 s; audit `after` has deviceId + ticketId, no value          | PC-01        | Pass              |
| DV4.1 Pattern shown as read-only grid with order                                     | "3 → 5 → 7 → 8"                                                                 | PC-02        | Pass              |
| DV4.2 Closed ticket / customer page: no button, 403 `PASSCODE_NOT_AVAILABLE`         | With deletion off so the guard itself is tested                                 | PC-03        | Pass              |
| DV4.3 "Viewed n times · last by …"                                                   | "Viewed 1 time · last by Pip Tech"                                              | PC-01        | Pass              |
| DV4.4 > 30 reveals/user/hour → 429; other users unaffected                           | 31 calls                                                                        | PC-06        | Pass              |
| DV4.5 Never in URL, title, storage; no copy button                                   | Checked during reveal                                                           | PC-01        | Pass              |
| DV5 Delete on close; kept while another ticket on the device is open; timeline event | Sequential closes                                                               | PC-04, TD-03 | Pass              |
| DV5 under concurrent close                                                           | —                                                                               | PC-07        | **Fail (KNOWN)**  |

### §3 Statuses / §4 Ticket settings

| AC                                                                                                         | Test case                                                                                              | Test         | Status |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------ | ------ |
| ST1.2 Rename (unique case-insensitive), colour, notify                                                     | `STATUS_NAME_TAKEN`; new name shows on tickets                                                         | ST-01        | Pass   |
| ST1.3 System statuses: rename yes; hide / re-categorise → `SYSTEM_STATUS_LOCKED`                           | Received, Collected, Cancelled                                                                         | ST-01        | Pass   |
| ST1.4 Hide: tickets stay; gone from menu; change into it → `STATUS_HIDDEN`                                 | API + status menu                                                                                      | ST-02        | Pass   |
| ST1.5 Category change moves tickets at once; confirm "n tickets will move"                                 | UI confirm "2 tickets will move from In progress to Ready"; counts update; DB `statusCategory` updated | ST-03        | Pass   |
| ST1.6 Last visible open/ready protected                                                                    | `LAST_VISIBLE_STATUS`                                                                                  | ST-02        | Pass   |
| §5.12 to/from Closed while in use → `STATUS_IN_USE`; custom closed only via Cancel                         | —                                                                                                      | ST-03        | Pass   |
| ST1.2 Reorder (Move down), max 20, Add disabled at 20                                                      | —                                                                                                      | ST-04        | Pass   |
| requiresNote on a custom status                                                                            | 400 without note, 200 with                                                                             | ST-04        | Pass   |
| ST1.7 Audit `ticket_status.created/updated/reordered`                                                      | —                                                                                                      | ST-01, ST-04 | Pass   |
| TS1 Prefix (display-only, search with new prefix), next number only upwards, turnaround 0 = today, audited | `RP-1001` shown for old ticket, `RP-5000` next; `TICKET_NUMBER_TOO_LOW`; bad prefix 400                | TS-01        | Pass   |
| TK4 / DoD Gapless numbering under concurrency                                                              | 24 parallel creates incl. 4 invalid → 1001…1020 contiguous                                             | TS-02, CI-03 | Pass   |

### §5 Tickets

| AC                                                                                                                                                                                     | Test case                                                                                                       | Test                                | Status                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| TK1 Returning customer keyboard-only, ≤ 15 keys, < 60 s                                                                                                                                | See timings                                                                                                     | CI-01                               | Pass                                                   |
| TK2 New customer + device inline, one transaction, < 90 s                                                                                                                              | One customer + one device row; pattern lock; IMEI                                                               | CI-02                               | Pass                                                   |
| TK3 Draft restored without passcode                                                                                                                                                    | Reload → "Draft restored", "Enter the passcode again"; PIN not in storage                                       | CI-08                               | Pass                                                   |
| TK3.2 Leave-page confirmation                                                                                                                                                          | —                                                                                                               | —                                   | N/T (browser `beforeunload` dialog)                    |
| Idempotent create / double submit                                                                                                                                                      | Same key sequential → 201 then 200 same id; 5 concurrent same key → one ticket/customer; triple ⌘↵ → one ticket | CI-03, CI-04                        | Pass                                                   |
| Scanner IMEI in Find customer                                                                                                                                                          | Fast typed IMEI → "IMEI match" → ↵ → Issues                                                                     | CI-07                               | Pass                                                   |
| Archived customer "Restore and use"; API `CUSTOMER_ARCHIVED`                                                                                                                           | —                                                                                                               | CI-06                               | Pass                                                   |
| TL1.1 Views + counts (incl. deactivated assignee in Unassigned)                                                                                                                        | Purpose-built shop with 6 tickets across categories                                                             | TL-01, TL-04                        | Pass                                                   |
| TL1.2 Technician lands on Mine                                                                                                                                                         | —                                                                                                               | TL-04                               | Pass                                                   |
| TL1.4 Filters (status, priority, device type, technician incl. Unassigned, created range, bad range 400)                                                                               | —                                                                                                               | TL-03                               | Pass                                                   |
| TL1.5 Search: number (`T-1001`, `t1001`, `1001`, `t-1001`), phone (7 formats incl. last 4), name (any order), IMEI full + last 4, serial contains                                      | —                                                                                                               | TL-02, TL-04                        | Pass                                                   |
| TL1.6 Default sort urgent → due                                                                                                                                                        | —                                                                                                               | TL-01                               | Pass                                                   |
| TL1.8 Row "Take", row status change                                                                                                                                                    | —                                                                                                               | TL-05                               | Pass                                                   |
| TD1 Detail page, shortcuts S/A/M, two columns at 1024                                                                                                                                  | —                                                                                                               | TD-01, TD-07, TD-08, LAYOUT-S2-1024 | Pass                                                   |
| §5.4 Transitions: menu shows allowed only; Collected explained from open; same status rejected; Cancelled not via status; Collected 409 from open; T 403 to Collected                  | —                                                                                                               | TD-01, TD-03                        | Pass                                                   |
| Unrepairable requires a note (customer-visible default)                                                                                                                                | API 400; dialog validation                                                                                      | TD-02                               | Pass                                                   |
| Collect confirm lists accessories; closed read-only except notes (`TICKET_CLOSED`)                                                                                                     | —                                                                                                               | TD-03                               | Pass                                                   |
| TK-C Cancel: reason, hand-back checkbox, OTHER note ≥ 3, audited, T 403                                                                                                                | —                                                                                                               | TD-04                               | Pass                                                   |
| TK-R Reopen ≤ 7 days to status before close, passcode notice, audited, reopenCount; > 7 days → 409 and "New ticket for this device"                                                    | `closedAt` aged by SQL                                                                                          | TD-05                               | Pass                                                   |
| TK-W Warranty: prefilled check-in with banner, links both ways, timeline `warranty_linked`, root link, not from Cancelled                                                              | —                                                                                                               | TD-06                               | Pass                                                   |
| M2 same device only                                                                                                                                                                    | —                                                                                                               | TD-06b                              | **Fail (KNOWN)**                                       |
| AS1 Assign / Take, timeline, status unchanged, deactivated not offered + `ASSIGNEE_NOT_ACTIVE`, technicians first                                                                      | —                                                                                                               | TD-07                               | Pass                                                   |
| A20 Notes: internal default, customer-visible tone + helper, edit own ≤ 10 min ("edited"), visibility fixed, others can't, > 10 min `NOTE_EDIT_WINDOW_PASSED`, notes on closed tickets | —                                                                                                               | TD-08, TD-03                        | Pass                                                   |
| TE1.4 Version conflict across two contexts: message names the other user, input kept                                                                                                   | —                                                                                                               | TD-09                               | Pass (message) / **Fail (BUG-02)** (data after Reload) |
| §5.12 Concurrent pure status changes both applied                                                                                                                                      | —                                                                                                               | TD-10                               | Pass                                                   |
| DU1 Due at closing time in shop TZ; closed day 23:59; time given; DST (US Mar 2027, UK Mar 2027)                                                                                       | —                                                                                                               | TZ-01, TZ-03                        | Pass                                                   |
| DU1.2–1.3 Overdue / due today by **Karachi** date (cases straddling UTC midnight); ready never overdue                                                                                 | —                                                                                                               | TZ-02                               | Pass                                                   |

### §6 Dashboard, §7 Search, §8 Backlog

| AC                                                                                                                                            | Test case | Test                       | Status             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------- | ------------------ |
| DB1.1/1.5 Tiles = counts; each tile's list shows the same number of rows                                                                      | —         | DB-01, TZ-02               | Pass               |
| DB1.2 My queue (technician)                                                                                                                   | —         | DB-02                      | Pass               |
| DB1.3 FD "New ticket" button; T none                                                                                                          | —         | DB-02, A11Y-S2             | Pass               |
| GS1.1–1.4 ⌘K and `/`, grouped results, Recent, exact ticket number ↵, full IMEI ↵ → latest ticket, Esc                                        | —         | GS-01                      | Pass               |
| GS1.5 Archived excluded, erased never match, permission-scoped quick actions                                                                  | —         | GS-01, GS-02, CU-06, CU-08 | Pass               |
| GS1.2 Recent cleared on sign-out                                                                                                              | —         | —                          | N/T                |
| BK1 / A13 Two tabs: switch shop in one, create in the other → 409, banner, nothing written in either shop, draft kept under original shop key | —         | SH-01                      | Pass               |
| BK1 API: mismatch → 409 on reads and writes, nothing written, `X-Shop-Id` echoed, no header still works                                       | —         | SH-02                      | Pass               |
| BK2 onboarding flake                                                                                                                          | —         | —                          | N/T (mocked suite) |

### Tenant isolation, a11y, layout

| AC                                                             | Test case                                                                                                                                                                                                                                                                                     | Test                           | Status             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------ |
| Cross-shop ids → 404 never 403 (API and UI)                    | PK owner with US ticket, customer, device, status ids: 19 endpoints incl. writes, reveal, export, erase, status PATCH → 404; check-in with US ids 404; list by US `customerId` empty; search empty; US ticket version unchanged; UI "We can't find that ticket/customer."                     | ISO-S2-01                      | Pass               |
| axe (WCAG 2.1 A/AA) on every new page and dialog               | 22 targets: dashboard, ticket list, detail (open + closed), status menu, cancel/edit/assign dialogs, check-in (empty + new customer/device/pattern/checklist), customer list/detail (3 tabs)/new/edit, add-device and erase dialogs, statuses (+ add dialog), ticket settings, search palette | A11Y-S2 (+ per-test axe)       | Pass, 0 violations |
| 1024 and 1440: no horizontal scroll; ticket detail two columns | 15 pages at each width                                                                                                                                                                                                                                                                        | LAYOUT-S2-1024, LAYOUT-S2-1440 | Pass               |
| Readable at 1024/1440                                          | Status and names in ticket list                                                                                                                                                                                                                                                               | LAYOUT-S2-badges               | **Fail (BUG-05)**  |

## Retest after fixes (2026-11-25, fix/sprint2-web with main fc5c973 merged)

Real-stack suite against `fix/sprint2-web` with `main` at fc5c973 merged (backend review fixes and the race fixes, migration `20261204090000_lock_order` applied), fresh reset, `REAL_API_LOG` set, all `test.fail` markers for BUG-01..05 and the four "KNOWN (open item)" markers removed: **125 passed, 0 failed, 0 skipped** (Sprint 1 + 2) in 6.4 min. Stack as in "How to run", on API 5100 / web 5101, databases `repairos_s2wfix(_test)`, Redis DB 7.

409 `CONFLICT` (a ticket write still racing after the API's retries) has no contract copy, so every screen shows the API's own message (`errorMessage` falls back to it); covered by a unit test and a mocked status-change + Edit details test in `tickets.spec.ts`.

| Bug / item | Status | Fixed in |
| --- | --- | --- |
| BUG-02 Reload after a version conflict overwrote a colleague's change | **Fixed**: TD-09 passes (A's condition notes survive B's save) | fix/sprint2-web: Edit details and the customer form keep a baseline; Reload keeps only the fields the person edited and takes the rest from the server; saves send only real changes with the baseline's version (the customer form used to PATCH every field). Device dialog and ticket settings have no `version` in their contracts. Mocked: `fix-conflict.spec.ts` (two browser contexts) |
| BUG-01 invalid phone not flagged on blur | **Fixed**: CI-09, CU-02b pass | fix/sprint2-web: check-in quick form flags it on blur and "Use this customer" / ↵ stay on the field; customer form validates each phone on blur. Mocked: `fix-validation.spec.ts` |
| BUG-03 Back left the list instead of undoing a filter | **Fixed**: CU-05b passes | fix/sprint2-web: customer and ticket lists push a history entry per filter/view change; the search box makes one entry per search (debounced; later typing in the same search replaces it); Back restores the box. Mocked: `fix-history.spec.ts` |
| BUG-04 14-digit IMEI not flagged on blur | **Fixed**: CU-10b passes | fix/sprint2-web: device dialog (IMEI, serial) and check-in new device flag on blur. Mocked: `fix-validation.spec.ts` |
| BUG-05 status/assignee cut off in the ticket list; Due cut in Details at 1024 | **Fixed**: LAYOUT-S2-badges, LAYOUT-S2-1024/1440 pass | fix/sprint2-web: status column sized to the longest status name, columns weighted by their floors (no table scroll at 1440), names wrap, "(deactivated)" always shown; the overdue date sits next to its badge. Screenshots re-taken (`bug-05-truncated-status-1440.png` now shows the fixed list, `layout-*`). Mocked: `fix-layout.spec.ts` |
| KNOWN M2 warranty for another device/customer | **Fixed**: TD-06b passes (409 `WARRANTY_NOT_ALLOWED`) | main (backend). Web: warranty check-in keeps customer and device locked and says why, warns up front if the original wasn't collected, and shows the API's message with "Create without the warranty link" if refused (`fix-warranty.spec.ts`) |
| KNOWN passcode not deleted on concurrent close | **Fixed**: PC-07 passes (5/5 deleted) | main (backend) |
| KNOWN export missing internal notes (A11-c) | **Fixed**: CU-07b passes | main (backend) |
| KNOWN erase leaves identifiers in free text (A11-b) | **Fixed**: CU-09 passes | main (backend) |
| Flaky mocked test "customer list: search, archived switch, open a customer" | **Fixed**: 30/30 with `--repeat-each=30`, no retries | fix/sprint2-web: Clear filters reset the search box, which scheduled a debounced commit built from the filters captured before the clear; ~250 ms later it navigated back to `?archived=true`, undoing the clear and racing the click on the customer link. Clear now cancels the pending commit. Deterministic regression in `fix-history.spec.ts` |

Test-only change found in the retest: TD-03 read the ticket right after the optimistic "Closed" text appeared, so it raced the API (it expected the optimistic-only text "Closed. Notes can still be added."). It now accepts either closed text and polls the API for `COLLECTED`.

`openTicketCount` drift on concurrent close was still not measured separately (PC-07 exercises the same path and passes).

## What wasn't tested, and why

- **Performance §9** (50k/100k perf seed, EXPLAINs, p95): not in this QA scope; needs `pnpm db:seed:perf` and a load tool on a quiet machine.
- **Real-person hallway test** (DoD median < 60 s): needs people. KLM estimates are above.
- **`openTicketCount` drift on concurrent close** (known item) was not separately measured.
- **TK3.2 leave-page confirm**, **TL1.9 / DB1.4 60-second refresh**, **GS1.2 Recent cleared on sign-out**, **CU2.2 "and n more"**, **PASSCODE_UNREADABLE** (needs a wrong key), **production start-up refusal with a placeholder key**: not covered on the real stack.
- **Mobile < 900 px**: only 1024 and 1440 were in scope.
- **PostHog `ticket_created` instrumentation**: not observable without the analytics backend.
