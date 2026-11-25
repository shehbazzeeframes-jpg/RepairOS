# Backlog

Known follow-ups that are deliberately not in the current sprint. Each item says where it came from.

## Security / platform

### Billing ties extra shops to subscriptions (Sprint 6)
*Source: Sprint 0 API review, finding 15 (cap and rate limit done in Sprint 1).*
`POST /api/shops` is capped at 3 owned shops (`SHOP_OWNED_LIMIT`) and 5 creations per hour
(`SHOP_CREATE_PER_HOUR`, in-memory). Sprint 6 billing replaces the flat cap with subscription-based limits.

### Shared store for rate limits
*Source: Sprint 0 API.*
Auth rate limits use express-rate-limit's in-memory store, so each API instance counts separately
and counts reset on restart. Move to a Redis store (`rate-limit-redis`) when the API runs more than
one instance (before the beta).

## Done in Sprint 1 (kept for context)

- Finding 14 (email verification before invites attach memberships): resolved by design (story §3). Accepting needs
  the secret token from the invite email *and* a signed-in account with that email; on accept `emailVerified` is set
  unless the link was exposed through "Copy invite link" (D7). Tests: `apps/api/test/invites.test.ts`.
- Finding 15 (cap `POST /api/shops`): 3 owned shops + 5 per hour, tested at the boundary.

## Done in the review fix (kept for context)

- Finding 12 (getSession dropped refreshed `Set-Cookie`): fixed. The auth guard calls
  `getSession({ returnHeaders: true })` and forwards `Set-Cookie`, so sliding session expiry and
  cleared cookies reach the browser through `/api/*` calls (test: "forwards the refreshed session cookie").

### Stale-tab requests can be cached under the previous shop (Sprint 2, in progress)
*Web side done in `feat/sprint2-web-design`:* `apiFetch` sends `X-Shop-Id` on every shop-scoped request and
discards a response whose echoed `X-Shop-Id` differs (`ACTIVE_SHOP_CHANGED`, refetches `/api/me`). Still open: the
API guard + echo, the "You're now working in {shop}" banner, and the two-tab Playwright test.

*Source: Sprint 1 web fixes (M3 follow-up).*
If tab 2 switches shop, a request already sent by tab 1 is answered for the new shop but cached under the old shop's key until the next `/me` refetch (focus or 403) drops it. Close it fully by having the API echo `shopId` in shop-scoped responses (or accept an `X-Shop-Id` header and reject a mismatch with 409), with the web client discarding mismatched responses.

### Done in Sprint 2: flaky mocked e2e, onboarding country select (BK2)
*Source: Sprint 1 web fixes.* Playwright runs with `reducedMotion: 'reduce'` and picks Astryx `Selector` options
through `selectOption()` (`e2e/tests/support/select.ts`): waits for the listbox and the option, clicks, then checks
the trigger shows the choice. `--repeat-each=50 --retries=0` on `onboarding.spec.ts`: 200/200 passed.
