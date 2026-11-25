# Sprint 1: Shop & people

**Goal:** a shop owner can set up the shop properly (profile, tax, hours), invite staff, control what each role can do, track who is clocked in, and see who changed what.

**Already done in Sprint 0 (not repeated here):** sign-up, sign-in, onboarding wizard that creates a shop with market defaults (currency, locale, timezone, tax rates, prices-include-tax), caller becomes OWNER, sessions carry `activeShopId`, `AuditLog` table, `shop.created` audit event, `GET /api/me`, `POST /api/me/active-shop`, auth rate limits.

**Deferred from the ROADMAP line for this sprint:** the **logo upload moves to Sprint 3**, where photo/attachment storage (R2) is built. Settings shows no logo field in Sprint 1; receipts are not printed until Sprint 3, so nothing is lost.

Roles used below: **O** = Owner, **M** = Manager, **FD** = Front desk, **T** = Technician.

Conventions for every area:
- All timestamps are stored in UTC and shown in the **shop's** timezone, in the shop's locale (`en-US` MM/DD/YYYY, `en-GB` DD/MM/YYYY).
- Emails are trimmed and compared lower-cased; max 254 characters; must pass the same email check as sign-up.
- Every error uses the existing `ApiError` shape. New error `code`s are listed per area.
- API paths are suggestions for the backend engineer, not a binding contract. Contracts (Zod) land in `packages/contracts` first.

---

## 1. Permissions model

### Decision
One fixed **role × permission matrix** in `packages/contracts` (e.g. `permissions.ts`): a `Permission` enum and `ROLE_PERMISSIONS: Record<Role, Permission[]>`, plus a pure helper `can(role, permission)`. The API guard and the web UI both read it; nothing else decides access. The matrix is **not editable per shop in the MVP** (custom roles/permissions are out of scope).

Some rules cannot be expressed as a flat permission (who may manage whom, "not yourself"). Those live next to the matrix as pure functions in contracts too, e.g. `manageableRoles(actorRole)`: O → all four roles, M → FD and T, others → none.

`GET /api/me` adds `permissions: Permission[]` for the active shop so the UI never re-derives it from the role.

### Matrix (defaults)
✓ = granted, — = not granted. **S1** = enforced in Sprint 1; the sprint number otherwise says when it starts being enforced.

| Key | What it allows | O | M | FD | T | Enforced |
|---|---|---|---|---|---|---|
| `settings.view` | Open Settings; read shop profile, tax, hours | ✓ | ✓ | — | — | S1 |
| `settings.manage` | Edit shop profile and business hours | ✓ | ✓ | — | — | S1 |
| `tax.manage` | Prices-include-tax toggle, add/edit/archive tax rates, defaults | ✓ | ✓ | — | — | S1 |
| `staff.view` | See the staff list and pending invites | ✓ | ✓ | — | — | S1 |
| `staff.manage` | Invite, resend/revoke, change role, deactivate/reactivate (limited by `manageableRoles`) | ✓ | ✓ | — | — | S1 |
| `timeclock.self` | Clock self in/out, see own entries | ✓ | ✓ | ✓ | ✓ | S1 |
| `timesheet.view` | Timesheets for all staff | ✓ | ✓ | — | — | S1 |
| `timesheet.edit` | Fix/add/delete time entries (with reason) | ✓ | ✓ | — | — | S1 |
| `timesheet.export` | CSV export of timesheets | ✓ | ✓ | — | — | S1 |
| `audit.view` | Audit log viewer | ✓ | ✓ | — | — | S1 |
| `billing.manage` | Subscription, seats, invoices, SMS bundles | ✓ | — | — | — | S6 |
| `shop.delete` | Close/delete the shop | ✓ | — | — | — | later |
| `statuses.manage` | Configure ticket status labels | ✓ | ✓ | — | — | S2 |
| `tickets.view` | See tickets (all tickets; small shops share one queue) | ✓ | ✓ | ✓ | ✓ | S2 |
| `tickets.create` | Check in a device | ✓ | ✓ | ✓ | — | S2 |
| `tickets.edit` | Edit ticket details, notes, status, assignment | ✓ | ✓ | ✓ | ✓ | S2 |
| `tickets.cancel` | Cancel a ticket | ✓ | ✓ | ✓ | — | S2 |
| `tickets.view_passcode` | Reveal a stored device passcode (audited) | ✓ | ✓ | ✓ | ✓ | S2 |
| `customers.view` | See customers and devices | ✓ | ✓ | ✓ | ✓ | S2 |
| `customers.manage` | Create/edit customers and devices | ✓ | ✓ | ✓ | — | S2 |
| `customers.export_delete` | GDPR export / delete a customer | ✓ | ✓ | — | — | S2 |
| `pricelist.manage` | Edit services/price list | ✓ | ✓ | — | — | S3 |
| `notifications.manage` | Edit SMS/email templates | ✓ | ✓ | — | — | S3 |
| `inventory.view` | See products and stock (no cost price) | ✓ | ✓ | ✓ | ✓ | S4 |
| `inventory.view_cost` | See cost price and stock value | ✓ | ✓ | — | — | S4 |
| `inventory.manage` | Create/edit products, CSV import | ✓ | ✓ | — | — | S4 |
| `inventory.adjust` | Stock adjustments with reason | ✓ | ✓ | — | — | S4 |
| `inventory.use_parts` | Add parts to a ticket (creates stock movement) | ✓ | ✓ | ✓ | ✓ | S4 |
| `purchasing.manage` | Suppliers, purchase orders, receiving | ✓ | ✓ | — | — | S4 |
| `pos.sell` | Check out tickets/retail, take payment | ✓ | ✓ | ✓ | — | S5 |
| `pos.discount` | Apply discounts | ✓ | ✓ | — | — | S5 |
| `pos.refund` | Issue refunds | ✓ | ✓ | — | — | S5 |
| `register.operate` | Open/close the register, cash count | ✓ | ✓ | ✓ | — | S5 |
| `reports.view` | Sales, tax, technician and inventory reports | ✓ | ✓ | — | — | S6 |
| `reports.export` | CSV export of reports | ✓ | ✓ | — | — | S6 |
| `data.import` | CSV import of customers/products | ✓ | ✓ | — | — | S4 |

Owner has every key, including any key added later (the helper treats OWNER as "all", and a contracts test asserts it).

### Stories
**P1. As an owner, I want each role to see and do only what it should, so that staff cannot change settings or money they are not responsible for.**
1. Given the matrix in contracts, When the API handles a request for a protected route, Then it checks the route's required permission for the caller's role in the active shop and returns `403 FORBIDDEN` ("Your role does not allow this action") if missing.
2. Given a Front desk or Technician user, When they load the app, Then the Settings nav item and Settings pages are hidden, and opening a Settings URL directly shows a "You don't have access to this page" state (not a crash, not a blank page).
3. Given any user, When `GET /api/me` responds, Then it includes `permissions` for the active shop, and the UI hides buttons whose permission is missing.
4. Given a role change for a user, When that user makes their next request, Then the new permissions apply (membership is re-read per request). The web app refetches `/api/me` on any 403 and on window focus.
5. Given the contracts package, When tests run, Then a snapshot test of the matrix exists (any change is a deliberate, reviewed diff), and a test asserts OWNER has every key.

### Edge cases
- Route with no declared permission: the guard must fail closed in non-public controllers (a lint/test checks every route declares `@Public()` or a permission).
- Replace the Sprint 0 `@Roles(...)` decorator with `@RequirePermission(...)`; keep one mechanism.

### Out of scope
Custom roles, per-shop permission toggles, per-user overrides, discount limits by role, "only my assigned tickets" for technicians.

---

## 2. Staff management

### Stories
**S1. As an owner or manager, I want to see everyone who works in my shop, so that I know who has access.**
1. Given I have `staff.view`, When I open Settings → Staff, Then I see one row per member and per pending invite with: name (invites: "—"), email, role, status (**Active**, **Invited**, **Deactivated**), last clock-in (shop time; "Clocked in now" badge if an entry is open; "Never").
2. Given the list, Then it is sorted Active first (Owners, Managers, Front desk, Technicians, then by name), then Invited, then Deactivated, and I can filter by status (default: Active + Invited).
3. Given the list, Then a header shows seats: "4 of 5 users" with help text "Active users and pending invites count toward your plan."

**S2. As an owner or manager, I want to invite a person by email with a role, so that they can join the shop.**
1. Given I have `staff.manage` and seats are available, When I submit an email and a role I am allowed to assign, Then an invite is created (status Invited, expires in 7 days), an email is queued (see §8), the row appears in the list, and `invite.created` is audited.
2. Given I am a Manager, When I open the role selector, Then only Front desk and Technician are offered; the API rejects any other role with `403 FORBIDDEN`.
3. Given the email belongs to an **active** member, Then error `ALREADY_MEMBER` "{email} is already on your team."
4. Given the email belongs to a **deactivated** member, Then error `MEMBER_DEACTIVATED` "{name} was deactivated. Reactivate them instead." with a link to the row.
5. Given a **pending** invite exists for the email, Then error `INVITE_PENDING` "An invite was already sent to {email}." with a "Resend" action.
6. Given active members + pending invites = 5, When I try to invite, Then the Invite button is disabled with the message **"Your plan includes 5 users. Extra users are $5/month; billing arrives later."** and the API returns `403 SEAT_LIMIT_REACHED` with the same message.

**S3. As an owner or manager, I want to resend or revoke an invite, so that I can fix a lost email or a mistake.**
1. Given a pending or expired invite I may manage, When I click Resend, Then a **new** token is generated (the old link stops working), expiry resets to 7 days from now, the email is sent again, and `invite.resent` is audited.
2. Given a pending invite, When I click Revoke and confirm, Then the invite becomes Revoked, its link shows the revoked state, it no longer counts toward seats, and `invite.revoked` is audited. Revoked invites disappear from the default list filter.
3. Given an expired invite, Then it shows "Expired on {date}" with Resend and Remove (= revoke). Expired invites **do not** count toward seats. Resending an expired invite re-checks the seat limit.

**S4. As an owner or manager, I want to change a staff member's role, so that access matches their job.**
1. Given a member whose current and new role are both in my `manageableRoles`, When I change the role, Then it is saved, applies on their next request, and `member.role_changed` is audited (before/after role).
2. Given I am a Manager, Then I cannot change anyone who is or would become an Owner or Manager (UI hides the action; API `403`).
3. Given the target is me, Then the action is not offered and the API returns `403 CANNOT_CHANGE_SELF` "You can't change your own role."
4. Given the target is the **last active Owner**, When anyone tries to demote them, Then `409 LAST_OWNER` "A shop needs at least one active owner." (Owners can't demote themselves anyway, so this only arises under concurrency; the check runs inside the write transaction.)

**S5. As an owner or manager, I want to deactivate someone who left, so that they lose access at once without losing their history.**
1. Given a member I may manage who is not me, When I deactivate and confirm ("{name} will lose access to {shop} immediately."), Then status becomes Deactivated, `member.deactivated` is audited, and their **very next** request for this shop is rejected (see 5–6).
2. Given they had an open time entry, Then it is closed at the deactivation time, marked "Closed on deactivation", and `time_entry.auto_closed` is audited.
3. Given the target is me, Then `403 CANNOT_CHANGE_SELF` "You can't deactivate yourself."
4. Given the target is the last active Owner, Then `409 LAST_OWNER`.
5. Given a deactivated user whose session's active shop is that shop, When they make any API request, Then the guard does **not** treat them as a member: it falls back to their oldest **active** membership in another shop (if any) and the UI lands on that shop's dashboard with a banner "You no longer have access to {shop}."
6. Given a deactivated user with **no other active membership**, Then `/api/me` returns `activeShop: null` plus a flag (e.g. `accessRemoved: true`), and the web app shows a "You no longer have access to {shop}" page with Sign out and "Create your own shop" — **not** silent redirect to onboarding.
7. Given a deactivated member, When an Owner/Manager who may manage their role clicks Reactivate, Then the seat limit is checked, status becomes Active with the **same role**, and `member.reactivated` is audited.

### Rules (summary, enforced in the API inside one transaction)
- At least one ACTIVE OWNER at all times (role change, deactivation).
- Only an Owner can invite, promote to, demote from, deactivate or reactivate an Owner. (Promoting a Manager to Manager-level is also Owner-only, since `manageableRoles(M)` = FD, T.)
- Nobody changes their own role or deactivates themselves. **Leaving a shop / transferring ownership:** an Owner promotes another person to Owner, who can then change the first one. No separate "transfer" flow.
- Seats: `count(ACTIVE memberships) + count(PENDING, unexpired invites) ≤ 5`. Checked on invite create, invite resend (if expired), reactivate. Accepting an invite never fails on seats (it already holds a seat). Applies during the trial too. No billing.

### Edge cases
- Two Owners demote/deactivate each other at the same moment: the row-locked count check lets one succeed, the other gets `LAST_OWNER`.
- Two managers invite the same email at once: unique constraint on (shopId, lower(email)) for PENDING invites; the loser gets `INVITE_PENDING`.
- Seat race (two invites at once with 1 seat left): seat count checked under a shop-level lock; one gets `SEAT_LIMIT_REACHED`.
- Inviting your own email: `ALREADY_MEMBER`.
- User is a member of shop A and invited to shop B: normal; they get a second membership.
- Role changed while the user has a page open: the next action may 403; the web app refetches `/api/me` and re-renders.
- A deactivated user still has a valid session cookie: the session stays valid for other shops; only this shop is rejected (we do not sign them out globally).
- Staff name and email come from the user account; editing other people's names/emails is not possible (out of scope).

### Data
**Membership** (add): `status` enum `ACTIVE | DEACTIVATED` (default ACTIVE), `deactivatedAt?`, `deactivatedByUserId?`. Existing rows migrate to ACTIVE.

**Invitation** (new tenant table, needs isolation test): `id`, `shopId`, `email` (lower-cased, ≤254), `role` (Role), `tokenHash` (SHA-256 of a 32-byte random base64url token; plaintext token is never stored or logged), `status` `PENDING | ACCEPTED | REVOKED` (expired = PENDING and `expiresAt < now`, derived), `expiresAt` (created/resent + 7 days), `invitedByUserId`, `lastSentAt`, `sendCount`, `emailStatus` `QUEUED | SENT | FAILED`, `acceptedAt?`, `acceptedByUserId?`, `revokedAt?`, `revokedByUserId?`, `createdAt`, `updatedAt`. Unique partial index: one PENDING invite per (shopId, email).

Input `CreateInviteInput`: `email` (required, valid, ≤254), `role` (Role, must be in `manageableRoles(actor)`).

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/staff` | Members + invites, with status, last clock-in, and `seats: { used, included: 5 }` | `staff.view` |
| `POST /api/staff/invites` | Create invite and queue email | `staff.manage` |
| `POST /api/staff/invites/:id/resend` | New token, new expiry, re-send | `staff.manage` |
| `POST /api/staff/invites/:id/revoke` | Revoke | `staff.manage` |
| `PATCH /api/staff/:membershipId/role` | Change role | `staff.manage` |
| `POST /api/staff/:membershipId/deactivate` | Deactivate (closes open time entry) | `staff.manage` |
| `POST /api/staff/:membershipId/reactivate` | Reactivate (seat check) | `staff.manage` |

Rate limits: invites created ≤ 20 per shop per day; resend ≤ 1 per minute and ≤ 5 per day per invite (`429 RATE_LIMITED`).

### Screens
- **Settings → Staff** (table): seat counter; "Invite staff" primary button (disabled + message at limit); status filter; row actions menu per row (Change role, Deactivate / Reactivate, Resend, Revoke) showing only allowed actions; "You" tag on own row with no actions. States: loading (skeleton rows), only-me empty state ("You're the only one here. Invite your team."), error with Try again.
- **Invite dialog**: Email, Role (`Selector` limited to allowed roles) with one-line role descriptions; seat note; inline field errors; success toast "Invite sent to {email}".
- **Change role dialog**, **Deactivate confirm dialog** (destructive), **Revoke confirm dialog**.
- Invite row shows "Email failed. Resend" when `emailStatus = FAILED`.

### Out of scope
Billing for extra seats, custom seat counts, editing staff names/emails, removing (hard-deleting) members, transfer-ownership wizard, bulk invite/CSV, SSO, 2FA, per-location assignment, PIN/fast user switching on a shared counter device.

---

## 3. Accepting an invite

### Decision: the invite link is the email-ownership proof (resolves BACKLOG "Require email verification before staff invites attach memberships")
The BACKLOG worry is: someone signs up first as `alex@shop.com` (no verification) and inherits Alex's invite. In this design that cannot happen, because **accepting requires the secret token from the email**, not just a matching account email. To accept, a person must both (a) hold the link sent to `alex@shop.com` and (b) be signed in to an account whose email is `alex@shop.com`. Holding the link proves they can read that inbox, which is exactly what a verification email proves. So we don't need a separate verification step for invites, and on a successful accept we set `user.emailVerified = true` for that account.

**Remaining risks (accepted for MVP):**
- **Leaked or forwarded link:** anyone with the link *and* an account under that email can join. Since the account must use the invited email, a forwarded link is only useful to someone who controls that address. Mitigations: 7-day expiry, single use, token stored hashed, revocable, Resend rotates the token, owners see "accepted" in the staff list and audit log, and deactivation is instant.
- **Squatted account:** an attacker pre-registers `alex@shop.com`. They still can't join (no link), but the real Alex can't sign in either and there is no password reset yet. Result is a lockout, not a data leak. See tech-lead decision D4.
- **Link scanners / previews:** corporate mail scanners may open the link. Opening only shows the invite; accepting requires a signed-in user to click "Join", so a scanner cannot accept.
- General sign-up email verification (for shop creators) is still not required; that is unchanged from Sprint 0 and not needed for tenant safety.

### Stories
**A1. As an invited person, I want the email link to take me straight into the shop, so that joining takes a minute.**
1. Given a valid pending invite and I am signed out, When I open `/invite/<token>`, Then I see "{Inviter} invited you to join **{Shop}** as {Role}" and two options: "Create account" and "I already have an account".
2. Given I choose Create account, Then the sign-up form shows the invite email **prefilled and read-only**; after sign-up I return to `/invite/<token>`.
3. Given I choose sign in, Then the sign-in form has the email prefilled (editable); after sign-in I return to `/invite/<token>`.
4. Given I am signed in as the invited email (case-insensitive exact match after trim), When I click "Join {Shop}", Then in one transaction the invite becomes ACCEPTED, an ACTIVE membership with the invite's role is created, my `emailVerified` is set to true, my session's active shop becomes this shop, `invite.accepted` is audited, and I land on the dashboard with a toast "Welcome to {Shop}".
5. Given the `/invite/*` route, Then the Sprint 0 redirect rules do **not** send a signed-in user with no shop to `/onboarding` while on this page.

**A2. As an invited person, I want clear messages when the link can't be used, so that I know what to do.**
1. **Expired:** "This invite expired on {date}. Ask {inviter} to send a new one." (No accept button.)
2. **Revoked:** "This invite is no longer valid. Ask the shop for a new invite." (Do not say who revoked it.)
3. **Already accepted by me:** "You've already joined {Shop}." with "Go to {Shop}" (switches active shop).
4. **Already accepted by someone else / unknown token / malformed token:** one generic page "This invite link isn't valid." (no shop details, so tokens can't be probed).
5. **Wrong account:** signed in as `b@x.com`, invite is for `a@y.com`: "This invite is for a@y.com, but you're signed in as b@x.com." with "Sign out and continue" (returns to the invite page signed out). The API returns `403 INVITE_EMAIL_MISMATCH`; the invite is unchanged.
6. **Already an active member of that shop** (e.g. invited, then joined through another route): accept marks the invite ACCEPTED and just switches to the shop.

**A3. As someone who works at two shops, I want to switch shops from the user menu, so that I can work in either.**
1. Given I have more than one ACTIVE membership, When I open the user menu, Then I see "Switch shop" with each shop name and my role there, the current one checked.
2. When I pick another shop, Then `POST /api/me/active-shop` is called, the app reloads to that shop's dashboard, and everything (nav, permissions, currency, timezone) reflects the new shop.
3. Deactivated memberships are not listed. Switching to a shop where I'm deactivated returns `403`.
4. The menu also shows "Create a new shop" (→ onboarding), subject to the cap in §7.
5. Being clocked in at shop A does not affect shop B; the top-bar clock shows the active shop's state only.

### Data
No new tables beyond Invitation. `User.emailVerified` set on accept. `/api/me`: `memberships` lists ACTIVE memberships only; add `permissions` (§1) and `accessRemoved` (§2 S5.6).

### API (suggested)
| Method + path | Purpose | Auth |
|---|---|---|
| `GET /api/invites/:token` | Preview: status, shop name, inviter name, role, invite email, expiry. Generic 404 for unknown/used-by-other | Public, rate limited per IP (e.g. 30/min) |
| `POST /api/invites/:token/accept` | Accept (email match, status checks, membership, emailVerified, active shop) | Signed in |

### Screens
- **`/invite/[token]`** (same `login-card` frame as sign-in): states loading, valid signed out, valid signed in (match), wrong account, expired, revoked, already joined, invalid, accept in progress, accept error.
- **Sign-up / sign-in** variants with `?invite=<token>`: locked email on sign-up, a small "Joining {Shop}" note, return to invite page after success.
- **User menu**: "Switch shop" list, "Create a new shop".

### Out of scope
Magic-link sign-in, Google sign-in, inviting a phone number / WhatsApp invite, request-to-join, leaving a shop by yourself, invite links not tied to an email.

---

## 4. Shop settings

### 4.1 Profile
**SP1. As an owner or manager, I want to keep the shop's details correct, so that receipts, messages and times are right.**
1. Given `settings.manage`, When I edit and save the profile, Then fields validate as below, phone is stored as E.164, `shop.updated` is audited with only the changed fields in before/after, and a success toast shows.
2. Country and currency are shown as read-only with the note: "Country and currency can't be changed after the shop is created. All prices, tax and reports are recorded in {currency}; changing it would misstate past sales. To trade in another country, create a new shop."
3. Changing the timezone shows a confirm: "Times on tickets, timesheets and reports will be shown in {new zone}. Recorded times don't change." 
4. Manager can edit everything Owner can in profile (no Owner-only fields in Sprint 1).

| Field | Rules |
|---|---|
| Shop name | Required, trimmed, 2–80 chars |
| Phone | Optional, ≤32 chars input; must be a valid number per `libphonenumber-js` with the shop country as default region; stored E.164; shown in national format. Examples: US `(212) 555-0142` → `+12125550142`; UK `020 7946 0018` / `07911 123456` → `+44…`; PK mobile `0300 1234567` → `+923001234567`, PK landline `042 35761234` |
| Address line 1 | Optional, ≤120 |
| Address line 2 | Optional, ≤120 |
| City | Optional, ≤80 (labelled "Town/City" for GB) |
| Region | US: optional select of 50 states + DC (label "State"); GB: optional free text ≤80 (label "County"); PK: optional select Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu & Kashmir (label "Province") |
| Postcode | Optional. US label "ZIP code": `^\d{5}(-\d{4})?$`. GB label "Postcode": standard UK postcode pattern, stored upper-case with one space before the last 3 characters (`sw1a1aa` → `SW1A 1AA`). PK label "Postal code": `^\d{5}$` |
| Timezone | Required, IANA name from a per-country list. US: America/New_York (Eastern), America/Chicago (Central), America/Denver (Mountain), America/Phoenix (Arizona), America/Los_Angeles (Pacific), America/Anchorage (Alaska), Pacific/Honolulu (Hawaii). GB: Europe/London only. PK: Asia/Karachi only. Shown as "Eastern Time (New York)" etc. |
| Country, Currency | Read-only after creation |

Note: the `CreateShopInput` in contracts should adopt the same phone/postcode/region rules, so onboarding and settings agree.

### 4.2 Tax
**TX1. As an owner or manager, I want to set how tax works in my shop, so that prices and receipts are correct.**
1. Given `tax.manage`, When I toggle "Prices include tax" and confirm ("This changes how prices are entered and shown from now on. Past sales don't change."), Then it saves and `shop.tax_settings_updated` is audited.
2. Given the tax rates list, Then each row shows name, rate (%), applies to (All items / Goods (parts & accessories) / Services (labour)), Default badge(s), and Archived rates are hidden behind a "Show archived" toggle.
3. When I add a rate (name, rate, applies to), Then it is created and `tax_rate.created` is audited.
4. When I edit a rate, Then the dialog states "Changes apply to new sales only. Past invoices keep the rate they were charged at." and `tax_rate.updated` is audited.
5. When I archive a rate, Then it is hidden from pickers for new items/sales but kept for history; `tax_rate.archived` is audited. I can restore it (`tax_rate.restored`).
6. Given defaults, Then there is **one default rate for goods and one for services** (a rate that applies to All can be the default for both; a Goods rate can't be the services default and vice versa). Setting a default moves the badge and is audited (`tax_rate.default_changed`). New catalog items (Sprint 3–4) pick the default by their kind. *See decision D1.*
7. I cannot archive a rate that is currently a default (`409 TAX_RATE_IS_DEFAULT` "Choose another default first"), and the shop always has at least one active rate (`409 LAST_TAX_RATE`). A 0% rate is valid (US default).

**"Editing a rate never changes past records"**: enforced by snapshot, not by versioning: every invoice/ticket line (Sprints 3–5) stores the tax rate name and rate it was calculated with. Sprint 1 has no such lines yet; the story's job is to record this rule in contracts docs and in the tax-engine tests so later sprints honour it.

| Field | Rules |
|---|---|
| Name | Required, trimmed, 1–40 chars, unique among the shop's non-archived rates (case-insensitive) |
| Rate | Required, 0–100 %, **up to 3 decimal places** (US combined rates such as 8.875% exist). Input accepts "8.875" or "8.875%". *See decision D2: `rateBps` can't store 8.875%.* |
| Applies to | `all` / `goods` / `services` |
| Default for goods / services | Booleans per above rules |
| Archived | `archivedAt?` |

### 4.3 Business hours
**BH1. As an owner or manager, I want to set opening hours, so that receipts show them and booking/ARIA can use them later.**
1. Given `settings.manage`, When I open Business hours, Then I see Monday–Sunday (week starts Monday for GB/PK, Sunday for US display order), each with an Open/Closed switch and Opens/Closes time pickers.
2. Given a new shop, Then defaults are Mon–Sat 10:00–19:00, Sunday closed (owner adjusts). Existing Sprint 0 shops get the same defaults by migration.
3. When I save, Then times are validated (Closes after Opens, same day), and `shop.hours_updated` is audited (whole week before/after).
4. "Copy Monday to all weekdays" action fills Tue–Fri.

| Field | Rules |
|---|---|
| Per weekday (0–6) | `isOpen` boolean; when open: `opensAt`, `closesAt` as `HH:mm` 24h in shop local time, 15-minute steps, `closesAt > opensAt`. Display 12h for en-US, 24h for en-GB |

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/shop` | Profile + tax setting + hours | `settings.view` |
| `PATCH /api/shop` | Update profile fields (country/currency rejected) | `settings.manage` |
| `PATCH /api/shop/tax-settings` | Prices-include-tax toggle | `tax.manage` |
| `GET /api/shop/tax-rates?includeArchived=` | List rates | `settings.view` (pickers in later sprints will need a lighter read for all roles) |
| `POST /api/shop/tax-rates` | Add | `tax.manage` |
| `PATCH /api/shop/tax-rates/:id` | Edit / set default | `tax.manage` |
| `POST /api/shop/tax-rates/:id/archive` · `/restore` | Archive / restore | `tax.manage` |
| `PUT /api/shop/hours` | Replace the week | `settings.manage` |

### Screens
- **Settings layout**: secondary nav General · Tax · Business hours · Staff · Timesheets · Audit log (only items the user has permission for). Replaces the Sprint 0 "Coming in Sprint 1" placeholder.
- **General**: form with sections Shop details, Address, Region & time (country/currency read-only + reason). States: loading, saved, field errors, unsaved-changes guard on navigation, save error banner.
- **Tax**: prices-include-tax switch with explanation per market ("UK shops usually show prices including VAT"); rates table; add/edit dialog; archive confirm; show archived toggle.
- **Business hours**: 7 rows; closed rows collapse the pickers.

### Out of scope
Logo (Sprint 3), VAT number / NTN / STRN on invoices (with receipts, Sprint 3–5), receipt templates (Sprint 3), holiday closures and split hours (lunch breaks), multiple locations, compound/stacked taxes, tax-exempt customers, changing country/currency, deleting a shop.

---

## 5. Clock in / clock out

### Stories
**C1. As any staff member, I want to clock in and out from the top bar, so that my hours are recorded without paperwork.**
1. Given I am an active member with `timeclock.self` and not clocked in, When I click "Clock in" in the top bar, Then an entry opens at the server time and the button shows "Clocked in · 2h 14m" (updates each minute).
2. Given I'm clocked in, When I open it and click "Clock out", Then the entry closes at server time and a toast shows "Clocked out. 7h 52m today."
3. Given I'm already clocked in (e.g. another tab), When I try to clock in again, Then `409 ALREADY_CLOCKED_IN` and the UI refreshes to the clocked-in state. Same for clocking out with no open entry (`409 NOT_CLOCKED_IN`).
4. Given my open entry is older than 14h, Then the top bar shows a warning state "Still clocked in since {day time}. Clock out and ask a manager to fix the time."
5. I can see my own entries for the current and previous week (read-only) from the clock menu ("My hours").

**C2. As an owner or manager, I want a timesheet by staff and date range, so that I can check hours and pay people.**
1. Given `timesheet.view`, When I open Settings → Timesheets, Then I pick a date range (default: this week, Mon–Sun in shop timezone; presets This week, Last week, This month, Last month, Custom) and staff (default: all, includes deactivated people who have entries in range).
2. Then I see per staff: total hours for the range, and per day: entries (in/out times), daily total. Totals shown as `7h 52m` and decimal hours in export.
3. An entry belongs to the **shop-local day it started on**. An overnight entry is not split.
4. Entries longer than **14h** and entries still open after the shop's day ended are flagged ("Long shift", "Still open") and counted in a "Needs review" filter.
5. Edited entries show an "Edited" marker; hovering/opening shows who, when and reason.

**C3. As an owner or manager, I want to fix a wrong entry, so that the timesheet is accurate.**
1. Given `timesheet.edit`, When I edit an entry's clock-in and/or clock-out with a **required reason** (3–200 chars), Then it saves and `time_entry.updated` is audited (before/after times + reason).
2. I can **add a missing entry** for a staff member (in, out, reason) → `time_entry.created`; and **delete** an entry with a reason → `time_entry.deleted` (before snapshot kept in audit).
3. I can close someone's open entry by setting a clock-out (same as edit).
4. Validation: clock-out after clock-in; duration ≤ 24h; not in the future; no overlap with another entry of the same person (`409 TIME_ENTRY_OVERLAP`); at most one open entry per person.
5. A Manager can fix entries for Front desk and Technician staff and other Managers, but **not their own** entries (an Owner fixes those). An Owner can fix anyone's including their own. *See decision D5.*

**C4. As an owner or manager, I want to export the timesheet to CSV, so that I can run payroll.**
1. Given `timesheet.export`, When I click Export CSV, Then the file contains the current filters, one row per entry: `Staff name, Email, Role, Date, Clock in, Clock out, Duration (hours), Duration (minutes), Flags, Edited, Edit reason`.
2. Date `YYYY-MM-DD` and times `HH:mm` in shop timezone (ISO-like so spreadsheets parse it in any locale); hours with 2 decimals; open entries have empty clock-out and flag "Still open".
3. Filename `timesheet-{shop-slug}-{from}-{to}.csv`, UTF-8 with BOM (Excel), cells starting with `= + - @` are escaped against CSV injection.
4. `timesheet.exported` is audited (range + staff filter, no data).

### Edge cases
- DST (US/UK): durations come from UTC instants, so a shift across a clock change is the real elapsed time; the day boundary uses the shop's zone on that date. PK has no DST.
- Timezone changed in settings: past entries re-display in the new zone; nothing is rewritten.
- Deactivation closes an open entry (§2 S5.2). A deactivated person can't clock in.
- Role changes don't affect entries.
- Clocked in at shop A, switch to shop B: separate entries per shop; allowed.
- Clock in/out uses server time only; the client never sends a timestamp for self clock-in.
- Date range max 93 days in the UI and API (`400`), to keep exports small.

### Data
**TimeEntry** (new tenant table, isolation test): `id`, `shopId`, `userId`, `clockInAt` (UTC), `clockOutAt?` (UTC), `closedReason?` (`DEACTIVATED` or null), `createdByUserId`, `source` `SELF | MANUAL`, `editedAt?`, `editedByUserId?`, `editReason?` (last edit; full history in AuditLog), `createdAt`, `updatedAt`. Partial unique index: one row with `clockOutAt IS NULL` per (shopId, userId). Index (shopId, clockInAt). Deleting is a hard delete with the audit snapshot (decision D5).

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/timeclock/me` | Open entry (if any) + my recent entries | `timeclock.self` |
| `POST /api/timeclock/clock-in` | Open an entry | `timeclock.self` |
| `POST /api/timeclock/clock-out` | Close my open entry | `timeclock.self` |
| `GET /api/timesheets?from&to&userId` | Entries + totals, flags | `timesheet.view` |
| `GET /api/timesheets/export.csv?from&to&userId` | CSV | `timesheet.export` |
| `POST /api/time-entries` | Add missing entry | `timesheet.edit` |
| `PATCH /api/time-entries/:id` | Fix times (reason required) | `timesheet.edit` |
| `DELETE /api/time-entries/:id` (body: reason) | Delete with reason | `timesheet.edit` |

### Screens
- **Top bar clock control**: states Clocked out ("Clock in"), Clocked in (elapsed), Long-shift warning, Loading, Error (toast + retry). At ≤ 900px icon-only with tooltip. Menu: Clock in/out, My hours.
- **My hours** dialog/panel: this week and last week, read-only.
- **Settings → Timesheets**: filter bar (range, staff, Needs review), summary per staff, expandable days, row actions (Edit, Delete), Add entry, Export CSV. States: loading, empty ("No hours recorded in this period"), error.
- **Edit / Add entry dialog**: date+time pickers in shop timezone, reason field, validation messages.

### Out of scope
Breaks, overtime rules, scheduled shifts/rota, geofencing/IP restriction, PIN clock-in on a shared device, staff editing their own entries, approval workflow, payroll integrations, auto clock-out.

---

## 6. Audit log viewer

### Stories
**AU1. As an owner or manager, I want to see who changed what and when, so that I can trust settings, staff and time records.**
1. Given `audit.view`, When I open Settings → Audit log, Then I see newest first: when (shop time), who (name; "System" when no actor; deactivated people still named), action (plain words, e.g. "Changed role"), entity (e.g. "Staff: Sam Lee", "Tax rate: VAT").
2. Filters: date range (default last 7 days, max 1 year per query), user, action type grouped by area (Shop settings, Tax, Business hours, Staff & invites, Timesheets). Paginated 50 per page (cursor).
3. When I open an event, Then a side panel shows before/after as a readable field diff: field label, old → new, values formatted (times in shop zone, roles as names, rates as %, booleans as Yes/No); unchanged fields hidden; created = only "after", deleted = only "before".
4. The log is read-only: no edit, delete or export in the UI, and no API to change entries. The DB role used by the API has no UPDATE/DELETE on `audit_logs` (devops/backend to confirm with RLS setup).
5. Managers see all events in the shop, including Owners' actions.

### Sprint 1 actions that MUST write an audit event
Written in the **same transaction** as the change. Before/after hold changed fields only; never tokens, token hashes, passwords or session ids.

| Action | Entity | Before/after |
|---|---|---|
| `shop.created` (exists) | Shop | after |
| `shop.updated` | Shop | changed profile fields (incl. timezone) |
| `shop.tax_settings_updated` | Shop | pricesIncludeTax |
| `shop.hours_updated` | Shop | week |
| `tax_rate.created` / `tax_rate.updated` / `tax_rate.archived` / `tax_rate.restored` / `tax_rate.default_changed` | TaxRate | rate fields / default flags |
| `invite.created` / `invite.resent` / `invite.revoked` | Invitation | email, role, expiresAt |
| `invite.accepted` | Invitation (actor = accepting user) | status, membership id, emailVerified set |
| `member.role_changed` | Membership | role |
| `member.deactivated` / `member.reactivated` | Membership | status |
| `time_entry.created` / `time_entry.updated` / `time_entry.deleted` | TimeEntry | times + reason |
| `time_entry.auto_closed` | TimeEntry | clockOutAt, closedReason |
| `timesheet.exported` | Shop | filters only |
| `shop.create_blocked` is **not** audited (no shop exists); log it in app logs |

**Not audited:** self clock-in/out (the time entry itself is the record), sign-in/out, shop switching, viewing pages. Contracts should define `AuditAction` as an enum so the viewer's labels and filters stay in sync.

### Data
Existing `AuditLog` is enough. Add index (shopId, actorUserId, createdAt) and (shopId, action, createdAt) if query plans need it. Labels and field formatters live in contracts or web, keyed by action.

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/audit-events?from&to&actorUserId&actionGroup&cursor` | List | `audit.view` |
| `GET /api/audit-events/:id` | Detail with before/after | `audit.view` |

### Screens
**Settings → Audit log**: filter bar, table, detail side panel with diff. States: loading, empty ("No activity in this period"), error, end of list.

### Out of scope
Audit export, retention settings, alerting, platform-level (cross-shop) audit, money/stock audit (comes with those features in Sprints 4–5, same table).

---

## 7. Backlog item: cap shop creation

**SC1. As the product, I want to limit how many shops one person can create, so that free accounts can't spam tenants before billing exists.**
1. Given I already **own** 3 shops (ACTIVE OWNER memberships), When I call `POST /api/shops`, Then `403 SHOP_LIMIT_REACHED` "You can own up to 3 shops for now. Contact support if you need more." and onboarding shows it in the banner.
2. Given I create more than **5 shops per hour**, Then `429 RATE_LIMITED` "Too many shops created. Try again later." (per user id; in-memory store is acceptable until the BACKLOG Redis store item).
3. Shops where I am only Manager/Front desk/Technician don't count. A shop where I'm a deactivated owner doesn't count.
4. "Create a new shop" in the user menu (§3 A3.4) opens onboarding even when I already have an active shop; the limit is checked on submit and the menu item shows the message if already at 3.
5. The cap and rate are config values (env), tested at the boundary (3rd succeeds, 4th fails).

Update `docs/BACKLOG.md`: move the cap item to done; keep "billing ties extra shops to subscriptions" for Sprint 6.

---

## 8. Email delivery (invites)

**E1. As an invited person, I want a clear email, so that I trust it and know what to do.**
1. Subject: **"{Inviter name} invited you to join {Shop name} on RepairOS"**.
2. Body: greeting, "{Inviter} ({inviter email}) has invited you to join **{Shop}** as **{Role}**.", one-line role description, primary button **"Accept invite"** linking to `{APP_URL}/invite/{token}`, the same URL as plain text below the button, "This invite expires on {date, time in shop zone}.", "If you weren't expecting this, you can ignore this email." Plain-text alternative included. No shop logo yet.
3. From: configured `EMAIL_FROM` (RepairOS); Reply-To: the inviter's email.
4. Sending is queued (BullMQ) with retries (e.g. 3 with backoff). Creating the invite does not wait for delivery; the invite's `emailStatus` becomes SENT or FAILED, and FAILED shows in the staff list with Resend.
5. The token appears only in the email/outbox, never in logs or audit.

**Delivery mechanism (for the integrations engineer):** an `EmailProvider` interface (`send({ to, subject, html, text, replyTo })`). Adapters:
- **Dev outbox** (default when `RESEND_API_KEY` is unset): writes each email (JSON + HTML) to a local outbox folder; a dev-only page (e.g. `/dev/outbox`, disabled when `NODE_ENV=production`) lists and renders them. E2E tests read invite links from it.
- **Resend** adapter, used only when `RESEND_API_KEY` is set.
- In production, starting without `RESEND_API_KEY` must fail loudly (see decision D6).

Out of scope: other email types (password reset, notifications: Sprint 3), templates editor, bounce/complaint webhooks, SMS/WhatsApp invites.

---

## Cross-cutting data/contract changes (summary)
- contracts: `Permission`, `ROLE_PERMISSIONS`, `can()`, `manageableRoles()`; `AuditAction`; inputs/outputs for staff, invites, shop profile, tax rates, hours, time entries, audit events; `MeResponse` gains `permissions`, `accessRemoved`; shared phone/postcode/region/timezone validators per country.
- db: Membership `status` (+ deactivation fields); new `Invitation`, `TimeEntry`, `BusinessHours` (or JSON on Shop); TaxRate `archivedAt`, default flags, rate precision change (D2). Isolation tests for every new tenant table.
- api: permission guard replaces `@Roles`; AuthGuard ignores DEACTIVATED memberships (including in its "oldest membership" fallback).

## Definition of done for Sprint 1
- [ ] Permission matrix in contracts with snapshot test; every non-public route declares a permission; UI hides by `permissions` from `/api/me`.
- [ ] Staff list, invite, resend, revoke, change role, deactivate, reactivate work with all rules (last owner, owner-only, manager limits, not-self, 5 seats) and have API tests for each rule.
- [ ] Deactivated member's next request for that shop is rejected (integration test) and the UI shows the access-removed state.
- [ ] Invite acceptance: happy path (new and existing account) + expired, revoked, accepted, wrong-account, invalid token; Playwright E2E using the dev outbox link.
- [ ] Tenant isolation tests for Invitation, TimeEntry, BusinessHours; cross-shop test: an invite token for shop A never grants shop B.
- [ ] Shop switcher works for a two-shop user.
- [ ] Shop profile, tax (toggle, rates, defaults, archive) and business hours editable with US/UK/PK validation tests.
- [ ] Clock in/out from the top bar; timesheet with flags, fix with reason, CSV export; DST test case (US/UK) and overnight >14h flag test.
- [ ] Audit viewer with filters and diff; every action in §6 table writes an event in the same transaction (one test per action).
- [ ] `POST /api/shops` capped at 3 owned shops + 5/hour, tested at the boundary; BACKLOG updated.
- [ ] Invite email sent via EmailProvider; dev outbox page works; Resend adapter used only with `RESEND_API_KEY`.
- [ ] ROADMAP Definition of Done (Astryx only, axe, 1024px, CI green, code review, docs).

## Riskiest items (in order)
1. **Deactivation & access re-check in the AuthGuard.** Today the guard falls back to the user's oldest membership of any kind; if it doesn't filter DEACTIVATED, a removed employee keeps access. A user with only deactivated memberships must not be sent to onboarding.
2. **Invite acceptance security.** Token hashing, single use, email match, setting `emailVerified`, and the accept transaction (invite + membership + active shop) must be atomic and race-safe; tokens must never reach logs.
3. **Role-rule invariants under concurrency** (last active owner, seat limit, duplicate invites): need DB locks/constraints, not just app checks.
4. **Timezone and DST** in timesheets (day boundaries, totals, CSV), plus timezone changes after the fact.
5. **Tax model shape** (rate precision, goods/services defaults, snapshot rule): wrong now = migration pain in Sprints 3–5.
6. **Email delivery** (queue, failures, prod misconfiguration): a silent failure blocks the whole "invite staff" goal.
7. **Matrix drift** between API and UI if anyone bypasses the shared contract.
8. **In-memory rate limits** (shop creation, invite resend) count per instance; acceptable until the Redis-store backlog item.

## Decisions for the tech lead to confirm
- **D1. Tax defaults:** brief says "one default". This spec uses one default **for goods** and one **for services** (an "All" rate can be both), because PK shops need GST 18% on parts and a different provincial rate on labour, and US shops often don't tax labour. Single default would mis-tax every PK service item.
- **D2. Tax rate precision:** `TaxRate.rateBps` (integer basis points) cannot store US combined rates like 8.875% (MARKETS.md's own example). Proposal: store rate with 3 decimal places of percent (e.g. integer `rateMilliPercent` 8875 = 8.875%) and update `MARKET_DEFAULTS` and the existing test.
- **D3. Matrix defaults:** Front desk has **no discount and no refund** by default; Technicians have no POS and can't create tickets; Managers can't touch Owners or other Managers' roles (Owner-only). Matrix is fixed (no per-shop customisation) in MVP.
- **D4. Password reset:** not in Sprint 1 scope, but an invited person whose email was squatted, or who forgot an old password, can't join. Recommend adding "Forgot password" (Better Auth + same EmailProvider) to Sprint 1 as a small extra, or early Sprint 2.
- **D5. Time entries:** Managers can't fix their own entries; entries are hard-deleted with the audit snapshot as the record; no auto clock-out (flag only).
- **D6. Email config:** production refuses to start without `RESEND_API_KEY` (instead of silently using the dev outbox). Also: Mailpit is already in docker-compose; the dev outbox adapter overlaps with it. Pick one (outbox is simpler for E2E; Mailpit tests SMTP we don't use).
- **D7. Accepting an invite sets `user.emailVerified = true`.** Reasonable since the token proves inbox access; flag in case another flow relies on verification semantics.
- **D8. Deactivation closes the open time entry** at deactivation time (marked), rather than leaving it open.
- **D9. Business hours default** Mon–Sat 10:00–19:00, Sunday closed; single interval per day (no lunch break). PK shops often close for Friday prayers; that's a split-hours case left out.
- **D10. Possible addition (not in scope):** "Copy invite link" for owners to send by WhatsApp (useful in PK where email is less used). It would rotate the token like Resend.

---

## Tech lead decisions (binding for Sprint 1)

| # | Decision |
|---|---|
| D1 | **Accepted.** One default goods rate and one default services rate; an "All items" rate may be both. |
| D2 | **Accepted.** Tax rates store thousandths of a percent: field `rateMilliPct`, 8875 = 8.875%, 20000 = 20%. Replace `rateBps` everywhere (contracts `MARKET_DEFAULTS`, schema with a data migration ×10, tests). |
| D3 | **Accepted.** Fixed matrix, no per-shop overrides. Front desk sells but cannot discount or refund; Technicians cannot sell or create tickets; only an Owner changes a Manager's role. |
| D4 | **In Sprint 1.** "Forgot password" (Better Auth reset flow over the same EmailProvider), with the existing per-IP+email rate limit. |
| D5 | **Accepted as written.** |
| D6 | **Accepted.** Production refuses to start without `RESEND_API_KEY` (and `EMAIL_FROM`). Dev uses a file outbox (`.outbox/`, gitignored) with a dev-only page `/dev/outbox` in the web app (404 in production). Remove mailpit from docker-compose. |
| D7 | **Accepted, with a condition.** Accepting via the emailed token sets `emailVerified=true` only if the link was never exposed through D10's copy-link (`linkCopiedAt` is null). |
| D8 | **Accepted.** |
| D9 | **Accepted.** |
| D10 | **In Sprint 1.** "Copy invite link" (Owner/Manager), for WhatsApp sharing in Pakistan. Copying records `linkCopiedAt` and an audit event. |
| Risk #1 | **Must fix in Sprint 1:** the AuthGuard's oldest-membership fallback and every membership check must ignore non-ACTIVE memberships. A user whose only membership is deactivated sees an "Access removed" page, not onboarding. `/invite/*` is exempt from the onboarding redirect. Add isolation tests. |
| Validators | Phone, postcode and timezone validators live in contracts and are shared by `CreateShopInput` and shop settings. |
