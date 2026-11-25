'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { FullPageLoader } from '@/components/FullPageLoader';
import { settingsHome } from '@/lib/permissions';
import { useSession } from '@/lib/shop-context';

/** /settings → the first settings page this user may see (the layout handles "none"). */
export default function SettingsIndex() {
  const { me } = useSession();
  const router = useRouter();
  const home = settingsHome(me.permissions);
  useEffect(() => {
    if (home) router.replace(home);
  }, [home, router]);
  return <FullPageLoader label="Opening settings" />;
}
