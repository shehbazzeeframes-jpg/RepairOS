'use client';

import { useParams } from 'next/navigation';
import { RequirePermission } from '@/components/RequirePermission';
import { TicketDetailPage } from '@/components/tickets/TicketDetailPage';

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission permission="tickets.view">
      {/* Keyed by id: dialogs and revealed passcodes never carry over to another ticket. */}
      <TicketDetailPage key={id} id={id} />
    </RequirePermission>
  );
}
