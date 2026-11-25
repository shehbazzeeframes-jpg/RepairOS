/**
 * Active-shop header (Sprint 2 story §8.1, decision A13 — binding).
 *
 * The web app sends `X-Shop-Id: <activeShopId the page was rendered for>` on EVERY shop-scoped request.
 * The API compares it with the session's active shop in a guard, before the handler runs:
 * - header absent → the request proceeds as before (scripts, tests, API clients);
 * - header present and different → 409 `ACTIVE_SHOP_CHANGED` ("You switched shop in another tab."); nothing written.
 * Shop-scoped responses echo `X-Shop-Id` (the session's active shop). The web client discards any response whose
 * echo differs from the shop it is cached under (never writes it into the query cache), refetches GET /api/me,
 * clears shop-scoped cache and keeps check-in drafts under the original shop key.
 * The API lists `X-Shop-Id` in CORS allowed and exposed headers.
 */
export const SHOP_ID_HEADER = 'X-Shop-Id';

/**
 * `Idempotency-Key` header on POST /api/tickets (check-in): a uuid per draft. A repeat with the same key from the
 * same user in the same shop within `IDEMPOTENCY_WINDOW_MINUTES` returns 200 with the ticket created the first time
 * (the body is not compared). A key that is not a uuid → 400 VALIDATION_FAILED.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_WINDOW_MINUTES = 10;
