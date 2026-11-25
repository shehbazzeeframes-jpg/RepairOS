import { type EmailConfig, isDevNodeEnv, loadEmailConfig, requireNodeEnv } from '@repairos/email';

export interface WorkerConfig {
  nodeEnv: string;
  logLevel: string;
  redisUrl: string;
  /** RLS-bound app role, used to record invite email delivery. Optional only in development and test. */
  appDatabaseUrl: string | null;
  email: EmailConfig;
}

/**
 * Worker settings. Refuses to start (throws) when:
 *  - NODE_ENV is not set (M2: no silent "development" default);
 *  - NODE_ENV is not development/test and RESEND_API_KEY or EMAIL_FROM is missing (D6, M2);
 *  - NODE_ENV is not development/test and APP_DATABASE_URL is missing (L5: invite email status would never be
 *    recorded, so the staff list would show "Sending" forever).
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const nodeEnv = requireNodeEnv(env);
  const email = loadEmailConfig(env);
  const appDatabaseUrl = env.APP_DATABASE_URL?.trim() || null;
  if (!appDatabaseUrl && !isDevNodeEnv(nodeEnv)) {
    throw new Error(`Missing required environment variable APP_DATABASE_URL: NODE_ENV=${nodeEnv} must record invite email status`);
  }
  return {
    nodeEnv,
    logLevel: env.LOG_LEVEL ?? 'info',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    appDatabaseUrl,
    email,
  };
}
