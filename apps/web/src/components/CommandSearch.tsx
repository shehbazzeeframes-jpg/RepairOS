'use client';

/*
 * Global search (spec §10; ⌘K / "/"): Astryx CommandPalette. Empty input shows Recent (this
 * browser, per user + shop, A19) and Actions; typing searches tickets, customers and devices
 * (GET /api/search), grouped, each group only with its permission. An exact ticket number or a
 * full IMEI/serial puts that result first, so a scanner's ↵ jumps straight there.
 */

import { CommandPalette } from '@astryxdesign/core/CommandPalette';
import { Text } from '@astryxdesign/core/Text';
import {
  GLOBAL_SEARCH_DEBOUNCE_MS,
  GLOBAL_SEARCH_PATH,
  GlobalSearchResponse,
  maskIdentifier,
} from '@repairos/contracts';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useCan } from './RequirePermission';
import { apiFetch } from '@/lib/api';
import { readRecent } from '@/lib/recent-items';
import { useSession } from '@/lib/shop-context';

interface SearchItem {
  id: string;
  label: string;
  auxiliaryData: { group: string; description?: string; href: string };
  [key: string]: unknown;
}

/** Pure: palette rows for a response (exact match first; "See all" last). */
export function searchItems(
  q: string,
  r: GlobalSearchResponse,
  opts: { canTickets: boolean; canCustomers: boolean },
): SearchItem[] {
  const items: SearchItem[] = [];
  if (opts.canTickets) {
    for (const t of r.tickets) {
      items.push({
        id: `ticket:${t.id}`,
        label: `${t.numberLabel} · ${t.customerDisplayName}`,
        auxiliaryData: {
          group: 'Tickets',
          description: `${t.deviceLabel} · ${t.status.name}`,
          href: `/tickets/${t.id}`,
        },
      });
    }
  }
  if (opts.canCustomers) {
    for (const c of r.customers) {
      items.push({
        id: `customer:${c.id}`,
        label: c.displayName,
        auxiliaryData: {
          group: 'Customers',
          description: [c.primaryPhone, c.email].filter(Boolean).join(' · ') || undefined,
          href: `/customers/${c.id}`,
        },
      });
    }
    for (const d of r.devices) {
      items.push({
        id: `device:${d.id}`,
        label: `${d.label} · ${d.customer.displayName}`,
        auxiliaryData: {
          group: 'Devices',
          description: [
            d.imei
              ? `IMEI ${maskIdentifier(d.imei)}`
              : d.serial
                ? `Serial ${maskIdentifier(d.serial)}`
                : null,
            d.latestTicket ? `Latest ticket ${d.latestTicket.numberLabel}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          href: d.latestTicket ? `/tickets/${d.latestTicket.id}` : `/customers/${d.customer.id}`,
        },
      });
    }
  }
  const exact = r.exactMatch;
  if (exact) {
    const key = exact.kind === 'ticket' ? `ticket:${exact.ticketId}` : `device:${exact.deviceId}`;
    const i = items.findIndex((x) => x.id === key);
    if (i > 0) items.unshift(...items.splice(i, 1));
  }
  if (opts.canTickets) {
    items.push({
      id: `all:${q}`,
      label: 'See all ticket results',
      auxiliaryData: { group: 'Tickets', href: `/tickets?view=all&q=${encodeURIComponent(q)}` },
    });
  }
  return items;
}

export function CommandSearch({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { me, shop } = useSession();
  const can = useCan();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const canTickets = can('tickets.view');
  const canCustomers = can('customers.view');
  const canCreate = can('tickets.create');
  const canManage = can('customers.manage');

  const source = useMemo(() => {
    const hrefs = new Map<string, string>();
    const ctl: { current: AbortController | null } = { current: null };
    const remember = (items: SearchItem[]) => {
      for (const i of items) hrefs.set(i.id, i.auxiliaryData.href);
      return items;
    };
    return {
      hrefs,
      bootstrap: () =>
        remember([
          ...readRecent(me.user.id, shop.id).map<SearchItem>((r) => ({
            id: `recent:${r.kind}:${r.id}`,
            label: r.label,
            auxiliaryData: {
              group: 'Recent',
              description: r.kind === 'ticket' ? 'Ticket' : 'Customer',
              href: r.kind === 'ticket' ? `/tickets/${r.id}` : `/customers/${r.id}`,
            },
          })),
          ...(canCreate
            ? [
                {
                  id: 'action:new-ticket',
                  label: 'New ticket',
                  auxiliaryData: { group: 'Actions', href: '/tickets/new' },
                },
              ]
            : []),
          ...(canManage
            ? [
                {
                  id: 'action:new-customer',
                  label: 'New customer',
                  auxiliaryData: { group: 'Actions', href: '/customers/new' },
                },
              ]
            : []),
        ]),
      search: async (query: string): Promise<SearchItem[]> => {
        const q = query.trim();
        if (q.length < 2) return [];
        ctl.current?.abort();
        const controller = new AbortController();
        ctl.current = controller;
        await new Promise((r) => window.setTimeout(r, GLOBAL_SEARCH_DEBOUNCE_MS));
        if (controller.signal.aborted) return [];
        try {
          const r = await apiFetch(
            `${GLOBAL_SEARCH_PATH}?q=${encodeURIComponent(q)}`,
            GlobalSearchResponse,
            {
              signal: controller.signal,
            },
          );
          setFailed(false);
          return remember(searchItems(q, r, { canTickets, canCustomers }));
        } catch {
          if (!controller.signal.aborted) setFailed(true);
          return [];
        }
      },
    };
  }, [me.user.id, shop.id, canTickets, canCustomers, canCreate, canManage]);

  return (
    <CommandPalette<SearchItem>
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      label="Search RepairOS"
      width={640}
      searchSource={source}
      emptySearchText={failed ? "Search isn't working right now." : 'Nothing found.'}
      emptyBootstrapText="Type to search tickets, customers and devices"
      renderItem={(item) => (
        <>
          <Text maxLines={1}>{item.label}</Text>
          {item.auxiliaryData.description ? (
            <Text type="supporting" color="secondary" maxLines={1}>
              {item.auxiliaryData.description}
            </Text>
          ) : null}
        </>
      )}
      onValueChange={(value) => {
        const href = source.hrefs.get(value);
        onOpenChange(false);
        if (href) router.push(href);
      }}
    />
  );
}
