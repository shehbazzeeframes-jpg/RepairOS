import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'Tickets' };

export default function TicketsPage() {
  return <ComingSoon href="/tickets" />;
}
