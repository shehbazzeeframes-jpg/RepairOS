'use client';

import { Center } from '@astryxdesign/core/Center';
import { Spinner } from '@astryxdesign/core/Spinner';

export function FullPageLoader({ label = 'Loading RepairOS' }: { label?: string }) {
  return (
    <Center axis="both" minHeight="100dvh" padding={6}>
      <Spinner size="lg" aria-label={label} />
    </Center>
  );
}
