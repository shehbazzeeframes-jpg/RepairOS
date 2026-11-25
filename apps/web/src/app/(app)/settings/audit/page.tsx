'use client';

import { Button } from '@astryxdesign/core/Button';
import { DialogHeader } from '@astryxdesign/core/Dialog';
import { Drawer } from '@astryxdesign/core/Drawer';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Table } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import {
  AUDIT_ACTION_GROUP_LABELS,
  AUDIT_ACTION_META,
  AuditActionGroup,
  AuditEventListQuery,
  MAX_AUDIT_RANGE_DAYS,
  auditActionsInGroup,
  type AuditAction,
  type AuditEventSummary,
} from '@repairos/contracts';
import { useMemo, useState } from 'react';
import { DateRangeFilter } from '@/components/DateRangeFilter';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission } from '@/components/RequirePermission';
import { auditActionLabel, auditDiff, auditEntityText, type DiffRow } from '@/lib/audit-diff';
import { useAuditEvent, useAuditEvents, useStaff, type AuditParams } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import {
  addDays,
  formatDateTime,
  lastMonth,
  thisMonth,
  todayInZone,
  type LocalDateRange,
  type ShopClock,
} from '@/lib/timezone';

/** Action filter values: "all", "group:<group>" or "action:<action>". */
function actionFilterParams(value: string): Pick<AuditParams, 'action' | 'actionGroup'> {
  if (value.startsWith('group:')) return { actionGroup: value.slice(6) as AuditParams['actionGroup'] };
  if (value.startsWith('action:')) return { action: value.slice(7) as AuditAction };
  return {};
}

const ACTION_OPTIONS = [
  { value: 'all', label: 'All actions' },
  ...AuditActionGroup.options.map((group) => ({
    type: 'section' as const,
    title: AUDIT_ACTION_GROUP_LABELS[group],
    options: [
      { value: `group:${group}`, label: `All ${AUDIT_ACTION_GROUP_LABELS[group].toLowerCase()}` },
      ...auditActionsInGroup(group).map((a) => ({
        value: `action:${a}`,
        label: AUDIT_ACTION_META[a].label,
      })),
    ],
  })),
];

function DiffTable({ rows }: { rows: DiffRow[] }) {
  const hasBefore = rows.some((r) => r.before !== null);
  const hasAfter = rows.some((r) => r.after !== null);
  if (rows.length === 0) return <Text color="secondary">No field changes were recorded.</Text>;
  return (
    <Table
      data={rows as (DiffRow & Record<string, unknown>)[]}
      idKey="key"
      density="compact"
      verticalAlign="top"
      columns={[
        { key: 'label', header: 'Field', renderCell: (r) => <Text weight="medium">{r.label}</Text> },
        ...(hasBefore
          ? [
              {
                key: 'before',
                header: 'Before',
                renderCell: (r: DiffRow) => <Text color="secondary">{r.before ?? '—'}</Text>,
              },
            ]
          : []),
        ...(hasAfter
          ? [{ key: 'after', header: 'After', renderCell: (r: DiffRow) => <Text>{r.after ?? '—'}</Text> }]
          : []),
      ]}
    />
  );
}

function EventDrawer({
  summary,
  shop,
  onClose,
}: {
  summary: AuditEventSummary | null;
  shop: ShopClock;
  onClose: () => void;
}) {
  const query = useAuditEvent(summary?.id ?? null);
  return (
    <Drawer
      isOpen={summary !== null}
      onOpenChange={(open) => !open && onClose()}
      label="Audit event"
      width={480}
    >
      {summary ? (
        <VStack gap={0}>
          <DialogHeader
            title={auditActionLabel(summary.action)}
            subtitle={`${summary.actor?.name ?? 'System'} · ${formatDateTime(summary.createdAt, shop)}`}
            onOpenChange={(open) => !open && onClose()}
          />
          <VStack gap={6} padding={6}>
            <MetadataList label={{ position: 'start', width: 96 }}>
              <MetadataListItem label="What">{auditEntityText(summary)}</MetadataListItem>
              <MetadataListItem label="Who">{summary.actor?.name ?? 'System'}</MetadataListItem>
              <MetadataListItem label="When">{formatDateTime(summary.createdAt, shop)}</MetadataListItem>
            </MetadataList>
            <VStack gap={3}>
              <Heading level={3}>Changes</Heading>
              {query.isPending ? (
                <Spinner aria-label="Loading changes" />
              ) : query.isError ? (
                <LoadError error={query.error} onRetry={() => void query.refetch()} />
              ) : (
                <DiffTable rows={auditDiff(query.data, shop)} />
              )}
            </VStack>
          </VStack>
        </VStack>
      ) : null}
    </Drawer>
  );
}

function AuditContent() {
  const { shop } = useSession();
  const today = todayInZone(shop.timezone);
  const [range, setRange] = useState<LocalDateRange>({ from: addDays(today, -6), to: today });
  const [userId, setUserId] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [open, setOpen] = useState<AuditEventSummary | null>(null);

  const params: AuditParams = {
    from: range.from,
    to: range.to,
    userId: userId || undefined,
    ...actionFilterParams(actionFilter),
  };
  const valid = AuditEventListQuery.safeParse(params);
  const query = useAuditEvents(params, valid.success);
  const staff = useStaff(['ACTIVE', 'DEACTIVATED']);
  const users = useMemo(
    () => (staff.data?.items ?? []).filter((s) => s.kind === 'MEMBER' && s.userId),
    [staff.data],
  );
  const events = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <title>Audit log · RepairOS</title>
      <PageIntro
        title="Audit log"
        description="Who changed settings, staff and time records, and when. Read-only."
      />
      <HStack gap={4} vAlign="end" wrap="wrap">
        <DateRangeFilter
          label="Dates"
          value={range}
          onChange={setRange}
          maxDays={MAX_AUDIT_RANGE_DAYS}
          max={today}
          error={valid.success ? undefined : valid.error.issues[0]?.message}
          presets={[
            { label: 'Last 7 days', range: { from: addDays(today, -6), to: today } },
            { label: 'Last 30 days', range: { from: addDays(today, -29), to: today } },
            { label: 'This month', range: thisMonth(today) },
            { label: 'Last month', range: lastMonth(today) },
          ]}
        />
        <Selector
          label="User"
          width={220}
          value={userId || 'all'}
          onChange={(v) => setUserId(!v || v === 'all' ? '' : v)}
          isLoading={staff.isPending}
          options={[
            { value: 'all', label: 'Everyone' },
            ...users.map((u) => ({ value: u.userId as string, label: u.name ?? u.email })),
          ]}
        />
        <Selector
          label="Action"
          width={260}
          value={actionFilter}
          onChange={(v) => setActionFilter(v ?? 'all')}
          options={ACTION_OPTIONS}
        />
      </HStack>

      {!valid.success ? null : query.isPending ? (
        <RowsSkeleton rows={6} label="Loading activity" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={<Icon icon={DocumentMagnifyingGlassIcon} size="lg" color="secondary" />}
          title="No activity in this period"
          description="Try a longer date range or clear the filters."
        />
      ) : (
        <VStack gap={4}>
          <Table
            data={events}
            idKey="id"
            textOverflow="truncate"
            columns={[
              {
                key: 'when',
                header: 'When',
                width: { type: 'pixel', value: 190 },
                renderCell: (e) => <Text hasTabularNumbers>{formatDateTime(e.createdAt, shop)}</Text>,
              },
              {
                key: 'who',
                header: 'Who',
                renderCell: (e) =>
                  e.actor ? e.actor.name : <Text color="secondary">System</Text>,
              },
              {
                key: 'action',
                header: 'Action',
                renderCell: (e) => (
                  <Link
                    href="#"
                    onClick={(ev) => {
                      ev.preventDefault();
                      setOpen(e);
                    }}
                  >
                    {auditActionLabel(e.action)}
                  </Link>
                ),
              },
              {
                key: 'entity',
                header: 'What',
                renderCell: (e) => <Text maxLines={1}>{auditEntityText(e)}</Text>,
              },
            ]}
          />
          <HStack hAlign="center">
            {query.hasNextPage ? (
              <Button
                label={query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                isLoading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              />
            ) : (
              <Text type="supporting" color="secondary">
                You&apos;ve reached the start of this period.
              </Text>
            )}
          </HStack>
        </VStack>
      )}
      <EventDrawer summary={open} shop={shop} onClose={() => setOpen(null)} />
    </>
  );
}

export default function AuditPage() {
  return (
    <RequirePermission permission="audit.view">
      <AuditContent />
    </RequirePermission>
  );
}
