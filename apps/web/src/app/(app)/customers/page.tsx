'use client';

import { Suspense } from 'react';
import { CustomerListPage } from '@/components/customers/CustomerListPage';
import { RequirePermission } from '@/components/RequirePermission';

export default function CustomersPage() {
  return (
    <RequirePermission permission="customers.view">
      <Suspense>
        <CustomerListPage />
      </Suspense>
    </RequirePermission>
  );
}
