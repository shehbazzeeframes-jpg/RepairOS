'use client';

import { CustomerForm } from '@/components/customers/CustomerForm';
import { RequirePermission } from '@/components/RequirePermission';

export default function NewCustomerPage() {
  return (
    <RequirePermission permission="customers.manage">
      <CustomerForm customer={null} />
    </RequirePermission>
  );
}
