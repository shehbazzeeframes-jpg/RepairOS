import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isDevOutboxEnabled } from '@/lib/dev-outbox';
import { DevOutbox } from './DevOutbox';

export const metadata: Metadata = { title: 'Dev outbox', robots: { index: false } };

/** Dev-only (D6): a 404 in production builds. The e2e build opts in with NEXT_PUBLIC_DEV_OUTBOX=1. */
export default function DevOutboxPage() {
  if (
    !isDevOutboxEnabled({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_DEV_OUTBOX: process.env.NEXT_PUBLIC_DEV_OUTBOX,
    })
  ) {
    notFound();
  }
  return <DevOutbox />;
}
