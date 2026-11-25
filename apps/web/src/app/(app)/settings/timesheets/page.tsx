'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Table } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { ArrowDownTrayIcon, ClockIcon, PlusIcon } from '@heroicons/react/24/outline';
import {
  MAX_TIMESHEET_RANGE_DAYS,
  ROLE_LABELS,
  TIMESHEET_EXPORT_PATH,
  TimesheetQuery,
  canEditTimeEntry,
  formatDuration,
  type Role,
  type TimeEntry,
  type TimesheetStaff,
} from '@repairos/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { DateRangeFilter } from '@/components/DateRangeFilter';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission, useCan } from '@/components/RequirePermission';
import { DeleteEntryDialog, EntryDialog } from '@/components/timesheets/EntryDialogs';
import { qk, timesheetSearch, useStaff, useTimesheets } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import {
  formatDateTime,
  formatLocalDate,
  formatTime,
  lastMonth,
  lastWeek,
  thisMonth,
  thisWeek,
  todayInZone,
  type LocalDateRange,
} from '@/lib/timezone';

interface EntryRow extends Record<string, unknown> {
  entry: TimeEntry;
  person: TimesheetStaff;
}

function Flags({ entry, shopClock }: { entry: TimeEntry; shopClock: { timezone: string; locale: string } }) {
  return (
    <HStack gap={1} wrap="wrap">
      {entry.flaggedLong ? <Badge variant="warning" label="Long shift" /> : null}
      {entry.stillOpen ? <Badge variant="warning" label="Still open" /> : null}
      {entry.closedReason === 'DEACTIVATED' ? <Badge label="Closed on deactivation" /> : null}
      {entry.edited ? (
        <Tooltip
          content={`${entry.edited.byName ?? 'Someone'} on ${formatDateTime(entry.edited.at, shopClock)}: ${entry.edited.reason}`}
        >
          <Badge label="Edited" />
        </Tooltip>
      ) : null}
    </HStack>
  );
}

function TimesheetsContent() {
  const { me, shop } = useSession();
  const can = useCan();
  const queryClient = useQueryClient();
  const today = todayInZone(shop.timezone);
  const [range, setRange] = useState<LocalDateRange>(() => thisWeek(today));
  const [userId, setUserId] = useState('');
  const [needsReview, setNeedsReview] = useState(false);
  const [editing, setEditing] = useState<EntryRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<EntryRow | null>(null);

  const params = { from: range.from, to: range.to, userId: userId || undefined, needsReview };
  const valid = TimesheetQuery.safeParse(params);
  const rangeError = valid.success ? undefined : valid.error.issues[0]?.message;
  const query = useTimesheets(params, valid.success);
  const staff = useStaff(['ACTIVE', 'DEACTIVATED']);
  const members = useMemo(
    () => (staff.data?.items ?? []).filter((s) => s.kind === 'MEMBER' && s.userId),
    [staff.data],
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.timesheetsAll });
  const myRole = me.role as Role;
  const mayEdit = (role: Role, entryUserId: string) =>
    canEditTimeEntry(myRole, role, entryUserId === me.user.id);
  const presets = [
    { label: 'This week', range: thisWeek(today) },
    { label: 'Last week', range: lastWeek(today) },
    { label: 'This month', range: thisMonth(today) },
    { label: 'Last month', range: lastMonth(today) },
  ];

  const data = query.data;
  const entryColumns = (person: TimesheetStaff) => [
    {
      key: 'date',
      header: 'Date',
      renderCell: (r: EntryRow) => formatLocalDate(r.entry.localDate, shop.locale, false),
    },
    {
      key: 'in',
      header: 'Clock in',
      renderCell: (r: EntryRow) => <Text hasTabularNumbers>{formatTime(r.entry.clockInAt, shop)}</Text>,
    },
    {
      key: 'out',
      header: 'Clock out',
      renderCell: (r: EntryRow) =>
        r.entry.clockOutAt ? (
          <Text hasTabularNumbers>{formatTime(r.entry.clockOutAt, shop)}</Text>
        ) : (
          <Text color="secondary">Open</Text>
        ),
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'end' as const,
      renderCell: (r: EntryRow) => <Text hasTabularNumbers>{formatDuration(r.entry.durationMinutes)}</Text>,
    },
    {
      key: 'flags',
      header: 'Flags',
      renderCell: (r: EntryRow) => <Flags entry={r.entry} shopClock={shop} />,
    },
    {
      key: 'actions',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: { type: 'pixel' as const, value: 64 },
      align: 'end' as const,
      renderCell: (r: EntryRow) =>
        mayEdit(person.role, person.userId) ? (
          <MoreMenu
            label={`Actions for ${person.name}'s entry on ${r.entry.localDate}`}
            alignment="end"
            items={[
              { label: 'Fix times…', onClick: () => setEditing(r) },
              { type: 'divider' },
              { label: 'Delete…', variant: 'destructive', onClick: () => setDeleting(r) },
            ]}
          />
        ) : null,
    },
  ];

  return (
    <>
      <title>Timesheets · RepairOS</title>
      <HStack gap={6} hAlign="between" vAlign="end" wrap="wrap">
        <PageIntro title="Timesheets" description={`Hours worked, in shop time (${shop.timezone}).`} />
        <HStack gap={2}>
          {can('timesheet.export') && valid.success ? (
            <Button
              label="Export CSV"
              icon={<Icon icon={ArrowDownTrayIcon} />}
              href={`${TIMESHEET_EXPORT_PATH}?${timesheetSearch(params)}`}
            />
          ) : null}
          {can('timesheet.edit') ? (
            <Button
              label="Add entry"
              variant="primary"
              icon={<Icon icon={PlusIcon} />}
              onClick={() => setEditing('new')}
            />
          ) : null}
        </HStack>
      </HStack>

      <HStack gap={4} vAlign="end" wrap="wrap">
        <DateRangeFilter
          label="Dates"
          value={range}
          onChange={setRange}
          presets={presets}
          maxDays={MAX_TIMESHEET_RANGE_DAYS}
          error={rangeError}
        />
        <Selector
          label="Staff"
          width={240}
          value={userId || 'all'}
          onChange={(v) => setUserId(!v || v === 'all' ? '' : v)}
          isLoading={staff.isPending}
          options={[
            { value: 'all', label: 'All staff' },
            ...members.map((m) => ({
              value: m.userId as string,
              label: m.status === 'DEACTIVATED' ? `${m.name ?? m.email} (deactivated)` : (m.name ?? m.email),
            })),
          ]}
        />
        <Switch
          label={`Needs review${data ? ` (${data.needsReviewCount})` : ''}`}
          value={needsReview}
          onChange={setNeedsReview}
        />
      </HStack>

      {!valid.success ? null : query.isPending ? (
        <RowsSkeleton rows={5} label="Loading timesheets" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : data && data.staff.length === 0 ? (
        <EmptyState
          icon={<Icon icon={ClockIcon} size="lg" color="secondary" />}
          title={needsReview ? 'Nothing needs review in this period' : 'No hours recorded in this period'}
          description="Staff clock in and out from the top bar. Pick another date range or person."
        />
      ) : data ? (
        <VStack gap={8}>
          <VStack gap={3}>
            <Heading level={2}>Totals</Heading>
            <Table
              data={data.staff as (TimesheetStaff & Record<string, unknown>)[]}
              idKey="userId"
              columns={[
                {
                  key: 'name',
                  header: 'Staff',
                  renderCell: (p) => (
                    <HStack gap={2} vAlign="center">
                      <Text weight="medium">{p.name}</Text>
                      {p.status === 'DEACTIVATED' ? <Badge label="Deactivated" /> : null}
                    </HStack>
                  ),
                },
                { key: 'role', header: 'Role', renderCell: (p) => ROLE_LABELS[p.role] },
                {
                  key: 'days',
                  header: 'Days worked',
                  align: 'end',
                  renderCell: (p) => <Text hasTabularNumbers>{p.days.length}</Text>,
                },
                {
                  key: 'total',
                  header: 'Total',
                  align: 'end',
                  renderCell: (p) => (
                    <Text hasTabularNumbers weight="semibold">
                      {formatDuration(p.totalMinutes)}
                    </Text>
                  ),
                },
              ]}
            />
          </VStack>
          {data.staff.map((person) => {
            const rows: EntryRow[] = person.days.flatMap((d) => d.entries.map((entry) => ({ entry, person })));
            return (
              <VStack gap={3} key={person.userId}>
                <Heading level={2}>
                  {person.name} · {formatDuration(person.totalMinutes)}
                </Heading>
                <Table data={rows} idKey={(r) => r.entry.id} columns={entryColumns(person)} />
              </VStack>
            );
          })}
        </VStack>
      ) : null}

      {editing !== null ? (
        <EntryDialog
          entry={editing === 'new' ? null : editing.entry}
          staffName={editing === 'new' ? undefined : editing.person.name}
          staffOptions={members
            .filter((m) => mayEdit(m.role, m.userId as string))
            .map((m) => ({ userId: m.userId as string, name: m.name ?? m.email }))}
          shop={shop}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      {deleting ? (
        <DeleteEntryDialog
          entry={deleting.entry}
          staffName={deleting.person.name}
          shop={shop}
          onClose={() => setDeleting(null)}
          onDeleted={refresh}
        />
      ) : null}
    </>
  );
}

export default function TimesheetsPage() {
  return (
    <RequirePermission permission="timesheet.view">
      <TimesheetsContent />
    </RequirePermission>
  );
}
