import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CheckInPrototype } from '@/components/prototype/CheckInPrototype';
import { isPrototypeEnabled } from '@/lib/prototypes';

export const metadata: Metadata = { title: 'Check-in prototype', robots: { index: false } };

/** Sprint 2 design prototype of /tickets/new (A1). Dev-only: a 404 in production builds. */
export default function CheckInPrototypePage() {
  if (
    !isPrototypeEnabled({
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_PROTOTYPES: process.env.NEXT_PUBLIC_PROTOTYPES,
    })
  ) {
    notFound();
  }
  return <CheckInPrototype />;
}
