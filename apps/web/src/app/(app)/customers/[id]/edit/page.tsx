'use client';

import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Button } from '@astryxdesign/core/Button';
import { useParams } from 'next/navigation';
import { CustomerForm } from '@/components/customers/CustomerForm';
import { LoadError, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission } from '@/components/RequirePermission';
import { hasErrorCode } from '@/lib/errors';
import { useCustomer } from '@/lib/sprint2-queries';

function EditCustomer({ id }: { id: string }) {
  const query = useCustomer(id);
  if (query.isPending) return <RowsSkeleton rows={6} label="Loading customer" />;
  if (hasErrorCode(query.error, 'NOT_FOUND')) {
    return (
      <EmptyState
        headingLevel={1}
        title="We can't find that customer."
        actions={<Button label="Back to customers" href="/customers" />}
      />
    );
  }
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  return <CustomerForm customer={query.data} />;
}

export default function EditCustomerPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission permission="customers.manage">
      <EditCustomer key={id} id={id} />
    </RequirePermission>
  );
}
