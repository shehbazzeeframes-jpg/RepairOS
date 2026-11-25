import { z } from 'zod';

/**
 * Auth extras (D4). These routes are served by Better Auth under basePath /api/auth (the web app proxies them,
 * same origin). Its JSON error bodies are Better Auth's, except 429 RATE_LIMITED / 400 VALIDATION_FAILED from the
 * per-IP+email rate-limit layer in front of it.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Minimum password policy, identical to Better Auth's config (minPasswordLength 8, maxPasswordLength 128). */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer`);

export const AUTH_PATHS = {
  signUp: '/api/auth/sign-up/email',
  signIn: '/api/auth/sign-in/email',
  signOut: '/api/auth/sign-out',
  /** POST `ForgotPasswordInput` → 200 `{ status: true }` whether or not the email exists (no account enumeration). */
  requestPasswordReset: '/api/auth/request-password-reset',
  /**
   * GET, the link inside the reset email: Better Auth validates the token and redirects to
   * `{redirectTo}?token=…` (or `{redirectTo}?error=INVALID_TOKEN`).
   */
  resetPasswordCallback: '/api/auth/reset-password/:token',
  /** POST `ResetPasswordInput` → 200 `{ status: true }`; 400 INVALID_TOKEN when expired/used. */
  resetPassword: '/api/auth/reset-password',
} as const;

/** Web page that receives the token and shows the new-password form. */
export const RESET_PASSWORD_PAGE = '/reset-password';

/** Body for POST /api/auth/request-password-reset. `redirectTo` = `${APP_URL}/reset-password`. */
export const ForgotPasswordInput = z.object({
  email: z.string().trim().min(1, 'Enter your email address').max(254).email('Enter a valid email address'),
  redirectTo: z.string().optional(),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;

/** Body for POST /api/auth/reset-password. */
export const ResetPasswordInput = z.object({ newPassword: PasswordSchema, token: z.string().min(1) });
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>;
