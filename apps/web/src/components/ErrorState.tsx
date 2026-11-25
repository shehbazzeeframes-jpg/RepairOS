'use client';

import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';

/** Full-area error with a retry, used when GET /api/me fails for a reason other than 401. */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Center role="main" axis="both" minHeight="100dvh" padding={6}>
      <EmptyState
        headingLevel={1}
        icon={<Icon icon="error" size="lg" color="error" />}
        title="We couldn't load RepairOS"
        description={message}
        actions={<Button label="Try again" variant="primary" onClick={onRetry} />}
      />
    </Center>
  );
}
