import { InviteToken, type MeResponse } from '@repairos/contracts';

/**
 * Where a screen sits in the sign-in → onboarding → app flow.
 * - `app`: needs a session and an active shop.
 * - `onboarding`: needs a session; a user with a shop only stays when creating another (`newShop`).
 * - `guest`: sign-in / sign-up; a signed-in user is sent on (back to the invite when there is one).
 * - `access-removed`: signed in, no active shop, and `accessRemoved` set.
 * - `public`: never redirects (invite pages, password reset, dev outbox).
 */
export type GateMode = 'app' | 'onboarding' | 'guest' | 'access-removed' | 'public';

export interface GateOptions {
  /** Invite token from `?invite=`; signed-in users return to `/invite/<token>`. */
  invite?: string | null;
  /** Onboarding opened from "Create a new shop". */
  newShop?: boolean;
}

/** Path back to an invite, or null for a missing/malformed token. */
export function invitePath(token: string | null | undefined): string | null {
  return token && InviteToken.safeParse(token).success ? `/invite/${token}` : null;
}

/** Where a signed-in user without an active shop belongs. */
function noShopTarget(me: MeResponse): string {
  return me.accessRemoved ? '/access-removed' : '/onboarding';
}

export function redirectFor(
  mode: GateMode,
  me: MeResponse | null,
  options: GateOptions = {},
): string | null {
  if (mode === 'public') return null;
  if (mode === 'guest') {
    if (!me) return null;
    return invitePath(options.invite) ?? (me.activeShop ? '/' : noShopTarget(me));
  }
  if (!me) return '/sign-in';
  switch (mode) {
    case 'app':
      return me.activeShop ? null : noShopTarget(me);
    case 'onboarding':
      return me.activeShop && !options.newShop ? '/' : null;
    case 'access-removed':
      if (me.activeShop) return '/';
      return me.accessRemoved ? null : '/onboarding';
  }
}
