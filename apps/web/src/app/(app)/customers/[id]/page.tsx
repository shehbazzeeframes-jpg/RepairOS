'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { CustomerDetailPage } from '@/components/customers/CustomerDetailPage';
import { RequirePermission } from '@/components/RequirePermission';

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission permission="customers.view">
      <Suspense>
        <CustomerDetailPage key={id} id={id} />
      </Suspense>
    </RequirePermission>
  );
}
