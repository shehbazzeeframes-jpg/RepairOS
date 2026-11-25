import { createRequire } from 'node:module';
import { type EmailConfig, loadEmailConfig } from '@repairos/email';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** Public web app URL; the only CORS / Better Auth trusted origin. */
  appUrl: string;
  /** Runtime DB URL (role repairos_app, so RLS applies). */
  databaseUrl: string;
  authSecret: string;
  /** Sign-in / sign-up / password-reset requests per IP per minute. */
  authRateLimitMax: number;
  /** express "trust proxy" setting (TRUST_PROXY), used for client IPs in logs and rate limits. */
  trustProxy: boolean | number | string;
  logLevel: string;
  version: string;
  /** Email provider settings (D6: production requires RESEND_API_KEY and EMAIL_FROM). */
  email: EmailConfig;
  /**
   * How emails leave the API: "queue" (BullMQ `email` queue, processed by apps/worker with retries) or
   * "sync" (sent in-process right after the transaction; default in tests). EMAIL_DELIVERY overrides.
   */
  emailDelivery: 'queue' | 'sync';
  redisUrl: string;
  /** §7: max shops a user may own (ACTIVE OWNER memberships). SHOP_OWNED_LIMIT, default 3. */
  shopOwnedLimit: number;
  /** §7: max shops a user may create per hour (in-memory, per process). SHOP_CREATE_PER_HOUR, default 5. */
  shopCreatePerHour: number;
  /** §3: public invite preview requests per IP per minute. INVITE_PREVIEW_RATE_LIMIT, default 30. */
  invitePreviewRateLimit: number;
}

export const CONFIG = Symbol('CONFIG');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

export function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** express `trust proxy`: true/false, a hop count, or addresses/presets ("loopback", "10.0.0.0/8"). */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? 'loopback').trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseEmailDelivery(raw: string | undefined, nodeEnv: string): 'queue' | 'sync' {
  const v = raw?.trim().toLowerCase();
  if (v === 'queue' || v === 'sync') return v;
  if (v) throw new Error('EMAIL_DELIVERY must be "queue" or "sync"');
  return nodeEnv === 'test' ? 'sync' : 'queue';
}

const WEAK_SECRETS = new Set(['change-me', 'changeme', 'secret', 'password']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  // Required: the owner/superuser URL would silently switch Row-Level Security off.
  const databaseUrl = required(env, 'APP_DATABASE_URL');
  const secret = required(env, 'BETTER_AUTH_SECRET');
  if (nodeEnv !== 'test' && (WEAK_SECRETS.has(secret) || secret.length < 32)) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters and not a placeholder (openssl rand -base64 32)');
  }
  return {
    nodeEnv,
    port: Number(env.PORT ?? 4000),
    appUrl: (env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl,
    authSecret: secret,
    authRateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX ?? 10),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL ?? 'info',
    version: readVersion(),
    email: loadEmailConfig({ ...env, NODE_ENV: nodeEnv }),
    emailDelivery: parseEmailDelivery(env.EMAIL_DELIVERY, nodeEnv),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    shopOwnedLimit: positiveInt(env.SHOP_OWNED_LIMIT, 3),
    shopCreatePerHour: positiveInt(env.SHOP_CREATE_PER_HOUR, 5),
    invitePreviewRateLimit: positiveInt(env.INVITE_PREVIEW_RATE_LIMIT, 30),
  };
}
