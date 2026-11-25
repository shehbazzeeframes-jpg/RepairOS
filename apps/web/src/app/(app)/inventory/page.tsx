import type { Metadata } from 'next';
import { ComingSoon } from '@/components/ComingSoon';

export const metadata: Metadata = { title: 'Inventory' };

export default function InventoryPage() {
  return <ComingSoon href="/inventory" />;
}
