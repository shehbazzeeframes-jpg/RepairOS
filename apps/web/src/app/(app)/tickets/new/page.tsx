'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/RequirePermission';
import { CheckInPage } from '@/components/tickets/CheckInPage';

function CheckInRoute() {
  const sp = useSearchParams();
  return (
    <CheckInPage
      prefill={{
        customerId: sp.get('customerId'),
        deviceId: sp.get('deviceId'),
        warrantyOf: sp.get('warrantyOf'),
      }}
    />
  );
}

export default function NewTicketPage() {
  return (
    <RequirePermission permission="tickets.create">
      <Suspense>
        <CheckInRoute />
      </Suspense>
    </RequirePermission>
  );
}
