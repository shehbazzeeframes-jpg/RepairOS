# Sprint 2: Customers & tickets I

**Goal:** a front-desk person can check in a device in **under 60 seconds**, and the shop can track every repair from intake to collection.

**Already done (not repeated here):** Sprint 0 app shell (sidebar, top bar with global search placeholder, dashboard placeholders), tenant-scoped Prisma client + RLS, Sprint 1 permission matrix (`packages/contracts/src/permissions.ts`), audit log + viewer (`audit.ts`), shared validators (`normalizePhone`, `formatPhone`, postcode/region/timezone), `EmailAddress`, `LocalDate`, `IdParam`, business hours, `FIELD_ENCRYPTION_KEY` in `.env.example`.

**Deferred and why:**
- **Photos** on tickets → Sprint 3 (built with R2 storage, like the logo). The timeline is designed to hold attachment events now (§5.6).
- **Printing** (intake receipt, device label) → Sprint 3. The Print menu is a visible, disabled placeholder (§5.10).
- **Customer notifications** → Sprint 3. Statuses carry a `notifyCustomer` flag now; nothing is sent (§6).
- **Services/parts line items** and the checklist editor → Sprint 3; parts consumption → Sprint 4; payment and the "balance due" guard on collection → Sprint 5.

Roles: **O** = Owner, **M** = Manager, **FD** = Front desk, **T** = Technician.

Conventions (same as Sprint 1):
- Timestamps stored in UTC, shown in the **shop's** timezone and locale (`en-US` MM/DD/YYYY, `en-GB` DD/MM/YYYY for GB and PK).
- Every error uses the existing `ApiError` shape; new `code`s are listed per area.
- API paths are suggestions; Zod contracts land in `packages/contracts` first.
- Every new tenant table has `shopId`, goes through the scoped client, has an RLS policy and an isolation test.
- Money = integer minor units + the shop currency (PKR shown without decimals).

---

## 0. Permissions for this sprint

Use the **existing keys** (note they are plural: `tickets.*`, `customers.*`). The brief's `ticket.assign` / `ticket.change_status` do not exist and are **not added**: the Sprint 1 matrix already defines `tickets.edit` as "edit ticket details, notes, status, assignment". One existing key gets a clarified meaning (decision A3). **No new permission keys.**

| Key | Sprint 2 meaning | O | M | FD | T |
|---|---|---|---|---|---|
| `tickets.view` | Ticket list, detail, timeline, dashboard counts, global search over tickets | ✓ | ✓ | ✓ | ✓ |
| `tickets.create` | Check in a device (new ticket, warranty ticket) | ✓ | ✓ | ✓ | — |
| `tickets.edit` | Edit issues, checklist, accessories, estimate, due date, priority; add notes; change status **within non-closed categories**; assign/reassign (incl. "Take" for self) | ✓ | ✓ | ✓ | ✓ |
| `tickets.cancel` | **Close lifecycle:** move a ticket into a `closed` status (Collected, Cancelled, custom closed) and **reopen** a closed ticket (A3) | ✓ | ✓ | ✓ | — |
| `tickets.view_passcode` | Reveal a device passcode/pattern from an open ticket (audited) | ✓ | ✓ | ✓ | ✓ |
| `customers.view` | Customer list, detail, devices; global search over customers/devices | ✓ | ✓ | ✓ | ✓ |
| `customers.manage` | Create/edit/archive/restore customers; create/edit devices (incl. setting a passcode); record consent | ✓ | ✓ | ✓ | — |
| `customers.export_delete` | GDPR export (JSON) and erase/anonymise | ✓ | ✓ | — | — |
| `statuses.manage` | Settings → Ticket statuses | ✓ | ✓ | — | — |
| `settings.manage` | Settings → Tickets (default due days, number prefix, next number, passcode clearing) | ✓ | ✓ | — | — |

Contracts change: add `SPRINT2_ENFORCED_PERMISSIONS` (the keys above) and update the description text of `tickets.cancel` in the matrix doc; the matrix snapshot test is updated deliberately (no grant changes).

Technicians therefore: see everything, work their queue, change status up to Ready for pickup, assign/take tickets, add notes, reveal passcodes on open tickets; they **cannot** check in, edit customers/devices, collect, cancel or reopen. (If a technician needs a device detail corrected, FD/M does it; logged as a known limitation, not a bug.)

---

## 1. Customers

### Stories
**CU1. As front desk, I want to create a customer in a few keystrokes, so that check-in isn't slowed down.**
1. Given `customers.manage`, When I open New customer (full form or the quick-create in check-in §5.1), Then I choose **Person** (default) or **Business**; Person needs a first name, Business needs a business name; everything else is optional except **at least one phone or an email**.
2. Given I type a phone in any common format for the shop's country (US `(212) 555-0142`, UK `07911 123456`, PK `0300-1234567` / `03001234567` / `+92 300 1234567`), When I leave the field, Then it is validated with the shared `normalizePhone` (shop country as default region) and shown back in national format; it is stored E.164. An invalid number shows "Enter a valid phone number" and blocks save.
3. Given I add more phones (max 3), Then each has a label (Mobile / Landline / Work / Other) and exactly one is **Primary** (the first one by default; choosing another moves the flag).
4. Given the shop country is PK, Then **Preferred contact** defaults to **WhatsApp** (on the primary phone); for US/UK it defaults to **SMS**. Options: SMS, WhatsApp, Email, Phone call. A "WhatsApp number" defaults to the primary phone and can be set to another of the customer's phones.
5. When I save, Then the customer is created, I land on (or return to the check-in with) the new customer, and a toast "Customer added" shows.

**CU2. As front desk, I want to be warned while typing if the customer already exists, so that I don't create duplicates.**
1. Given I have typed a phone that normalises to a valid E.164, or an email that passes `EmailAddress`, When 300 ms pass without typing, Then the app checks for existing customers (any of their phones, or email, exact match after normalisation) **including archived ones**.
2. Given matches exist, Then an inline panel shows up to 3: name, primary phone, email, last visit, open-ticket count, and an "Archived" badge if so, with **"Use this customer"** (archived: "Restore and use").
3. When I choose "Use this customer", Then the form is replaced by that customer (in check-in, the customer step completes); nothing I typed is saved onto the existing record.
4. Given I ignore the warning and save, Then the save succeeds (duplicates are allowed: families and businesses share numbers) and the new customer is created. The API does not block.

**CU3. As front desk, I want to edit a customer, so that contact details stay right.**
1. Given `customers.manage`, When I edit and save, Then the same validation applies, and the duplicate check runs on changed phones/emails (warning only).
2. Given two staff edit the same customer, When the second saves with an outdated `version`, Then `409 STALE_RECORD` "Someone else changed this customer. Reload to see their changes." (optimistic concurrency; the form keeps my input).
3. Customer edits are not audited (low risk); consent changes keep their own history (CU4).

**CU4. As an owner, I want marketing consent recorded per channel with when and how it was given, so that we meet UK GDPR/PECR and US TCPA basics.**
1. Given the customer form, Then there are three separate, **unticked by default** switches: "Marketing by SMS", "Marketing by email", "Marketing by WhatsApp". No pre-ticked boxes, no bundled consent.
2. When I turn a switch on or off and save, Then a **consent event** is appended: channel, `granted | withdrawn`, timestamp (server), **source** (required when granting: In store – verbal, In store – signed form, Website/online form, Imported, Customer request), the staff member who recorded it, optional note (≤200).
3. Given a customer, Then the detail page shows current consent per channel ("SMS marketing: Yes, since 12/03/2026, in store – verbal, by Sam") and the full history in a "Consent history" panel. History is append-only (no edit/delete).
4. Given a US shop and source "In store – verbal" for SMS marketing, Then a helper text warns: "US law (TCPA) expects written consent for marketing texts. Use a signed form or online form." It's a warning, not a block.
5. **Service messages** (repair updates, Sprint 3) are not marketing. Each channel also has a **"Service updates: opted out"** flag (default off) so a customer who says "don't text me" is honoured when sending starts in Sprint 3 (STOP handling comes with the sender).

**CU5. As front desk, I want to find any customer fast by name, phone in any format, or email, so that I can answer "is my phone ready?".**
1. Given `customers.view`, When I open Customers, Then I see a paginated table (25 per page; 25/50/100) with: name (business badge), primary phone (national format), email, tags, open tickets, last visit, created.
2. When I type in search (debounced 250 ms, min 2 characters), Then results match: name (contains, case- and accent-insensitive, any word order: "Khan Ali" finds "Ali Khan"; business name and business contact name too), phone (digits only after removing spaces, dashes, brackets; a full national or international number is normalised and matched exactly; 4+ digits match as a substring, so "4567" finds "+92 300 1234567"), email (contains).
3. Filters: Type (Person/Business), Tags (any of), Has open tickets, Marketing consent (SMS/Email/WhatsApp = yes), Created (date range), Show archived (off by default; archived rows carry a badge).
4. Sort: Name A–Z (default), Last visit (newest), Created (newest).
5. Filters, search and sort live in the URL (shareable, back button works).

**CU6. As front desk, I want a customer page with their devices, tickets and notes, so that I see the whole history in one place.**
1. Given a customer, When I open it, Then the header shows display name, type, phones (click-to-call `tel:`; WhatsApp numbers show a WhatsApp link `https://wa.me/<digits>`), email (`mailto:`), preferred contact, consent summary, tags, and the **customer note** highlighted if present.
2. Actions (shown only with permission): **New ticket** (opens check-in with this customer selected), Edit, Archive/Restore, Export data, Erase.
3. Tabs: **Tickets** (number, device, status badge, created, due, assignee; open first, then newest), **Devices** (type icon, brand + model, colour, IMEI/serial masked to last 4 unless clicked, "Passcode on file" yes/no, ticket count, "New ticket for this device"), **Details** (address, notes, consent history, created/updated by).
4. Empty states: "No tickets yet. Check in a device." / "No devices yet."

**CU7. As a manager, I want to archive customers I no longer need in lists, without losing history.**
1. Given `customers.manage` and the customer has **no ticket in an open, waiting or ready status**, When I archive and confirm, Then the customer is hidden from the list, global search and check-in search by default, and `customer.archived` is audited.
2. Given they have such tickets, Then `409 CUSTOMER_HAS_OPEN_TICKETS` "Close or cancel this customer's {n} open tickets first."
3. When I restore (from the list with "Show archived", from the duplicate panel, or from the detail page), Then the customer is active again and `customer.restored` is audited.
4. An archived customer can't get a new ticket until restored (check-in offers "Restore and use").

**CU8. As an owner or manager, I want to export a customer's data, so that I can answer a subject access request.**
1. Given `customers.export_delete`, When I click Export data, Then a JSON file downloads: `customer-{id}-{YYYY-MM-DD}.json` containing customer fields, phones, consent history, devices (without passcode; field `passcodeOnFile: true|false`), tickets (number, dates, status history, issues, checklist, accessories, estimate, **customer-visible notes**; internal notes excluded, see A11), and `exportedAt`, `shop` name.
2. `customer.exported` is audited (no personal data in before/after; just counts).
3. Export is generated synchronously (one customer is small); it works for archived customers but not for erased ones (`404`).

**CU9. As an owner or manager, I want to erase a customer on request, so that we comply with the right to erasure while keeping our business records.**
1. Given `customers.export_delete` and the customer has **no ticket in an open, waiting or ready status**, When I click Erase, Then a destructive dialog explains what happens and asks me to type **ERASE**.
2. When I confirm, Then in one transaction: name becomes "Erased customer", business name/contact, phones, email, address, notes, tags and consent history are deleted; preferred contact cleared; each device keeps type, brand and model but loses IMEI, serial, colour, notes and passcode; tickets **stay** (numbers, dates, statuses, issues, checklist, estimate) linked to the anonymised customer; the customer is flagged `erasedAt` and archived; `customer.erased` is audited with counts only.
3. Given an open/waiting/ready ticket exists, Then `409 CUSTOMER_HAS_OPEN_TICKETS` (the device is still in the shop; finish or cancel first).
4. Ticket notes are kept (repair record, warranty/legal claims). The dialog says: "Notes on tickets are kept as repair records. Remove personal details from them first if needed." (A11)
5. Erasure is irreversible; an erased customer can't be edited, restored, exported, or used for new tickets, and doesn't appear in duplicate checks or search (except by ticket number, where they show as "Erased customer").
6. Sprint 5 invoices will reference the anonymised customer, so financial records survive (they keep amounts and tax, not personal data).

### Merge duplicates: OUT of scope (decision A6)
Merging means moving devices, tickets, consent histories and resolving conflicting fields and consent; it is not trivial. Backlog it for Sprint 6 polish. In Sprint 2 the duplicate warning prevents most duplicates, and archive hides the extras.

### Edge cases
- Same phone on several customers (family, business staff): allowed; duplicate panel lists all (max 3 + "and {n} more").
- Phone from another country (UK customer with a PK number): accepted if valid in international format (`+92…`); shown in international format.
- Number entered without a country code that is valid in the shop's country only as a landline: allowed (label Landline); WhatsApp link hidden for numbers `libphonenumber` types as fixed-line.
- PK numbers written as `0300 1234567`, `3001234567`, `923001234567`, `+92-300-1234567` all normalise to `+923001234567`.
- Name with one word only (common in PK and for walk-ins): first name only is valid.
- Business with no contact person: valid; display name = business name.
- Email already used by another customer: warning only.
- Erasing a customer with a device that has a closed ticket within 7 days (reopen window): allowed; reopen then shows the anonymised customer.
- Customer marked erased while another user has their page open: next action returns `404 NOT_FOUND`, UI shows "This customer was erased."
- Consent withdrawn then granted again: both events kept; current = last event.
- Withdrawal needs no source (default "Customer request").
- Search with "+44 7911…" in a PK shop: international form normalises regardless of shop country.

### Data
**Customer** (new tenant table): `id`, `shopId`, `kind` `PERSON | BUSINESS`, `firstName?` (≤60), `lastName?` (≤60), `businessName?` (≤120), `businessContactName?` (≤120), `displayName` (derived and stored: Person "First Last"; Business "Business name"), `email?` (`EmailAddress`), `addressLine1?`, `addressLine2?`, `city?`, `region?`, `postcode?` (shop-country validators; address is always in the shop's country in MVP), `notes?` (≤2000), `tags` (text[] max 10, each 1–30 chars, trimmed, compared case-insensitively, stored as first-entered casing), `preferredChannel` `SMS | WHATSAPP | EMAIL | CALL`, `whatsappPhoneId?`, `serviceOptOutSms`, `serviceOptOutEmail`, `serviceOptOutWhatsapp` (booleans), `lastVisitAt?` (denormalised: last ticket created), `openTicketCount` (denormalised, maintained in the ticket transaction), `archivedAt?`, `erasedAt?`, `version` (int), `createdByUserId`, `createdAt`, `updatedAt`, search column `searchText` (lower, unaccented: names + business + email).

Validation: Person → `firstName` required (1–60, trimmed); Business → `businessName` required (1–120). At least one phone or `email`. Free-text fields trimmed, empty → null.

**CustomerPhone** (new tenant table): `id`, `shopId`, `customerId`, `e164` (validated), `digits` (E.164 without "+", for substring search), `label` `MOBILE | LANDLINE | WORK | OTHER`, `isPrimary`, `position`. Max 3 per customer; unique (customerId, e164); partial unique: one primary per customer.

**CustomerConsentEvent** (new tenant table, append-only): `id`, `shopId`, `customerId`, `channel` `SMS | EMAIL | WHATSAPP`, `purpose` `MARKETING` (enum ready for more), `state` `GRANTED | WITHDRAWN`, `source` `IN_STORE_VERBAL | IN_STORE_SIGNED | ONLINE_FORM | IMPORT | CUSTOMER_REQUEST`, `note?` (≤200), `recordedByUserId`, `createdAt`. Current consent per channel is derived (latest event), also denormalised on Customer as `marketingSms/Email/WhatsappAt?` (null = not granted) for list filters.

Indexes (performance §9): `customers (shopId, archivedAt, displayName)`, GIN trigram on `customers.searchText`, GIN trigram on `customer_phones.digits`, btree `customer_phones (shopId, e164)`, btree `customers (shopId, lower(email))`, GIN on `customers.tags`, `customers (shopId, lastVisitAt desc)`.

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/customers?q&type&tags&hasOpen&consent&createdFrom&createdTo&archived&sort&cursor&limit` | List/search, with `total` | `customers.view` |
| `GET /api/customers/duplicates?phone&email&excludeId` | Up to 3 matches + `more` count | `customers.view` |
| `GET /api/customers/:id` | Detail incl. phones, current consent, counts | `customers.view` |
| `POST /api/customers` | Create (with phones and initial consents) | `customers.manage` |
| `PATCH /api/customers/:id` | Edit (requires `version`) | `customers.manage` |
| `POST /api/customers/:id/consents` | Append consent event(s) | `customers.manage` |
| `GET /api/customers/:id/consents` | History | `customers.view` |
| `POST /api/customers/:id/archive` · `/restore` | Archive / restore | `customers.manage` |
| `GET /api/customers/:id/export` | JSON download | `customers.export_delete` |
| `POST /api/customers/:id/erase` (body `{ confirm: "ERASE" }`) | Anonymise | `customers.export_delete` |
| `GET /api/customers/tags` | Tag suggestions (distinct tags in shop) | `customers.view` |

Errors: `CUSTOMER_HAS_OPEN_TICKETS` (409), `CUSTOMER_ARCHIVED` (409, e.g. creating a ticket), `CUSTOMER_ERASED` (409/404), `STALE_RECORD` (409), `VALIDATION_FAILED` (400).

### Screens
- **Customers list**: search box (autofocus), filter bar, table, "New customer" button. States: loading skeleton, empty shop ("No customers yet. They're added when you check in a device." + New customer), no results ("No customers match '{q}'" + Clear filters), error + Try again.
- **Customer form** (page and dialog variants): Person/Business segmented control, names, phones repeater, email, preferred contact, consent switches with source select, tags (combobox with suggestions), address (collapsed "Add address"), notes. Inline duplicate panel. Unsaved-changes guard.
- **Customer detail**: header + actions, tabs Tickets / Devices / Details, Consent history side panel.
- **Archive confirm**, **Erase dialog** (type ERASE, list of what is removed/kept), **Export** (direct download + toast).

### Out of scope
Merge duplicates (A6), CSV import (Sprint 4 `data.import`), marketing campaigns and sending, UK soft opt-in automation, suppression list surviving erasure, customer portal/self-service, multiple emails, addresses outside the shop country, customer groups/pricing tiers, store credit/loyalty (Phase 2), birthday fields, custom fields.

---

## 2. Devices

### Stories
**DV1. As front desk, I want to add a device to a customer quickly, so that the ticket knows exactly what is being repaired.**
1. Given `customers.manage`, When I add a device (on the customer page or in check-in), Then I pick **Type** (Phone, Tablet, Laptop, Desktop, Console, Watch, Other) and **Brand** (select from the built-in list for that type + "Other" free text), and type **Model**.
2. Given I type in Model, Then suggestions come from (a) the built-in seed catalogue for the chosen brand (e.g. iPhone 11–16 incl. Pro/Pro Max/Plus/mini, iPhone SE 2nd/3rd gen; Galaxy S20–S24 incl. +/Ultra/FE, Galaxy A13–A55; Pixel 6–9 incl. Pro/a; iPad 9th/10th gen, iPad Air, iPad Pro, iPad mini; MacBook Air/Pro M1–M3; plus PK-popular Infinix Hot/Note, Tecno Spark/Camon, Redmi Note 10–13, Oppo A/Reno, Vivo Y; consoles PS4/PS5, Xbox One/Series, Switch/Switch OLED; Apple Watch Series 6–9/SE/Ultra) and (b) models this shop has used before (most used first). Free text is always accepted.
3. Optional fields: Colour (≤30, suggestions Black, White, Silver, Gold, Blue, …), IMEI, Serial number, Notes (≤1000).
4. When I save, Then the device belongs to the customer and appears in their Devices tab.

**DV2. As front desk, I want IMEI and serial validated, so that we record the right device and can search by it later.**
1. Given I type or scan an IMEI, Then spaces, dashes and slashes are removed; it must be **exactly 15 digits** and pass the **Luhn** check, else "This IMEI isn't valid. Check the 15 digits (dial *#06# on the phone)."
2. Given 16 digits (IMEISV) or 14 digits, Then the same error with the hint "IMEI has 15 digits".
3. Serial: trimmed, spaces/dashes removed, upper-cased, 4–30 characters `[A-Z0-9]`.
4. IMEI and serial are both optional ("Unknown" is fine: dead device, no label). The IMEI field is shown for Phone, Tablet and Watch; Serial for every type.
5. Given the IMEI (or serial) already belongs to **another customer's** device in this shop, Then a warning: "This IMEI is on {customer}'s {model} (last ticket T-1033)." with a link; saving is still allowed (resale, family hand-me-down). Same customer → offer "Use existing device".

**DV3. As front desk, I want to record the passcode or pattern securely, so that the technician can test the device without the customer's data being exposed.**
1. Given the device form, Then **Lock** has options: None, PIN/passcode, Password, Pattern, "Customer won't share".
2. PIN/passcode: digits 4–16; Password: any printable 1–64; both shown masked while typing with a show toggle.
3. Pattern: a **3×3 grid** of dots; I draw by click/drag or touch, or by keyboard (dots numbered 1–9, typing digits adds them in order; Backspace removes the last; Enter confirms). Valid pattern: 4–9 distinct dots. Stored as the ordered dot sequence (e.g. `1-5-9-6`).
4. On save, Then the value is encrypted with **AES-256-GCM** using `FIELD_ENCRYPTION_KEY` (stored with a key id for rotation); the API never returns it in normal reads, logs or audit. Reads return only `lockType` and `passcodeSetAt`.
5. Changing or clearing a passcode writes `device.passcode_changed` to the audit log (no value), and requires `customers.manage`.

**DV4. As a technician, I want to reveal the passcode when I start work, so that I can test the device; and the owner wants every reveal recorded.**
1. Given `tickets.view_passcode` and I am on a ticket whose status category is **not closed**, When I click "Show passcode", Then the API decrypts and returns it, the UI shows it (pattern: a read-only grid with numbered order and arrows) for **30 seconds** then hides it again, and `device.passcode_viewed` is audited (actor, device, ticket).
2. Given the ticket is closed, or I'm on the customer/device page, Then the button is not offered ("Passcode on file"); the API returns `403 PASSCODE_NOT_AVAILABLE` "Passcodes can be viewed only on an open ticket."
3. The device panel shows "Viewed {n} times · last by {name}, {time}".
4. More than 30 reveals per user per hour → `429 RATE_LIMITED` (protects against scraping).
5. There is no copy button and the value is never put in the URL, page title or local storage.

**DV5. As an owner, I want stored passcodes to be removed when the repair is done, so that we hold them no longer than needed.**
1. Given the shop setting **"Delete passcode when the repair is closed"** (Settings → Tickets, default **on**), When a ticket moves into a closed status and the device has no other non-closed ticket, Then the passcode is deleted in the same transaction (timeline: "Passcode deleted on close").
2. A returning customer is asked for the passcode again at the next check-in ("No passcode on file").

### Edge cases
- Scanner types the IMEI and Enter: the field accepts it and moves focus to the next field instead of submitting the whole form.
- Two IMEIs (dual SIM): store the first (IMEI 1); the second goes in notes. Out of scope to store both.
- Device moved to another customer (sold): not supported in Sprint 2; add a new device on the new customer (IMEI warning shows the history).
- Passcode with leading zeros: stored as string, never as a number.
- `FIELD_ENCRYPTION_KEY` missing or the placeholder `change-me` in production: API refuses to start (same pattern as `RESEND_API_KEY`).
- Key rotation: values carry `keyId`; a later script re-encrypts. Rotation tooling itself is out of scope.
- Decryption failure (wrong key): reveal returns `500 PASSCODE_UNREADABLE` "This passcode can't be read. Ask the customer again." and is logged as an error (no value).
- Customer erased: passcode, IMEI, serial deleted (§1 CU9).

### Data
**Device** (new tenant table): `id`, `shopId`, `customerId`, `type` `PHONE | TABLET | LAPTOP | DESKTOP | CONSOLE | WATCH | OTHER`, `brand` (≤40), `model` (≤60), `colour?` (≤30), `imei?` (15 digits, Luhn), `serial?` (normalised 4–30), `lockType` `NONE | PIN | PASSWORD | PATTERN | NOT_SHARED`, `passcodeCiphertext?`, `passcodeIv?`, `passcodeKeyId?`, `passcodeSetAt?`, `passcodeViewCount`, `passcodeLastViewedAt?`, `passcodeLastViewedByUserId?`, `notes?` (≤1000), `createdByUserId`, `createdAt`, `updatedAt`, `archivedAt?`.
Indexes: `(shopId, customerId)`, `(shopId, imei)`, GIN trigram on `serial` and on `imei` (partial search), `(shopId, brand, model)` for "models used before".

Contracts: `DEVICE_TYPES`, `DEVICE_BRANDS_BY_TYPE`, `DEVICE_MODEL_CATALOGUE` (seed list, ~150 entries, data only), `isValidImei()` (Luhn), `normalizeSerial()`, `PatternLock` schema (array of 4–9 distinct ints 1–9).

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/customers/:id/devices` | Devices of a customer | `customers.view` |
| `POST /api/customers/:id/devices` | Create (optional passcode) | `customers.manage` |
| `PATCH /api/devices/:id` | Edit; set/clear passcode | `customers.manage` |
| `GET /api/devices/lookup?imei|serial` | Existing owner warning | `customers.view` |
| `GET /api/devices/model-suggestions?type&brand&q` | Catalogue + shop history | `customers.view` |
| `POST /api/tickets/:ticketId/passcode/reveal` | Decrypt + audit (ticket must be non-closed) | `tickets.view_passcode` |

### Screens
- **Device form** (dialog; inline in check-in): type as icon segmented control, brand select, model combobox, colour, IMEI/serial (scan-friendly), lock type + PIN field or **pattern grid** component, notes.
- **Pattern grid** (built from Astryx primitives; keyboard accessible, labelled "Dot 1 … Dot 9", announces the sequence).
- **Passcode reveal** on ticket detail: masked chip → revealed with countdown → masked.

### Out of scope
IMEI blacklist/stolen checks (GSMA), automatic model detection from IMEI TAC, multiple IMEIs, device ownership transfer, device photos (Sprint 3), warranty per device, editable catalogue in settings.

---

## 3. Ticket statuses (configuration)

### Default workflow (seeded for every shop, and migrated into existing shops)
| # | Name | Category | System role | Notify customer (stored, used in Sprint 3) |
|---|---|---|---|---|
| 1 | Received | open | **INITIAL** | yes |
| 2 | Diagnosing | open | — | no |
| 3 | Awaiting approval | waiting | — | yes |
| 4 | Awaiting parts | waiting | — | no |
| 5 | In repair | open | — | no |
| 6 | Ready for pickup | ready | — | yes |
| 7 | Unrepairable | **ready** | — | yes |
| 8 | Collected | closed | **COLLECTED** | no |
| 9 | Cancelled | closed | **CANCELLED** | no |

**Unrepairable is a `ready` status** (decision A8): the device is still in the shop and must be handed back, which then happens through Collected. That keeps "every device leaves through Collected or Cancelled" true and keeps it in the Ready for pickup view.

Categories drive everything: **open** = being worked on; **waiting** = blocked on customer or parts; **ready** = waiting for pickup; **closed** = device has left / ticket finished.

### Stories
**ST1. As an owner or manager, I want to rename, reorder, add and hide statuses, so that the workflow matches how my shop talks.**
1. Given `statuses.manage`, When I open Settings → Ticket statuses, Then I see the list in order with name, category, colour, "Notify customer" switch, Hidden flag, ticket count.
2. I can rename (1–30 chars, unique case-insensitive among the shop's statuses), change colour (from the fixed set of Astryx badge tones), toggle Notify customer, reorder (drag or Move up/down buttons), add a status (name, category, colour; max **20** statuses), and hide/show.
3. **System statuses** (INITIAL, COLLECTED, CANCELLED) can be renamed and recoloured but not hidden and their category can't change. There is no delete (A9); hide instead.
4. Hiding a status: tickets already in it stay there and display normally; it disappears from the "change status" menu and from filters' default list (filters show hidden ones under "Hidden statuses").
5. Changing a custom status's category: allowed; in the same transaction all tickets in that status get the new `statusCategory` (denormalised), so views/dashboard update at once. Confirm dialog shows how many tickets move ("12 tickets will move from In progress to Waiting").
6. Rules: at least one visible status in each of open and ready; closed always has the two system ones.
7. Every change writes an audit event: `ticket_status.created`, `ticket_status.updated` (name/category/colour/notify/hidden before/after), `ticket_status.reordered`.

### Data
**TicketStatus** (new tenant table): `id`, `shopId`, `name`, `category` `OPEN | WAITING | READY | CLOSED`, `systemRole?` `INITIAL | COLLECTED | CANCELLED` (partial unique per shop), `colour` (enum of badge tones), `position` (int), `isHidden`, `notifyCustomer` (bool), `createdAt`, `updatedAt`. Unique (shopId, lower(name)).

### API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `GET /api/ticket-statuses` | All statuses (for pickers, badges) | `tickets.view` |
| `POST /api/ticket-statuses` | Add | `statuses.manage` |
| `PATCH /api/ticket-statuses/:id` | Rename/recolour/category/notify/hide | `statuses.manage` |
| `PUT /api/ticket-statuses/order` | Reorder (full id list) | `statuses.manage` |

### Out of scope
Per-status allowed-transition editor, per-status SLA timers, automatic status changes (e.g. on part received, Sprint 4), status-based notification templates (Sprint 3), deleting statuses.

---

## 4. Ticket settings

**TS1. As an owner or manager, I want to set ticket defaults, so that check-in needs fewer clicks.**
1. Given `settings.manage`, Settings → Tickets has:
   - **Default turnaround**: 0–30 days, default **2**. Counted in **open days** from business hours (closed days skipped). 0 = same day.
   - **Ticket number prefix**: 0–5 characters `[A-Z-]`, default `T-`. Display-only: changing it changes how all tickets are shown (number stays).
   - **Next ticket number**: default **1001** for new shops; can only be set **higher** than the highest number used (for shops moving from another system).
   - **Delete passcode when the repair is closed**: default on (DV5).
2. Saving writes `shop.ticket_settings_updated` (before/after).

Data: `ShopTicketSettings` (one row per shop, tenant table) `defaultTurnaroundDays`, `numberPrefix`, `deletePasscodeOnClose`; and **ShopCounter** (tenant table) `(shopId, name='ticket')` → `nextValue`.

---

## 5. Tickets

### 5.1 Fast check-in (the core of the product)

**Layout decision (A1):** one **single page** with stacked sections (not a multi-page wizard), so the person can see everything, jump back with Shift+Tab, and finish with one shortcut. Sections complete and collapse into a one-line summary as you go. Route `/tickets/new` (also a "New ticket" button in the top bar, shortcut **N** when not typing).

**TK1. As front desk, I want to check in a returning customer's device in under 60 seconds using only the keyboard.**
1. Given `tickets.create`, When I open New ticket, Then focus is in **Customer search**.
2. **Customer:** When I type a name, phone (any format) or email, Then up to 8 matches show (name, phone, last device); ↑/↓ + Enter selects. The customer note (if any) shows as a callout after selection. Archived customers show with "Restore and use"; erased never show.
3. **Device:** Given the customer is selected, Then their devices list as options (most recently used first, open-ticket badge if the device already has an open ticket); Enter picks the first; "+ New device" (shortcut **D**) opens the inline device form (§2). If the device already has a non-closed ticket, a warning shows "T-1040 is still open for this device" with a link (allowed to continue).
4. **Issues:** a chip list of common issues for the device type (Phone/Tablet: Screen cracked, Display/touch not working, Battery, Charging port, Back glass, Camera, Speaker/mic, Water damage, Won't turn on, Software/updates, Data recovery, Buttons; Laptop/Desktop adds Keyboard, Trackpad, Hinge, Slow/virus, OS install, Fan/overheating; Console adds HDMI port, Disc drive, Controller drift, Overheating). Typing filters chips; Enter toggles; free text "Describe the problem" (≤1000). **At least one chip or a description is required.**
5. **Condition checklist (pre-repair):** items for the device type (Phone/Tablet: Powers on, Screen/touch, Front camera, Rear camera, Buttons, Face ID / Touch ID, Speakers, Microphone, Charging, Wi-Fi/Bluetooth, Liquid indicators; Laptop/Desktop: Powers on, Screen, Keyboard, Trackpad, Ports, Battery, Webcam, Speakers, Charging, Liquid; Console/Watch/Other: a short generic set). Each is **Pass / Fail / Untested**, default **Untested**; keys **P / F / U** set the focused item and move down; "All pass" and "Won't power on (all untested)" shortcuts. Plus "Condition notes" (≤1000, e.g. "scratches on back"). Optional section.
6. **Accessories left:** chips SIM card, SIM tray, Memory card, Case, Charger, Cable, Stylus, Box, Other (text ≤100). Default none ("Nothing left with device").
7. **Estimate:** optional money amount in the shop currency (≥0, max 1,000,000 major units), shown with "incl. tax"/"excl. tax" per the shop's prices-include-tax setting; label "Estimate (approximate)". Help text: "Itemised quotes come with the price list."
8. **Due & priority:** due date prefilled with today + default turnaround (skipping closed days); optional time; priority **Normal** (default) / **Urgent**.
9. **Assign technician:** optional select of active members (anyone can be assigned; technicians listed first); "Unassigned" default.
10. **Create:** Enter on the last field or **⌘/Ctrl+Enter** anywhere creates the ticket. Then I land on the ticket detail with toast "Ticket T-1042 created" and the Print menu (disabled placeholder, §5.10).
11. Measured target: for a returning customer with an existing device, picking 1 issue and defaults, the keyboard path is ≤ 15 keystrokes after typing the search term; median time-to-create < 60 s (instrumented, see DoD).

**TK2. As front desk, I want to create the customer and device inside check-in, so that a new walk-in takes no detour.**
1. Given no match, When I press Enter on "+ New customer '{typed}'", Then an inline quick form opens with the typed text placed in the right field (digits → phone, contains @ → email, else → name: first word first name, rest last name), plus consent switches (unticked).
2. The duplicate check (CU2) runs inline; "Use this customer" swaps it in.
3. New customer and new device are saved **in the same transaction as the ticket** (one `POST /api/tickets` with nested `newCustomer`/`newDevice`), so a failed check-in leaves no half-created records. This needs `tickets.create` **and** `customers.manage` (FD has both).
4. Target for a brand-new customer: under 90 s; under 60 s is the returning-customer target.

**TK3. As front desk, I don't want to lose a half-finished check-in.**
1. Given I've started a check-in, When I refresh or navigate away accidentally, Then the draft (without passcode) is restored from this browser's storage for this user+shop for 24 h, with "Draft restored · Discard".
2. Leaving with unsaved input asks for confirmation.
3. The passcode is never stored in the draft; the field is empty after restore with a note "Enter the passcode again".

**TK4. Ticket numbering (decision A4: gapless).**
1. Given a ticket is created, Then it gets the shop's next number via `UPDATE shop_counters SET nextValue = nextValue + 1 … RETURNING` **inside the creation transaction**. If the transaction fails, the counter rolls back too, so there are **no gaps** and no duplicates. Unique (shopId, number).
2. Displayed as `{prefix}{number}`, e.g. `T-1042`. Search accepts `T-1042`, `t1042`, `1042`.
3. Contention is negligible for 1–8 staff (the row lock is held for one short transaction).

### Check-in edge cases
- Barcode scanner in Customer search: a scanned IMEI/serial finds the device and selects its customer and device in one go.
- Same customer checks in two devices: after create, "Check in another device for {customer}" keeps the customer selected.
- Device has an open ticket: warning, allowed.
- No phone or email on a quick-created customer: blocked (at least one required).
- Estimate entered with a decimal in a PKR shop: rounded to whole rupees on input (PKR shown without decimals; stored ×100).
- Due date before today: not allowed ("Due date can't be in the past"); a time earlier today: allowed only if later than now.
- All business days closed (no open days in hours): turnaround counts calendar days.
- Shop switched in another tab mid check-in: create is rejected with `409 ACTIVE_SHOP_CHANGED` (§8.1); the draft is kept for the original shop.
- Double-click/Enter twice on Create: client disables the button; API accepts an `Idempotency-Key` header (uuid per draft) and returns the same ticket for a repeat within 10 minutes.

### 5.2 Ticket list

**TL1. As anyone in the shop, I want ready-made views with counts, so that I can see the work at a glance.**
1. Given `tickets.view`, When I open Tickets, Then a view switcher shows each view with its count: **All open** (categories open, waiting, ready), **Mine** (assigned to me, not closed), **Unassigned** (open/waiting with no assignee *or* a deactivated assignee), **Ready for pickup** (ready), **Overdue** (open/waiting and due time passed in shop timezone), plus **Closed** (closed; searchable history, no count shown).
2. Technicians land on **Mine** by default; others on **All open**. The last view used is remembered per user on this device.
3. Columns: Ticket # (warranty badge), Customer (name + phone), Device (brand model), Issues (first 2 + "+n"), Status badge, Assignee (avatar/name or "Unassigned"), Due (relative: "Today 5:00 PM", "Tomorrow", "2 days overdue" in a danger tone), Priority (Urgent badge), Created.
4. Filters (combine with the view): Status (multi; hidden statuses in a sub-group), Technician (multi + Unassigned), Priority, Created date range, Due date range, Device type, Warranty only. Filters and sort are in the URL.
5. Search box: ticket number (exact), customer name, phone (any format, as CU5), email, IMEI (full or last 4+ digits), serial (contains). Debounced 250 ms.
6. Sort: default for open views **Urgent first, then due soonest**, then number; options Due, Created (newest), Last updated, Ticket #. Closed view default: closed date newest.
7. Pagination: cursor-based, 25 per page (25/50/100), with "Showing 1–25 of 312".
8. Row click or Enter opens the ticket; ↑/↓ moves focus; "Take" quick action on unassigned rows (assign to me).
9. Counts refresh on window focus and every 60 s.

### 5.3 Ticket detail

**TD1. As front desk or technician, I want one page with everything about the repair.**
1. **Header:** ticket number, status badge, Urgent badge, Warranty link ("Warranty for T-0998" / "Warranty ticket: T-1101"), due (overdue in danger tone), assignee. Actions: **Change status** (menu with allowed statuses, keyboard **S**), **Assign** (**A**), **Add note** (**M**), **Print** (disabled placeholder), overflow: Edit details, Cancel ticket, Reopen, Create warranty ticket. Only actions allowed for my permissions and the ticket state are shown.
2. **Customer card:** name (link), phones with call/WhatsApp links, preferred contact, customer note callout. **Device card:** type, brand model, colour, IMEI/serial, lock type + Show passcode (§2 DV4), link to device history ("3 previous tickets").
3. **Issues & intake:** issues, description, checklist (Pass/Fail/Untested with fail items highlighted), condition notes, accessories, estimate.
4. **Activity timeline** (newest at bottom, composer at bottom; filter: All / Notes / Status changes): created, status changes (from → to, by, when), assignment changes, edits (field: old → new), notes, checklist changes, cancel (reason), reopen (reason), warranty linked, passcode deleted on close. Reserved types for later sprints: `attachment_added` (S3 photos), `message_sent` (S3 notifications), `approval_*` (S3), `item_*` (S3/S4), `payment_*` (S5).
5. **Notes:** composer with a visibility toggle **Internal** (default) / **Customer-visible**. Customer-visible notes have a distinct tone and label "Visible to customer" (they appear on the Sprint 3 status page). 1–2000 chars. The author may edit their own note within **10 minutes** ("edited" marker); no deletion; visibility can't be changed after posting (post a new note instead).
6. Page works at 1024 px: two columns (cards left, timeline right) collapsing to one column on narrower screens.

### 5.4 Status changes and allowed transitions (decision A7)

Permissive with guards. Let `cat(x)` be a status's category.

| From (category) | To | Allowed? | Guard |
|---|---|---|---|
| open / waiting / ready | any visible open / waiting / ready status | ✓ `tickets.edit` | Not the same status (no-op rejected) |
| open / waiting / ready | **Unrepairable** (or any custom ready status) | ✓ `tickets.edit` | Unrepairable requires a note "Why can't it be repaired?" (customer-visible by default, can switch to internal) |
| **ready** | **Collected** (COLLECTED) | ✓ `tickets.cancel` | Only from a **ready** status. Confirm dialog: "Hand the device and these accessories back: {accessories}". Sprint 5 adds "balance must be paid or confirmed unpaid". |
| open / waiting | Collected | ✗ | `409 TRANSITION_NOT_ALLOWED` "Mark it Ready for pickup first, or cancel it if the customer took it back unrepaired." |
| open / waiting / ready | **Cancelled** (CANCELLED) or custom closed | ✓ `tickets.cancel` | Via **Cancel ticket** (TK-C below), reason required |
| closed | anything | ✗ via status menu | Only **Reopen** (TK-R) |
| any | hidden status | ✗ | `409 STATUS_HIDDEN` |

Every successful change: sets `statusId`, `statusCategory`, `statusChangedAt`; `closedAt` when entering closed; writes a `status_changed` timeline event; runs the passcode-deletion rule on close (DV5); updates the customer's `openTicketCount`. The `notifyCustomer` flag of the target status is recorded on the event (`notifyPending: true`) so Sprint 3 can see it, but nothing is sent.

### 5.5 Assignment, due dates, overdue, priority

**AS1. As front desk or technician, I want to assign or take a ticket, so that everyone knows who's on it.**
1. Given `tickets.edit`, When I pick an assignee (any **active** member) or "Unassigned", Then it saves and the timeline shows "Assigned to Sam" / "Unassigned (was Sam)". "Take" assigns to me.
2. A deactivated member stays as assignee on their tickets (shown "Sam (deactivated)") and those tickets appear in **Unassigned** so they get picked up. Deactivated members are not offered in the picker.
3. Assigning doesn't change status.

**DU1. Due dates and overdue in the shop's timezone.**
1. Due is stored as `dueAt` (UTC instant). When only a date is chosen, `dueAt` = that date's **closing time** from business hours in the shop timezone (or 23:59 if the day is closed or hours are missing); `dueHasTime=false` so the UI shows only the date.
2. **Overdue** = category open or waiting **and** `dueAt < now`. Ready and closed tickets are never overdue.
3. **Due today** = category open or waiting **and** `dueAt` falls on today's date in the shop timezone (includes overdue-today, excludes earlier days).
4. DST: computed with the shop zone on that date (a 2-day turnaround over a clock change still lands at closing time).
5. Changing due date or priority writes a timeline event.
6. Priority: Normal / Urgent. Urgent sorts first in queues and shows a badge.

### 5.6 Edit, cancel, reopen, warranty

**TE1. As front desk or technician, I want to correct ticket details while the repair is in progress.**
1. Given `tickets.edit` and a non-closed ticket, I can edit issues, description, checklist, condition notes, accessories, estimate, due, priority. Each save writes one `fields_changed` timeline event listing old → new per field (checklist changes listed per item, so the intake state is always recoverable for disputes).
2. Changing the **device or customer** of a ticket: allowed only for non-closed tickets with `tickets.edit` + `customers.manage` (picks another device of the same or another customer); timeline records it ("Device changed from iPhone 12 to iPhone 13"). For mistakes at the counter.
3. Closed tickets are read-only except adding notes.
4. Optimistic concurrency: edits send the ticket `version`; on mismatch `409 STALE_RECORD` "This ticket changed since you opened it." and the page refetches; my unsaved input stays in the form.

**TK-C. As front desk, I want to cancel a ticket with a reason.**
1. Given `tickets.cancel` and a non-closed ticket, When I choose Cancel ticket, Then I must pick a reason: Customer declined estimate, Customer took device back, Created by mistake, Duplicate ticket, Other (text 3–200 required for Other, optional otherwise).
2. For "declined" / "took back" / "other", a required checkbox "Device and accessories returned to the customer" must be ticked.
3. On confirm the ticket moves to the CANCELLED system status (or the chosen custom closed status), `ticket.cancelled` is audited (reason), and the timeline shows it.

**TK-R. As a manager or front desk, I want to reopen a ticket closed by mistake.**
1. Given `tickets.cancel` and a ticket closed **within the last 7 days** (decision A10), When I click Reopen, choose a target open/waiting/ready status (default: the status before closing) and give a reason (3–200), Then the ticket returns there, `closedAt` clears, `reopenCount` increments, `ticket.reopened` is audited and the timeline shows it.
2. Given it was closed more than 7 days ago, Then Reopen is not offered; for a Collected ticket the action is **Create warranty ticket**, for a Cancelled one **New ticket for this device**.
3. A passcode deleted on close is not restored; the timeline/reopen dialog says "Ask the customer for the passcode again".
4. Reopening a ticket whose customer was erased: allowed; customer shows as "Erased customer".

**TK-W. As front desk, I want to open a warranty ticket linked to the original repair.**
1. Given `tickets.create` and a **Collected** ticket, When I choose Create warranty ticket, Then check-in opens prefilled with the same customer and device, issues empty, a "Warranty for T-0998" banner, and priority Normal.
2. On create, the new ticket stores `warrantyOfTicketId`; both tickets link to each other; the original's timeline shows "Warranty ticket T-1101 opened".
3. A ticket can have several warranty tickets; a warranty ticket can't itself be the original of another (link to the root original instead).
4. Warranty period rules, free-of-charge pricing and warranty reports come in Sprint 5.

### 5.7 Technician queue

**TQ1. As a technician, I want my queue first, so that I know what to do next.**
1. Given I'm a Technician, Then Tickets opens on **Mine** sorted urgent → due, and the dashboard shows my queue (§6).
2. One-tap status change from the list row menu (open/waiting/ready statuses only) and "Take" on unassigned tickets.
3. I see all tickets (small shops share one queue; Sprint 1 out-of-scope note "only my assigned tickets" still applies).

### 5.8 Audit log vs ticket timeline (decision A12)

**Rule:** the **timeline** is the repair's story, visible to everyone with `tickets.view`, written for every change to a ticket. The **audit log** is for security- and compliance-sensitive actions, visible with `audit.view` (O/M). Some actions go to both.

| Action | Timeline | Audit log (`AuditAction`) |
|---|---|---|
| Ticket created, edited, status changed, assigned, note added/edited, checklist changed, warranty linked | ✓ | — |
| Ticket cancelled | ✓ | `ticket.cancelled` (reason) |
| Ticket reopened | ✓ | `ticket.reopened` (from/to status, reason) |
| Passcode revealed | — (device card shows count/last viewer) | `device.passcode_viewed` (deviceId, ticketId) |
| Passcode set/changed/cleared by staff | — | `device.passcode_changed` (no value) |
| Passcode deleted on close | ✓ | — |
| Customer archived / restored | — | `customer.archived` / `customer.restored` |
| Customer exported | — | `customer.exported` (counts) |
| Customer erased | — | `customer.erased` (counts only) |
| Status config changes | — | `ticket_status.created` / `.updated` / `.reordered` |
| Ticket settings changed | — | `shop.ticket_settings_updated` |
| Consent changes | Consent history table | — |

Contracts: extend `AUDIT_ACTIONS`, `AuditEntityType` (+ `Customer`, `Device`, `Ticket`, `TicketStatus`), and `AuditActionGroup` (+ `customers` "Customers & privacy", `tickets` "Tickets", `ticket_settings` "Ticket settings"). **No personal data in audit before/after for customer events**; `entityLabel` is resolved at read time, so an erased customer shows as "Erased customer" in old audit rows.

### 5.9 Data

**Ticket** (new tenant table): `id`, `shopId`, `number` (int, unique per shop), `statusId`, `statusCategory` (denormalised), `statusChangedAt`, `priority` `NORMAL | URGENT`, `customerId`, `deviceId`, `assigneeUserId?`, `issues` (jsonb array of `{ code?: IssueCode, label: string }`, 0–10, ≥1 issue or description), `description?` (≤1000), `checklist` (jsonb `{ itemKey: 'PASS'|'FAIL'|'UNTESTED' }`, keys from the device type's list), `conditionNotes?` (≤1000), `accessories` (jsonb array of codes) + `accessoriesOther?` (≤100), `estimateMinor?` (int ≥0), `currency` (shop currency, snapshot), `dueAt`, `dueHasTime`, `warrantyOfTicketId?`, `cancelReason?` (enum), `cancelNote?`, `closedAt?`, `reopenCount`, `version`, `createdByUserId`, `createdAt`, `updatedAt`, `searchText` (number + customer name/phone digits + IMEI/serial, maintained on write for one-box search).

**TicketNote** (new tenant table): `id`, `shopId`, `ticketId`, `authorUserId`, `visibility` `INTERNAL | CUSTOMER`, `body` (1–2000), `editedAt?`, `createdAt`.

**TicketEvent** (new tenant table, append-only timeline): `id`, `shopId`, `ticketId`, `actorUserId?` (null = system), `type` (enum: `created`, `status_changed`, `assigned`, `fields_changed`, `device_changed`, `customer_changed`, `note_added`, `note_edited`, `cancelled`, `reopened`, `warranty_linked`, `passcode_deleted`, reserved: `attachment_added`, `message_sent`, `approval_requested`, `approval_decided`, `item_added`, `item_removed`, `payment_recorded`), `data` (jsonb per type, e.g. `{ fromStatusId, toStatusId, notifyPending }`), `noteId?`, `createdAt`.

Plus **TicketStatus**, **ShopTicketSettings**, **ShopCounter** (§3–4), Customer/CustomerPhone/CustomerConsentEvent/Device (§1–2). **Isolation test for each of the 10 new tables.**

Contracts constants: `ISSUE_PRESETS_BY_DEVICE_TYPE`, `CHECKLIST_ITEMS_BY_DEVICE_TYPE`, `ACCESSORY_CODES`, `CANCEL_REASONS`, `STATUS_CATEGORIES`, `DEFAULT_TICKET_STATUSES`, `formatTicketNumber(prefix, n)`, `parseTicketNumberQuery()`, `computeDefaultDueAt(now, turnaroundDays, hours, tz)` (pure, unit-tested incl. DST and closed days), `isOverdue()`, `canTransition(from, to, permissions)` (pure, shared by API and UI).

### 5.10 API (suggested)
| Method + path | Purpose | Permission |
|---|---|---|
| `POST /api/tickets` (optional nested `newCustomer`, `newDevice`; `Idempotency-Key`) | Check in | `tickets.create` (+ `customers.manage` if nested creates) |
| `GET /api/tickets?view&status&assignee&priority&createdFrom&createdTo&dueFrom&dueTo&deviceType&warranty&q&sort&cursor&limit` | List + `total` | `tickets.view` |
| `GET /api/tickets/counts` | Counts per view (one grouped query) | `tickets.view` |
| `GET /api/tickets/:id` | Detail (customer, device, status, links) | `tickets.view` |
| `PATCH /api/tickets/:id` (with `version`) | Edit fields, due, priority, device/customer | `tickets.edit` (+ `customers.manage` for device/customer) |
| `POST /api/tickets/:id/status` `{ statusId, note? }` | Change status (guards §5.4) | `tickets.edit`; `tickets.cancel` into closed |
| `POST /api/tickets/:id/assign` `{ userId \| null }` | Assign / unassign / take | `tickets.edit` |
| `POST /api/tickets/:id/cancel` `{ reason, note?, returnedConfirmed }` | Cancel | `tickets.cancel` |
| `POST /api/tickets/:id/reopen` `{ statusId, reason }` | Reopen (≤7 days) | `tickets.cancel` |
| `GET /api/tickets/:id/timeline?cursor&filter` | Timeline (events + notes) | `tickets.view` |
| `POST /api/tickets/:id/notes` · `PATCH /api/tickets/:id/notes/:noteId` | Add / edit own (≤10 min) | `tickets.edit` |
| `POST /api/tickets/:id/passcode/reveal` | See §2 | `tickets.view_passcode` |
| `GET /api/assignees` | Active members for pickers | `tickets.view` |
| `GET/PATCH /api/shop/ticket-settings` | §4 | `settings.view` / `settings.manage` |

Errors: `TRANSITION_NOT_ALLOWED`, `STATUS_HIDDEN`, `REOPEN_WINDOW_PASSED`, `TICKET_CLOSED` (edit on closed), `STALE_RECORD`, `CUSTOMER_ARCHIVED`, `CUSTOMER_ERASED`, `ASSIGNEE_NOT_ACTIVE`, `NOTE_EDIT_WINDOW_PASSED`, `PASSCODE_NOT_AVAILABLE`, `PASSCODE_UNREADABLE`, `ACTIVE_SHOP_CHANGED`, `RATE_LIMITED`.

### 5.11 Screens
- **New ticket** (`/tickets/new`): sections Customer · Device · Issues · Condition · Accessories · Estimate · Due & priority · Technician; sticky footer with summary and "Create ticket ⌘↵"; keyboard hint line. States: empty, draft restored, section errors (scroll to first), creating, create failed (keeps input), shop changed.
- **Tickets list**: view tabs with counts, filter bar, search, table, pagination. States: loading, empty shop ("No tickets yet. Check in your first device."), empty view ("Nothing overdue. Nice."), no results, error.
- **Ticket detail**: header + actions, customer/device cards, intake section, timeline + composer. Dialogs: Change status (with note when required), Collect confirm, Cancel ticket, Reopen, Edit details, Assign, Create warranty ticket. States: loading, not found / other shop (404), stale data banner, read-only closed.
- **Print menu (placeholder):** "Print" button with menu items "Intake receipt" and "Device label", disabled, tooltip "Coming in Sprint 3" (reuse `ComingSoon` pattern).
- **Settings → Ticket statuses**, **Settings → Tickets**.

### 5.12 Ticket edge cases
- Two people change status at once: the second gets `STALE_RECORD` only if they also edited fields; pure status changes are applied in order and both appear on the timeline (no version needed for status/assign; the guard re-checks the current status inside the transaction).
- Status hidden while someone has the menu open: `409 STATUS_HIDDEN`, menu refreshes.
- Status category changed so that its tickets would become closed without going through Collect/Cancel: blocked. A status that holds tickets can't be changed to or from `closed` (`409 STATUS_IN_USE` "Move its tickets first"); changing *between* open/waiting/ready is fine. New custom closed statuses can be added (reached through Cancel ticket).
- Assignee deactivated: §5.5.
- Customer archived while a ticket is open: not possible (CU7 guard).
- Ticket for an erased customer (closed ticket): shown with "Erased customer", no contact links.
- Due date in the past after reopen: allowed; ticket immediately overdue (shown).
- Shop timezone changed: overdue/due today recompute from stored UTC `dueAt`; dates may shift by display only.
- Very long issue text / 10 issues: list shows first 2 + "+n".
- Deep link to a ticket from another shop: `404` (never 403, to avoid leaking existence).
- Technician tries to Collect via API: `403 FORBIDDEN`.

### Out of scope (tickets)
Photos (S3), printing (S3), notifications/status page/estimate approval (S3), signature (S3), services and parts line items (S3/S4), payments and the collect-requires-payment guard (S5), warranty rules (S5), editable issue/checklist lists in settings (S3 with price list), bulk actions on the list, saved custom views, Kanban board, ticket deletion, time tracking per ticket, multiple devices per ticket (one device per ticket; check in a second ticket), appointments/booking (Phase 2), SLA alerts.

---

## 6. Dashboard

**DB1. As anyone in the shop, I want real numbers on the dashboard, so that I see the day at a glance.**
1. Given `tickets.view`, When I open the dashboard, Then the Sprint 0 placeholders are replaced by four tiles: **Open tickets** (open + waiting categories), **Ready for pickup** (ready), **Overdue**, **Due today** (definitions §5.5). Each tile links to the matching list view/filter.
2. Below: **My queue**: up to 10 tickets assigned to me, not closed, sorted urgent → due, with number, device, status, due; "View all" → Mine. If I have none: "Nothing assigned to you." plus the top 5 **Unassigned** with "Take".
3. Front desk also sees a "New ticket" primary button on the dashboard.
4. Tiles refresh on focus and every 60 s; loading shows skeleton tiles; error shows "Couldn't load" + Retry per tile.
5. Counts come from `GET /api/tickets/counts` (same query as the list views, so numbers always agree).
6. Users without `tickets.view` (none in the matrix today) see the Sprint 0 welcome card.

Out of scope: revenue tiles, charts, turnaround stats (Sprint 6 reports).

---

## 7. Global search

**GS1. As front desk, I want one search box for tickets, customers and devices, so that I answer "is my phone ready?" in seconds.**
1. Given I'm anywhere in the app, When I press **/** (while not typing in a field) or **⌘K / Ctrl+K** (anywhere), Then the top-bar search opens as a command palette with focus in the input.
2. With an empty input, Then **Recent** shows my last 10 opened tickets and customers (this user + this shop, stored in this browser; cleared on sign-out; entries that now 404 are dropped).
3. When I type (debounced 200 ms, min 2 chars), Then grouped results: **Tickets** (≤5; matches number, customer name/phone, IMEI/serial; shows number, customer, device, status), **Customers** (≤5; name/phone/email), **Devices** (≤5; IMEI/serial; shows model + owner and opens the latest ticket or the customer). "See all ticket results" opens the ticket list with `q`.
4. ↑/↓ moves, Enter opens, Esc closes. A query that exactly matches a ticket number, a full IMEI or a full serial jumps straight there on Enter (barcode-scanner friendly; the Sprint 3 label barcode encodes the ticket number).
5. Results respect permissions (`tickets.view`, `customers.view`); archived customers are excluded, erased customers never match by name/phone.
6. Quick actions in the palette: "New ticket" (with `tickets.create`), "New customer" (with `customers.manage`).

API: `GET /api/search?q&limit=5` → `{ tickets, customers, devices }`; p95 < 200 ms at the §9 data volume.

---

## 8. Backlog items included

### 8.1 Stale-tab requests cached under the previous shop (from `docs/BACKLOG.md`)
Decision (A13): **request header + reject**, because Sprint 2 adds writes (a check-in sent from a stale tab must never land in the other shop).
**BK1.**
1. Given the web client, Then every shop-scoped API request sends `X-Shop-Id: <activeShopId the page was rendered for>`.
2. Given the header doesn't match the session's active shop, Then the API returns `409 ACTIVE_SHOP_CHANGED` "You switched shop in another tab." and performs nothing (checked in the guard before the handler).
3. Given the web client receives `ACTIVE_SHOP_CHANGED`, Then it discards the response (never writes it into the query cache), refetches `/api/me`, clears shop-scoped cache, and shows a banner "You're now working in {shop}. This page was reloaded."; drafts (check-in) are kept under the original shop key.
4. Shop-scoped responses also echo `X-Shop-Id`; the client drops any response whose echo differs from the key it is cached under (belt and braces for in-flight GETs).
5. Requests without the header (scripts, tests) keep working as today (header optional; mismatch is the only rejection).
6. Tests: API integration (mismatch → 409, nothing written); Playwright with two tabs switching shop then creating a ticket in the stale tab.
7. Update `docs/BACKLOG.md` to move the item to done.

### 8.2 Flaky mocked e2e: onboarding country select
**BK2.**
1. Given `e2e/tests/onboarding.spec.ts`, Then the Country option is chosen via role locators after asserting the listbox is visible and stable (`await expect(page.getByRole('listbox')).toBeVisible()` then click the `option` by name), and Playwright runs with `reducedMotion: 'reduce'` so Astryx animations are skipped in e2e.
2. Done when `pnpm e2e --grep onboarding --repeat-each=50` passes in CI with no failures.
3. Apply the same helper (`selectOption(page, label, option)`) to new Sprint 2 selects (device type, brand, status) to avoid the same flake.
4. Update `docs/BACKLOG.md`.

---

## 9. Performance and search (50k customers, 100k tickets per shop)

**Targets:** list and search p95 < 300 ms API (PRODUCT NFR), global search p95 < 200 ms, check-in create p95 < 300 ms, measured on a seeded shop with **50,000 customers, 70,000 devices, 100,000 tickets, 400,000 timeline events**.

**Approach (decision A14): Postgres only, `pg_trgm` + normalised columns, no search service.**
- Enable `pg_trgm` and `unaccent` extensions (migration). Use an immutable `f_unaccent()` wrapper so it can be indexed.
- **Names/emails:** `customers.searchText` = lower(unaccent(displayName, firstName, lastName, businessName, businessContactName, email)); GIN `gin_trgm_ops`. Query with `ILIKE '%term%'` per word (AND), which the trigram index serves; rank exact/prefix matches first, then `similarity()`.
- **Phones:** `customer_phones.digits` (E.164 without "+") with GIN trigram. The query is first normalised with `normalizePhone(q, shopCountry)`; if valid → exact `e164 =` (btree); else digits-only substring (≥4 digits) via trigram. This makes `0300-1234567`, `+92 300 1234567` and `1234567` all work.
- **IMEI/serial:** stored normalised; btree for exact (`imei =`, `serial =`), GIN trigram for partial (≥4 chars).
- **Ticket number:** `parseTicketNumberQuery()` → exact `(shopId, number)` unique index.
- **Ticket list:** denormalised `statusCategory` makes every view a simple indexed filter. Indexes: `(shopId, statusCategory, priority desc, dueAt)`, `(shopId, assigneeUserId, statusCategory, dueAt)`, `(shopId, createdAt desc)`, `(shopId, closedAt desc)`, `(shopId, customerId)`, `(shopId, deviceId)`, `(shopId, number)` unique, GIN trigram on `tickets.searchText` for the list's one-box search. Keyset (cursor) pagination on the sort key + id; `total` via a count on the same filter (fast with these indexes; for >10k matches the UI shows "10,000+").
- **Counts per view:** one query `count(*) FILTER (WHERE …)` per view over the non-closed tickets (closed excluded by index), so cost grows with *open* tickets (hundreds), not history.
- **Timeline:** `(shopId, ticketId, createdAt)`, cursor-paginated (50).
- All tenant indexes lead with `shopId` (RLS + scoped client).
- `EXPLAIN` checks for the list, counts, customer search, phone search, IMEI search and global search are saved in the PR; a `pnpm db:seed:perf` script creates the dataset; a k6 or autocannon smoke run reports p95.

---

## 10. US / UK / PK specifics

| Topic | US | UK | PK |
|---|---|---|---|
| Phone input/display | `(212) 555-0142` → `+12125550142` | `07911 123456` → `+447911123456`; landlines `020 …` | `0300 1234567` / `03001234567` → `+923001234567`; landline `042 35761234` |
| Default preferred contact | SMS | SMS | **WhatsApp** (primary phone) |
| Names | First + last; last optional | First + last; last optional | Often a single name or "Ali Khan"; last optional; no father's-name field |
| Business customers | Common (offices, schools) | Common | Common (dealers, shops sending devices) |
| Marketing consent | Separate per channel; TCPA warning for verbal SMS consent | Separate per channel, opt-in, no pre-ticked boxes (PECR/UK GDPR); soft opt-in not automated | Separate per channel incl. WhatsApp; same opt-in pattern |
| Date display | MM/DD/YYYY, 12 h | DD/MM/YYYY, 24 h | DD/MM/YYYY, 12 h (locale en-GB, time format follows locale) |
| Address | ZIP + State select | Postcode + County | Postal code + Province select |
| Popular brands seeded | Apple, Samsung, Google, Motorola | Apple, Samsung, Google | + Infinix, Tecno, Xiaomi/Redmi, Oppo, Vivo, Realme |

---

## Cross-cutting contract/data changes (summary)
- contracts: customer, phone, consent, device (IMEI Luhn, serial, pattern), ticket (create with nested, edit, status, cancel, reopen, notes, list query, counts), status config, ticket settings, search; constants (issues, checklist items, accessories, cancel reasons, default statuses, catalogue); pure helpers (`canTransition`, `computeDefaultDueAt`, `isOverdue`, `formatTicketNumber`, `parseTicketNumberQuery`); `SPRINT2_ENFORCED_PERMISSIONS`; audit actions/entity types/groups.
- db: 10 new tenant tables (Customer, CustomerPhone, CustomerConsentEvent, Device, Ticket, TicketNote, TicketEvent, TicketStatus, ShopTicketSettings, ShopCounter) with RLS + isolation tests; `pg_trgm`/`unaccent`; default statuses + settings seeded for new shops and migrated for existing ones.
- api: `X-Shop-Id` guard; field encryption service (AES-256-GCM, key id, startup check); idempotency for ticket create.
- web: check-in page, tickets list/detail, customers list/detail/form, device form + pattern grid, settings pages, dashboard tiles, command palette.

## Definition of Done for Sprint 2
- [ ] Check-in: keyboard-only Playwright happy path (returning customer + existing device; and new customer + new device) creates a ticket; time-to-create is instrumented (PostHog `ticket_created` with `durationMs`, `path: returning|new`); a 5-person hallway test with the seed data has **median < 60 s** for the returning path (result noted in the PR).
- [ ] Ticket numbers are gapless and unique under concurrency (test: 20 parallel creates + forced failures → contiguous numbers).
- [ ] Customers: create/edit/archive/restore, duplicate warning, consent events, export JSON, erase (blocked with open tickets; anonymises as specified) with API tests per rule.
- [ ] Devices: IMEI Luhn/serial validation tests; passcode encrypted at rest (test reads raw DB and finds no plaintext), reveal only on open ticket, audited, rate-limited; passcode deleted on close when the setting is on.
- [ ] Statuses: defaults seeded and migrated; rename/reorder/add/hide/category change with rules and audit; transitions per §5.4 enforced by the shared `canTransition` (unit-tested matrix) and API tests for each guard.
- [ ] Ticket list views, filters, search, sort, cursor pagination and counts agree with the dashboard tiles (one test asserts the same numbers).
- [ ] Overdue/due-today/default due computed in shop timezone with DST and closed-day tests (US and UK).
- [ ] Timeline records every event type in §5.8; audit events written in the same transaction (one test per new audit action); no PII in customer audit payloads.
- [ ] Global search with `/` and ⌘K, recent items, exact-match jump.
- [ ] Performance: perf seed + saved EXPLAINs + p95 numbers meeting §9 targets.
- [ ] Backlog: `X-Shop-Id` mismatch → 409 with two-tab Playwright test; onboarding e2e green 50× in a row; `docs/BACKLOG.md` updated.
- [ ] Tenant isolation tests for all 10 new tables; cross-shop 404 tests for ticket, customer, device ids.
- [ ] Permissions: every new route declares a permission; UI hides actions per `/api/me` permissions; Technician cannot create, collect, cancel, reopen, edit customers/devices (API tests).
- [ ] ROADMAP Definition of Done (Astryx only, axe, 1024 px, CI green, code review, docs/changelog).

## Riskiest items (in order)
1. **Check-in speed.** The whole product promise; a slow or mouse-dependent form fails it. Needs early design review and the timed hallway test, not just a passing e2e.
2. **Search performance and correctness** (phone in any format, trigram indexes, counts) at 50k/100k; wrong index choices show up only with realistic data, so the perf seed must land in week 1.
3. **Passcode security**: encryption, key handling, no leaks into logs/drafts/exports/audit, reveal guard and rate limit.
4. **GDPR erase semantics**: what is deleted vs kept must hold up and stay compatible with Sprint 5 invoices; audit rows must not keep PII.
5. **Configurable statuses + denormalised category**: category changes, hidden statuses and guards must keep views, dashboard and transitions consistent.
6. **Timezone/DST logic** for due/overdue and turnaround over closed days.
7. **Concurrency**: gapless numbering, optimistic edits, double-submit (idempotency), stale-tab shop mismatch.
8. **Scope size**: this is the biggest sprint so far (10 tables, ~6 screens). If it slips, cut in this order: device model suggestions from shop history → consent history panel UI (keep the data) → global search recent items → customer list filters beyond search/archived.

## Decisions made by the analyst (for the tech lead to confirm)

| # | Decision | Reason |
|---|---|---|
| A1 | Check-in is **one keyboard-first page** with collapsible sections and ⌘/Ctrl+Enter to create, not a multi-step wizard; new customer/device are created in the **same transaction** as the ticket; drafts saved locally (no passcode). | Fewer screen changes = faster; no orphan records; refresh-safe. |
| A2 | Customer needs a name (first name **or** business name) and **at least one phone or email**; last name optional. Up to 3 phones, one primary. Address limited to the shop's country. | PK single names and walk-ins; shop must be able to contact the customer. |
| A3 | **No new permission keys.** `tickets.edit` covers status (non-closed), assignment, notes; `tickets.cancel` is clarified as the **close lifecycle** key: Collect, Cancel, Reopen. Technicians can't collect/cancel/reopen. | Matrix is fixed and snapshot-tested; handing the device back is a counter job. |
| A4 | Ticket numbers are **gapless**: per-shop counter row incremented inside the create transaction; default prefix `T-`, start **1001**; next number can only be raised. | Small shops expect no gaps; contention is negligible at 1–8 staff. |
| A5 | Duplicate detection = exact match on normalised phone (any of the customer's) or email, **warn only, never block**, includes archived (offer restore). | Families/businesses share numbers. |
| A6 | **Merge duplicates is out of scope** (backlog, Sprint 6). | Not trivial: devices, tickets, consent conflicts. |
| A7 | Transitions are permissive among open/waiting/ready; **Collected only from a ready status**; Cancel needs a reason (+ "device returned" confirmation); closed tickets change only via Reopen; Unrepairable needs a note. Sprint 5 adds the payment guard on Collect. | Prevents the two costly mistakes (handing back unfinished devices silently, losing why a ticket ended) without a workflow editor. |
| A8 | **Unrepairable is in the `ready` category** (device still to be handed back via Collected). | Every device leaves through Collected or Cancelled; shows in Ready for pickup. |
| A9 | Statuses can't be deleted, only hidden; system statuses (Received, Collected, Cancelled) can be renamed but not hidden or re-categorised; max 20; an in-use status can't be changed to closed. | Keeps history and views consistent. |
| A10 | **Reopen allowed within 7 days** of closing (for mistakes); after that, warranty ticket (Collected) or new ticket (Cancelled). Warranty ticket links to the root original. | Keeps "reopen" from becoming a second warranty path. |
| A11 | **Erase** anonymises the customer and strips IMEI/serial/passcode/colour from devices, deletes consent history, keeps tickets (and ticket notes) as repair records; blocked while any ticket is open/waiting/ready. **Export** excludes passcodes and internal notes (internal staff notes are shop records, not shared by default). | Right to erasure vs keeping business/financial records; device still in shop must be finished first. *Alternative if the tech lead prefers stricter: also redact ticket note bodies on erase.* |
| A12 | Timeline vs audit split as in §5.8: timeline for the repair story; audit for passcode views/changes, customer archive/export/erase, cancel/reopen, status and ticket-settings config. Consent has its own append-only history. No PII in customer audit payloads; labels resolved at read time. | Technicians need the story; owners need the security trail; erased names must not survive in the audit log. |
| A13 | Stale-tab fix: web sends `X-Shop-Id`, API rejects a mismatch with `409 ACTIVE_SHOP_CHANGED`, responses echo `X-Shop-Id`, client discards mismatches. | Sprint 2 adds writes; a stale-tab check-in must never land in the wrong shop. |
| A14 | Search = Postgres `pg_trgm` + `unaccent` with normalised columns (phone digits/E.164, IMEI, serial, ticket number) and denormalised `statusCategory`; no external search service. | Meets p95 targets at 50k/100k; fits ARCHITECTURE "no extra service". |
| A15 | Passcode: AES-256-GCM with `FIELD_ENCRYPTION_KEY` + key id; reveal only from a **non-closed ticket**, 30 s display, 30 reveals/user/hour; API refuses to start in production with a missing/placeholder key; **passcode deleted on close** by default (shop setting). | Minimises how long and where passcodes are exposed. |
| A16 | Due date default = today + **2 open days** (business hours skip closed days), due time = closing time unless set; overdue/due today apply to open+waiting only, in shop timezone. | Matches how shops promise "ready by Thursday"; ready tickets aren't late. |
| A17 | Marketing consent: separate SMS/email/WhatsApp switches, unticked, with source and timestamp, append-only history; plus per-channel "service updates opt-out". PK defaults preferred contact to WhatsApp. US verbal SMS consent shows a TCPA warning. | UK GDPR/PECR and TCPA basics; PK runs on WhatsApp. |
| A18 | Issue presets, checklist items and the model catalogue are **built-in constants** in contracts for Sprint 2 (not editable); editing comes with the Sprint 3 price list. | Ships the fast path now without a settings UI. |
| A19 | Recent items in global search are stored per user+shop **in the browser**, cleared on sign-out. | Good enough for MVP; no new table. |
| A20 | Notes: internal by default; author can edit within 10 minutes; no deletion; visibility fixed after posting. Statuses carry `notifyCustomer`, recorded on status events as `notifyPending` for Sprint 3. | Customer-visible history must not be rewritten later. |
| A21 | One device per ticket; multiple devices = multiple tickets ("Check in another device for {customer}"). | Simpler status/tech assignment per device; matches labels in Sprint 3. |

---

## Tech lead decisions (binding for Sprint 2)

All analyst decisions A1–A21 are **accepted** as written, with these clarifications:

| # | Clarification |
|---|---|
| A3 | Accepted: no new permission keys; `tickets.cancel` covers collect/cancel/reopen. Update the JSDoc in `packages/contracts/src/permissions.ts` to say so. |
| A11 | Accepted as written (ticket notes are kept as repair/warranty business records). Erasure keeps no customer name, phone, email or address anywhere, including the audit log and denormalised search columns, and the search index must not retain erased values. |
| A13 | Accepted and required this sprint: the `X-Shop-Id` header is sent by the web app on every shop-scoped request; the API returns `409 ACTIVE_SHOP_CHANGED` on mismatch; requests without the header are still accepted (API clients, tests) but the web app always sends it. |
| A15 | Accepted. Reveal is a POST (never GET), the response is `Cache-Control: no-store`, and the passcode never appears in logs, audit `before/after`, exports or the ticket timeline. |
| Size | If the sprint slips, cut in the analyst's cut order; never cut the isolation tests, passcode security or check-in speed. |
