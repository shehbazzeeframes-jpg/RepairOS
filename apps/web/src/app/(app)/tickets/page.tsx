'use client';

import { Suspense } from 'react';
import { RequirePermission } from '@/components/RequirePermission';
import { TicketListPage } from '@/components/tickets/TicketListPage';

export default function TicketsPage() {
  return (
    <RequirePermission permission="tickets.view">
      <Suspense>
        <TicketListPage />
      </Suspense>
    </RequirePermission>
  );
}
