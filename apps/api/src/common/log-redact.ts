/**
 * Keeps secrets in URLs out of the logs (BUG-01, story E1.5): invite tokens travel in the path
 * (`/api/invites/<token>`, `/api/invites/<token>/accept`), password-reset tokens in the path of Better Auth's
 * callback (`/api/auth/reset-password/<token>`) and in `?token=` of the page it redirects to. The browser also
 * sends the page URL (`/invite/<token>`, `/reset-password?token=`) as `Referer` on every API call from it.
 */

export const REDACTED = '[REDACTED]';

/** Path prefixes whose next segment is a secret token. */
const TOKEN_PATH = /(\/api\/invites\/|\/api\/auth\/reset-password\/|\/invite\/)[^/?#\s]+/g;
/** `token=…` in a query string. */
const TOKEN_QUERY = /([?&](?:token|resetToken)=)[^&#\s]*/gi;

/** Masks invite/reset tokens in a URL or any free text that may contain one. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATH, `$1${REDACTED}`).replace(TOKEN_QUERY, `$1${REDACTED}`);
}

/** True for request URLs that carry a token in their path (their params/query are dropped from logs). */
export function isTokenUrl(url: string): boolean {
  return /^\/api\/(invites\/[^/?#]+|auth\/reset-password\/[^/?#]+)/.test(url);
}

/** Headers never logged: `referer` holds the page URL, which can carry a token. */
const DROPPED_HEADERS = new Set(['referer', 'referrer']);

interface SerializedReq {
  url?: string;
  query?: unknown;
  params?: unknown;
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Body keys whose values are never logged, at any depth (A15: device passcodes travel as `passcode` /
 * `devicePasscode` objects holding `value` or `pattern`; plus passwords and tokens).
 */
const SECRET_BODY_KEYS = new Set(['passcode', 'devicepasscode', 'value', 'pattern', 'password', 'newpassword', 'currentpassword', 'token']);

/** Deep copy of a request body with secret keys replaced by `[REDACTED]`. */
export function redactBody(body: unknown, depth = 0): unknown {
  if (depth > 8 || body === null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((v) => redactBody(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SECRET_BODY_KEYS.has(k.toLowerCase()) ? REDACTED : redactBody(v, depth + 1);
  }
  return out;
}

/** pino-http `serializers.req`: receives pino-std-serializers' request object. */
export function serializeReq(req: SerializedReq): SerializedReq {
  const url = typeof req.url === 'string' ? req.url : '';
  const out: SerializedReq = { ...req, url: redactSecrets(url) };
  // Request bodies are not logged by pino-std-serializers; if one is ever attached, its secrets are masked.
  if ('body' in out) out.body = redactBody(out.body);
  if ('raw' in out) delete out.raw;
  if (isTokenUrl(url)) {
    delete out.query;
    delete out.params;
  } else if (out.query && typeof out.query === 'object' && 'token' in out.query) {
    out.query = { ...(out.query as Record<string, unknown>), token: REDACTED };
  }
  if (req.headers) {
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(k.toLowerCase())) headers[k] = v;
    out.headers = headers;
  }
  return out;
}

interface SerializedRes {
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** pino-http `serializers.res`: the reset callback answers 302 with `Location: …/reset-password?token=…`. */
export function serializeRes(res: SerializedRes): SerializedRes {
  if (!res.headers) return res;
  const headers = { ...res.headers };
  if (typeof headers.location === 'string') headers.location = redactSecrets(headers.location);
  return { ...res, headers };
}
