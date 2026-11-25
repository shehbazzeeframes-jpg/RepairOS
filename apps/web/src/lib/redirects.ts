import type { MeResponse } from '@repairos/contracts';

/**
 * Where a screen sits in the sign-in → onboarding → app flow.
 * - `app`: needs a session and an active shop.
 * - `onboarding`: needs a session and no active shop yet.
 * - `guest`: sign-in / sign-up; a signed-in user is sent on to the app.
 */
export type GateMode = 'app' | 'onboarding' | 'guest';

export function redirectFor(mode: GateMode, me: MeResponse | null): string | null {
  if (mode === 'guest') {
    if (!me) return null;
    return me.activeShop ? '/' : '/onboarding';
  }
  if (!me) return '/sign-in';
  if (mode === 'app' && !me.activeShop) return '/onboarding';
  if (mode === 'onboarding' && me.activeShop) return '/';
  return null;
}
