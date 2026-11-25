'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Table } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import {
  ArrowRightStartOnRectangleIcon,
  CalendarDaysIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import {
  LONG_SHIFT_MINUTES,
  TIMECLOCK_PATHS,
  TimeclockStatus,
  formatDuration,
  type TimeEntry,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { clockedInLabel, formatShortDuration, minutesBetween } from '@/lib/duration';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { qk, useTimeclock } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import {
  formatDayTime,
  formatLocalDate,
  formatTime,
  thisWeek,
  todayInZone,
  type ShopClock,
} from '@/lib/timezone';

/** Re-render every 15 s so the elapsed time stays current (the label shows minutes). */
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function EntriesTable({ entries, shop }: { entries: TimeEntry[]; shop: ShopClock }) {
  return (
    <Table
      data={entries}
      idKey="id"
      density="compact"
      emptyState={<Text color="secondary">No hours recorded.</Text>}
      columns={[
        {
          key: 'date',
          header: 'Date',
          renderCell: (e) => formatLocalDate(e.localDate, shop.locale, false),
        },
        { key: 'in', header: 'In', renderCell: (e) => formatTime(e.clockInAt, shop) },
        {
          key: 'out',
          header: 'Out',
          renderCell: (e) => (e.clockOutAt ? formatTime(e.clockOutAt, shop) : 'Now'),
        },
        {
          key: 'duration',
          header: 'Duration',
          align: 'end',
          renderCell: (e) => <Text hasTabularNumbers>{formatDuration(e.durationMinutes)}</Text>,
        },
      ]}
    />
  );
}

function MyHoursDialog({
  entries,
  shop,
  onClose,
}: {
  entries: TimeEntry[];
  shop: ShopClock;
  onClose: () => void;
}) {
  const weekStart = thisWeek(todayInZone(shop.timezone)).from;
  const current = entries.filter((e) => e.localDate >= weekStart);
  const previous = entries.filter((e) => e.localDate < weekStart);
  const total = (list: TimeEntry[]) =>
    formatDuration(list.reduce((s, e) => s + e.durationMinutes, 0));
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} width={560}>
      <DialogHeader
        title="My hours"
        subtitle="Ask a manager if a time is wrong."
        onOpenChange={(open) => !open && onClose()}
      />
      <VStack gap={6} padding={6}>
        {entries.length === 0 ? (
          <EmptyState isCompact title="No hours in the last two weeks" />
        ) : (
          [
            { title: 'This week', list: current },
            { title: 'Last week', list: previous },
          ].map(({ title, list }) => (
            <VStack gap={2} key={title}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={3}>{title}</Heading>
                <Text weight="semibold" hasTabularNumbers>
                  {total(list)}
                </Text>
              </HStack>
              <EntriesTable entries={list} shop={shop} />
            </VStack>
          ))
        )}
      </VStack>
    </Dialog>
  );
}

/** Top-bar clock in/out with optimistic updates (server time only; the client never sends a time). */
export function ClockControl({ isCompact }: { isCompact: boolean }) {
  const { me, shop } = useSession();
  const enabled = can(me.permissions, 'timeclock.self');
  const query = useTimeclock(enabled);
  const timeclockKey = qk.timeclock(shop.id);
  const queryClient = useQueryClient();
  const showToast = useToast();
  const now = useNow();
  const [showHours, setShowHours] = useState(false);

  // Server clock offset, so the elapsed time matches the server's durations.
  const skew = query.data ? Date.parse(query.data.serverNow) - query.dataUpdatedAt : 0;

  const optimistic = (open: boolean): TimeclockStatus | undefined => {
    const prev = queryClient.getQueryData<TimeclockStatus>(timeclockKey);
    if (!prev) return undefined;
    const at = new Date(Date.now() + skew).toISOString();
    return {
      ...prev,
      serverNow: at,
      openEntry: open
        ? {
            id: 'pending',
            userId: me.user.id,
            clockInAt: at,
            clockOutAt: null,
            localDate: todayInZone(shop.timezone),
            durationMinutes: 0,
            source: 'SELF',
            closedReason: null,
            flaggedLong: false,
            stillOpen: false,
            edited: null,
          }
        : null,
    };
  };

  const clock = useMutation({
    mutationFn: (direction: 'in' | 'out') =>
      apiFetch(
        direction === 'in' ? TIMECLOCK_PATHS.clockIn : TIMECLOCK_PATHS.clockOut,
        TimeclockStatus,
        {
          method: 'POST',
        },
      ),
    onMutate: async (direction) => {
      await queryClient.cancelQueries({ queryKey: timeclockKey });
      const previous = queryClient.getQueryData<TimeclockStatus>(timeclockKey);
      const next = optimistic(direction === 'in');
      if (next) queryClient.setQueryData(timeclockKey, next);
      return { previous };
    },
    onSuccess: (status, direction) => {
      queryClient.setQueryData(timeclockKey, status);
      if (direction === 'out') {
        showToast({ body: `Clocked out. ${formatShortDuration(status.todayMinutes)} today.` });
      }
    },
    onError: (err, _direction, context) => {
      if (hasErrorCode(err, 'ALREADY_CLOCKED_IN', 'NOT_CLOCKED_IN')) {
        // Another tab already did it: show the real state.
        showToast({ body: errorMessage(err) });
      } else {
        if (context?.previous) queryClient.setQueryData(timeclockKey, context.previous);
        showToast({ body: errorMessage(err), type: 'error' });
      }
      void queryClient.invalidateQueries({ queryKey: timeclockKey });
    },
  });

  if (!enabled) return null;

  if (query.isError && !query.data) {
    return (
      <Button
        label="Clock unavailable. Retry"
        variant="ghost"
        icon={<Icon icon="warning" />}
        isIconOnly={isCompact}
        tooltip={errorMessage(query.error)}
        onClick={() => void query.refetch()}
      />
    );
  }

  const status = query.data;
  if (!status || !status.openEntry) {
    return (
      <HStack gap={0.5} vAlign="center">
        <Button
          label="Clock in"
          icon={<Icon icon={ClockIcon} />}
          isIconOnly={isCompact}
          tooltip={isCompact ? 'Clock in' : undefined}
          isLoading={query.isPending || (clock.isPending && clock.variables === 'in')}
          onClick={() => clock.mutate('in')}
        />
        {status ? (
          <MoreMenu
            label="Time clock options"
            alignment="end"
            items={[
              { label: 'My hours', icon: CalendarDaysIcon, onClick: () => setShowHours(true) },
            ]}
          />
        ) : null}
        {showHours && status ? (
          <MyHoursDialog
            entries={status.recentEntries}
            shop={shop}
            onClose={() => setShowHours(false)}
          />
        ) : null}
      </HStack>
    );
  }

  const open = status.openEntry;
  const minutes = minutesBetween(Date.parse(open.clockInAt), now + skew);
  const isLong = minutes > LONG_SHIFT_MINUTES;
  const label = clockedInLabel(minutes);

  return (
    <>
      <DropdownMenu
        alignment="end"
        menuWidth={300}
        button={{
          label,
          variant: 'secondary',
          isIconOnly: isCompact,
          tooltip: isCompact ? label : undefined,
          // The dot is decorative here: the button's name is its label alone, "Clocked in 2h 14m"
          // (BUG-07: the dot's own label made it "Clocked in Clocked in 0m").
          icon: (
            <StatusDot
              aria-hidden
              variant={isLong ? 'warning' : 'success'}
              label={isLong ? 'Long shift' : 'Clocked in'}
              isPulsing={!isLong}
            />
          ),
        }}
        header={
          isLong ? (
            <VStack padding={3}>
              <Banner
                status="warning"
                title={`Still clocked in since ${formatDayTime(open.clockInAt, shop)}.`}
                description="Clock out and ask a manager to fix the time."
              />
            </VStack>
          ) : (
            <VStack padding={3} gap={0.5}>
              <Text weight="semibold">{label}</Text>
              <Text type="supporting" color="secondary">
                Since {formatTime(open.clockInAt, shop)} at {shop.name}
              </Text>
            </VStack>
          )
        }
      >
        <DropdownMenuItem
          label="Clock out"
          icon={ArrowRightStartOnRectangleIcon}
          onClick={() => clock.mutate('out')}
        />
        <DropdownMenuItem
          label="My hours"
          icon={CalendarDaysIcon}
          onClick={() => setShowHours(true)}
        />
      </DropdownMenu>
      {showHours ? (
        <MyHoursDialog
          entries={status.recentEntries}
          shop={shop}
          onClose={() => setShowHours(false)}
        />
      ) : null}
    </>
  );
}
