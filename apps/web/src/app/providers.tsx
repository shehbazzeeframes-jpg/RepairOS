'use client';

import { LinkProvider } from '@astryxdesign/core/Link';
import { Theme } from '@astryxdesign/core/theme';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useState, type ReactNode } from 'react';
import { defaultThemeSlug, themes } from '../../astryx-themes';
import { isApiRequestError } from '@/lib/api';
import { meQueryKey } from '@/lib/me';
import { watchActiveShop } from '@/lib/shop-cache';

function makeQueryClient() {
  // A 403 may mean the user's role or membership changed: re-read /api/me so the UI catches up.
  const onError = (error: unknown) => {
    if (isApiRequestError(error) && error.status === 403) {
      // cancelRefetch: false joins a /me fetch already in flight instead of cancelling it, so a burst
      // of 403s makes one request (the API's one-shot `accessRemoved` arrives in that one).
      void client.invalidateQueries({ queryKey: meQueryKey }, { cancelRefetch: false });
    }
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // Never retry auth/permission/validation failures; retry transient ones once.
        retry: (failureCount, error) =>
          !(isApiRequestError(error) && error.status >= 400 && error.status < 500) &&
          failureCount < 1,
      },
    },
  });
  // Drop other shops' cached data whenever /me's active shop changes (review M3).
  watchActiveShop(client);
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <Theme theme={themes[defaultThemeSlug]}>
      <LinkProvider component={NextLink}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </LinkProvider>
    </Theme>
  );
}
