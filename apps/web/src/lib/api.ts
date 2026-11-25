import { API_ERROR_MESSAGES, ApiError, SHOP_ID_HEADER } from '@repairos/contracts';
import type { ZodType, ZodTypeDef } from 'zod';

/** Thrown for every non-2xx response; `body` always has the contract's ApiError shape. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(body: ApiError) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = body.statusCode;
    this.body = body;
  }
}

const FALLBACK_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

/** Turn any non-2xx body (JSON ApiError, other JSON, text, or nothing) into the ApiError shape. */
export async function toApiError(res: Response): Promise<ApiError> {
  let raw: unknown = undefined;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
  }
  const parsed = ApiError.safeParse(raw);
  if (parsed.success) return parsed.data;

  const message =
    raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string'
      ? raw.message
      : res.status >= 500
        ? 'Something went wrong on our side. Please try again.'
        : res.statusText || 'Request failed';
  return {
    statusCode: res.status,
    code: FALLBACK_CODES[res.status] ?? (res.status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
    message,
  };
}

// ---------- Active shop header (A13 / BK1) ----------

/** The shop the current page was rendered for; set by the app shell's SessionProvider. */
let requestShopId: string | null = null;

export function setRequestShopId(shopId: string | null): void {
  requestShopId = shopId;
}

/** User-level routes that never carry `X-Shop-Id` (session, auth, shop creation, invites, dev tools). */
const NOT_SHOP_SCOPED = /^\/api\/(me(\/.*)?|auth\/.*|shops|invites\/.*|dev\/.*)$/;

export function isShopScopedPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? '';
  return pathname.startsWith('/api/') && !NOT_SHOP_SCOPED.test(pathname);
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** JSON-serialisable request body. */
  json?: unknown;
}

/**
 * Typed fetch against our own origin (`/api/*` is rewritten to the API by Next.js).
 * Parses 2xx bodies with the given Zod schema and throws ApiRequestError otherwise.
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  { json, headers, ...init }: ApiFetchOptions = {},
): Promise<T> {
  // Every shop-scoped request says which shop the page was rendered for; the API answers
  // 409 ACTIVE_SHOP_CHANGED when another tab switched shop (story §8.1).
  const shopId = isShopScopedPath(path) ? requestShopId : null;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(shopId ? { [SHOP_ID_HEADER]: shopId } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new ApiRequestError({
      statusCode: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach RepairOS. Check your connection and try again.',
    });
  }

  if (!res.ok) throw new ApiRequestError(await toApiError(res));

  // Belt and braces for in-flight GETs: a response for another shop is never handed to the cache.
  const echoed = res.headers.get(SHOP_ID_HEADER);
  if (shopId && echoed && echoed !== shopId) {
    throw new ApiRequestError({
      statusCode: 409,
      code: 'ACTIVE_SHOP_CHANGED',
      message: API_ERROR_MESSAGES.ACTIVE_SHOP_CHANGED ?? 'You switched shop in another tab.',
    });
  }

  const data: unknown = res.status === 204 ? undefined : await res.json();
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiRequestError({
      statusCode: res.status,
      code: 'INVALID_RESPONSE',
      message: 'The server sent a response this app does not understand.',
    });
  }
  return parsed.data;
}

export function isApiRequestError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError;
}
