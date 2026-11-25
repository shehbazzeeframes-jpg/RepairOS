import { AUTH_PATHS, type ForgotPasswordInput, type ResetPasswordInput } from '@repairos/contracts';

/** Outcome of a Better Auth call: its JSON error bodies are not ApiError-shaped, so read `code` loosely. */
export interface AuthCallResult {
  ok: boolean;
  status: number;
  code: string | null;
}

async function authPost(path: string, body: unknown): Promise<AuthCallResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let code: string | null = null;
    try {
      const json: unknown = await res.json();
      if (json && typeof json === 'object' && 'code' in json && typeof json.code === 'string') {
        code = json.code;
      }
    } catch {
      code = null;
    }
    return { ok: res.ok, status: res.status, code };
  } catch {
    return { ok: false, status: 0, code: 'NETWORK_ERROR' };
  }
}

export function requestPasswordReset(input: ForgotPasswordInput): Promise<AuthCallResult> {
  return authPost(AUTH_PATHS.requestPasswordReset, input);
}

export function resetPassword(input: ResetPasswordInput): Promise<AuthCallResult> {
  return authPost(AUTH_PATHS.resetPassword, input);
}

/** Better Auth reports an expired/used/unknown token as INVALID_TOKEN (400). */
export function isInvalidToken(result: AuthCallResult): boolean {
  return (
    result.code === 'INVALID_TOKEN' ||
    (result.status === 400 && result.code !== 'VALIDATION_FAILED')
  );
}
