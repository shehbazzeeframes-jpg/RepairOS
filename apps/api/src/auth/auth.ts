import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@repairos/db';
import type { AppConfig } from '../config';

export const AUTH = Symbol('AUTH');

/**
 * Better Auth: email + password, sessions stored in Postgres (sessions table), httpOnly cookies.
 * The browser reaches /api/auth/* through the web app's same-origin proxy, so baseURL is APP_URL.
 */
export function createAuth(prisma: PrismaClient, config: AppConfig) {
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
      cookiePrefix: 'repairos',
      useSecureCookies: config.appUrl.startsWith('https://'),
    },
    telemetry: { enabled: false },
    logger: { disabled: config.logLevel === 'silent' },
  });
}

export type Auth = ReturnType<typeof createAuth>;
