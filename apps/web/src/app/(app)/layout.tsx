'use client';

import type { ReactNode } from 'react';
import { AppFrame } from '@/components/AppFrame';
import { ErrorState } from '@/components/ErrorState';
import { FullPageLoader } from '@/components/FullPageLoader';
import { useSessionGate } from '@/lib/session-gate';
import { SessionProvider } from '@/lib/shop-context';

/** Signed-in area: needs a session (else /sign-in) and an active shop (else /onboarding). */
export default function AppLayout({ children }: { children: ReactNode }) {
  const gate = useSessionGate('app');

  if (gate.status === 'error')
    return <ErrorState message={gate.error.message} onRetry={gate.retry} />;
  if (gate.status === 'loading' || !gate.me?.activeShop) return <FullPageLoader />;

  return (
    <SessionProvider value={{ me: gate.me, shop: gate.me.activeShop }}>
      {/* Keyed by shop: when the active shop changes (switch, deactivation fallback, another tab),
          every dialog, form and local state from the old shop is thrown away (review M3). */}
      <AppFrame key={gate.me.activeShop.id}>{children}</AppFrame>
    </SessionProvider>
  );
}
