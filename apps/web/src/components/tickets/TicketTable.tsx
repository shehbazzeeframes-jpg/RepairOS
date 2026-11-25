'use client';

import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { HStack } from '@astryxdesign/core/HStack';
import { Link } from '@astryxdesign/core/Link';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { deviceLabel, type TicketListItem, type UserRef } from '@repairos/contracts';
import type { ReactNode } from 'react';
import { DueChip } from '@/components/ui/DueChip';
import { PhoneText } from '@/components/ui/PhoneText';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { onRowLinkKeyDown } from '@/lib/focus';
import { useSession } from '@/lib/shop-context';
import { formatShortDate } from '@/lib/timezone';

export function AssigneeText({ assignee }: { assignee: UserRef | null }) {
  if (!assignee) return <Text color="secondary">Unassigned</Text>;
  return (
    <HStack gap={2} vAlign="center">
      <Avatar name={assignee.name} size="xsm" tooltip={false} />
      <Text maxLines={1}>{assignee.active ? assignee.name : `${assignee.name} (deactivated)`}</Text>
    </HStack>
  );
}

export function issuesText(t: Pick<TicketListItem, 'issues' | 'description'>): string {
  if (t.issues.length === 0) return t.description ?? '—';
  const shown = t.issues.slice(0, 2).join(', ');
  return t.issues.length > 2 ? `${shown} +${t.issues.length - 2}` : shown;
}

export type TicketColumn =
  | 'number'
  | 'customer'
  | 'device'
  | 'issues'
  | 'status'
  | 'assignee'
  | 'due'
  | 'priority'
  | 'created';

export interface TicketTableProps {
  rows: TicketListItem[];
  columns: readonly TicketColumn[];
  /** The list's `serverNow`, so every row's due agrees. */
  now?: number;
  /** Row menu items; an empty list hides the menu. */
  actions?: (row: TicketListItem) => DropdownMenuOption[];
  /** Extra end column (e.g. the dashboard's "Take"). */
  endCell?: (row: TicketListItem) => ReactNode;
  emptyState?: ReactNode;
  density?: 'compact' | 'balanced';
  /** 1024 layout: priority folds into the # cell. */
  isNarrow?: boolean;
}

/** Ticket rows (spec §6): the list, a customer's Tickets tab and the dashboard queue. */
export function TicketTable({
  rows,
  columns,
  now,
  actions,
  endCell,
  emptyState,
  density = 'balanced',
  isNarrow,
}: TicketTableProps) {
  const { shop } = useSession();
  const show = new Set(columns);
  if (isNarrow) {
    show.delete('created');
    show.delete('priority');
  }
  const all: TableColumn<TicketListItem>[] = [
    {
      key: 'number',
      header: 'Ticket',
      width: pixel(isNarrow ? 104 : 112),
      renderCell: (t: TicketListItem) => (
        <VStack gap={1}>
          <Link href={`/tickets/${t.id}`} weight="semibold">
            {t.numberLabel}
          </Link>
          {t.isWarranty ? <Badge variant="info" label="Warranty" /> : null}
          {isNarrow && t.priority === 'URGENT' ? <Badge variant="warning" label="Urgent" /> : null}
        </VStack>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      width: proportional(1, { minWidth: 140 }),
      renderCell: (t: TicketListItem) => (
        <VStack gap={0.5}>
          <Text maxLines={1} weight="medium">
            {t.customer.displayName}
          </Text>
          {t.customer.primaryPhone && !t.customer.erased ? (
            <PhoneText e164={t.customer.primaryPhone} shopCountry={shop.country} />
          ) : null}
        </VStack>
      ),
    },
    {
      key: 'device',
      header: 'Device',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (t: TicketListItem) => <Text maxLines={2}>{deviceLabel(t.device)}</Text>,
    },
    {
      key: 'issues',
      header: 'Issues',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (t: TicketListItem) => (
        <Text maxLines={2} color={t.issues.length ? 'primary' : 'secondary'}>
          {issuesText(t)}
        </Text>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1, { minWidth: 130 }),
      renderCell: (t: TicketListItem) => <StatusBadge {...t.status} />,
    },
    {
      key: 'assignee',
      header: 'Assignee',
      width: proportional(1, { minWidth: 120 }),
      renderCell: (t: TicketListItem) => <AssigneeText assignee={t.assignee} />,
    },
    {
      key: 'due',
      header: 'Due',
      width: proportional(1, { minWidth: 112 }),
      renderCell: (t: TicketListItem) => (
        <DueChip
          dueAt={t.dueAt}
          hasTime={t.dueHasTime}
          category={t.status.category}
          shop={shop}
          now={now}
        />
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: pixel(88),
      renderCell: (t: TicketListItem) =>
        t.priority === 'URGENT' ? (
          <Badge variant="warning" label="Urgent" />
        ) : (
          <Text color="secondary">Normal</Text>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      width: pixel(128),
      renderCell: (t: TicketListItem) => (
        <Text color="secondary" hasTabularNumbers>
          {formatShortDate(t.createdAt, shop)}
        </Text>
      ),
    },
  ];
  const cols = all.filter((c) => show.has(c.key as TicketColumn));

  if (endCell) {
    cols.push({
      key: 'end',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(96),
      renderCell: (t: TicketListItem) => <>{endCell(t)}</>,
    });
  }
  if (actions) {
    cols.push({
      key: 'actions',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: pixel(56),
      renderCell: (t: TicketListItem) => {
        const items = actions(t);
        return items.length ? (
          <MoreMenu label={`Actions for ${t.numberLabel}`} alignment="end" items={items} />
        ) : null;
      },
    });
  }

  return (
    <VStack onKeyDown={onRowLinkKeyDown}>
      <Table
        data={rows}
        idKey="id"
        columns={cols}
        hasHover
        density={density}
        textOverflow="wrap"
        emptyState={emptyState}
      />
    </VStack>
  );
}
