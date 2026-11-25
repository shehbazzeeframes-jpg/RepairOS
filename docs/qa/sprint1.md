# QA report: Sprint 1 (shop & people), real stack

Tested `main` at `10b5ad9` on branch `qa/sprint1`, 2026-11-25. Source of truth: `docs/stories/sprint1-shop-and-people.md` (the "Tech lead decisions" table overrides earlier text) and `docs/screens/sprint1.md`.

Unlike `e2e/tests/` (every `/api/**` call mocked), this suite drives a production build of the web app, which proxies to the real NestJS API, Postgres (with RLS, as `repairos_app`), the BullMQ worker on Redis and the file outbox. It has **no `page.route` mocks**. Emails come from `/dev/outbox` and its API.

## Summary

| Area                                                                         | Tests  | Pass   | Known bug (expected fail)  |
| ---------------------------------------------------------------------------- | ------ | ------ | -------------------------- |
| Invites, accept, copy link, resend/revoke, email (§2 S2–S3, §3, §8, D7, D10) | 7      | 7      | 0                          |
| Seats, last owner, manager limits (§2 S2.6, S4, S5.3–4)                      | 9      | 9      | 0                          |
| Permissions and deactivation (§1, §2 S5, Risk #1)                            | 9      | 8      | 1 (BUG-03)                 |
| Forgot / reset password (D4)                                                 | 2      | 2      | 0                          |
| Shop profile US/UK/PK (§4.1)                                                 | 5      | 4      | 1 (BUG-04)                 |
| Tax rates (§4.2, D1, D2)                                                     | 3      | 3      | 0                          |
| Business hours (§4.3)                                                        | 2      | 2      | 0                          |
| Clock, timesheet, correction, CSV (§5)                                       | 3      | 3      | 0                          |
| Shop switcher, shop cap, tenant isolation (§3 A3, §7)                        | 4      | 4      | 0                          |
| Accessibility (axe) and layout at 1024/1440                                  | 5      | 4      | 1 (BUG-05)                 |
| Audit viewer, read-only DB role, flags (§6, C1.4, C2.4)                      | 4      | 3      | 1 (BUG-02)                 |
| Security (token logging) and a11y naming                                     | 3      | 0      | 3 (BUG-01, BUG-06, BUG-07) |
| **Total**                                                                    | **56** | **49** | **7**                      |

Last full run: `REAL_API_LOG=… pnpm e2e:real` gave 56 tests, all as expected (49 pass, 7 expected failures), in 2.8 min, from a fresh reset. Without `REAL_API_LOG`, SEC-01 is skipped. Known bugs are marked with `test.fail(true, 'BUG-0x: …')`. The suite stays green while a bug is present, and Playwright reports "expected to fail but passed" once it is fixed, so the marker must then be removed.

**No blockers.** Three major bugs and four minor ones are listed below.

## How to run

Prerequisites: local Postgres and Redis, Chromium from `PLAYWRIGHT_BROWSERS_PATH`. Never run `playwright install`.

1. Create throwaway databases and point a repo-root `.env` at them. Copy the main `.env`, then:
   ```
   su postgres -c "createdb -O repairos repairos_qa"
   su postgres -c "createdb -O repairos repairos_qa_test"
   # in .env: DATABASE_URL / APP_DATABASE_URL → …/repairos_qa, *_TEST → …/repairos_qa_test
   # APP_URL=http://localhost:3200  API_URL=http://localhost:4100  PORT=4100
   # REDIS_URL=redis://localhost:6379/7   (own Redis DB, so another worktree's worker can't take our email jobs)
   # AUTH_RATE_LIMIT_MAX=300  SHOP_CREATE_PER_HOUR=100  INVITE_PREVIEW_RATE_LIMIT=1000   (the suite signs in a lot from one IP)
   # NODE_ENV=development  DEV_OUTBOX=1   (required since fix/sprint1-api: the API/worker refuse to start without
   #   NODE_ENV, and /api/dev/outbox is a 404 unless DEV_OUTBOX=1, RESEND_API_KEY is unset and NODE_ENV is development/test)
   # PASSWORD_RESET_PER_EMAIL_HOUR=50   (optional: reset emails per account per hour, default 5)
   pnpm install && pnpm db:migrate && pnpm db:seed
   ```
2. Build:
   ```
   pnpm --filter @repairos/contracts --filter @repairos/db --filter @repairos/email build
   pnpm --filter @repairos/api build && pnpm --filter @repairos/worker build
   API_URL=http://localhost:4100 NEXT_PUBLIC_DEV_OUTBOX=1 pnpm --filter @repairos/web build   # API_URL is fixed at build time
   ```
3. Start (three terminals, or `nohup … &`):
   ```
   (cd apps/api && pnpm start > /tmp/api.log 2>&1)       # needs NODE_ENV=development + DEV_OUTBOX=1 in .env for /api/dev/outbox
   (cd apps/worker && pnpm start)
   (cd apps/web && pnpm exec next start --port 3200)
   ```
4. Run: `pnpm e2e:real`, or `pnpm --filter @repairos/e2e test:real`. Options:
   - `REAL_BASE_URL` (default `http://localhost:3200`).
   - `REAL_API_LOG=/tmp/api.log` turns on SEC-01 (token-in-logs check).
   - `REAL_SKIP_RESET=1` skips the reset.

   Global setup checks `/api/health`, then **truncates every table** in `DATABASE_URL` (except `_prisma_migrations`), re-seeds and clears `.outbox/`. It refuses to touch a database named `repairos` unless `REAL_ALLOW_RESET=1`. Tests run serially (`workers: 1`). Most tests create their own owner and shop through the API, so they don't depend on each other. Only a few read the seed shop, and they don't change it.

Files: `e2e/playwright.real.config.ts`, `e2e/real/*.real.ts`, `e2e/real/support/{global-setup,stack}.ts`. Screenshots: `docs/qa/sprint1/*.png`. The suite is not part of `pnpm test` or `pnpm e2e`.

## Bugs (ranked)

### BUG-01: Invite and password-reset tokens are written to the API request log (major)

Violates E1.5 ("the token appears only in the email/outbox, never in logs") and Riskiest item #2. This is a possible blocker for the tech lead to decide: anyone with log access can use a reset token to take over an account.

- **Steps:**
  1. Start the API with stdout going to a file.
  2. Invite someone, open `/invite/<token>` and accept.
  3. Request a password reset and open the `/reset-password?token=…` link.
  4. `grep` the API log for the tokens.
- **Expected:** neither token appears.
- **Actual:** pino-http logs `req.url`, which is `/api/invites/<token>` and `/api/invites/<token>/accept` (46 lines in one run). It also logs the `Referer` header on every request made from those pages: `http://localhost:3200/invite/<token>` and `http://localhost:3200/reset-password?token=<token>` (20 lines). The reset token is logged by the page's `GET /api/me` _before_ the user submits, while it is still valid. Cookies and `authorization` are redacted (`apps/api/src/app.factory.ts` `redact`), but the URL and referer are not.
- **Evidence:** `SEC-01` in `e2e/real/12-security-a11y-names.real.ts`. Run it with `REAL_API_LOG`; both soft assertions fail.
- **Suggested fix area (backend):** a pino-http `serializers.req` that masks `/invites/<token>` in `url` and drops or masks `referer`. The web app could also set `Referrer-Policy: no-referrer` on `/invite/*` and `/reset-password`.

### BUG-02: Opening Settings → Timesheets writes "Exported timesheet" audit events (major)

- **Steps:** as an owner, open `/settings/timesheets` and do nothing. Open the Audit log.
- **Expected:** `timesheet.exported` is written only when the user clicks Export CSV (C4.4).
- **Actual:** the "Export CSV" button is a Next `<Link>`, so the production build **prefetches** `/api/timesheets/export.csv?from…&to…&_rsc=…` (headers `next-router-prefetch: 1`) as soon as the page renders. A second prefetch has no range at all. The API builds the CSV and audits `timesheet.exported` each time. Every visit, and every filter change that changes the href, adds false "Exported timesheet" rows, so owners can't trust that entry. It also wastes a CSV build per view. In one QA session the seed shop gained 4 export events from page views alone.
- **Evidence:** `AUD-03` in `e2e/real/11-audit-flags.real.ts`; the probe captured the prefetch request headers.
- **Suggested fix area (web):** use a plain `<a href download>` or `prefetch={false}` for the export link. The API could also ignore requests that carry `next-router-prefetch` / `rsc`.

### BUG-03: The "You no longer have access to {shop}" banner is lost when the user's next action is in-app (major)

S5.5: the UI should land on the other shop's dashboard **with a banner**.

- **Steps:**
  1. A user works in shop A (front desk) and owns shop B. Shop A is active and the dashboard is open.
  2. The owner of A deactivates them.
  3. The user clicks **Clock in**, without reloading.
- **Expected:** the app switches to shop B and shows the warning banner "You no longer have access to {A}."
- **Actual:** the app switches to shop B silently, with no banner. `POST clock-in` returns 403, and `GET /api/timeclock/me` also returns 403. Each 403 invalidates `me`, so `/api/me` is fetched twice. The first response has `accessRemoved: {shopName: A}` and moves the session. The second has `accessRemoved: null` and replaces it before the banner renders. The banner does show when the page is reloaded instead (DEACT-02a passes), because then only one `/api/me` fetch happens.
- **Evidence:** `DEACT-02b` in `e2e/real/03-access.real.ts`. The annotation records `/api/me` bodies `{"shopId":…,"shopName":"QA GB …"} | null`. Screenshot `docs/qa/sprint1/deact-02b-no-banner.png`; compare `deact-02a-fallback-banner.png`.
- **Suggested fix area:** the API's `accessRemoved` is one-shot server state consumed by the first `GET /api/me`. Either the web keeps the last non-null `accessRemoved` until dismissed, or the API stops clearing it on read.

### BUG-04: The story's own UK mobile example `07700 900123` is rejected (minor)

- **Steps:** in a GB shop, Settings → General → Shop phone `07700 900123` → Save (or `PATCH /api/shop {phone}`).
- **Expected (story §4.1 table):** accepted and stored as `+447700900123`.
- **Actual:** `400 VALIDATION_FAILED` "Enter a valid phone number". `07700 900000–900999` is Ofcom's drama range, which `libphonenumber-js` reports `isValid() = false`. Real mobiles work (`07911 123456` → `+447911123456`, tested), and so does the UK landline example (`020 7946 0018`).
- **Evidence:** `PROF-GB-2` in `e2e/real/05-shop-profile.real.ts`.
- **Decision needed:** most likely the story example needs changing (product/tech lead), not the validator.

### BUG-05: At 1024px the staff table truncates the owner's own name and the "You" badge to "Y…" (minor)

- **Steps:** at a 1024×900 viewport, open Settings → Staff as owner@demo.test.
- **Expected:** at 1024px (the tablet target in the ROADMAP Definition of Done), names and the short "You" badge are readable; long emails may truncate.
- **Actual:** the Name column shows "Demo O…" with a "Y…" badge. Emails and "Last clock-in" are also cut ("Nov 24, 2026, 9…"). On Timesheets, the "Deactivat…" and "Closed on deac…" badges are cut too. There is no horizontal page scroll; tooltips exist per the spec's truncation rule.
- **Evidence:** `LAYOUT-1024` in `e2e/real/10-a11y-layout.real.ts` (truncated: `["Demo Owner","You"]`). Screenshots `docs/qa/sprint1/layout-1024-staff.png` and `layout-1024-timesheets.png`.

### BUG-06: Business-hours time inputs all have the same accessible name (minor, a11y)

- **Steps:** open Settings → Business hours with a screen reader, or inspect the accessibility tree.
- **Expected:** each picker names its day, e.g. "Monday opens" / "Monday closes" (WCAG 2.4.6, labels that describe the purpose).
- **Actual:** six textboxes are named "Opens" and six "Closes". Only the switches carry the day ("Monday open"). axe does not flag this.
- **Evidence:** `A11Y-names-hours` in `e2e/real/12-security-a11y-names.real.ts`.

### BUG-07: The clocked-in button's accessible name repeats itself (minor, a11y)

- **Steps:** clock in, then inspect the top-bar button.
- **Expected:** "Clocked in 2h 14m" (screen spec §2 / Accessibility: "the clock button's name includes the elapsed time").
- **Actual:** "Clocked in Clocked in 0m". The `StatusDot` image label "Clocked in" is part of the name.
- **Evidence:** `A11Y-names-clock` in `e2e/real/12-security-a11y-names.real.ts`.

### Observations (not filed as bugs)

- Some copy differs slightly from the screen spec. For example the tax row menu says "Make goods default" where the spec says "Set as goods default". The revoke confirm adds "…and the seat is freed", and the archive confirm adds "…and you can restore it later". The Tax helper text is longer than the spec's one-liner. All read fine.
- The access-removed banner is one-shot: after a further reload it is gone. The spec doesn't say it must persist.
- During its open animation, the My hours dialog briefly fails axe colour-contrast (text mid-fade). The suite waits 700 ms before running axe. This is not a real contrast issue.

## Test cases by acceptance criterion

Status: **Pass**, **Fail (BUG-x)**, **Partial** (the real-stack test covers part; the rest is in unit or mocked tests), **N/T** (not tested here; reason given).

### §1 Permissions

| AC   | Test case                                                                                                                                                                                        | Test                                                                       | Status      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------- |
| P1.1 | FD/T get `403 FORBIDDEN` on settings, staff, timesheet, audit and export APIs and on `PATCH /api/shop`. Manager gets 403 on owner/manager actions                                                | PERM-01, MGR-02                                                            | Pass        |
| P1.2 | FD/T: no Settings in the main nav or the user menu. Each of `/settings`, `/settings/{general,tax,hours,staff,timesheets,audit}` shows "You don't have access to this page" + "Back to dashboard" | PERM-01 (×2 roles)                                                         | Pass        |
| P1.3 | `/api/me.permissions` drives the UI: manager sees 6 settings items; Invite/actions hidden where not allowed                                                                                      | PERM-02, MGR-01, PERM-01                                                   | Pass        |
| P1.4 | Role change applies to the next request without re-login; an open page that gets a 403 refetches `/me` and renders NoAccess                                                                      | PERM-03                                                                    | Pass        |
| P1.5 | Matrix snapshot + "OWNER has every key" tests exist                                                                                                                                              | inspection: `packages/contracts/src/permissions.test.ts` + `__snapshots__` | Pass (unit) |

### §2 Staff

| AC          | Test case                                                                                                                          | Test                                                          | Status                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| S1.1        | Rows show name/"—", email, role, status badge, last clock-in / "Never" / "Expires …"; "Clocked in now"                             | INV-01, SEAT-02, DEACT-01, screenshot `layout-1440-staff.png` | Pass                                  |
| S1.2        | Sort Active (O, M, FD, T) → Invited; default filter hides Deactivated                                                              | DEACT-01 (filter); sort checked visually in screenshot        | Partial (sort not asserted)           |
| S1.3        | Seat header "n of 5 users" + help text                                                                                             | SEAT-01/02, INV-01, INV-05                                    | Pass                                  |
| S2.1        | Invite → toast, Invited row, email queued → `SENT`, `invite.created` audited                                                       | INV-01                                                        | Pass                                  |
| S2.2        | Manager role picker = FD, T; API 403 for MANAGER/OWNER                                                                             | MGR-01, MGR-02, MGR-03                                        | Pass                                  |
| S2.3–2.5    | `ALREADY_MEMBER` (incl. own email), `MEMBER_DEACTIVATED`, `INVITE_PENDING` (case-insensitive)                                      | INV-07 (API)                                                  | Pass. UI copy covered by mocked suite |
| S2.6        | 5/5: Invite disabled + banner copy; API `403 SEAT_LIMIT_REACHED` with the same message; race with one seat left → one 201, one 403 | SEAT-01, SEAT-02, SEAT-03                                     | Pass                                  |
| S3.1        | Resend: new token (old link 404), new email, `invite.resent`; 2nd resend within a minute → 429                                     | INV-05                                                        | Pass                                  |
| S3.2        | Revoke: confirm copy, row gone from default filter, seat freed, link shows revoked copy, `invite.revoked`                          | INV-05                                                        | Pass                                  |
| S3.3        | Expired invite: "Expired on", doesn't count toward seats; resend re-checks seats (403 when full)                                   | SEAT-02                                                       | Pass                                  |
| S4.1        | Owner promotes manager → owner via dialog; `member.role_changed`                                                                   | OWN-03                                                        | Pass                                  |
| S4.2        | Manager can't change owner/manager or promote to manager (API 403, UI no actions)                                                  | MGR-01, MGR-02                                                | Pass                                  |
| S4.3        | Own row has no actions; API `403 CANNOT_CHANGE_SELF`                                                                               | OWN-01                                                        | Pass                                  |
| S4.4 / S5.4 | Two owners deactivate each other at once → one 200, one `409 LAST_OWNER`; exactly one active owner left                            | OWN-02                                                        | Pass                                  |
| S5.1        | Deactivate confirm copy; the person's very next action fails                                                                       | DEACT-01                                                      | Pass                                  |
| S5.2        | Open time entry closed, "Closed on deactivation", `time_entry.auto_closed`                                                         | DEACT-01                                                      | Pass                                  |
| S5.3        | Self-deactivate → `403 CANNOT_CHANGE_SELF`                                                                                         | OWN-01                                                        | Pass                                  |
| S5.5        | Fallback to the other active shop + banner                                                                                         | DEACT-02a (reload path), DEACT-02b (in-app path)              | **Fail (BUG-03)** on the in-app path  |
| S5.6        | Only membership deactivated → `/access-removed` page (not onboarding), `accessRemoved` set, settings URLs redirect                 | DEACT-01, DEACT-03                                            | Pass                                  |
| S5.7        | Reactivate keeps the same role; seat check (403 when full, OK after a revoke); `member.reactivated`                                | OWN-03, DEACT-04                                              | Pass                                  |
| Risk #1     | Deactivated user can't switch back (`POST /api/me/active-shop` → 403); `/invite/*` exempt from onboarding redirect                 | DEACT-01, INV-02                                              | Pass                                  |

### §3 Accepting an invite

| AC       | Test case                                                                                                                                              | Test                   | Status                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| A1.1     | Signed out: "Join {shop}", "{inviter} invited you…", Create account / I already have an account                                                        | INV-01                 | Pass                                                                                                     |
| A1.2     | Sign-up has the invite email prefilled + readonly; returns to the invite                                                                               | INV-01                 | Pass                                                                                                     |
| A1.3     | Sign-in prefilled (editable), "Sign in to join {shop}", returns to the invite                                                                          | INV-02                 | Pass                                                                                                     |
| A1.4     | Join → membership with the invited role, active shop switched, `emailVerified=true`, `invite.accepted`, lands on `/` with "Welcome to {shop}"          | INV-01                 | Pass                                                                                                     |
| A1.5     | Signed-in user with no shop stays on `/invite/…`                                                                                                       | INV-02                 | Pass                                                                                                     |
| A2.1     | Expired copy with the inviter's name, no Join                                                                                                          | SEAT-02                | Pass                                                                                                     |
| A2.2     | Revoked copy                                                                                                                                           | INV-05                 | Pass                                                                                                     |
| A2.3     | Accepted by me: "You've already joined {shop}" + "Go to {shop}"                                                                                        | INV-02                 | Pass                                                                                                     |
| A2.4     | Unknown/malformed/rotated token: one generic "This invite link isn't valid." (preview API 404)                                                         | INV-06, INV-04, INV-05 | Pass                                                                                                     |
| A2.5     | Wrong account: mismatch copy, no Join, API `403 INVITE_EMAIL_MISMATCH`, invite stays pending, "Sign out and continue" returns to the invite signed out | INV-03                 | Pass                                                                                                     |
| A2.6     | Already an active member → accept just switches                                                                                                        | not tested             | N/T (needs a member to receive a second invite, which `ALREADY_MEMBER` prevents; only reachable by race) |
| A3.1–3.2 | Switch shop from the user menu (radio, current checked); nav, role permissions, currency/timezone follow                                               | SW-01                  | Pass                                                                                                     |
| A3.3     | Deactivated memberships not listed; switching to them → 403                                                                                            | DEACT-02a, DEACT-01    | Pass                                                                                                     |
| A3.4     | "Create a new shop" → `/onboarding?new=1` "Set up another shop"                                                                                        | CAP-01                 | Pass                                                                                                     |
| A3.5     | Clocked in at A doesn't affect B's top-bar clock                                                                                                       | SW-01                  | Pass                                                                                                     |

### §4 Shop settings

| AC               | Test case                                                                                                                                                                                  | Test                                                  | Status            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------- |
| SP1.1 US         | ZIP `1234` rejected, `10001-1234` OK; phone `(212) 555-0142` → `+12125550142`, shown national; State select; audit `shop.updated` with **only** the changed fields                         | PROF-US                                               | Pass              |
| SP1.1 GB         | `nope` rejected; `sw1a1aa` → `SW1A 1AA`; `07911 123456` → `+447911123456`; `020 7946 0018` → `+442079460018`; County free text; "Town/City" label                                          | PROF-GB                                               | Pass              |
| SP1.1 GB example | `07700 900123` accepted (story example)                                                                                                                                                    | PROF-GB-2                                             | **Fail (BUG-04)** |
| SP1.1 PK         | `5400` rejected, `54000` OK; Province list (7, in order); `0300 1234567` → `+923001234567`; `042 35761234` → `+924235761234`; `12345` rejected                                             | PROF-PK                                               | Pass              |
| SP1.1 API        | Server rejects wrong-market postcode/region/timezone, bad phone, 1-char name                                                                                                               | PROF-API                                              | Pass              |
| SP1.2            | Country/currency read-only with the reason text; `PATCH {country,currency}` → 400 and unchanged                                                                                            | PROF-US                                               | Pass              |
| SP1.3            | Time zone change asks "Times on tickets… shown in {zone}. Recorded times don't change."; GB/PK show "has one time zone"                                                                    | PROF-US, PROF-GB                                      | Pass              |
| SP1.4            | Manager can edit the profile                                                                                                                                                               | Manager reaches General (PERM-02); edit not exercised | Partial           |
| TX1.1            | Prices-include-tax switch with confirm → saved, `shop.tax_settings_updated`                                                                                                                | TAX-01                                                | Pass              |
| TX1.2            | Rows: name, rate %, applies to, default badges; archived behind "Show archived"                                                                                                            | TAX-01                                                | Pass              |
| TX1.3            | Add 8.875% goods rate (`rateMilliPct` 8875); "8.8755" and "100.5" rejected; duplicate name (case-insensitive) rejected                                                                     | TAX-01                                                | Pass              |
| TX1.4            | Edit dialog note "Changes apply to new sales only…"; 8.875 → 8.5                                                                                                                           | TAX-01                                                | Pass              |
| TX1.5            | Archive (confirm) hides; Show archived shows the "Archived" badge; Restore                                                                                                                 | TAX-01                                                | Pass              |
| TX1.6 / D1       | Goods default moves; services default unchanged; goods rate not offered as services default (API refuses); PK defaults GST 18% goods + 16% services; an "All" rate can be default for both | TAX-01, TAX-03                                        | Pass              |
| TX1.7            | Archive a default → "Choose another default first."; only rate → 409; 0% US rate valid                                                                                                     | TAX-01, TAX-02                                        | Pass              |
| BH1.1            | US order Sun→Sat with 12h display; GB order Mon→Sun with 24h                                                                                                                               | HRS-01, HRS-02                                        | Pass              |
| BH1.2            | Defaults Mon–Sat 10:00–19:00, Sunday closed                                                                                                                                                | HRS-01, HRS-02                                        | Pass              |
| BH1.3            | Closes ≤ opens → "Closing time must be after opening time"; save toast; `shop.hours_updated`; API rejects closes ≤ opens and non-15-min steps                                              | HRS-01, HRS-02                                        | Pass              |
| BH1.4            | "Copy Monday to all weekdays" fills Tue–Fri only                                                                                                                                           | HRS-01                                                | Pass              |

### §5 Clock in/out and timesheets

| AC        | Test case                                                                                                                                                                                                   | Test                                                      | Status                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| C1.1      | Top-bar "Clock in" → "Clocked in 0m"                                                                                                                                                                        | CLK-01                                                    | Pass (per-minute tick not observed)                  |
| C1.2      | Clock out → toast "Clocked out. … today."                                                                                                                                                                   | CLK-01                                                    | Pass                                                 |
| C1.3      | Second clock-in → `409 ALREADY_CLOCKED_IN`; clock-out with none open → `409 NOT_CLOCKED_IN`                                                                                                                 | CLK-01                                                    | Pass (UI reaction to 409 is in the mocked suite)     |
| C1.4      | Open entry > 14h → "Still clocked in since …" + "Clock out and ask a manager to fix the time."                                                                                                              | FLAG-01                                                   | Pass                                                 |
| C1.5      | My hours dialog (This week / Last week)                                                                                                                                                                     | CLK-01                                                    | Pass                                                 |
| C2.1      | Timesheets default range this week Mon–Sun in shop tz; staff filter                                                                                                                                         | screenshot `layout-1024-timesheets.png` (Nov 23 – Nov 29) | Partial (presets and staff filter not exercised)     |
| C2.2      | Per-person total "8h 0m"; days and entries                                                                                                                                                                  | CLK-02                                                    | Pass                                                 |
| C2.3      | Entry belongs to the day it started; overnight not split                                                                                                                                                    | not tested                                                | N/T (covered by API unit tests; needs clock control) |
| C2.4      | "Long shift" / "Still open" flags + "Needs review (1)"                                                                                                                                                      | FLAG-01                                                   | Pass                                                 |
| C2.5      | "Edited" marker after a fix                                                                                                                                                                                 | CLK-01                                                    | Pass                                                 |
| C3.1      | Fix times: reason required (min 3), saved, `time_entry.updated`; audit drawer shows Clock in Before/After and the reason                                                                                    | CLK-01                                                    | Pass                                                 |
| C3.2      | Add a missing entry (`time_entry.created`); delete with reason (`time_entry.deleted`)                                                                                                                       | CLK-02                                                    | Pass                                                 |
| C3.3      | Close someone's open entry by setting clock-out                                                                                                                                                             | not tested                                                | N/T                                                  |
| C3.4      | Overlap → `409 TIME_ENTRY_OVERLAP`; future → 400; > 24h → 4xx                                                                                                                                               | CLK-02                                                    | Pass                                                 |
| C3.5 / D5 | Manager can't fix own (403), can fix a technician's; owner can fix the manager's                                                                                                                            | CLK-03                                                    | Pass                                                 |
| C4.1–4.3  | CSV: filename `timesheet-{slug}-{from}-{to}.csv`, UTF-8 BOM, exact header, `HH:mm`/`YYYY-MM-DD` shop time, 2-dp hours; `=`-leading name and reason neutralised with `'` and quoted; embedded quotes doubled | CLK-01                                                    | Pass                                                 |
| C4.4      | `timesheet.exported` audited on export                                                                                                                                                                      | CLK-01 (yes); AUD-03 (also written on mere page view)     | **Fail (BUG-02)**                                    |

### §6 Audit log

| AC           | Test case                                                                                                                                                                                                                                                                                                                                         | Test                                                                         | Status                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| AU1.1        | Newest first; who/action/entity columns                                                                                                                                                                                                                                                                                                           | AUD-01, CLK-01                                                               | Pass                                                  |
| AU1.2        | Action-group filter ("All staff & invites") narrows the list                                                                                                                                                                                                                                                                                      | AUD-01                                                                       | Pass (date/user filters and pagination not exercised) |
| AU1.3        | Drawer diff: created event shows After only (Email, Role "Front desk"); time-entry fix shows Before/After                                                                                                                                                                                                                                         | AUD-01, CLK-01                                                               | Pass                                                  |
| AU1.4        | No PATCH/PUT/DELETE on `/api/audit-events/:id`; `repairos_app` gets "permission denied" on UPDATE/DELETE `audit_logs`                                                                                                                                                                                                                             | AUD-01, AUD-02                                                               | Pass                                                  |
| AU1.5        | Manager sees the owner's events                                                                                                                                                                                                                                                                                                                   | AUD-01                                                                       | Pass                                                  |
| Action table | Seen in real runs: shop.updated, shop.tax_settings_updated, shop.hours_updated, tax_rate.created/updated/default_changed/archived/restored, invite.created/resent/revoked/link_copied/accepted, member.role_changed/deactivated/reactivated, time_entry.created/updated/deleted/auto_closed, timesheet.exported. Tokens absent from audit details | INV-01, INV-04, INV-05, OWN-03, DEACT-01, TAX-01, HRS-01, PROF-US, CLK-01/02 | Pass                                                  |

### §7 Shop cap, §8 Email, decisions

| AC          | Test case                                                                                                                                         | Test                                | Status                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| SC1.1 / 1.4 | Third owned shop via the UI succeeds; at 3 the menu item is disabled; fourth via onboarding shows the contract copy; API `403 SHOP_LIMIT_REACHED` | CAP-01                              | Pass                                                                                  |
| SC1.3       | Staff memberships don't count; a shop where the user is a deactivated owner doesn't count                                                         | CAP-01, CAP-02                      | Pass                                                                                  |
| SC1.2       | 5 shops/hour → 429                                                                                                                                | not tested                          | N/T (QA env raises `SHOP_CREATE_PER_HOUR` so reruns don't trip the in-memory limiter) |
| E1.1–1.2    | Subject, body lines, Accept link `{APP_URL}/invite/{token}`, expiry line, "If you weren't expecting this…", HTML has "Accept invite"              | INV-01                              | Pass                                                                                  |
| E1.3        | Reply-To = inviter; From contains RepairOS                                                                                                        | INV-01 (outbox file envelope)       | Pass                                                                                  |
| E1.4        | Queued via worker; `inviteEmailStatus` → SENT                                                                                                     | INV-01                              | Pass (FAILED path not tested)                                                         |
| E1.5        | Token never in logs or audit                                                                                                                      | INV-01 (audit: pass); SEC-01 (logs) | **Fail (BUG-01)**                                                                     |
| D4          | Forgot password → outbox link → reset → old password fails, new works, link single-use; unknown email same answer, no email                       | PWD-01, PWD-02                      | Pass                                                                                  |
| D6          | `/dev/outbox` lists and renders emails, links open in the tab                                                                                     | INV-01, PWD-01                      | Pass (prod refusal without `RESEND_API_KEY` not tested)                               |
| D7          | Emailed link → `emailVerified=true`; copied link → stays false                                                                                    | INV-01, INV-04                      | Pass                                                                                  |
| D10         | Copy link: clipboard + dialog, new link replaces the emailed one (old 404), `invite.link_copied` audited                                          | INV-04                              | Pass                                                                                  |

### Tenant isolation (CLAUDE.md rule 2)

| Test case                                                                                                                                                                                                                                                                                                                                                                  | Test   | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| PK owner, signed in, uses real US ids: audit detail, edit/archive tax rate, change role, deactivate, revoke/link/resend invite, fix/delete time entry, add an entry for a US user → **404** each; switch active shop to US → **403**; `x-shop-id` header and a US `userId` filter return only PK data; US rows unchanged; PK owner's Staff and Audit pages show no US data | ISO-01 | Pass   |
| Invite token for shop A can't be used by another account (email match)                                                                                                                                                                                                                                                                                                     | INV-03 | Pass   |

### Accessibility and layout

| Test case                                                                                                                                                                                                                                                                                         | Test                                          | Status                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| axe (WCAG 2.0/2.1 A+AA via `@axe-core/playwright` 4.11.0) on General, Tax, Business hours, Staff, Timesheets, Audit log, Invite dialog, Audit drawer, My hours, `/invite/<token>`, `/sign-up?invite=`, `/forgot-password`, `/reset-password`, invalid invite, `/access-removed`: **0 violations** | A11Y-settings-1440, A11Y-dialogs, A11Y-public | Pass                      |
| One h1 per settings page; labelled "Settings" nav                                                                                                                                                                                                                                                 | A11Y-settings-1024/1440                       | Pass                      |
| No horizontal page scroll at 1024 and 1440 on settings and public pages                                                                                                                                                                                                                           | A11Y-settings-1024/1440, A11Y-public          | Pass                      |
| Staff table readable at 1024                                                                                                                                                                                                                                                                      | LAYOUT-1024                                   | **Fail (BUG-05)**         |
| Day-specific names for hours pickers; clock button name                                                                                                                                                                                                                                           | A11Y-names-hours, A11Y-names-clock            | **Fail (BUG-06, BUG-07)** |

## Not tested, and why

- **axe on `/dev/outbox`:** each email renders in a sandboxed `srcdoc` iframe (no scripts), which axe can't enter. The page is dev-only.
- **A2.6** (accepting while already an active member): not reachable without a race, because invite creation refuses members.
- **C2.3 / DST / overnight day boundaries, C3.3, timesheet presets, audit pagination and date/user filters, the per-minute clock tick:** they need clock control or large data sets. The API unit tests and the mocked e2e suite cover them.
- **SC1.2** (5 shops per hour) and invite rate limits (20/day/shop): the limits are in-memory per API process, so reruns against a long-lived API would trip them. The QA env raises `SHOP_CREATE_PER_HOUR`.
- **E1.4 FAILED path / "Email failed. Resend"**, **D6 production start-up refusal:** they need a failing provider or a production start. Out of scope for this suite.
- **Mobile ≤ 900px** (TabList settings nav, icon-only clock): only 1024 and 1440 were in scope.
