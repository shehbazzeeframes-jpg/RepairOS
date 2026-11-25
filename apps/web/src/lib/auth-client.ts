import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client. It talks to our own origin (default path /api/auth), which
 * Next.js rewrites to the API, so session cookies are first-party.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin,
});

/** Better Auth returns `{ error: { message, status, code } }` instead of throwing. */
export function authErrorMessage(
  error: { message?: string; status?: number; code?: string } | null | undefined,
): string {
  if (!error) return 'Something went wrong. Please try again.';
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'That email and password do not match. Check them and try again.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'An account with this email already exists. Sign in instead.';
    case 'PASSWORD_TOO_SHORT':
      return 'Password is too short.';
  }
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error.status !== undefined && error.status >= 500)
    return 'Something went wrong on our side. Please try again.';
  return error.message || 'Something went wrong. Please try again.';
}
