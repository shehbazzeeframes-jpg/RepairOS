import type { ApiError } from '@repairos/contracts';
import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { jsonBody } from '../common/json-body';

const WINDOW_MS = 60_000;

const SIGN_IN = ['/api/auth/sign-in'];
const SIGN_UP = ['/api/auth/sign-up'];
const RESET = ['/api/auth/request-password-reset', '/api/auth/reset-password', '/api/auth/change-password'];

function tooMany(_req: Request, res: Response) {
  const body: ApiError = { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' };
  res.status(429).json(body);
}

const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export function normaliseEmail(body: unknown): string {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Rate limits for credential endpoints, each with its own bucket (in-memory, per process):
 *  - sign-in: per IP + normalised email (`max`), plus a looser per-IP cap (`5 × max`) against
 *    spraying many emails; successful sign-ins are not counted;
 *  - sign-up: per IP (`max`);
 *  - password reset/change: per IP + email (`max`).
 * JSON bodies of these routes are parsed here so the email can be read; Better Auth accepts a
 * pre-parsed body.
 */
export function authRateLimits(max: number): Router {
  const router = express.Router();
  const common = { windowMs: WINDOW_MS, standardHeaders: 'draft-7' as const, legacyHeaders: false, handler: tooMany };

  router.use([...SIGN_IN, ...SIGN_UP, ...RESET], jsonBody('64kb'));

  router.use(
    SIGN_IN,
    rateLimit({ ...common, limit: max * 5, skipSuccessfulRequests: true, keyGenerator: (req) => `ip:${ipOf(req)}` }),
    rateLimit({
      ...common,
      limit: max,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => `ip-email:${ipOf(req)}|${normaliseEmail(req.body)}`,
    }),
  );
  router.use(SIGN_UP, rateLimit({ ...common, limit: max, keyGenerator: (req) => `ip:${ipOf(req)}` }));
  router.use(
    RESET,
    rateLimit({ ...common, limit: max, keyGenerator: (req) => `ip-email:${ipOf(req)}|${normaliseEmail(req.body)}` }),
  );
  return router;
}
