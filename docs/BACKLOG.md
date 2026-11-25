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
