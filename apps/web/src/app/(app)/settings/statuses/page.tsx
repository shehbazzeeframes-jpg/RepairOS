'use client';

import { RequirePermission } from '@/components/RequirePermission';
import { TicketStatusesPage } from '@/components/settings/TicketStatusesPage';

export default function StatusesSettingsPage() {
  return (
    <RequirePermission permission="statuses.manage">
      <TicketStatusesPage />
    </RequirePermission>
  );
}
