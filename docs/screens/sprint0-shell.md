# Sprint 0: auth, onboarding and app shell

Built in `apps/web`; screenshots in `docs/screens/sprint0/` (1440×900 and 1024×768, regenerate with `pnpm --filter @repairos/e2e screenshots`).

## Flow
`GET /api/me` decides where a user may be (`apps/web/src/lib/redirects.ts`):

| /api/me | Sign-in, sign-up | Onboarding | App pages |
|---|---|---|---|
| 401 | stay | → /sign-in | → /sign-in |
| `activeShop: null` | → /onboarding | stay | → /onboarding |
| has `activeShop` | → / | → / | stay |
| 5xx / network | form still shown | error state + "Try again" | error state + "Try again" |

While `/api/me` loads, gated pages show a centred `Spinner`.

## Sign-in / sign-up
- Frame: Astryx `login-card` template (`Section` muted ground, `Center`, `Card`, `Heading` h1). Width 400.
- Fields: `TextInput` in `FormLayout`; sign-up = Your name, Work email, Password ("At least 8 characters").
- Validation on submit, then live: "Enter your name", "Enter your email address", "Enter a valid email address", "Use at least 8 characters", "Enter your password".
- Submitting: button label "Signing in…" / "Creating account…" with `isLoading`.
- API error: `Banner status="error"` above the fields ("Could not sign you in" / "Could not create your account"), with plain copy for known Better Auth codes.
- Links: "New to RepairOS? Create an account" / "Already have an account? Sign in".

## Onboarding
- Same frame, width 560. Fields from `CreateShopInput`: Shop name, Country (`Selector`: United States / United Kingdom / Pakistan), Shop phone, Address, City + Postcode (label "ZIP code" for US) side by side.
- Picking a country shows a muted `Card` with a `MetadataList`: currency with a sample price (`£129.00`, `$129.00`, `Rs 129`), tax ("Prices include VAT 20%", "Prices exclude sales tax. Add your local rate in Settings.", "Prices exclude tax: GST 18% on goods, Sales tax on services 16%") and time zone.
- Empty optional fields are not sent. API `issues[]` map onto the matching field; the message shows in the banner.
- Footer: "Signed in as {email}. Sign out".

## App shell
- `AppShell` + `TopNav` + `SideNav` (block `AppShellTopNavWithSideNav`).
- TopNav: shop name (links to /), search `TextInput` "Search tickets, customers, IMEI…" (placeholder only), primary "New ticket" (→ /tickets until Sprint 2), user menu (`DropdownMenu` on an `Avatar`: name, role · email, Settings, Sign out).
- SideNav groups: Front desk (Dashboard, Tickets, Customers, POS), Back office (Inventory, Reports, Settings); heroicons outline/solid pairs through the `icon`/`selectedIcon` props.
- Responsive contract: > 1180px sidebar expanded; ≤ 1180px it starts collapsed to icons (toggle still expands it) and search narrows; ≤ 900px "New ticket" is icon-only; below Astryx `md` the sidebar moves to the mobile drawer.
- Dashboard: "Welcome, {first name}", date in the shop time zone; three stat `Card`s (Open tickets, Ready for pickup, Today's sales in shop currency) and an `EmptyState` "No tickets yet".
- Placeholders: `EmptyState` "Coming in Sprint N" (Tickets/Customers 2, Inventory 4, POS 5, Reports 6, Settings 1) with "Back to dashboard".

## Accessibility
One h1 per page; `TopNav` labelled "Shop", `SideNav` labelled "Main", current item has `aria-current="page"`; AppShell provides the skip link and `main`; field errors are attached to inputs and announced through Astryx's live region; all colours come from the theme.
