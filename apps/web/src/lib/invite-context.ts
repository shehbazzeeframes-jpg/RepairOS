'use client';

import { useSearchParams } from 'next/navigation';
import { useInvitePreview } from './queries';
import { invitePath } from './redirects';

/**
 * `?invite=<token>` on sign-in / sign-up: the invite's path to return to, and (for a VALID invite)
 * the shop name and invited email for the "Joining {shop}" note and the prefilled email.
 */
export function useInviteContext() {
  const searchParams = useSearchParams();
  const token = searchParams.get('invite');
  const returnTo = invitePath(token);
  const preview = useInvitePreview(token ?? '', returnTo !== null);
  const valid = preview.data?.state === 'VALID' ? preview.data : null;
  return {
    token: returnTo ? token : null,
    returnTo,
    isLoading: returnTo !== null && preview.isPending,
    shopName: valid?.shopName ?? null,
    email: valid?.email ?? null,
  };
}
