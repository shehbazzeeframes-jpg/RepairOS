# Backlog

Known follow-ups that are deliberately not in the current sprint. Each item says where it came from.

## Security / platform

### Require email verification before staff invites attach memberships (Sprint 1)
*Source: Sprint 0 API review, finding 14.*
Sign-up currently auto-signs-in without verifying the email. That is fine while a user can only
create their own shop, but once staff invites exist, an invite for `alex@shop.com` must only attach a
membership to an account that has proven it owns that address. Otherwise anyone who signs up first
with that email inherits the invite (and the shop's data).
- Enable Better Auth email verification (Resend adapter from the integrations engineer).
- Accept an invite only when `user.emailVerified` is true and the emails match; otherwise show
  "verify your email to join <shop>".
- Isolation test: an unverified account with the invited email cannot read the shop.

### Cap or rate limit `POST /api/shops` before billing (Sprint 6, before paid launch)
*Source: Sprint 0 API review, finding 15.*
Any signed-in user can create unlimited shops, each with default rows (location, tax rates, audit
log). Before Stripe billing exists this is a free resource sink and a way to spam tenants.
- Per-user cap (e.g. 3 shops without an active subscription) returning 403 FORBIDDEN with a clear message.
- Plus a per-user rate limit (e.g. 5 per hour).
- Billing (Sprint 6) then ties extra shops to subscriptions.

### Shared store for rate limits
*Source: Sprint 0 API.*
Auth rate limits use express-rate-limit's in-memory store, so each API instance counts separately
and counts reset on restart. Move to a Redis store (`rate-limit-redis`) when the API runs more than
one instance (before the beta).

## Done in the review fix (kept for context)

- Finding 12 (getSession dropped refreshed `Set-Cookie`): fixed. The auth guard calls
  `getSession({ returnHeaders: true })` and forwards `Set-Cookie`, so sliding session expiry and
  cleared cookies reach the browser through `/api/*` calls (test: "forwards the refreshed session cookie").
