'use client';

/* Customer list (spec §4.1; template table-page). Every filter in the URL; keyset pages. */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { DateRangeInput } from '@astryxdesign/core/DateRangeInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Pagination } from '@astryxdesign/core/Pagination';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { PlusIcon, UsersIcon } from '@heroicons/react/24/outline';
import {
  CONSENT_CHANNEL_LABELS,
  CUSTOMER_SORT_LABELS,
  LIST_SEARCH_DEBOUNCE_MS,
  PAGE_SIZES,
  type ConsentChannel,
  type CustomerListItem,
  type CustomerSort,
} from '@repairos/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadError, RowsSkeleton } from '@/components/PageStates';
import { useCan } from '@/components/RequirePermission';
import { PhoneText } from '@/components/ui/PhoneText';
import { isTypingTarget, onRowLinkKeyDown } from '@/lib/focus';
import {
  customerFiltersFrom,
  customerFiltersToApi,
  customerFiltersToUrl,
  hasCustomerFilters,
  pageRangeText,
  type CustomerFilters,
} from '@/lib/list-params';
import { useSession } from '@/lib/shop-context';
import { useCustomerList, useCustomerTags } from '@/lib/sprint2-queries';
import { formatShortDate } from '@/lib/timezone';

const toRange = (from: string | null, to: string | null) =>
  from && to ? { start: from as ISODateString, end: to as ISODateString } : null;

export function CustomerListPage() {
  const { shop } = useSession();
  const can = useCan();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const filters = useMemo(() => customerFiltersFrom(new URLSearchParams(sp.toString())), [sp]);
  const urlKey = customerFiltersToUrl(filters);
  const [paging, setPaging] = useState<{ key: string; cursors: (string | null)[]; page: number }>({
    key: urlKey,
    cursors: [null],
    page: 1,
  });
  const { cursors, page } = paging.key === urlKey ? paging : { cursors: [null], page: 1 };
  const list = useCustomerList(customerFiltersToApi(filters, cursors[page - 1] ?? null));
  const tags = useCustomerTags();
  const [search, setSearch] = useState(filters.q);
  const searchRef = useRef<HTMLElement>(null);

  const navigate = (next: CustomerFilters) => {
    const qs = customerFiltersToUrl(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const update = (patch: Partial<CustomerFilters>) => navigate({ ...filters, ...patch });
  const clear = () => {
    setSearch('');
    navigate({
      ...filters,
      q: '',
      type: null,
      tags: [],
      hasOpen: false,
      consent: [],
      createdFrom: null,
      createdTo: null,
      archived: false,
    });
  };

  useEffect(() => {
    if (search === filters.q) return;
    const t = window.setTimeout(() => update({ q: search }), LIST_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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

  const rows = list.data?.items ?? [];
  const filtered = hasCustomerFilters(filters);
  const columns: TableColumn<CustomerListItem>[] = [
    {
      key: 'name',
      header: 'Name',
      width: proportional(1, { minWidth: 160 }),
      renderCell: (c) => (
        <VStack gap={0.5}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Link href={`/customers/${c.id}`} weight="semibold">
              {c.displayName}
            </Link>
            {c.kind === 'BUSINESS' ? <Badge label="Business" /> : null}
            {c.archivedAt ? <Badge label="Archived" /> : null}
          </HStack>
          {c.businessContactName ? (
            <Text type="supporting" color="secondary">
              {c.businessContactName}
            </Text>
          ) : null}
        </VStack>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      width: proportional(1, { minWidth: 130 }),
      renderCell: (c) =>
        c.primaryPhone ? (
          <PhoneText e164={c.primaryPhone} shopCountry={shop.country} />
        ) : (
          <Text color="secondary">—</Text>
        ),
    },
    {
      key: 'email',
      header: 'Email',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (c) => (
        <Text color="secondary" maxLines={1}>
          {c.email ?? '—'}
        </Text>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (c) => (
        <HStack gap={1} wrap="wrap">
          {c.tags.slice(0, 2).map((t) => (
            <Token key={t} label={t} size="sm" />
          ))}
          {c.tags.length > 2 ? <Text type="supporting">+{c.tags.length - 2}</Text> : null}
        </HStack>
      ),
    },
    {
      key: 'open',
      header: 'Open tickets',
      width: pixel(104),
      align: 'end',
      renderCell: (c) => <Text hasTabularNumbers>{c.openTicketCount}</Text>,
    },
    {
      key: 'lastVisit',
      header: 'Last visit',
      width: pixel(128),
      renderCell: (c) => (
        <Text color="secondary">
          {c.lastVisitAt ? formatShortDate(c.lastVisitAt, shop) : 'Never'}
        </Text>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      width: pixel(128),
      renderCell: (c) => <Text color="secondary">{formatShortDate(c.createdAt, shop)}</Text>,
    },
  ];

  return (
    <VStack gap={5}>
      <title>Customers · RepairOS</title>
      <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
        <Heading level={1}>Customers</Heading>
        {can('customers.manage') ? (
          <Button
            label="New customer"
            variant="primary"
            icon={<Icon icon={PlusIcon} />}
            href="/customers/new"
          />
        ) : null}
      </HStack>
      <HStack gap={3} wrap="wrap" vAlign="end" role="search" aria-label="Filter customers">
        <VStack ref={searchRef}>
          <TextInput
            type="search"
            label="Search customers"
            isLabelHidden
            placeholder="Search name, phone or email"
            startIcon="search"
            value={search}
            onChange={setSearch}
            hasAutoFocus
            width={280}
          />
        </VStack>
        <SegmentedControl
          label="Type"
          size="sm"
          value={filters.type ?? 'ALL'}
          onChange={(v) => update({ type: v === 'ALL' ? null : (v as 'PERSON' | 'BUSINESS') })}
        >
          <SegmentedControlItem value="ALL" label="All" />
          <SegmentedControlItem value="PERSON" label="Person" />
          <SegmentedControlItem value="BUSINESS" label="Business" />
        </SegmentedControl>
        <MultiSelector
          label="Tags"
          isLabelHidden
          placeholder="Tags"
          hasSearch
          options={(tags.data?.tags ?? []).map((t) => ({ value: t, label: t }))}
          value={filters.tags}
          onChange={(v) => update({ tags: v })}
          width={140}
        />
        <MultiSelector
          label="Marketing consent"
          isLabelHidden
          placeholder="Marketing consent"
          options={(Object.keys(CONSENT_CHANNEL_LABELS) as ConsentChannel[]).map((c) => ({
            value: c,
            label: CONSENT_CHANNEL_LABELS[c],
          }))}
          value={filters.consent}
          onChange={(v) => update({ consent: v as ConsentChannel[] })}
          width={180}
        />
        <DateRangeInput
          label="Created"
          isLabelHidden
          placeholder="Created between"
          size="sm"
          value={toRange(filters.createdFrom, filters.createdTo)}
          onChange={(r) => update({ createdFrom: r?.start ?? null, createdTo: r?.end ?? null })}
        />
        <Switch
          label="Has open tickets"
          value={filters.hasOpen}
          onChange={(hasOpen) => update({ hasOpen })}
        />
        <Switch
          label="Show archived"
          value={filters.archived}
          onChange={(archived) => update({ archived })}
        />
        <Selector
          label="Sort"
          isLabelHidden
          size="sm"
          value={filters.sort}
          onChange={(v) => v && update({ sort: v as CustomerSort })}
          options={(Object.keys(CUSTOMER_SORT_LABELS) as CustomerSort[]).map((s) => ({
            value: s,
            label: CUSTOMER_SORT_LABELS[s],
          }))}
          width={180}
        />
        {filtered ? (
          <Button label="Clear filters" variant="ghost" size="sm" onClick={clear} />
        ) : null}
      </HStack>

      {list.isPending ? (
        <RowsSkeleton rows={8} label="Loading customers" />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 && !filtered ? (
        <EmptyState
          headingLevel={2}
          icon={<Icon icon={UsersIcon} size="lg" color="secondary" />}
          title="No customers yet"
          description="They're added when you check in a device."
          actions={
            can('customers.manage') ? (
              <Button label="New customer" variant="primary" href="/customers/new" />
            ) : undefined
          }
        />
      ) : (
        <VStack gap={3}>
          <VStack onKeyDown={onRowLinkKeyDown}>
            <Table
              data={rows}
              idKey="id"
              columns={columns}
              hasHover
              textOverflow="wrap"
              emptyState={
                <EmptyState
                  isCompact
                  title={
                    filters.q
                      ? `No customers match “${filters.q}”`
                      : 'No customers match these filters'
                  }
                  actions={<Button label="Clear filters" onClick={clear} />}
                />
              }
            />
          </VStack>
          {list.data && rows.length ? (
            <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
              <Text color="secondary" hasTabularNumbers aria-live="polite">
                {pageRangeText(
                  page,
                  filters.limit,
                  rows.length,
                  list.data.total,
                  list.data.totalCapped,
                  shop.locale,
                )}
              </Text>
              <Pagination
                label="Customer pages"
                variant="compact"
                page={page}
                hasMore={!!list.data.nextCursor}
                pageSize={filters.limit}
                pageSizeOptions={[...PAGE_SIZES]}
                onPageSizeChange={(limit) => update({ limit })}
                onChange={(p) => {
                  const next = [...cursors];
                  if (p > page && list.data?.nextCursor) next[page] = list.data.nextCursor;
                  setPaging({ key: urlKey, cursors: next, page: p });
                }}
              />
            </HStack>
          ) : null}
        </VStack>
      )}
    </VStack>
  );
}
