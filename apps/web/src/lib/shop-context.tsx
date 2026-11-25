'use client';

import type { MeResponse, Shop } from '@repairos/contracts';
import { createContext, useContext, type ReactNode } from 'react';

export interface SessionContextValue {
  me: MeResponse;
  shop: Shop;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionContextValue;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The signed-in user and their active shop. Only usable inside the app shell. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside the app shell');
  return ctx;
}

/** The active shop's id: part of every shop-scoped query key (see `qk` in lib/queries). */
export function useShopId(): string {
  return useSession().shop.id;
}
