import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'POS' };

export default function PosPage() {
  return <ComingSoon href="/pos" />;
}
