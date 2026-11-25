'use client';

import { LinkProvider } from '@astryxdesign/core/Link';
import { Theme } from '@astryxdesign/core/theme';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import NextLink from 'next/link';
import { useState, type ReactNode } from 'react';
import { defaultThemeSlug, themes } from '../../astryx-themes';
import { isApiRequestError } from '@/lib/api';
import { meQueryKey } from '@/lib/me';

function makeQueryClient() {
  // A 403 may mean the user's role or membership changed: re-read /api/me so the UI catches up.
  const onError = (error: unknown) => {
    if (isApiRequestError(error) && error.status === 403) {
      void client.invalidateQueries({ queryKey: meQueryKey });
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
