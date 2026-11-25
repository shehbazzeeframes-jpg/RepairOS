'use client';

/*
 * Ticket list (spec §6; templates table-page + table-filter). Views with counts as tabs, a filter
 * bar, a table with row menus, and keyset pagination. Every filter is in the URL; the cursor stack
 * lives in component state and resets when the filters change.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { DateRangeInput } from '@astryxdesign/core/DateRangeInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Pagination } from '@astryxdesign/core/Pagination';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Switch } from '@astryxdesign/core/Switch';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { InboxStackIcon, PlusIcon } from '@heroicons/react/24/outline';
import {
  DEVICE_TYPE_LABELS,
  LIST_SEARCH_DEBOUNCE_MS,
  PAGE_SIZES,
  STATUS_CATEGORY_LABELS,
  TICKET_VIEW_LABELS,
  TicketDetail,
  UNASSIGNED,
  defaultTicketView,
  ticketPath,
  type DeviceTypeValue,
  type TicketCounts,
  type TicketListItem,
  type TicketSort,
  type TicketView,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadError, RowsSkeleton } from '@/components/PageStates';
import { useCan } from '@/components/RequirePermission';
import { ShortcutHint } from '@/components/ui/ShortcutHint';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isTypingTarget } from '@/lib/focus';
import {
  clearTicketFilters,
  hasTicketFilters,
  pageRangeText,
  ticketFiltersFrom,
  ticketFiltersToApi,
  ticketFiltersToUrl,
  type TicketFilters,
} from '@/lib/list-params';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import {
  useAssignees,
  useTicketCounts,
  useTicketList,
  useTicketStatuses,
} from '@/lib/sprint2-queries';
import { statusMenuTargets, useStatusChanger } from './status-change';
import { TicketTable } from './TicketTable';

const TAB_VIEWS: TicketView[] = ['open', 'mine', 'unassigned', 'ready', 'overdue', 'closed'];

const EMPTY_VIEW: Record<TicketView, string> = {
  open: 'No open tickets.',
  mine: 'Nothing assigned to you.',
  unassigned: 'Every ticket has someone on it.',
  ready: 'Nothing waiting for pickup.',
  overdue: 'Nothing overdue. Nice.',
  closed: 'No closed tickets yet.',
  all: 'No tickets yet.',
};

const SORT_OPTIONS: { value: TicketSort; label: string }[] = [
  { value: 'default', label: 'Urgent first, then due' },
  { value: 'due', label: 'Due (soonest)' },
  { value: 'created', label: 'Created (newest)' },
  { value: 'updated', label: 'Last updated' },
  { value: 'number', label: 'Ticket # (highest)' },
];

const viewKey = (userId: string, shopId: string) => `repairos:tickets-view:${userId}:${shopId}`;

function rememberedView(userId: string, shopId: string): TicketView | null {
  try {
    const v = window.localStorage.getItem(viewKey(userId, shopId));
    return v && (TAB_VIEWS as string[]).includes(v) ? (v as TicketView) : null;
  } catch {
    return null;
  }
}

function countFor(counts: TicketCounts | undefined, view: TicketView): number | null {
  if (!counts || view === 'closed' || view === 'all') return null;
  return counts[view];
}

const toRange = (from: string | null, to: string | null) =>
  from && to ? { start: from as ISODateString, end: to as ISODateString } : null;

export function TicketListPage() {
  const { me, shop } = useSession();
  const can = useCan();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const isNarrow = useMediaQuery('(max-width: 1180px)');

  const fallbackView = defaultTicketView(me.role);
  const filters = useMemo(() => {
    const f = ticketFiltersFrom(new URLSearchParams(sp.toString()), fallbackView);
    if (!sp.get('view') && typeof window !== 'undefined') {
      const remembered = rememberedView(me.user.id, shop.id);
      if (remembered) f.view = remembered;
    }
    return f;
  }, [sp, fallbackView, me.user.id, shop.id]);
  const urlKey = ticketFiltersToUrl(filters);

  // Keyset pages: cursors[i] opens page i + 1. Paging belongs to one set of filters: when the URL's
  // filters change it starts again at page 1.
  const [paging, setPaging] = useState<{ key: string; cursors: (string | null)[]; page: number }>({
    key: urlKey,
    cursors: [null],
    page: 1,
  });
  const current = paging.key === urlKey ? paging : { key: urlKey, cursors: [null], page: 1 };
  const { cursors, page } = current;

  const apiSearch = ticketFiltersToApi(filters, cursors[page - 1] ?? null);
  const list = useTicketList(apiSearch);
  const counts = useTicketCounts();
  const statuses = useTicketStatuses();
  const assignees = useAssignees();
  const changer = useStatusChanger();

  const [search, setSearch] = useState(filters.q);
  const searchRef = useRef<HTMLElement>(null);
  const navigate = (next: TicketFilters) => {
    const qs = ticketFiltersToUrl(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const update = (patch: Partial<TicketFilters>) => navigate({ ...filters, ...patch });

  // Search box → URL after the debounce.
  useEffect(() => {
    if (search === filters.q) return;
    const t = window.setTimeout(() => update({ q: search }), LIST_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // "/" focuses this page's search (page search wins over the palette, §0.3).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      searchRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const take = useMutation({
    mutationFn: (t: TicketListItem) =>
      apiFetch(ticketPath('assign', { id: t.id }), TicketDetail, {
        method: 'POST',
        json: { userId: me.user.id },
      }),
    onSuccess: (d) => showToast({ body: `You took ${d.numberLabel}` }),
    onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shop.id) }),
  });

  const selectView = (view: string) => {
    try {
      window.localStorage.setItem(viewKey(me.user.id, shop.id), view);
    } catch {
      // per-device convenience only
    }
    update({
      view: view as TicketView,
      sort: view === 'closed' ? 'closed' : filters.sort === 'closed' ? 'default' : filters.sort,
    });
  };

  const rowActions = (t: TicketListItem): DropdownMenuOption[] => {
    const items: DropdownMenuOption[] = [];
    if (can('tickets.edit') && !t.assignee && t.status.category !== 'CLOSED') {
      items.push({ label: 'Take', description: 'Assign it to you', onClick: () => take.mutate(t) });
    }
    const targets = statusMenuTargets(t.status, statuses.data?.items ?? [], me.permissions);
    if (targets.length) {
      items.push({
        label: 'Change status',
        items: targets.map((s) => ({
          id: s.id,
          label: <StatusBadge {...s} />,
          onClick: () => changer.request(t, s),
        })),
      });
    }
    items.push({ label: 'Open ticket', href: `/tickets/${t.id}` });
    return items;
  };

  const statusOptions = useMemo(() => {
    const all = statuses.data?.items ?? [];
    const visible = all.filter((s) => !s.isHidden).map((s) => ({ value: s.id, label: s.name }));
    const hidden = all.filter((s) => s.isHidden).map((s) => ({ value: s.id, label: s.name }));
    return hidden.length
      ? [...visible, { type: 'section' as const, title: 'Hidden statuses', options: hidden }]
      : visible;
  }, [statuses.data]);

  const data = list.data;
  const rows = data?.items ?? [];
  const now = data ? Date.parse(data.serverNow) : undefined;
  const filtered = hasTicketFilters(filters);
  const emptyShop =
    !filtered && filters.view === 'open' && counts.data?.open === 0 && rows.length === 0;
  const tabViews = filters.view === 'all' ? [...TAB_VIEWS, 'all' as const] : TAB_VIEWS;

  return (
    <VStack gap={5}>
      <title>Tickets · RepairOS</title>
      <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
        <Heading level={1}>Tickets</Heading>
        {can('tickets.create') ? (
          <HStack gap={2} vAlign="center">
            <ShortcutHint keys="n" label="New ticket" />
            <Button
              label="New ticket"
              variant="primary"
              icon={<Icon icon={PlusIcon} />}
              href="/tickets/new"
            />
          </HStack>
        ) : null}
      </HStack>

      <TabList value={filters.view} onChange={selectView} hasDivider aria-label="Ticket views">
        {tabViews.map((v) => {
          const n = countFor(counts.data, v);
          return (
            <Tab
              key={v}
              value={v}
              label={TICKET_VIEW_LABELS[v]}
              endContent={
                counts.isPending && v !== 'closed' && v !== 'all' ? (
                  <Skeleton width={20} height={16} />
                ) : n !== null ? (
                  <Badge
                    label={String(n)}
                    variant={v === 'overdue' && n > 0 ? 'error' : 'neutral'}
                  />
                ) : undefined
              }
            />
          );
        })}
      </TabList>

      <VStack gap={3} role="search" aria-label="Filter tickets">
        <HStack gap={3} wrap="wrap" vAlign="end">
          <VStack ref={searchRef}>
            <TextInput
              type="search"
              label="Search tickets"
              isLabelHidden
              placeholder="Search #, customer, phone, IMEI…"
              startIcon="search"
              value={search}
              onChange={setSearch}
              width={280}
            />
          </VStack>
          <MultiSelector
            label="Status"
            isLabelHidden
            placeholder="Status"
            options={statusOptions}
            value={filters.status}
            onChange={(status) => update({ status })}
            renderOption={(o) => {
              const s = statuses.data?.items.find((x) => x.id === o.value);
              return s ? <StatusBadge {...s} /> : o.label;
            }}
            hasSearch
            width={160}
          />
          <MultiSelector
            label="Technician"
            isLabelHidden
            placeholder="Technician"
            options={[
              { value: UNASSIGNED, label: 'Unassigned' },
              ...(assignees.data?.items ?? []).map((a) => ({
                value: a.userId,
                label: a.isSelf ? `${a.name} (you)` : a.name,
              })),
            ]}
            value={filters.assignee}
            onChange={(assignee) => update({ assignee })}
            width={160}
          />
          <MultiSelector
            label="Device type"
            isLabelHidden
            placeholder="Device type"
            options={Object.entries(DEVICE_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            value={filters.deviceType}
            onChange={(v) => update({ deviceType: v as DeviceTypeValue[] })}
            width={150}
          />
          <SegmentedControl
            label="Priority"
            value={filters.priority ?? 'ANY'}
            onChange={(v) => update({ priority: v === 'ANY' ? null : (v as 'NORMAL' | 'URGENT') })}
            size="sm"
          >
            <SegmentedControlItem value="ANY" label="Any" />
            <SegmentedControlItem value="NORMAL" label="Normal" />
            <SegmentedControlItem value="URGENT" label="Urgent" />
          </SegmentedControl>
        </HStack>
        <HStack gap={3} wrap="wrap" vAlign="end">
          <DateRangeInput
            label="Created"
            isLabelHidden
            placeholder="Created between"
            size="sm"
            value={toRange(filters.createdFrom, filters.createdTo)}
            onChange={(r) => update({ createdFrom: r?.start ?? null, createdTo: r?.end ?? null })}
          />
          <DateRangeInput
            label="Due"
            isLabelHidden
            placeholder="Due between"
            size="sm"
            value={toRange(filters.dueFrom, filters.dueTo)}
            onChange={(r) => update({ dueFrom: r?.start ?? null, dueTo: r?.end ?? null })}
          />
          <Switch
            label="Warranty only"
            value={filters.warranty}
            onChange={(warranty) => update({ warranty })}
          />
          {filters.category.length ? (
            <Badge
              label={`Category: ${filters.category.map((c) => STATUS_CATEGORY_LABELS[c]).join(', ')}`}
            />
          ) : null}
          <Selector
            label="Sort"
            size="sm"
            value={filters.sort}
            onChange={(v) => v && update({ sort: v as TicketSort })}
            options={
              filters.view === 'closed'
                ? [{ value: 'closed', label: 'Closed (newest)' }, ...SORT_OPTIONS]
                : SORT_OPTIONS
            }
            width={220}
          />
          {filtered ? (
            <Button
              label="Clear filters"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                navigate(clearTicketFilters(filters));
              }}
            />
          ) : null}
        </HStack>
      </VStack>

      {list.isPending ? (
        <RowsSkeleton rows={8} label="Loading tickets" />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : emptyShop ? (
        <EmptyState
          headingLevel={2}
          icon={<Icon icon={InboxStackIcon} size="lg" color="secondary" />}
          title="No tickets yet"
          description="Check in your first device."
          actions={
            can('tickets.create') ? (
              <Button label="New ticket" variant="primary" href="/tickets/new" />
            ) : undefined
          }
        />
      ) : (
        <VStack gap={3}>
          <TicketTable
            rows={rows}
            now={now}
            isNarrow={isNarrow}
            columns={[
              'number',
              'customer',
              'device',
              'issues',
              'status',
              'assignee',
              'due',
              'priority',
              'created',
            ]}
            actions={rowActions}
            emptyState={
              <EmptyState
                isCompact
                title={
                  filtered
                    ? `No tickets match${filters.q ? ` “${filters.q}”` : ' these filters'}`
                    : EMPTY_VIEW[filters.view]
                }
                actions={
                  filtered ? (
                    <Button
                      label="Clear filters"
                      onClick={() => {
                        setSearch('');
                        navigate(clearTicketFilters(filters));
                      }}
                    />
                  ) : undefined
                }
              />
            }
          />
          {data && rows.length > 0 ? (
            <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
              <Text color="secondary" hasTabularNumbers aria-live="polite">
                {pageRangeText(
                  page,
                  filters.limit,
                  rows.length,
                  data.total,
                  data.totalCapped,
                  shop.locale,
                )}
              </Text>
              <Pagination
                label="Ticket pages"
                variant="compact"
                page={page}
                hasMore={!!data.nextCursor}
                pageSize={filters.limit}
                pageSizeOptions={[...PAGE_SIZES]}
                onPageSizeChange={(limit) => update({ limit })}
                onChange={(p) => {
                  const next = [...cursors];
                  if (p > page && data.nextCursor) next[page] = data.nextCursor;
                  setPaging({ key: urlKey, cursors: next, page: p });
                }}
              />
            </HStack>
          ) : null}
        </VStack>
      )}
      {changer.dialogs}
    </VStack>
  );
}
