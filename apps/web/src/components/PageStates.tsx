'use client';

import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading, Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/errors';

/** h1 + one-line intro + optional actions on the right. */
export function PageIntro({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <VStack gap={1}>
      <Heading level={1}>{title}</Heading>
      {description ? <Text color="secondary">{description}</Text> : null}
      {actions}
    </VStack>
  );
}

/** Shown when a page is opened without the permission it needs. */
export function NoAccess() {
  return (
    <EmptyState
      headingLevel={1}
      icon={<Icon icon={LockClosedIcon} size="lg" color="secondary" />}
      title="You don't have access to this page"
      description="Ask an owner or manager if you need it."
      actions={<Button label="Back to dashboard" href="/" />}
    />
  );
}

/** In-page load failure with a retry. */
export function LoadError({
  error,
  onRetry,
  title = "We couldn't load this",
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <EmptyState
      headingLevel={2}
      icon={<Icon icon="error" size="lg" color="error" />}
      title={title}
      description={errorMessage(error)}
      actions={<Button label="Try again" variant="primary" onClick={onRetry} />}
    />
  );
}

/** Placeholder rows while a table loads. */
export function RowsSkeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <VStack gap={3} aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} index={i} height={40} />
      ))}
    </VStack>
  );
}
