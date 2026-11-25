'use client';

import { RequirePermission } from '@/components/RequirePermission';
import { TicketSettingsPage } from '@/components/settings/TicketSettingsPage';

export default function TicketSettingsRoute() {
  return (
    <RequirePermission permission="settings.view">
      <TicketSettingsPage />
    </RequirePermission>
  );
}
