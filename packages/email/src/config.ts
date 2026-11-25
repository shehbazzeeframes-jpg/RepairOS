import { defaultOutboxDir, OutboxEmailProvider } from './outbox';
import type { EmailProvider } from './provider';
import { ResendEmailProvider } from './resend';

export interface EmailConfig {
  /** "resend" when RESEND_API_KEY is set, otherwise the dev file outbox. */
  provider: 'resend' | 'outbox';
  resendApiKey: string | null;
  from: string;
  outboxDir: string;
}

export const DEV_EMAIL_FROM = 'RepairOS <no-reply@repairos.local>';

/** NODE_ENV values where the file outbox and dev-only routes are allowed. Anything else is treated as production. */
export const DEV_NODE_ENVS: readonly string[] = ['development', 'test'];

/** M2: NODE_ENV must be set explicitly (no silent "development" default that would switch on dev-only behaviour). */
export function requireNodeEnv(env: NodeJS.ProcessEnv = process.env): string {
  const nodeEnv = env.NODE_ENV?.trim();
  if (!nodeEnv) {
    throw new Error('Missing required environment variable NODE_ENV (development, test or production; see .env.example)');
  }
  return nodeEnv;
}

export const isDevNodeEnv = (nodeEnv: string): boolean => DEV_NODE_ENVS.includes(nodeEnv);

/**
 * Reads NODE_ENV, RESEND_API_KEY, EMAIL_FROM and EMAIL_OUTBOX_DIR. D6/M2: unless NODE_ENV is development or test,
 * both RESEND_API_KEY and EMAIL_FROM are required (the process refuses to start instead of silently writing to a
 * file outbox).
 */
export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const nodeEnv = requireNodeEnv(env);
  const resendApiKey = env.RESEND_API_KEY?.trim() || null;
  const from = env.EMAIL_FROM?.trim() || null;
  if (!isDevNodeEnv(nodeEnv)) {
    const missing = [!resendApiKey && 'RESEND_API_KEY', !from && 'EMAIL_FROM'].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Missing required environment variable ${missing.join(' and ')}: NODE_ENV=${nodeEnv} sends email through Resend (see .env.example)`,
      );
    }
  }
  return {
    provider: resendApiKey ? 'resend' : 'outbox',
    resendApiKey,
    from: from ?? DEV_EMAIL_FROM,
    outboxDir: env.EMAIL_OUTBOX_DIR?.trim() || defaultOutboxDir(),
  };
}

export function createEmailProvider(config: EmailConfig, deps: { fetch?: typeof fetch } = {}): EmailProvider {
  if (config.provider === 'resend' && config.resendApiKey) {
    return new ResendEmailProvider({ apiKey: config.resendApiKey, from: config.from, fetch: deps.fetch });
  }
  return new OutboxEmailProvider(config.outboxDir, config.from);
}
