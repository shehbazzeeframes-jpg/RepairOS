# Sprint 1: shop & people screens

Builds on `sprint0-shell.md`. Source of truth for behaviour: `docs/stories/sprint1-shop-and-people.md` (its "Tech lead decisions" table wins) and the Zod schemas in `packages/contracts/src`. Screenshots: `docs/screens/sprint1/` (1440×900, regenerate with `pnpm --filter @repairos/e2e screenshots`).

Astryx v0.7.17 only, tokens only. Components were picked with `pnpm exec astryx build|template|component` (the `settings-sidebar` page template for the settings frame, `login-card` for the signed-out cards, `DropdownMenuActions` for row menus).

## Shared rules
- **Permissions:** the UI reads `me.permissions` (never the role) through `hasPermission`-style checks in `lib/permissions.ts`. A hidden control is never the only guard: the API enforces too, and any 403 refetches `/api/me` (as does window focus) so the UI catches up after a role change.
- **Errors:** copy comes from `API_ERROR_MESSAGES[code]` with `{placeholders}` filled from what the screen knows; when a placeholder can't be filled the API's own (already substituted) message is used (`lib/errors.ts`). Unknown codes show the API message.
- **Times:** stored UTC, shown in the shop's time zone and locale (`en-US` 12h MM/DD, `en-GB` 24h DD/MM). Form pickers work in shop-local time and convert with `lib/timezone.ts`.
- **States everywhere:** loading = `Skeleton` rows or `Spinner`; error = `EmptyState` with the message and "Try again"; no permission = `NoAccess` (`EmptyState`, "You don't have access to this page", "Ask an owner or manager if you need it.", "Back to dashboard"); long text truncates with `maxLines={1}` + tooltip; tables scroll inside their region, never the page.
- **Keyboard:** every action is a `Button`, `Link`, menu item or form control; dialogs focus their title on open, trap focus, close on Escape (form dialogs don't close on backdrop after typing) and return focus to the trigger; forms submit on Enter.

## Redirect rules (`lib/redirects.ts`)
| `/api/me` | Sign-in / sign-up | Onboarding | App pages | `/access-removed` | `/invite/*`, `/forgot-password`, `/reset-password`, `/dev/outbox` |
|---|---|---|---|---|---|
| 401 | stay | → /sign-in | → /sign-in | → /sign-in | stay |
| no shop, `accessRemoved: null` | → /onboarding | stay | → /onboarding | → /onboarding | stay |
| no shop, `accessRemoved` set | → /access-removed | stay (they chose "Create your own shop") | → /access-removed | stay | stay |
| has shop | → / | → / unless `?new=1` ("Create a new shop") | stay (banner if `accessRemoved`) | → / | stay |

Sign-in/sign-up with `?invite=<token>` send a signed-in user back to `/invite/<token>` instead.

## 1. Settings (`/settings/*`)
**Frame:** inside the Sprint 0 `AppShell`; `Layout` with a `LayoutPanel` (start, 220 wide, `label="Settings"`, divider) holding a `List` of `ListItem` links (`aria-current="page"` on the current one; no divider, the selected row carries the state), and the page in the content slot. Each page: `Heading` h1 + one-line `Text` intro, then `Section`s. Forms sit in a 640 column; tables take the content width. At ≤ 900px the panel becomes a `TabList` of links above the page.

| Nav item | Path | Shown with |
|---|---|---|
| General | `/settings/general` | `settings.view` |
| Tax | `/settings/tax` | `settings.view` |
| Business hours | `/settings/hours` | `settings.view` |
| Staff | `/settings/staff` | `staff.view` |
| Timesheets | `/settings/timesheets` | `timesheet.view` |
| Audit log | `/settings/audit` | `audit.view` |

`/settings` goes to the first item the user may see. The side-nav "Settings" item and the user-menu "Settings" row hide when none is visible. A hidden page opened by URL shows `NoAccess`. Without the `*.manage` permission a page is read-only (inputs `isReadOnly`, no save/add buttons).

### 1.1 General (shop profile)
- `FormLayout` sections: **Shop details** (Shop name, Shop phone), **Address** (Address line 1, line 2, `CITY_LABELS[country]`, `REGION_LABELS[country]` = US `Selector` of `US_STATES` with search, GB `TextInput` "County", PK `Selector` of `PK_PROVINCES`; `POSTCODE_LABELS[country]`), **Region & time** (Time zone `Selector` from `TIMEZONES_BY_COUNTRY[country]` with `timezoneLabel`; disabled with "Your country has one time zone" when there's only one).
- Locked: `MetadataList` Country + Currency, each with a lock icon, and the reason text: "Country and currency can't be changed after the shop is created. All prices, tax and reports are recorded in {currency}; changing it would misstate past sales. To trade in another country, create a new shop."
- Validation: `shopProfileSchema(country)` (react-hook-form + zodResolver); phone shown with `formatPhone`, saved E.164. Only changed fields are sent (`PATCH /api/shop`).
- Changing the time zone asks first (`AlertDialog`, `actionVariant="primary"`): "Times on tickets, timesheets and reports will be shown in {zone}. Recorded times don't change."
- Footer: "Save changes" (primary, disabled until dirty) + "Discard". Success `Toast` "Shop details saved". API `issues[]` map to fields; other errors show a `Banner` above the form. Leaving with unsaved changes prompts (`beforeunload`).

### 1.2 Tax
- **Prices include tax** `Switch` with per-country helper ("UK shops usually show prices including VAT." / "US shops usually add sales tax at checkout." / "Pakistani shops usually show prices before GST."). Flipping asks: "This changes how prices are entered and shown from now on. Past sales don't change." (`AlertDialog`, primary).
- Info `Banner` (status info): "Editing or archiving a rate never changes past records. Every sale keeps the rate it was charged at."
- `Table` columns: Name, Rate (`formatRate`, tabular numbers), Applies to (`TAX_APPLIES_TO_LABELS`), Default (`Badge`s "Goods default" / "Services default"; "Archived" neutral badge), actions `MoreMenu` (Edit, Set as goods default, Set as services default (only when `canBeDefaultFor`), Archive / Restore).
- Toolbar: "Add tax rate" (primary), "Show archived" `Switch` (re-queries with `includeArchived=true`).
- **Rate dialog** (`Dialog` + `DialogHeader`, 480): Name, Rate (`TextInput`, `inputMode="decimal"`, "e.g. 8.875"; parsed with `parseRatePercent`, error "Enter a rate from 0 to 100 with up to 3 decimals"), Applies to (`Selector`), checkboxes "Default for goods" / "Default for services" (disabled with reason when incompatible). Edit shows "Changes apply to new sales only. Past invoices keep the rate they were charged at."
- Archive confirm (`AlertDialog`): "Archive {name}? It won't be offered for new items or sales. Past records keep it." Errors `TAX_RATE_IS_DEFAULT`, `LAST_TAX_RATE`, `TAX_RATE_NAME_TAKEN`, `TAX_RATE_ARCHIVED` show contract copy in a toast (error) or on the Name field.
- Empty (only archived hidden): "No active tax rates" (can't really happen, `LAST_TAX_RATE` prevents it).

### 1.3 Business hours
- One row per weekday in `weekdayDisplayOrder(country)`: `Switch` (label hidden, "{Day} open"), day name (`Text` semibold), and when open two `TimeInput`s "Opens" "to" "Closes" (`increment={15}`, 12h for en-US, 24h for en-GB). Closed rows show "Closed" instead of the pickers.
- "Copy Monday to all weekdays" `Button` (ghost) above the rows.
- Validate with `BusinessHoursWeek`; errors attach to the field ("Closing time must be after opening time"). Save → `PUT /api/shop/hours`, toast "Business hours saved".

### 1.4 Staff
- Header row: h1 "Staff", seat meter `ProgressBar` (label "Seats", `formatValueLabel` → "3 of 5 users", warning variant at the limit) + `Text` "Active users and pending invites count toward your plan.", primary "Invite staff".
- At the limit the button is disabled with `disabledMessage` and a warning `Banner`: "Your plan includes 5 users. Extra users are $5/month; billing arrives later."
- Filter: `SegmentedControl` "Active & invited" (default) · "Deactivated" · "All" → `status` query.
- `Table` (`textOverflow="truncate"`): Name (name or "—", plus "You" `Badge`), Email, Role, Status (`Badge` Active success / Invited info / Expired warning / Deactivated neutral; plus "Clocked in now" `StatusDot`), Last clock-in (shop time or "Never"; invites: "Expires {date}" / "Expired on {date}"), actions `MoreMenu`.
- Row actions (only those allowed: `staff.manage` and `canManageRole(myRole, row.role)`, never on `isSelf`):
  - Member, active: Change role…, Deactivate… (destructive).
  - Member, deactivated: Reactivate.
  - Invite: Resend invite, Copy invite link, Revoke invite… (destructive; "Remove invite…" when expired).
- Invite row with `inviteEmailStatus = FAILED`: error `Badge` "Email failed" + inline `Link` "Resend invite" under the expiry date.
- **Invite dialog:** Email (`EmailAddress`), Role `Selector` limited to `manageableRoles(myRole)` with one-line descriptions (Owner "Everything, including billing", Manager "Runs the shop: settings, staff, reports", Front desk "Check-in, customers and the till", Technician "Works on repairs and parts"). Errors `ALREADY_MEMBER` / `INVITE_PENDING` / `MEMBER_DEACTIVATED` on the Email field; `SEAT_LIMIT_REACHED` as a banner. Success toast "Invite sent to {email}".
- **Copy invite link:** calls `POST …/link`, writes the URL to the clipboard and opens a `Dialog`: "Invite link copied", the link in a read-only `TextInput` with a Copy button, and "Paste it into WhatsApp or a text message. This new link replaced the emailed one and expires on {date}. Anyone with the link and access to {email} can join."
- **Change role dialog:** `Selector` of `manageableRoles` (current role preselected); `LAST_OWNER` / `CANNOT_CHANGE_SELF` show in the dialog banner.
- **Deactivate confirm:** "{name} will lose access to {shop} immediately. If they're clocked in, they'll be clocked out." **Revoke confirm:** "The link in their email will stop working."
- States: loading skeleton rows; only-me empty state "You're the only one here. Invite your team." (with the Invite button); error with Try again.

### 1.5 Timesheets
- Filter bar (`HStack` wrap): `DateRangeInput` "Dates" with presets (This week, Last week, This month, Last month; weeks start Monday, in shop time), `maxRangeSpan={93}`; Staff `Selector` (All staff + people from `GET /api/staff?status=ACTIVE,DEACTIVATED`); "Needs review ({n})" `Switch`; "Export CSV" `Button` link to `/api/timesheets/export.csv?…` (shown with `timesheet.export`); "Add entry" (with `timesheet.edit`).
- Range over 93 days (custom typing) shows the contract message "Choose a range of 93 days or fewer" and skips the query.
- Summary `Table`: Staff (name + role + "Deactivated" badge), Days worked, Total (`formatDuration`, tabular). Then one `Section` per person: h2 "{name} · {total}" and an entries `Table`: Date, Clock in, Clock out (or "Still open"), Duration, Flags (`Badge` warning "Long shift" (> 14h), "Still open"; neutral "Edited" with `Tooltip` "{by} on {date}: {reason}"; "Closed on deactivation"), actions `MoreMenu` (Edit, Delete) only when `canEditTimeEntry(myRole, row.role, isMe)`.
- **Entry dialog** (add / edit): Staff (add only), Clock in `DateTimeInput` (shop time), Clock out `DateTimeInput` (optional only for an open entry being left open), Reason `TextArea` (required, 3–200, counter). Validated with `CreateTimeEntryInput` / `UpdateTimeEntryInput`; `TIME_ENTRY_OVERLAP` shows in the dialog. **Delete** dialog asks for a reason too (`DeleteTimeEntryInput`).
- States: loading skeleton; empty "No hours recorded in this period"; error.

### 1.6 Audit log
- Filter bar: `DateRangeInput` (default last 7 days, `maxRangeSpan={366}`), User `Selector` (All users + staff members), Action `Selector` with sections per `AUDIT_ACTION_GROUP_LABELS` group: "All {group}" (actionGroup) then each action (`AUDIT_ACTION_META[a].label`).
- `Table`: When (shop date + time), Who (name or "System"), Action (`Link` button opening the drawer), Entity ("{entityType label}: {entityLabel}").
- "Load more" `Button` under the table while `nextCursor` is set; "You've reached the start of this period." at the end.
- **Detail `Drawer`** (end, 440): title = action label, subtitle "{who} · {when}", `MetadataList` of the entity, then the diff as a `Table` (Field, Before, After); created = only After, deleted = only Before; values formatted: instants in shop time, `rateMilliPct` with `formatRate`, roles with `ROLE_LABELS`, booleans Yes/No, `appliesTo` labels, the hours week as "Mon 10:00–19:00, Sun closed", null as "—"; unchanged fields hidden.
- States: loading, empty "No activity in this period", error.

## 2. Clock in/out (top bar)
- Shown for users with `timeclock.self`, left of "New ticket". Data: `GET /api/timeclock/me`; elapsed time uses the server clock (`serverNow` offset) and re-renders every 15 s.
- Clocked out: secondary `Button` "Clock in" (clock icon). Click → optimistic "Clocked in 0m", `POST clock-in`; on `ALREADY_CLOCKED_IN` it refetches and keeps the clocked-in state; other errors roll back with an error toast and "Try again".
- Clocked in: `DropdownMenu` button "Clocked in 2h 14m" (`StatusDot` success); menu: "Clock out", "My hours". Clock out → optimistic, toast "Clocked out. {todayMinutes} today.".
- Open entry older than 14h: warning `StatusDot`, menu header `Banner` warning "Still clocked in since {day time}. Clock out and ask a manager to fix the time."
- ≤ 900px: icon-only with tooltip.
- **My hours** `Dialog`: two `Section`s (This week, Last week) each with a total and a compact `Table` (Date, In, Out, Duration).

## 3. User menu
- Header: name, "{role} · {email}". Rows: Settings (when any settings page is visible), "Switch shop" `DropdownMenuGroup` with `DropdownMenuRadioGroup` of memberships ("{shop}" + role description) when there are 2+, "Create a new shop" (→ `/onboarding?new=1`; disabled with "You can own up to 3 shops for now…" when the user already owns 3), Sign out.
- Switching calls `POST /api/me/active-shop`, replaces the cached `/me`, drops every other cached query and lands on `/`.
- Onboarding (`?new=1`): same form, title "Set up another shop", "Back to {current shop}" link; `SHOP_LIMIT_REACHED` shows the contract copy in the banner.

## 4. Auth extras (`login-card` frame, 400)
- **Sign in:** "Forgot password?" `Link` under the password field. With `?invite=` the email is prefilled (editable) and a muted note "Sign in to join {shop}." shows; success returns to the invite.
- **Forgot password** `/forgot-password`: Email → `POST /api/auth/request-password-reset` `{ email, redirectTo: {origin}/reset-password }`. Afterwards always: "Check your email" + "If an account exists for {email}, we've sent a link to reset your password. It expires in 1 hour." (same on any 2xx/4xx except 429 "Too many attempts. Wait a minute and try again."). "Back to sign in".
- **Reset password** `/reset-password?token=…`: New password + Confirm password (`PasswordSchema`, "Passwords don't match"). Success → "Password updated" + "Sign in". `?error=INVALID_TOKEN`, missing token or 400 `INVALID_TOKEN` → "This reset link has expired or was already used." + "Request a new link".

## 5. Invite `/invite/[token]` (`login-card` frame)
| State | Content |
|---|---|
| Loading | Spinner in the card |
| Valid, signed out | h1 "Join {shop}", "{inviter} invited you to join **{shop}** as {role}.", `MetadataList` (Email, Expires), "Create account" (primary → `/sign-up?invite=`), "I already have an account" (→ `/sign-in?invite=`) |
| Valid, signed in (match) | "Join {shop}" primary; signed-in note |
| Wrong account | warning `Banner` with `INVITE_EMAIL_MISMATCH` copy, "Sign out and continue" |
| Expired | "This invite expired on {date}. Ask {inviter} to send a new one." |
| Revoked | `INVITE_REVOKED` copy |
| Accepted by me | "You've already joined {shop}." + "Go to {shop}" |
| Invalid / 404 / malformed | `INVITE_INVALID` copy + "Go to RepairOS" |
| Accepting | button "Joining…" |
| Accept error | `Banner` error with contract copy |

Sign-up with `?invite=`: email prefilled and `isReadOnly` ("This invite is for this email."), note "Joining {shop}", success returns to the invite. Accept → `/me` refetch → `/` with toast "Welcome to {shop}".

## 6. Access removed `/access-removed`
`login-card` frame: h1 "You no longer have access to {shop}", "An owner or manager of {shop} removed your access. Your account still works.", buttons "Create your own shop" (primary → `/onboarding`), shop switcher list if other memberships exist, "Sign out". In-app variant (another shop is active): dismissable warning `Banner` at the top of the content "You no longer have access to {shop}.".

## 7. Dev outbox `/dev/outbox`
Enabled when `NODE_ENV !== 'production'` or `NEXT_PUBLIC_DEV_OUTBOX=1` (the e2e build); otherwise `notFound()`. `Layout`: start `LayoutPanel` (360) with a `List` of emails (subject, "to · time"), newest first, "Refresh"; content: subject h1, `MetadataList` (To, Sent), "Links in this email" (`List` of `Link`s; app links for `/invite/` and `/reset-password` open in this tab), then the HTML in an `<iframe sandbox="" srcDoc>` (no scripts) and the plain text in a `CodeBlock`. Empty: "No emails yet. Invites and password resets you trigger locally appear here."

## Accessibility
One h1 per page; settings nav is a labelled landmark; table action menus are labelled "Actions for {name}"; status is never colour-only (badges carry text); the clock button's name includes the elapsed time; toasts are announced via Astryx's live region; all colours from the theme.
