'use client';

/*
 * "Already a customer?" (spec §4.4, A5): exact phone/email matches, archived included, shown under
 * the contact fields after DUPLICATE_CHECK_DEBOUNCE_MS. A warning only: saving is never blocked.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
  CUSTOMER_ACTION_PATHS,
  DUPLICATE_CHECK_DEBOUNCE_MS,
  DuplicateCheckResponse,
  EmailAddress,
  normalizePhone,
  type DuplicateMatch,
} from '@repairos/contracts';
import { useQuery } from '@tanstack/react-query';
import { PhoneText } from '@/components/ui/PhoneText';
import { apiFetch } from '@/lib/api';
import { useSession } from '@/lib/shop-context';
import { formatLongDate } from '@/lib/timezone';
import { useDebounced } from '@/lib/use-debounced';

export function useDuplicates(phone: string, email: string, excludeId?: string) {
  const { shop } = useSession();
  const p = useDebounced(phone.trim(), DUPLICATE_CHECK_DEBOUNCE_MS);
  const e = useDebounced(email.trim(), DUPLICATE_CHECK_DEBOUNCE_MS);
  const validPhone = p && normalizePhone(p, shop.country) ? p : '';
  const validEmail = e && EmailAddress.safeParse(e).success ? e : '';
  const params = new URLSearchParams();
  if (validPhone) params.set('phone', validPhone);
  if (validEmail) params.set('email', validEmail);
  if (excludeId) params.set('excludeId', excludeId);
  return useQuery({
    queryKey: ['shop', shop.id, 'customers', 'duplicates', params.toString()],
    queryFn: () =>
      apiFetch(`${CUSTOMER_ACTION_PATHS.duplicates}?${params.toString()}`, DuplicateCheckResponse),
    enabled: !!(validPhone || validEmail),
    staleTime: 30_000,
  });
}

export function CustomerDuplicatePanel({
  phone,
  email,
  excludeId,
  onUse,
  useLabel = 'Use this customer',
}: {
  phone: string;
  email: string;
  excludeId?: string;
  /** Omit to show matches without a "use" action (the edit form). */
  onUse?: (match: DuplicateMatch) => void;
  useLabel?: string;
}) {
  const { shop } = useSession();
  const dupes = useDuplicates(phone, email, excludeId);
  const items = dupes.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Banner
      status="warning"
      title="Already a customer?"
      description={
        <VStack gap={2}>
          <List density="compact" aria-label="Possible matches">
            {items.map((m) => (
              <ListItem
                key={m.id}
                label={
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="medium">{m.displayName}</Text>
                    {m.archived ? <Badge label="Archived" /> : null}
                  </HStack>
                }
                description={
                  <VStack gap={0.5}>
                    <HStack gap={2} wrap="wrap" vAlign="center">
                      {m.primaryPhone ? (
                        <PhoneText e164={m.primaryPhone} shopCountry={shop.country} />
                      ) : null}
                      {m.email ? <Text color="secondary">{m.email}</Text> : null}
                    </HStack>
                    <Text type="supporting" color="secondary">
                      {m.lastVisitAt
                        ? `Last visit ${formatLongDate(m.lastVisitAt, shop)}`
                        : 'No visits yet'}{' '}
                      · {m.openTicketCount} open {m.openTicketCount === 1 ? 'ticket' : 'tickets'}
                    </Text>
                  </VStack>
                }
                endContent={
                  onUse ? (
                    <Button
                      size="sm"
                      label={m.archived ? 'Restore and use' : useLabel}
                      onClick={() => onUse(m)}
                    />
                  ) : undefined
                }
              />
            ))}
          </List>
          {dupes.data && dupes.data.more > 0 ? (
            <Text type="supporting">and {dupes.data.more} more</Text>
          ) : null}
        </VStack>
      }
    />
  );
}
