# Sprint 2: customers, devices and tickets screens

Builds on `sprint0-shell.md` and `sprint1.md` (their shared rules still apply). Source of truth for behaviour: `docs/stories/sprint2-customers-and-tickets.md` (its "Tech lead decisions" table wins; A1–A21 accepted) and the Zod contracts in `packages/contracts/src` (merged at `d02ee20`). **Every screen below names the exact contract schemas, constants, helpers and paths it uses**, so the build is mechanical: parse every response with the named schema, validate every form with the named input schema (react-hook-form + `zodResolver`), take every label from the named `*_LABELS` constant.

Astryx v0.7.17 only, tokens only. Templates and components were picked with `pnpm exec astryx build|template|component|docs` (listed per screen). The check-in page was proven with a clickable prototype first (§2.10).

- **Prototype:** removed once the real page shipped (see §12); `/tickets/new` replaced it.
- **Screenshots:** `docs/screens/sprint2/*-{1440x900,1024x768}.png` of the built pages against the mocked API (regenerate with `pnpm --filter @repairos/e2e screenshots`).
- **Keyboard proof:** `e2e/tests/check-in.spec.ts` (keyboard-only on the real page, counts keystrokes: 7 and 49 after the search term, as in the prototype).

## 0. Shared for Sprint 2

### 0.1 Components already built (apps/web, contract-backed, unit-tested in `src/components/ui/ui.test.tsx`)

| Component | File | Use it for | Contract inputs |
|---|---|---|---|
| `StatusBadge` | `components/ui/StatusBadge.tsx` | Every ticket status (lists, header, timeline, search, dashboard) | spread a `StatusRef` / `TicketStatus`: `name`, `category: StatusCategory`, `colour: StatusColour`. Tone = colour, else category tone; icon per category (Open wrench, Waiting pause, Ready check, Closed archive) so it is never colour-only. |
| `DueChip` | `components/ui/DueChip.tsx` | Due in lists ("Today 17:00", "Tomorrow", "Fri", "9 Dec", "2 days overdue"), `format="absolute"` in the ticket header | `dueAt`, `dueHasTime`, `category` (+ shop `{timezone, locale}`, injected `now`). Overdue via contract `isOverdue` (OPEN/WAITING only): error badge + warning glyph; due today: warning badge; else plain secondary text. Tooltip carries the other form. |
| `MoneyText` | `components/ui/MoneyText.tsx` | Estimate and later all money | `Money.amountMinor` + `currency`, `taxNote` from `estimateIncludesTax`; `formatMoney` (PKR without decimals). |
| `PhoneText` | `components/ui/PhoneText.tsx` | Customer phones | E.164 + shop country → `formatPhone`; `isCallable` = `tel:` link; `hasWhatsApp` = `whatsappLink` (show for the customer's `whatsappPhoneId`, never for `LANDLINE`). |
| `ShortcutHint` / `ShortcutHints` | `components/ui/ShortcutHint.tsx` | Key hints next to actions and hint lines | Astryx `Kbd` keys (`mod+enter`, `/`, `escape`, `["up","down"]`). |
| `PatternLockInput` | `components/ui/PatternLockInput.tsx` | Pattern entry (device form) and reveal (`isReadOnly`) | `PatternLock` / `formatPattern` rules via `lib/pattern-lock.ts`. |
| `RovingGroup` | `components/ui/RovingGroup.tsx` | One Tab stop for chip groups and the pattern grid (Astryx `useListFocus`, roving tab index) | — |

Still to build (composites from Astryx parts, in apps/web): `PasscodeReveal` (§3.2), `TicketTimeline` (§7.4), `CustomerDuplicatePanel` (§4.4), `ConsentEditor` (§4.5), `TicketStatusMenu` (§7.2), `CommandSearch` (§10).

### 0.2 Data rules
- **Active shop header (A13, binding):** `apiFetch` now sends `SHOP_ID_HEADER` (`X-Shop-Id`) on every shop-scoped path (`isShopScopedPath`; not `/api/me*`, `/api/auth/*`, `/api/shops`, `/api/invites/*`, `/api/dev/*`), set from the rendered shop by `SessionProvider` (`setRequestShopId`). A response whose echoed `X-Shop-Id` differs is discarded (thrown as `ACTIVE_SHOP_CHANGED`, never cached); `ACTIVE_SHOP_CHANGED` from the API or the echo check refetches `/api/me` (providers `onError`). Still to build: the banner "You're now working in {shop}. This page was reloaded." (warning `Banner`, dismissable, same slot as the access-removed banner) and keeping check-in drafts under the original shop's `checkInDraftKey`.
- **Query keys:** shop-scoped `['shop', shopId, …]` as in Sprint 1 (`qk` in `lib/queries.ts`): add `tickets(view, query)`, `ticketCounts`, `ticket(id)`, `timeline(id, filter)`, `customers(query)`, `customer(id)`, `customerDevices(id)`, `statuses`, `ticketSettings`, `assignees`, `dashboard`, `search(q)`, `checkInContext`.
- **Status changes** are optimistic (TanStack Query `onMutate` → set the badge, roll back on error with an error toast).
- **Counts** (`TicketCounts`) refresh on window focus and every `TICKET_COUNTS_REFRESH_MS`; lists and dashboard use the same query so numbers agree.
- **Errors:** copy from `API_ERROR_MESSAGES[code]` via `lib/errors.ts` (Sprint 1 rule). `STALE_RECORD`: keep the user's input, show the contract message in a warning `Banner` with "Reload" (refetch, form keeps values where unchanged).
- **Permissions:** `can(me.permissions, …)` only; table in story §0. Hidden actions are never the only guard.
- **Selects in e2e:** use `selectOption(scope, label, option)` (`e2e/tests/support/select.ts`) for every Astryx `Selector` (BK2.3).

### 0.3 Global keyboard map (registered with Astryx `useHotkeys`, shown with `Kbd`)

| Key | Where | Does |
|---|---|---|
| `N` | anywhere, not typing | New ticket (`/tickets/new`) when `tickets.create` |
| `mod+K` | anywhere, also while typing | Open global search (§10) |
| `/` | anywhere not typing, **except** `/tickets/new` and lists with their own search | Open global search |
| `/` | check-in, ticket list, customer list | Focus that page's search box (page search wins over the palette, like GitHub; `mod+K` still opens the palette) |
| `S` / `A` / `M` | ticket detail, not typing | Change status / Assign / Add note |
| `↑` `↓` `Enter` | ticket list, customer list rows | Move row focus / open |
| `Esc` | any dialog, menu, palette, inline form | Close / cancel (Sprint 1 rule: form dialogs ask before discarding typed input) |

Every shortcut has a visible control; `Kbd` hints sit next to that control or in the page's hint line, never as the only way.

---

## 1. Screen inventory

| Screen | Route | Template (`astryx template …`) | Permission |
|---|---|---|---|
| Check-in | `/tickets/new` | `form-wizard-inline` (stacked steps that collapse to a summary) + `payment-form` (pinned summary + commit) | `tickets.create` |
| Ticket list | `/tickets` | `table-page` (Searchable Table) + `TabList` views; filter bar from `table-filter` | `tickets.view` |
| Ticket detail | `/tickets/[id]` | `work-item-detail` (title + status selector, activity feed, property rail) | `tickets.view` |
| Customer list | `/customers` | `table-page` | `customers.view` |
| Customer detail | `/customers/[id]` | `detail-page` (summary header + actions, rail) with `TabList` | `customers.view` |
| Customer create / edit | `/customers/new`, `/customers/[id]/edit`; dialog variant | `settings` (single scrolling form, 640 column); dialog = `Dialog` + `FormLayout` | `customers.manage` |
| Device add / edit | dialog | `Dialog` + `FormLayout` (`form-wizard-dialog` sizing) | `customers.manage` |
| Settings → Ticket statuses | `/settings/statuses` | Sprint 1 `settings-sidebar` frame; `List` with `createReorderable` | `statuses.manage` |
| Settings → Tickets | `/settings/tickets` | Sprint 1 settings frame, `FormLayout` 640 | view `settings.view`, edit `settings.manage` |
| Dashboard | `/` | `dashboard` (headline tiles, then tables) | `tickets.view` (else Sprint 0 card) |
| Global search | top bar | `shell-nav` command-palette pattern; `CommandPalette` | `tickets.view` / `customers.view` |

Add to `SETTINGS_NAV` (`lib/permissions.ts`): "Ticket statuses" (`statuses.manage`), "Tickets" (`settings.view`), after Business hours. Side nav "Tickets" and "Customers" lose their `ComingSoon`.

---

## 2. Check-in (`/tickets/new`) — A1

**Purpose:** a front-desk person checks in a device in under 60 s, keyboard only. **Primary user:** front desk (FD/M/O). **Entry points:** top bar "New ticket", `N`, dashboard "New ticket", customer page "New ticket" (`?customerId=`), device row "New ticket for this device" (`?customerId=&deviceId=`), "Create warranty ticket" (`?warrantyOf=<ticketId>`), "Check in another device for {customer}" (keeps the customer).

### 2.1 Data
| When | Call | Contract |
|---|---|---|
| Page load | `GET TICKET_PATHS.checkInContext` | `CheckInContext` (currency, locale, timezone, `pricesIncludeTax`, `hours`, `defaultTurnaroundDays`, `numberPrefix`, `defaultDue`). FD has no `settings.view`, so this is the only settings read. |
| Customer search | `GET CUSTOMER_ACTION_PATHS.list?q=` (limit 8, debounce `LIST_SEARCH_DEBOUNCE_MS`) | `CustomerListResponse` → `CustomerListItem` (archived customers must be included and flagged, see R5) |
| Full IMEI / serial typed or scanned | `GET DEVICE_ACTION_PATHS.lookup?imei=|serial=` | `DeviceLookupResponse` → selects customer + device |
| Customer chosen | `GET CUSTOMER_ACTION_PATHS.devices` | `DeviceListResponse` (sort by `lastTicketAt` desc; `openTicket` → warning) |
| New customer typing | `GET CUSTOMER_ACTION_PATHS.duplicates?phone|email` after `DUPLICATE_CHECK_DEBOUNCE_MS` | `DuplicateCheckResponse` |
| Model field | `GET DEVICE_ACTION_PATHS.modelSuggestions?type&brand&q` | `ModelSuggestionsResponse` (see R1 for the one-box search) |
| IMEI on another customer's device | `GET DEVICE_ACTION_PATHS.lookup?imei=` | `DeviceLookupResponse` → "This IMEI is on {customer}'s {model} (last ticket T-1033)." |
| Technician list | `GET TICKET_PATHS.assignees` | `AssigneesResponse` (Technicians first) |
| Create | `POST TICKET_PATHS.create` with headers `IDEMPOTENCY_KEY_HEADER: <uuid per draft>` and `SHOP_ID_HEADER` | body validated with `createTicketSchema(ctx.country)` (`CreateTicketInput`); 201/200 → `TicketDetail` |

Body mapping (proven by the prototype: its body passes `createTicketSchema`): existing customer → `customerId`, else `newCustomer` (`CreateCustomerInput`: `kind`, `firstName`, `lastName`, `email`, `phones: [{ number, label: 'MOBILE' }]`, `consents: ConsentChangeInput[]` with `source`); existing device → `deviceId` (+ `devicePasscode: PasscodeInput` only when the lock was re-entered), else `newDevice` (`CreateDeviceInput` with `passcode: PasscodeInput`); `issues: [{ code: IssueCode }]` or `{ label }` for free text; `description`; `checklist` (only touched items; API fills UNTESTED); `conditionNotes`; `accessories: AccessoryCode[]` + `accessoriesOther`; `estimate: { amountMinor: parseMajorAmount(text, currency), currency }` or null; `dueDate` (+ `dueTime`); `priority: TicketPriority`; `assigneeUserId`; `warrantyOfTicketId`.

### 2.2 Layout (1440 and 1024)
Inside the AppShell content: one column, `maxWidth 760`, `gap 4` (the `form-wizard-inline` column), left-aligned with the page heading. At 1440 the right side stays empty on purpose (eyes go straight down the column; a side summary was tried in thought and dropped: the pinned footer already shows the summary and keeps the commit next to it). At 1024 the side nav is collapsed to icons (Sprint 0 contract) and the column is 760 of ~900.

| Region | Astryx | Content |
|---|---|---|
| Header | `VStack gap 2`: `HStack` (`Heading` h1 "New ticket", warranty `Badge` "Warranty for T-0998" when `warrantyOf`) + `ShortcutHints` | Hints: `↵` Choose and go on · `mod ↵` Create ticket · `/` Customer search · `Esc` Close or cancel |
| Banners | `Banner` | Draft restored (info: "Draft restored from {time}." + "Discard" button), shop changed (warning), create failed (error, contract copy) |
| Sections 1–6 | `Card padding 5` each, containing `VStack as="section" aria-labelledby` + header row: step number `Text` or success `Icon` "Done", `Heading` h2, "Optional" `Text`, one-line summary `Text maxLines 1` when done, ghost `Button` "Change" | see §2.3 |
| Footer | `Card padding 4 elevation med`, sticky to the bottom of the scroll region (the one inline style, as in the `payment-form` template's sticky column, with `var(--spacing-4)`), `VStack as="section" aria-label="Ticket summary"` | errors `Banner`, `HStack between`: summary `Text maxLines 1 aria-live polite` + `Kbd mod+enter` + primary `Button` "Create ticket"; supporting line "Drafts are kept on this device for 24 hours, without the passcode." |

### 2.3 Sections

**1 · Customer** (required)
- Not chosen: `Typeahead` label "Find customer" (label hidden), placeholder "Name, phone, email, or scan an IMEI", `startIcon="search"`, `hasAutoFocus`, `minQueryLength 2`, `maxMenuItems 9`, `debounceMs 150` (+ the API debounce). Items: `TypeaheadItem` with `description` = "{primary phone} · {last device}"; archived: "Archived · Restore and use"; device match: "IMEI match: {device}". Always last item: `PlusIcon` "New customer “{typed}”" with description "Add them without leaving check-in". Empty search text: "No customers found".
- Chosen (existing): summary "{displayName}"; body: `PhoneText isCallable` + email; customer note as info `Banner` "Customer note" (`CustomerDetail.notes`); archived (chosen via "Restore and use"): the page calls `CUSTOMER_ACTION_PATHS.restore` first, then shows a warning `Banner` "Archived customer" / "Restored. They're back in lists and search." (R5).
- New customer (inline quick form, TK2): `Grid columns {minWidth 200, max 2}`: First name (required), Last name (optional), Phone (`type tel`, description "Mobile, for repair updates"), Email (optional). Typed text placed by `splitQuickCreateText`. Below: `CustomerDuplicatePanel` (§4.4) when `DuplicateCheckResponse` has matches. `Collapsible` "Marketing consent · none given" (closed by default; switches never pre-ticked) with three `Switch`es ("Marketing by SMS / email / WhatsApp") and, when any is on, `Selector` "How was consent given?" (`CONSENT_SOURCE_LABELS` of IN_STORE_VERBAL, IN_STORE_SIGNED, ONLINE_FORM) with `TCPA_VERBAL_SMS_WARNING` as description when `showTcpaWarning`. Then "Use this customer" `Button` + hints "`↵` in Phone or Email", "`Esc` back to search". Preferred contact is not asked here: `defaultPreferredChannel(country)` (PK WhatsApp, else SMS).
- Errors: "Enter a first name", "Add a phone number or an email" (contract copy from `customerRecordIssues`), phone "Enter a valid phone number" on blur (`normalizePhone`).

**2 · Device** (required)
- Before a customer: `Text` "Choose the customer first. Their devices show here."
- Existing customer with devices: `RadioList` (label hidden) of devices sorted by `lastTicketAt`, first one checked; each `RadioListItem` label `deviceLabel(d)`, description "{`DEVICE_TYPE_LABELS`} · {colour} · IMEI {`maskIdentifier`} · Passcode on file | {`LOCK_TYPE_LABELS`} · {openTicket.numberLabel} still open"; last item "New device" ("Or press D in this list"). `d.openTicket` → warning `Banner` "{T-1040} is still open for this device" + "You can still check it in, for example for a second fault." with a `Link` to the ticket. `ShortcutHints`: `↑ ↓` Choose · `↵` Use device · `D` New device.
- New device (inline, same fields as the dialog §5): Model first (R1), then Type `Selector` (`DEVICE_TYPE_LABELS`) · Brand (`DEVICE_BRANDS_BY_TYPE[type]` + `OTHER_BRAND`; prototype uses a text field filled by the model pick) · Colour (`DEVICE_COLOUR_SUGGESTIONS`) · IMEI (only `IMEI_DEVICE_TYPES`) · Serial · Lock `SegmentedControl` (`LOCK_TYPE_LABELS`, default NONE) · PIN/Password `TextInput type password` (`PinCode` / `PasswordCode`) or `PatternLockInput` · "Use this device" · "Back to their devices".
- Passcode note under the field: "Encrypted. Staff see it only on an open ticket; deleted when the repair is closed."
- Existing device whose passcode was deleted on close (`passcodeOnFile false`, lockType secret): small "No passcode on file · Add" link opening the lock fields (→ `devicePasscode`).

**3 · Issues** (an issue or a description is required)
- Filter `TextInput` (label hidden "Find an issue", placeholder "Type to filter, ↵ to add (scr → Screen cracked)") over `ToggleButtonGroup type multiple size sm` chips from `ISSUE_PRESETS_BY_DEVICE_TYPE[type]` with `ISSUE_LABELS`, wrapped in `RovingGroup` (one Tab stop). Pressed chips show a check `pressedIcon`. While filtering: only matching chips (word-prefix first) + hint "`↵` adds “Screen cracked”". Max `MAX_TICKET_ISSUES`.
- `TextArea` "Describe the problem" (optional, `maxLength 1000`, counter, placeholder "What the customer told you, in their words"); a description alone satisfies the rule.

**4 · Condition** (optional): `Collapsible` closed by default, trigger "Pre-repair checklist · 0 pass · 0 fail · 11 untested". Inside: "All pass" and "Won't power on (all untested)" buttons, hints `P` pass · `F` fail · `U` untested (`CHECKLIST_RESULT_KEYS`), one row per `CHECKLIST_ITEMS_BY_DEVICE_TYPE[type]`: label + `SegmentedControl size sm` Pass/Fail/Untested (`CHECKLIST_RESULT_LABELS`); `P/F/U` sets the focused row and moves to the next; "Condition notes" `TextArea`.

**5 · Accessories left** (optional): chips from `ACCESSORY_CODES` / `ACCESSORY_LABELS` in a `RovingGroup`; "Other" reveals "What else?" (required then: "Say what else was left"); summary text `accessoriesSummary` or `NO_ACCESSORIES_LABEL`.

**6 · Estimate, due date and technician**: `Grid {minWidth 200, max 2}`:
- `InputGroup` "Estimate (approximate)", optional, prefix `InputGroupText` (£ / $ / Rs), description "incl. tax | excl. tax · itemised quotes come with the price list"; `inputMode decimal`; parsed with `parseMajorAmount` (PKR rounds to whole rupees as you leave the field); error "Enter an amount" / `EstimateInput` messages ("Use 1,000,000 or less").
- `DateInput` "Due" (`presentation popover`, `min` today), default `ctx.defaultDue.date`, description "{n} open days, by closing time"; optional time via a "Set a time" `Link` revealing `TimeInput` (15-min steps); `dueInputProblem` errors ("Due date can't be in the past", "Choose a time later than now"). Picking another date recomputes with `dueAtFor` client-side for the summary only (the API recomputes).
- Priority `SegmentedControl` Normal / Urgent (`TICKET_PRIORITY_LABELS`).
- Technician `Selector` "Unassigned" + `AssigneesResponse` items ("{name} (you)", role description).

### 2.4 Tab order (as built in the prototype, measured with Playwright)
Focus starts in **Find customer** (autofocus). `Shift+Tab` from there reaches the top bar (skip link, shop, search, clock, New ticket, account) and the side nav, as everywhere.

1. Find customer → (results are a listbox: `↑ ↓`, not Tab stops)
   - when chosen: Change (customer) → phone link
   - new customer: First name → Last name → Phone → Email → Marketing consent → [3 switches → source] → Use this customer
2. Device radio group (one stop, `↑ ↓`)
   - new device: Model → Clear selection (chip ×) → Type → Brand → Colour → IMEI → Serial → Lock (one stop, `← →`) → PIN/Password field **or** pattern grid (one stop via `RovingGroup`) → Use this device → Back to their devices
3. Find an issue → issue chips (one stop) → Describe the problem
4. Condition disclosure → [All pass → Won't power on → one stop per checklist row → Condition notes]
5. Accessory chips (one stop) → [What else?]
6. Estimate amount → Open calendar → Due → Priority (one stop) → Technician
7. Create ticket

Before `RovingGroup` the walk had 12 + 9 + 9 extra stops (issue chips, accessories, pattern dots): every chip group is now a single stop.

### 2.5 Shortcuts and focus moves
| Key | Context | Effect / focus |
|---|---|---|
| `↵` | Find customer, a result highlighted | choose it → focus the **checked device radio** (or Model when the customer has no devices); scanned IMEI → customer and device chosen → focus **Find an issue** |
| `↵` | "New customer “…”" | quick form; focus the first field the typed text didn't fill (Phone after a name) |
| `↵` | Phone / Email in the quick form | "Use this customer" → focus device (Model) |
| `Esc` | quick form | back to Find customer (typed text kept) |
| `↵` | device radio | use that device → focus **Find an issue**; on "New device" → open the form, focus Model |
| `D` | device radio group | New device |
| `↵` | Model result | fill model, brand, type → focus **IMEI** (Serial for non-IMEI types) |
| `↵` | IMEI (typed or scanner suffix) | never submits; → focus **Lock** |
| `↵` | PIN / Password, or inside the pattern grid | "Use this device" → focus **Find an issue** |
| `1`–`9`, `Backspace`, `Delete`, `↵` | pattern grid | add dot, remove last, clear, confirm |
| `↵` | Find an issue with text | toggle the first match, clear the filter (stay in the field for the next issue) |
| `Esc` | Find an issue with text | clear the filter |
| `P` `F` `U` | checklist row | set and move down |
| `mod+↵` | anywhere on the page | Create ticket (or show what's missing and focus the first problem) |
| `↵` | Technician (last field), closed | Create ticket |
| `/` | not typing | back to Find customer (reopens the Customer section if done) |

Focus is moved after render and held for up to 4 frames (an Astryx `Typeahead` moves focus to its value chip after a pick), released as soon as the person presses a key (`focusSoon` in the prototype; reuse it).

### 2.6 Keystrokes and time (measured on the prototype, keyboard only)

| Scenario | Keys (search term excluded) | Total | Machine time | Person, estimated |
|---|---|---|---|---|
| **Returning customer, known device, 1 issue, defaults** | `↵` customer · `↵` device · `s c r` · `↵` · `mod+↵` = **7** | 12 (search "ali k" = 5) | 0.5–0.8 s | **≈ 10–15 s** |
| **New customer + new device, PIN, IMEI typed, 1 issue** | `↵` new customer · phone 12 · `↵` · model "iph 13" 6 · `↵` · IMEI 15 · `↵` · `→` · `Tab` · PIN 4 · `↵` · `s c r` · `↵` · `mod+↵` = **49** | 59 (search "Priya Shah" = 10) | 1.6–2.3 s | **≈ 35–45 s**; ≈ 25–35 s with a scanner (IMEI = one scan) |

Story target TK1.11: ≤ 15 keystrokes after the search term → **met with 7**. Person estimates use the keystroke-level model (≈ 0.28 s per key for an average typist, ≈ 1.35 s per decision: ~4 decisions on the returning path, ~10 on the new path) plus ~3 s of reading; the hallway test (DoD) replaces these with real medians. Both paths are under 60 s; the new path is under the story's 90 s target with margin.

**Why it meets < 60 s:** one page, no navigation; every confirm moves focus to the next required input, so the returning path never needs Tab; `↵` picks the first match everywhere; Device preselects the most recently used device; due, priority and technician have defaults; the four optional sections never need visiting; Create works from anywhere (`mod+↵`); a scanned IMEI collapses Customer + Device into one action.

### 2.7 States and copy
| State | Shows |
|---|---|
| Loading context | Section cards render; Due shows a `Skeleton` field, Create is disabled with `disabledMessage` "Loading shop settings…" |
| Context error | error `Banner` "Couldn't load check-in settings." + "Try again"; the form stays usable but Create is disabled |
| No permission (`tickets.create` missing) | `NoAccess` (Sprint 1). Without `customers.manage` (not in the matrix today): "New customer" and "New device" items hidden |
| Empty search | Typeahead "No customers found" + the New customer item |
| Draft restored (TK3) | info `Banner` "Draft restored · Discard"; passcode fields empty with "Enter the passcode again" |
| Missing fields on create | error `Banner` in the footer "Before creating: choose a customer · choose a device · pick an issue or describe the problem", field errors, focus on the first |
| Creating | Create `isLoading` "Creating…", page inputs read-only; double `mod+↵` ignored (Idempotency-Key covers retries) |
| Create failed | error `Banner` with contract copy, input kept; `VALIDATION_FAILED` `issues[]` mapped onto fields (paths `newCustomer.*`, `newDevice.*`, `estimate.amountMinor`, `dueDate`); `CUSTOMER_ARCHIVED` → "Restore and use" action; `ASSIGNEE_NOT_ACTIVE` → Technician field error |
| Shop changed (`ACTIVE_SHOP_CHANGED`) | warning `Banner` "You switched shop in another tab. This check-in is kept for {original shop}." Create disabled |
| Created | navigate to `/tickets/[id]` with toast "Ticket T-1042 created" (+ "Check in another device for {customer}" toast action) |
| Long data | summaries `maxLines 1` with tooltip; customer note wraps; 10 issues chips wrap |
| 1024 | same column (side nav collapsed to icons); quick-form grid stays 2 columns; footer summary truncates first |

### 2.8 Accessibility
One h1; each section is a `section` labelled by its h2; done state is an icon with label "Done"; summary line is `aria-live polite`; chip groups are labelled (`ToggleButtonGroup label`) and one Tab stop; the pattern grid is a labelled group described by its help and the live sequence text; all inputs keep visible labels except the two search fields (hidden labels "Find customer", "Find an issue"); `Kbd` announces "Control + Enter" / "Command + Enter".

### 2.9 Warranty, prefilled and another-device variants
- `?warrantyOf=` (from a Collected ticket): Customer and Device done and locked (no "Change"), header `Badge` "Warranty for T-0998", issues empty, priority Normal; body adds `warrantyOfTicketId`.
- `?customerId=` / `&deviceId=`: those sections start done; focus starts in Find an issue (or Device).
- "Check in another device for {customer}": Customer done, Device open on the radio list.

### 2.10 Prototype findings → recommendations for the build
- **R1 One-box model search (recommend adopting).** Typing "iph 13" and `↵` fills Type, Brand and Model in one step, instead of Type → Brand → Model (≈ 6–8 keystrokes and two selects saved on every new device). Needs a contract tweak: `ModelSuggestionsQuery.type` optional and items carrying `{ type, brand, model }` (today `catalogueModels(type, brand, q)` returns model names only). Type and Brand stay editable below.
- **R2 Rank shortest match first** in model suggestions ("iph 13" → iPhone 13 above 13 mini / 13 Pro). The prototype's first run picked "iPhone 13 mini" on `↵`; the API should rank exact, then prefix, then shortest.
- **R3 One Tab stop per chip group** (`RovingGroup`): done in the prototype; without it the Tab walk had 30 extra stops.
- **R4 Focus hold after picks** (`focusSoon`): Astryx `Typeahead` refocuses its value chip after a selection; the page must re-assert focus for a few frames and stop on the next key press. Without the "stop on key" part a fast `Tab` was pulled back (seen as a flaky test).
- **R5 Archived customers in check-in search:** the list API excludes archived by default; check-in should call `GET /api/customers?q=&archived=include` (or the API returns them flagged) so "Restore and use" can appear; picking one calls `restore` before create. Needs the backend to confirm the query flag.
- **R6 Scanner path:** a full IMEI in Find customer should call `DEVICE_ACTION_PATHS.lookup` and jump straight to Issues (prototype does this on mock data); keep it.
- **R7 Contract display bug (backend):** `formatPhone('+447911123456', 'GB')` returns "+44 7911 123456" because libphonenumber reports that range's country as a Crown Dependency; national format should be chosen by country calling code, not country. Affects UK numbers starting 07911/07781/07797 etc.

---

## 3. Pattern lock and passcode

### 3.1 Pattern input (`PatternLockInput`)
`VStack gap 2`: label `Text` medium "Pattern"; help "Tap the dots in order, or type their numbers (1 is top left, 9 bottom right)."; `RovingGroup` > `Grid columns 3 gap 2` of nine `ToggleButton size lg` labelled "Dot n" (pressed: "Dot n, step k"), one Tab stop; sequence `Text` `aria-live polite`: "Pattern: 1 → 5 → 9 → 6 (4 dots)". Pointer: tap dots in order, tap the last again to undo (drag-to-draw on touch: pointer down on a dot, `pointermove` + `elementFromPoint` adds dots under the finger; build item). Keyboard: `1–9` add, `Backspace` last, `Delete` clear, `↵` confirm, arrows + `Space` also work. Error (after submit) from `PatternLock`: "Connect at least 4 dots" / "Each dot can be used once"; empty: "Draw the pattern, or type the dot numbers". Stored with `formatPattern`.

### 3.2 Passcode reveal (`PasscodeReveal`, ticket detail Device card)
- Shown only when `can('tickets.view_passcode')`, the ticket's `status.category !== 'CLOSED'` and `device.passcodeOnFile`.
- Masked: `HStack`: lock `Icon`, `Text` "{LOCK_TYPE_LABELS[lockType]} on file", secondary `Button size sm` "Show passcode" (`Kbd` none; it's deliberate).
- Click → `POST passcodeRevealPath(ticketId)` (never GET; no body) → `PasscodeReveal`. While loading the button `isLoading`.
- Revealed (for `PASSCODE_REVEAL_SECONDS` = 30): PIN/Password in a `Text type code size lg` with letter spacing from the theme, inside a `Card variant muted`; pattern via `PatternLockInput isReadOnly` (numbers show the order) and "Order: 1 → 5 → 9 → 6"; a `ProgressBar` counting down (label "Hides in {s} s", `aria-live off` except at 10 s) and a ghost "Hide now". Then back to masked. No copy button; never in URL, title, logs or storage; the value is cleared from component state on hide and on unmount.
- Under it: supporting `Text` "Viewed {passcodeViewCount} times · last by {passcodeLastViewedBy.name}, {time}" (updated from the reveal's `viewCount`).
- Closed ticket / customer page: "Passcode on file" only, no button. Errors: `PASSCODE_NOT_AVAILABLE`, `PASSCODE_UNREADABLE` ("This passcode can't be read. Ask the customer again."), `RATE_LIMITED` → inline error `Text` under the button with the contract copy.

---

## 4. Customers

### 4.1 Customer list (`/customers`) — template `table-page`
- Header `HStack between`: h1 "Customers", primary "New customer" (`customers.manage`).
- Toolbar (`HStack wrap gap 3`): search `TextInput type search` "Search name, phone or email" (autofocus, `/` focuses it, debounce `LIST_SEARCH_DEBOUNCE_MS`, min 2 via `SearchText`); `SegmentedControl` Type (All / Person / Business); `MultiSelector` Tags (`CustomerTagsResponse`); `Switch` "Has open tickets"; `MultiSelector` "Marketing consent" (SMS/Email/WhatsApp); `DateRangeInput` "Created"; `Switch` "Show archived"; `Selector` Sort (`CUSTOMER_SORT_LABELS`). All in the URL (`CustomerListQuery`), back button works.
- `Table` (`idKey "id"`, `textOverflow wrap`, columns with `proportional` floors to fit 1024): Name (`Link` to detail; "Business" neutral `Badge` for `kind BUSINESS`, contact name as supporting text; "Archived" neutral badge), Phone (`PhoneText`), Email (truncates + tooltip), Tags (up to 2 `Token`s + "+n"), Open tickets (tabular number), Last visit (`Timestamp format date`), Created.
- Footer: `Pagination variant count` "Showing 1–25 of 312" (`LIST_TOTAL_CAP` → "10,000+"), page size 25/50/100 (`PAGE_SIZES`), cursor from `CustomerListResponse`.
- Keyboard: `↑ ↓` row focus, `↵` opens.
- States: loading 8 `Skeleton` rows; empty shop `EmptyState` "No customers yet" / "They're added when you check in a device." + New customer; no results "No customers match “{q}”" + "Clear filters"; error + Try again; no permission `NoAccess`.

### 4.2 Customer detail (`/customers/[id]`) — template `detail-page`
- Summary header: h1 `displayName` (+ Business badge, Archived / Erased badge), `PreferredChannel` label, consent summary line ("SMS marketing: Yes since 12/03/2026 · Email: No · WhatsApp: No" from `ConsentSummary`), tags as `Token`s; phones (`PhoneText isCallable`, WhatsApp link on `whatsappPhoneId`, label `PHONE_LABELS`), email (`Link mailto:`).
- Customer note (`notes`) as an info `Banner` "Customer note".
- Actions (right): primary "New ticket" (`tickets.create`, not archived/erased) → `/tickets/new?customerId=`; "Edit" (`customers.manage`); `MoreMenu` "More actions": Archive / Restore (`customers.manage`), Export data, Erase… (`customers.export_delete`; destructive section).
- `TabList hasDivider` (in the URL `?tab=`): **Tickets** (count) · **Devices** (count) · **Details**.
  - Tickets: `Table` from `GET /api/tickets?view=all&customerId=&sort=open_first` (`TicketListItem`): #, Device, `StatusBadge`, Created, `DueChip`, Assignee. Empty: "No tickets yet. Check in a device."
  - Devices: `Table` from `DeviceListResponse`: type `Icon` + `deviceLabel`, colour, IMEI/serial `maskIdentifier` with a "Show" `Link` toggling the full value, "Passcode on file" Yes/No, tickets count, `MoreMenu` (Edit, New ticket for this device, Archive/Restore). "Add device" button. Empty: "No devices yet."
  - Details: `MetadataList` (address, notes, created by/at, updated), **Consent** card: current per channel + "Consent history" `Table` (`ConsentHistoryResponse`: When, Channel, Granted/Withdrawn badge, Source `CONSENT_SOURCE_LABELS`, By, Note), "Change consent" button (§4.5).
- States: loading skeleton header + table; 404 / erased (`CUSTOMER_ERASED`) `EmptyState` "This customer was erased." / "We can't find that customer."; no permission `NoAccess`. Erased: name "Erased customer", no contact data, actions hidden except tickets.

### 4.3 Customer form (page `/customers/new`, `/customers/[id]/edit`; dialog variant from check-in-less places)
`settings` template column (640), `FormLayout` sections; validated with `createCustomerSchema(country)` / `updateCustomerSchema(country)` (edit sends `version`).
- **Who:** `SegmentedControl` Person / Business (`CustomerKind`); Person: First name, Last name; Business: Business name, Contact name.
- **Contact:** phones repeater (max `MAX_CUSTOMER_PHONES`): number `TextInput type tel` (formatted on blur), label `Selector` (`PHONE_LABELS`), `RadioList`-style "Primary" choice (one), "WhatsApp" choice (one; hidden for Landline), remove `IconButton`; "Add phone". Email `TextInput type email`. Preferred contact `SegmentedControl` (`PREFERRED_CHANNEL_LABELS`), default `defaultPreferredChannel(country)`.
- **Duplicate panel** inline under contact (§4.4).
- **Marketing consent** (§4.5) and **Service updates opt-out**: three `Switch`es "Don't send repair updates by SMS / email / WhatsApp".
- **Tags:** `Tokenizer` with suggestions from `CustomerTagsResponse` (max `MAX_CUSTOMER_TAGS`).
- **Address:** `Collapsible` "Add address" (closed when empty) with Sprint 1 per-country labels (`CITY_LABELS`, `REGION_LABELS`, `POSTCODE_LABELS`).
- **Notes:** `TextArea` "Customer note" (2000, "Shown on every ticket for this customer").
- Footer: "Save customer" / "Save changes" + "Cancel"; unsaved-changes guard (Sprint 1). Success toast "Customer added" / "Customer saved". `STALE_RECORD` → warning banner with Reload, input kept.

### 4.4 Duplicate warning (`CustomerDuplicatePanel`)
Under the contact fields after `DUPLICATE_CHECK_DEBOUNCE_MS` with a valid phone or email: warning `Banner` "Already a customer?" with a compact `List` (max 3, `DuplicateMatch`): name, primary phone, email, "Last visit {date} · {n} open tickets", Archived badge; per row `Button size sm` "Use this customer" (archived: "Restore and use"); footer "and {more} more" when `more > 0`. Dismiss = keep typing; saving is never blocked (A5).

### 4.5 Consent (`ConsentEditor`)
Three unticked `Switch`es; turning one on reveals Source `Selector` (required, `ConsentSource` minus IMPORT) + optional Note (200); turning off records WITHDRAWN (source defaults to CUSTOMER_REQUEST). US + SMS + verbal → `TCPA_VERBAL_SMS_WARNING` as a warning description (not a block). On the detail page "Change consent" opens a `Dialog` with the same editor → `POST CUSTOMER_ACTION_PATHS.consents` (`AppendConsentsInput`, only effective changes via `effectiveConsentChanges`); toast "Consent updated".

### 4.6 Archive, export, erase
- **Archive:** `AlertDialog actionVariant primary` "Archive {name}?" / "They'll be hidden from lists and search. Their tickets and history stay." → `archive`; `CUSTOMER_HAS_OPEN_TICKETS` shows the contract copy ("Close or cancel this customer's {n} open tickets first.") in the dialog. Restore: no confirm, toast "Customer restored".
- **Export data:** direct download via `DownloadAnchor` (Sprint 1 pattern: `<a download>` + fetch first), file name `customerExportFilename`, toast "Export downloaded"; error toast with contract copy.
- **Erase:** `Dialog purpose form width 520`, destructive: title "Erase {name}?"; two `List`s: **Removed** (name, phones, email, address, notes, tags, consent history; IMEI, serial, colour, notes and passcode of every device) and **Kept** (tickets with numbers, dates, statuses, issues, checklist and estimate; device type, brand and model); `Banner warning` "Notes on tickets are kept as repair records. Remove personal details from them first if needed."; `TextInput` "Type ERASE to confirm" (`EraseCustomerInput`, "Type ERASE to confirm"); destructive "Erase customer" enabled only when it matches. Open tickets → `CUSTOMER_HAS_OPEN_TICKETS` in the dialog. Success → toast "Customer erased", page shows the erased state.

---

## 5. Device add / edit (dialog)
`Dialog width 560 purpose form` + `DialogHeader` "Add device" / "Edit device"; `FormLayout`; validated with `CreateDeviceInput` / `UpdateDeviceInput` → `POST CUSTOMER_ACTION_PATHS.devices` / `PATCH DEVICE_ACTION_PATHS.update`.
- Type `SegmentedControl` with icons (`DEVICE_TYPE_LABELS`; icon-only labels hidden below 560); Brand `Selector hasSearch` (`DEVICE_BRANDS_BY_TYPE[type]` + `OTHER_BRAND` → free-text "Brand"); Model `Typeahead` over `ModelSuggestionsResponse` (shop history first, "Used before" description; free text "Use “{q}”"; R1/R2 apply); Colour `Typeahead` over `DEVICE_COLOUR_SUGGESTIONS` with free text.
- IMEI (only `IMEI_DEVICE_TYPES`): `TextInput inputMode numeric`, "Scan it, or dial *#06#"; normalised with `normalizeImei`; error `IMEI_ERROR` (+ " " + `IMEI_LENGTH_HINT` for 14/16 digits) once 15+ digits or on blur; scanner `↵` moves to Serial. Serial: `normalizeSerial`, `SERIAL_ERROR`.
- Ownership warning (DV2.5) from `DEVICE_ACTION_PATHS.lookup`: another customer → warning `Banner` "This IMEI is on {customer}'s {model} (last ticket {T-1033})." + `Link`; same customer → info `Banner` + "Use existing device".
- Lock: `SegmentedControl` (`LOCK_TYPE_LABELS`), PIN/Password field (masked, show toggle), `PatternLockInput`; edit shows "Passcode on file · Replace / Remove" instead of the value (never shown here). Changing it is audited server-side; copy: "Changing the passcode is recorded in the audit log."
- Notes `TextArea` (1000).
- Footer: "Add device" / "Save device" + Cancel. `CUSTOMER_ERASED` → error banner. Archive (row menu) → `AlertDialog` "Archive {device}?"; `DEVICE_HAS_OPEN_TICKETS` copy in the dialog.

---

## 6. Ticket list (`/tickets`) — templates `table-page` + `table-filter`
- Header: h1 "Tickets", primary "New ticket" (`tickets.create`).
- **Views:** `TabList hasDivider` of `TICKET_VIEWS` minus `all`, labels `TICKET_VIEW_LABELS`, counts from `TicketCounts` as `Tab endContent` `Badge` (counts are what Badge is for): All open `open`, Mine `mine`, Unassigned `unassigned`, Ready for pickup `ready`, Overdue `overdue` (error badge when > 0), Closed (no count). Default `defaultTicketView(me.role)`; last view remembered per user on this device (local storage, try/catch). `view` in the URL.
- **Toolbar:** search `TextInput type search` "Search #, customer, phone, IMEI…" (`/` focuses; `SearchText`); filters `MultiSelector` Status (visible statuses, then a "Hidden statuses" section; options show `StatusBadge`), `MultiSelector` Technician (+ "Unassigned" = `UNASSIGNED`), `SegmentedControl` Priority (Any/Normal/Urgent), `DateRangeInput` Created, `DateRangeInput` Due, `MultiSelector` Device type, `Switch` "Warranty only"; Sort `Selector` (Urgent first then due (`default`), Due, Created, Last updated, Ticket #; Closed view: closed date). "Clear filters" ghost. All in the URL (`TicketListQuery`).
- **Table** (`TicketListItem`, `hasHover`, columns floored for 1024): Ticket # (`Link` `numberLabel`, "Warranty" info badge), Customer (`displayName` + `PhoneText` supporting; erased: "Erased customer"), Device (`deviceLabel`), Issues (first 2 + "+n"; `description` when none), Status (`StatusBadge`), Assignee (`Avatar size xsm` + name; "Unassigned"; "Sam (deactivated)"), Due (`DueChip` with the list's `serverNow`), Priority ("Urgent" warning badge), Created (`Timestamp date`), row actions `MoreMenu` "Actions for T-1042": Take (unassigned rows, `tickets.edit` → `AssignTicketInput { userId: me }`), Change status ▸ (`allowedTargetStatuses(row.status, statuses, { permissions, via: 'status' })` minus `requiresNote` targets, which open the note dialog).
- 1024: Created and Priority hide (Priority folds into the # cell as a badge); Customer phone moves under the name.
- Footer `Pagination variant count`, 25/50/100, keyset cursor, "10,000+" cap.
- Keyboard: `↑ ↓` rows, `↵` open, `/` search.
- States: loading skeleton rows (tabs show `Skeleton` counts); empty shop "No tickets yet" / "Check in your first device." + New ticket; empty view copy: Mine "Nothing assigned to you.", Unassigned "Every ticket has someone on it.", Ready "Nothing waiting for pickup.", Overdue "Nothing overdue. Nice.", Closed "No closed tickets yet."; no results "No tickets match “{q}”" + Clear filters; error + Try again; counts error → tabs without counts.

---

## 7. Ticket detail (`/tickets/[id]`) — template `work-item-detail`
Two columns at ≥ 1024: main (cards) and a 360 rail (activity). Below 1024: one column, timeline after the cards.

### 7.1 Header
`HStack wrap`: h1 `numberLabel`, `StatusBadge`, "Urgent" warning badge, warranty `Link`s ("Warranty for T-0998" / "Warranty ticket: T-1101"), `DueChip format absolute`, assignee (`Avatar` + name). Actions (only allowed ones): **Change status** (secondary `DropdownMenu`, `S`), **Assign** (`A`), **Add note** (`M`, focuses the composer), **Print** (disabled `DropdownMenu` trigger with items "Intake receipt", "Device label", `disabledMessage` "Coming in Sprint 3", the `ComingSoon` pattern), `MoreMenu`: Edit details, Cancel ticket (`tickets.cancel`, not closed), Reopen (closed and `reopenableUntil > now`), Create warranty ticket (`status.systemRole === 'COLLECTED'` and `tickets.create`), New ticket for this device (Cancelled past the window).

### 7.2 Status menu (`TicketStatusMenu`)
Items = `allowedTargetStatuses(ticket.status, statuses, { permissions: me.permissions, via: 'status' })`, each rendered with `StatusBadge`, grouped by category (`STATUS_CATEGORY_LABELS`) with `DropdownMenuGroup`. Hidden statuses never appear. Collected appears only from READY with `tickets.cancel`. Disabled explanation row for the common "not allowed" case: from OPEN/WAITING a disabled "Collected" with `COLLECT_NOT_READY_MESSAGE`. Choosing:
- a target with `requiresNote` (Unrepairable) → `Dialog` "Mark as {name}" with `TextArea` "Why can't it be repaired?" (required) + `SegmentedControl` visibility (`NOTE_VISIBILITY_LABELS`, default Customer-visible) → `ChangeTicketStatusInput { statusId, note }`;
- COLLECTED → **Collect** `AlertDialog actionVariant primary` "Hand the device back" / "Hand the device and these accessories back: {accessoriesSummary(...)}" action "Mark collected";
- anything else → immediate optimistic change and toast "Status changed to {name}" (no undo: the timeline is the record; change it again if needed).
Errors: `STATUS_HIDDEN` (refetch statuses, toast), `TRANSITION_NOT_ALLOWED`, `TICKET_CLOSED`, `FORBIDDEN` → contract copy.

### 7.3 Cards (main column)
- **Customer card** (`Card`): name `Link`, `PhoneText` (call + WhatsApp), preferred contact, customer note info `Banner`; erased: "Erased customer", no contact.
- **Device card:** type icon + `deviceLabel`, colour, IMEI/serial masked with "Show", lock type + `PasscodeReveal` (§3.2), "{previousTicketCount} previous tickets" `Link` (→ `/tickets?view=all&deviceId=`).
- **Intake card:** issues as neutral `Token`s, description, checklist (`Table compact`: item, result badge — Fail error, Pass success, Untested neutral; fail rows first), condition notes, accessories (`accessoriesSummary`), estimate (`MoneyText taxNote`). "Edit details" opens a `Dialog` with the intake fields (`UpdateTicketInput` with `version`); closed tickets read-only.
- **Details card (rail top on ≥ 1280, else main):** `MetadataList`: Priority, Due, Assignee, Created by/at, Checked in from (warranty link), Reopened n times.

### 7.4 Timeline (`TicketTimeline`, rail)
Header `HStack`: h2 "Activity" + `SegmentedControl size sm` All / Notes / Status changes (`TimelineFilter`). `List density compact` oldest → newest (newest at the bottom, scrolled into view), cursor paged (`TIMELINE_PAGE_SIZE`, "Show earlier" at the top). One row per `TicketTimelineItem`: `Avatar` (actor; system = wrench icon "RepairOS"), sentence, `Timestamp format relative` (tooltip absolute):
- created "Checked in by {name}" · status_changed "{actor} changed status {StatusBadge from} → {StatusBadge to}" (+ "Customer will be notified" supporting text when `notifyPending`, Sprint 3) · assigned "Assigned to Sam" / "Unassigned (was Sam)" · fields_changed "Edited {field}: old → new" per field, checklist per item · device_changed / customer_changed · cancelled "Cancelled: {CANCEL_REASON_LABELS} — {note}" · reopened "Reopened to {status}: {reason}" · warranty_linked · passcode_deleted "Passcode deleted on close" (system) · reserved types → generic "Activity" row (never crash).
- **Notes:** INTERNAL rows render plain on the list background with a lock `Icon` and "Internal"; CUSTOMER rows render inside `Card variant blue` with an eye `Icon` and "Visible to customer" label (colour + icon + text, never colour-only). "edited" marker; "Edit" `Link` on own notes while `canEditNote` (10 min).
- **Composer** (bottom, sticky in the rail): `TextArea` "Add a note" (2000, `mod+↵` posts), `SegmentedControl` visibility Internal (default) / Visible to customer with helper "Customers will see this on their repair status page (from Sprint 3)." when Customer is chosen; "Add note" button. `CreateTicketNoteInput`.

### 7.5 Dialogs
- **Assign** (`A`): `Selector` (searchable) of `AssigneesResponse` + "Unassigned", "Take" shortcut button when not me; `AssignTicketInput`; `ASSIGNEE_NOT_ACTIVE` inline.
- **Cancel ticket:** `Dialog purpose form` "Cancel T-1042": `RadioList` reason (`CANCEL_REASON_LABELS`), note `TextArea` (required for OTHER, 3–200), for `CANCEL_REASONS_REQUIRING_RETURN` a required `CheckboxInput` "Device and accessories returned to the customer ({accessoriesSummary})"; custom closed statuses: `Selector` "Close as" from `allowedTargetStatuses(..., { via: 'cancel' })` (default Cancelled); destructive "Cancel ticket"; `CancelTicketInput`.
- **Reopen:** "Reopen T-1042": `Selector` target from `allowedTargetStatuses(..., { via: 'reopen', closedAt })` default `statusBeforeClose`; `TextArea` reason (`Reason`); info `Banner` "The passcode was deleted when this ticket closed. Ask the customer for it again." when the device has no passcode; `ReopenTicketInput`. After `reopenableUntil` the action is absent (`REOPEN_WINDOW_PASSED` copy if raced).
- **Create warranty ticket:** navigates to `/tickets/new?warrantyOf=` (§2.9), no dialog.
- **Edit details:** see 7.3; `STALE_RECORD` → warning banner in the dialog "This ticket changed since you opened it." + Reload, input kept.

### 7.6 States
Loading: header skeleton + card skeletons; 404 (incl. other shop) `EmptyState` "We can't find that ticket." + "Back to tickets"; stale data banner after `STALE_RECORD`; closed: read-only intake, only notes and Reopen/Warranty; no permission `NoAccess`. 1024: two columns (main ≈ 600 + rail 360 with the side nav collapsed); below 900: one column.

---

## 8. Settings

### 8.1 Ticket statuses (`/settings/statuses`, `statuses.manage`)
h1 "Ticket statuses", intro "Rename and order the steps a repair goes through. Categories decide where tickets show up: In progress, Waiting, Ready, Closed." Info `Banner` "Statuses can't be deleted. Hide one to stop using it; tickets already in it stay there."
- `List hasDividers` with `createReorderable` (drag handle) of `TicketStatus` by `position`; each row: `StatusBadge`, name, category (`STATUS_CATEGORY_LABELS`), "System" neutral badge for `systemRole`, "Notify customer" `Switch` (label hidden "Notify customer when a ticket moves to {name}"; supporting "Messages start in Sprint 3"), "Hidden" badge, ticket count, `MoreMenu` "Actions for {name}": Edit…, Move up, Move down (keyboard reorder), Hide / Show (not for system). Reorder → `PUT TICKET_STATUS_PATHS.order` (`ReorderTicketStatusesInput`), optimistic.
- "Add status" (disabled at `MAX_TICKET_STATUSES` with "You can have up to 20 statuses."). **Status dialog** (`CreateTicketStatusInput` / `UpdateTicketStatusInput`): Name (`StatusName`), Category `SegmentedControl` (disabled for system statuses: "System statuses keep their category"), Colour: `RadioList horizontal` of `STATUS_COLOURS` each shown as a `Badge` preview with the name, Notify customer `Switch`, Requires a note `Switch`. Category change on a status with tickets → `AlertDialog` "{n} tickets will move from {old} to {new}." Errors via `checkStatusCreate` / `checkStatusUpdate` client-side and contract copy (`STATUS_IN_USE` "Move its tickets first", name taken, last visible in category).
- States: loading skeleton rows; error; no permission `NoAccess`.

### 8.2 Tickets (`/settings/tickets`)
`FormLayout` 640, `TicketSettings` / `UpdateTicketSettingsInput`: **Default turnaround** `NumberInput` 0–`MAX_TURNAROUND_DAYS` "open days" (description "Counted in open days from your business hours. 0 = same day."); **Ticket number prefix** `TextInput` (`TicketNumberPrefix`, uppercase as typed) with live preview "Next ticket: {formatTicketNumber(prefix, nextNumber)}" and "Changing the prefix changes how every ticket is shown; numbers stay."; **Next ticket number** `NumberInput` min `highestUsedNumber + 1` (`isValidNextNumber`, `TICKET_NUMBER_TOO_LOW` copy "Use a number above {highest}"); **Delete passcode when the repair is closed** `Switch` (default on) with "Recommended. Passcodes are kept only while a repair is open." Read-only without `settings.manage`. Save → toast "Ticket settings saved".

---

## 9. Dashboard (`/`) — template `dashboard`
`GET DASHBOARD_PATH` → `DashboardSummary`; refresh on focus and `TICKET_COUNTS_REFRESH_MS`.
- Header: "Welcome, {first name}" + date (Sprint 0) and, for `tickets.create`, primary "New ticket" (`Kbd n`).
- Tiles `Grid {minWidth 200, max 4}` of `ClickableCard`s (Sprint 0 stat card look): Open tickets (`counts.openAndWaiting` → `/tickets?view=open&category=OPEN,WAITING`), Ready for pickup (`ready` → view ready), Overdue (`overdue` → view overdue; number in an error `Badge` when > 0), Due today (`dueToday` → open + due today). Loading `Skeleton` tiles; per-tile error "Couldn't load" + Retry.
- **My queue** `Section`: h2 "My queue" + "View all ({myQueueTotal})" `Link` → `?view=mine`; compact `Table` of `myQueue`: #, Device, `StatusBadge`, `DueChip`, Urgent badge. Empty: "Nothing assigned to you." then h3 "Unassigned" with `unassigned` rows and a "Take" button per row.
- Technicians see the same page; the queue is their first table. Without `tickets.view`: the Sprint 0 welcome card.

---

## 10. Global search (⌘K / "/") — `CommandSearch`
- Trigger: the top-bar search field becomes a button-like `TextInput` (read-only) that opens `CommandPalette` (`label "Search RepairOS"`, width 640); `mod+K` anywhere, `/` when not typing (except pages with their own search, §0.3).
- Input: `CommandPaletteInput` placeholder "Search tickets, customers, IMEI…".
- Empty input: group **Recent** (`RecentItem[]` from `recentItemsKey(userId, shopId)`, `RECENT_ITEMS_MAX`, cleared on sign-out; entries that 404 are dropped) + group **Actions**: "New ticket" (`tickets.create`), "New customer" (`customers.manage`).
- Typing (min 2, `GLOBAL_SEARCH_DEBOUNCE_MS`) → `GET GLOBAL_SEARCH_PATH?q=` → `GlobalSearchResponse`, groups via `auxiliaryData.group`: **Tickets** (`numberLabel`, customer, device, `StatusBadge`), **Customers** (name, phone, email), **Devices** (label, masked IMEI, owner, latest ticket), then "See all ticket results" → `/tickets?view=all&q=`. Each group only with its permission.
- `↑ ↓` move, `↵` open, `Esc` close. `exactMatch` → `↵` jumps straight to the ticket / device's latest ticket (scanner friendly).
- States: loading spinner in the input; no results "Nothing found for “{q}”"; error "Search isn't working right now." Footer: default `CommandPaletteFooter` key guidance.

---

## 11. Build checklist (per screen → contracts)
| Screen | Read schemas | Write schemas | Constants / helpers |
|---|---|---|---|
| Check-in | `CheckInContext`, `CustomerListResponse`, `DeviceListResponse`, `DeviceLookupResponse`, `DuplicateCheckResponse`, `ModelSuggestionsResponse`, `AssigneesResponse`, `TicketDetail` | `createTicketSchema(country)` | `ISSUE_PRESETS_BY_DEVICE_TYPE`, `ISSUE_LABELS`, `CHECKLIST_ITEMS_BY_DEVICE_TYPE`, `CHECKLIST_RESULT_KEYS`, `ACCESSORY_CODES/LABELS`, `DEVICE_TYPE_LABELS`, `LOCK_TYPE_LABELS`, `IMEI_DEVICE_TYPES`, `splitQuickCreateText`, `defaultPreferredChannel`, `parseMajorAmount`, `dueAtFor`, `dueInputProblem`, `deviceLabel`, `maskIdentifier`, `checkInDraftKey`, `CHECK_IN_DRAFT_TTL_HOURS`, `IDEMPOTENCY_KEY_HEADER`, `SHOP_ID_HEADER` |
| Ticket list | `TicketListResponse`, `TicketCounts`, `TicketStatusListResponse` | `AssignTicketInput`, `ChangeTicketStatusInput` | `TICKET_VIEWS/LABELS`, `defaultTicketView`, `TicketListQuery`, `UNASSIGNED`, `allowedTargetStatuses`, `LIST_TOTAL_CAP`, `PAGE_SIZES` |
| Ticket detail | `TicketDetail`, `TimelineResponse`, `PasscodeReveal`, `TicketStatusListResponse` | `UpdateTicketInput`, `ChangeTicketStatusInput`, `AssignTicketInput`, `CancelTicketInput`, `ReopenTicketInput`, `CreateTicketNoteInput`, `UpdateTicketNoteInput` | `canTransition`, `allowedTargetStatuses`, `COLLECT_NOT_READY_MESSAGE`, `CANCEL_REASON_LABELS`, `CANCEL_REASONS_REQUIRING_RETURN`, `NOTE_VISIBILITY_LABELS`, `canEditNote`, `TIMELINE_FILTER_TYPES`, `accessoriesSummary`, `passcodeRevealPath`, `PASSCODE_REVEAL_SECONDS`, `ticketPath` |
| Customers | `CustomerListResponse`, `CustomerDetail`, `ConsentHistoryResponse`, `DuplicateCheckResponse`, `CustomerTagsResponse`, `CustomerExport` | `createCustomerSchema`, `updateCustomerSchema`, `AppendConsentsInput`, `EraseCustomerInput` | `CUSTOMER_ACTION_PATHS`, `PHONE_LABELS`, `PREFERRED_CHANNEL_LABELS`, `CONSENT_*_LABELS`, `showTcpaWarning`, `effectiveConsentChanges`, `whatsappLink`, `customerExportFilename`, `ERASED_CUSTOMER_NAME` |
| Devices | `Device`, `DeviceLookupResponse`, `ModelSuggestionsResponse` | `CreateDeviceInput`, `UpdateDeviceInput` | `DEVICE_ACTION_PATHS`, `DEVICE_BRANDS_BY_TYPE`, `OTHER_BRAND`, `DEVICE_COLOUR_SUGGESTIONS`, `IMEI_ERROR`, `IMEI_LENGTH_HINT`, `SERIAL_ERROR`, `PatternLock`, `formatPattern` |
| Statuses settings | `TicketStatusListResponse` | `CreateTicketStatusInput`, `UpdateTicketStatusInput`, `ReorderTicketStatusesInput` | `TICKET_STATUS_PATHS`, `STATUS_COLOURS`, `STATUS_CATEGORY_LABELS`, `MAX_TICKET_STATUSES`, `checkStatusCreate/Update` |
| Ticket settings | `TicketSettings` | `UpdateTicketSettingsInput` | `TICKET_SETTINGS_PATH`, `formatTicketNumber`, `isValidNextNumber`, `MAX_TURNAROUND_DAYS` |
| Dashboard | `DashboardSummary` | `AssignTicketInput` (Take) | `DASHBOARD_PATH`, `TICKET_COUNTS_REFRESH_MS` |
| Global search | `GlobalSearchResponse`, `RecentItem` | — | `GLOBAL_SEARCH_PATH`, `GLOBAL_SEARCH_DEBOUNCE_MS`, `recentItemsKey`, `RECENT_ITEMS_MAX` |

## Accessibility (all screens)
One h1 per page; status is never colour-only (`StatusBadge` icon + text; overdue `DueChip` glyph + words; note visibility icon + label); every chip group and the pattern grid are a single Tab stop with arrow keys; table row menus are labelled "Actions for {ticket|name}"; live regions: check-in summary, pattern sequence, toasts; reveal countdown is not announced every second; colours only from the theme (`StatusColour` = Astryx Badge variants).

## 12. Build notes (feat/sprint2-web)

What shipped and where it differs from the text above; everything else is as specified.

- **Prototype route removed.** `/prototype/check-in`, its component, mock model and `isPrototypeEnabled` are gone; the helpers it proved (`focusSoon`, quick-create seeding, IMEI copy, issue filter) live in `apps/web/src/lib/focus.ts` and `lib/check-in.ts`. The keystroke budget is now proven on `/tickets/new` (returning path 7 keys after the search term, new customer + device 49).
- **R1 / R5 call sites:** `apps/web/src/lib/sprint2-queries.ts`: `fetchModelSuggestions` (`ModelSuggestionsQuery`, one box, `type`/`brand` optional; falls back to the contract's `suggestModels` over the catalogue if the request fails) and `searchCheckInCustomers` (`GET GLOBAL_SEARCH_PATH?q=&limit=8&includeArchived=true`, `GlobalSearchQuery`). The temporary `contract-additions.ts` shim is gone. R7 needed no web change.
- **Check-in search description:** `SearchCustomerResult` has no "last device" (nor an open-ticket count), so a result shows phone (or email), plus "Archived · Restore and use" when archived.
- **Check-in search limit:** global search takes `limit` up to 10; check-in asks for 8.
- **Version conflict copy:** on `STALE_RECORD` the Edit details dialog reads the newest timeline item (`GET …/timeline?filter=all&limit=1`) and says "This ticket was changed by {actor}." (contract `STALE_TICKET_MESSAGE` when unknown), with Reload; input is kept.
- **Global search ↵:** the palette has no highlight until an arrow key, so ↵ with nothing highlighted opens the top result (an exact ticket number / IMEI / serial is put first): the scanner path.
- **A13 banner:** "You're now working in {shop}. This page was reloaded." is latched in `lib/shop-changed.ts` (the shell remounts per shop). Proven by the two-tab test in `e2e/tests/sprint2-shell.spec.ts`.
- **Tabs:** Astryx `TabList` with an `aria-label` renders a navigation of buttons; views/sections are announced that way.
- **Dashboard overdue tile:** the number stays large with an error "Needs attention" badge next to it (Badge for counts only).
- **Status menu:** the 's' shortcut opens the header menu (controlled `isMenuOpen`).
- **Lists:** column floors use `proportional(1, { minWidth })` so tables fit 1024 (weight 2+ raised the floors); dates in dense tables are short ("23 Nov 2026").
