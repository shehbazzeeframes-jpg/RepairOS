import { createRequire } from 'node:module';

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
  logLevel: string;
  version: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.APP_DATABASE_URL ?? required(env, 'DATABASE_URL');
  if (!env.APP_DATABASE_URL) {
    console.warn('[config] APP_DATABASE_URL is not set: using DATABASE_URL, so Row-Level Security is NOT enforced.');
  }
  const secret = required(env, 'BETTER_AUTH_SECRET');
  if ((env.NODE_ENV ?? 'development') === 'production' && (secret === 'change-me' || secret.length < 32)) {
    throw new Error('BETTER_AUTH_SECRET must be a strong secret in production');
  }
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 4000),
    appUrl: (env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl,
    authSecret: secret,
    authRateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX ?? 10),
    logLevel: env.LOG_LEVEL ?? 'info',
    version: readVersion(),
  };
}
