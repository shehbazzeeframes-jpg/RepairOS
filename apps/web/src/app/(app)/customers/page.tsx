import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'Customers' };

export default function CustomersPage() {
  return <ComingSoon href="/customers" />;
}
