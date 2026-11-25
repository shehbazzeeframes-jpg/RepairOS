import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@repairos/db';
import { type EmailMessage, passwordResetEmail } from '@repairos/email';
import type { Logger as PinoLogger } from 'pino';
import { redactSecrets } from '../common/log-redact';
import type { AppConfig } from '../config';

/** Password-reset links are valid for one hour (Better Auth default, stated in the email). */
export const RESET_PASSWORD_TOKEN_TTL_SECONDS = 60 * 60;

export const AUTH = Symbol('AUTH');

/**
 * L4: reset tokens Better Auth issued for this user in the last hour, from any IP. Better Auth stores one
 * `verifications` row per request (`identifier = reset-password:<token>`, `value = userId`) before it calls
 * `sendResetPassword`, so this count includes the current request and survives restarts. Rows of tokens that were
 * used are deleted, so only unused requests count.
 */
export async function recentResetRequests(prisma: PrismaClient, userId: string, now = Date.now()): Promise<number> {
  return prisma.verification.count({
    where: { value: userId, identifier: { startsWith: 'reset-password:' }, createdAt: { gt: new Date(now - 60 * 60 * 1000) } },
  });
}

/**
 * Better Auth: email + password, sessions stored in Postgres (sessions table), httpOnly cookies.
 * The browser reaches /api/auth/* through the web app's same-origin proxy, so baseURL is APP_URL.
 */
export function createAuth(
  prisma: PrismaClient,
  config: AppConfig,
  sendEmail: (message: EmailMessage) => Promise<void>,
  logger?: PinoLogger,
) {
  return betterAuth({
    appName: 'RepairOS',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.appUrl],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      // D4: "Forgot password". The emailed link is Better Auth's callback ({APP_URL}/api/auth/reset-password/<token>
      // ?callbackURL=<redirectTo>), which redirects to `${APP_URL}/reset-password?token=…`.
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // L4: at most `passwordResetPerEmailHour` reset emails per account per hour across all IPs. Over the cap the
        // email is silently skipped: the response stays the same 200, so it reveals nothing about the account.
        if ((await recentResetRequests(prisma, user.id)) > config.passwordResetPerEmailHour) {
          logger?.warn({ userId: user.id }, 'password reset email skipped: per-account hourly cap reached');
          return;
        }
        const email = passwordResetEmail({ name: user.name, url, expiresIn: '1 hour' });
        await sendEmail({ to: user.email, ...email });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh expiry at most daily
      additionalFields: {
        // Set only by POST /api/shops and POST /api/me/active-shop; membership is re-checked per request.
        activeShopId: { type: 'string', required: false, input: false },
      },
    },
    // Rate limiting for auth routes is done in front of the handler (express-rate-limit, see app.factory.ts)
    // so it also applies in development and returns the ApiError shape.
    rateLimit: { enabled: false },
    advanced: {
      // L3: Better Auth turns its Origin / callbackURL / redirectTo checks off when NODE_ENV=test. Keep them on
      // everywhere, so tests exercise the production behaviour.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: 'repairos',
      useSecureCookies: config.appUrl.startsWith('https://'),
    },
    telemetry: { enabled: false },
    // Better Auth's messages go to the app's pino logger, token-scrubbed, and without the extra arguments
    // (they can hold request details). BUG-01.
    logger: {
      disabled: config.logLevel === 'silent',
      log: (level, message) => {
        const text = `[better-auth] ${redactSecrets(String(message))}`;
        if (!logger) return;
        if (level === 'error') logger.error(text);
        else if (level === 'warn') logger.warn(text);
        else if (level === 'debug') logger.debug(text);
        else logger.info(text);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
