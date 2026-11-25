'use client';

import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { Heading } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { navItemFor } from '@/lib/nav';

/** Placeholder for a nav area that a later sprint delivers. */
export function ComingSoon({ href }: { href: string }) {
  const item = navItemFor(href);
  return (
    <VStack gap={6}>
      <Heading level={1}>{item.label}</Heading>
      <EmptyState
        headingLevel={2}
        icon={<Icon icon={item.icon} size="lg" color="secondary" />}
        title={`Coming in Sprint ${item.sprint ?? '?'}`}
        description={item.description}
        actions={<Button label="Back to dashboard" href="/" />}
      />
    </VStack>
  );
}
