import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'Reports' };

export default function ReportsPage() {
  return <ComingSoon href="/reports" />;
}
