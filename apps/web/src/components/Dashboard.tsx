'use client';

/*
 * Dashboard (spec §9; template dashboard): four count tiles that open the matching ticket list, then
 * "My queue" and, when it's empty, unassigned tickets with Take. Without tickets.view: the Sprint 0
 * welcome card.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  CalendarDaysIcon,
  CheckBadgeIcon,
  ExclamationTriangleIcon,
  InboxStackIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { TicketDetail, ticketPath, type TicketListItem } from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useCan } from './RequirePermission';
import { TicketTable } from './tickets/TicketTable';
import { ShortcutHint } from './ui/ShortcutHint';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { useDashboard } from '@/lib/sprint2-queries';
import { todayInZone } from '@/lib/timezone';

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function Tile({
  label,
  value,
  href,
  icon,
  hint,
  isLoading,
  isError,
  onRetry,
  isAlert,
}: {
  label: string;
  value: number | undefined;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  hint: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  isAlert?: boolean;
}) {
  const body: ReactNode = isLoading ? (
    <Skeleton width={56} height={40} />
  ) : isError ? (
    <HStack gap={2} vAlign="center">
      <Text color="secondary">Couldn&apos;t load</Text>
      <Button label="Retry" size="sm" variant="ghost" onClick={onRetry} />
    </HStack>
  ) : isAlert && (value ?? 0) > 0 ? (
    <HStack gap={2} vAlign="center">
      <Text type="display-3" hasTabularNumbers>
        {value}
      </Text>
      <Badge
        variant="error"
        label="Needs attention"
        icon={<Icon icon={ExclamationTriangleIcon} size="xsm" />}
      />
    </HStack>
  ) : (
    <Text type="display-3" hasTabularNumbers>
      {value}
    </Text>
  );
  const content = (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Icon icon={icon} size="sm" color="secondary" />
        <Text weight="medium" color="secondary">
          {label}
        </Text>
      </HStack>
      {body}
      <Text type="supporting" color="secondary">
        {hint}
      </Text>
    </VStack>
  );
  if (isError)
    return (
      <Card padding={5} height="100%">
        {content}
      </Card>
    );
  return (
    <ClickableCard label={`${label}: ${value ?? ''}`} href={href} padding={5} height="100%">
      {content}
    </ClickableCard>
  );
}

function Welcome() {
  const { me, shop } = useSession();
  const today = new Intl.DateTimeFormat(shop.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: shop.timezone,
  }).format(new Date());
  return (
    <VStack gap={1}>
      <Heading level={1}>Welcome, {firstName(me.user.name)}</Heading>
      <Text color="secondary">
        {today} at {shop.name}
      </Text>
    </VStack>
  );
}

export function Dashboard() {
  const { me, shop } = useSession();
  const can = useCan();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const canView = can('tickets.view');
  const query = useDashboard(canView);
  const today = todayInZone(shop.timezone);
  const counts = query.data?.counts;

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

  const header = (
    <HStack gap={4} hAlign="between" vAlign="end" wrap="wrap">
      <Welcome />
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
  );

  if (!canView) {
    return (
      <VStack gap={6}>
        {header}
        <Card padding={8}>
          <EmptyState
            headingLevel={2}
            icon={<Icon icon={InboxStackIcon} size="lg" color="secondary" />}
            title="Nothing to show here yet"
            description="Your role doesn't include tickets. Ask an owner or manager if you need them."
          />
        </Card>
      </VStack>
    );
  }

  const tileState = {
    isLoading: query.isPending,
    isError: query.isError,
    onRetry: () => void query.refetch(),
  };
  const myQueue = query.data?.myQueue ?? [];
  const unassigned = query.data?.unassigned ?? [];
  const now = query.data ? Date.parse(query.data.counts.serverNow) : undefined;

  return (
    <VStack gap={6}>
      <title>Dashboard · RepairOS</title>
      {header}
      <Grid columns={{ minWidth: 200, max: 4 }} gap={4}>
        <Tile
          label="Open tickets"
          value={counts?.openAndWaiting}
          href="/tickets?view=open&category=OPEN,WAITING"
          icon={InboxStackIcon}
          hint="In progress or waiting"
          {...tileState}
        />
        <Tile
          label="Ready for pickup"
          value={counts?.ready}
          href="/tickets?view=ready"
          icon={CheckBadgeIcon}
          hint="Finished, waiting for the customer"
          {...tileState}
        />
        <Tile
          label="Overdue"
          value={counts?.overdue}
          href="/tickets?view=overdue"
          icon={ExclamationTriangleIcon}
          hint="Past their due date"
          isAlert
          {...tileState}
        />
        <Tile
          label="Due today"
          value={counts?.dueToday}
          href={`/tickets?view=open&category=OPEN,WAITING&dueFrom=${today}&dueTo=${today}`}
          icon={CalendarDaysIcon}
          hint="Promised for today"
          {...tileState}
        />
      </Grid>

      <Card padding={5}>
        <VStack gap={4} as="section" aria-labelledby="queue-title">
          <HStack gap={3} hAlign="between" vAlign="center">
            <Heading level={2} id="queue-title">
              My queue
            </Heading>
            {query.data && query.data.myQueueTotal > 0 ? (
              <Link href="/tickets?view=mine">{`View all (${query.data.myQueueTotal})`}</Link>
            ) : null}
          </HStack>
          {query.isPending ? (
            <Skeleton height={96} />
          ) : query.isError ? (
            <Text color="secondary">Couldn&apos;t load your queue.</Text>
          ) : myQueue.length > 0 ? (
            <TicketTable
              rows={myQueue}
              now={now}
              density="compact"
              columns={['number', 'device', 'status', 'due', 'priority']}
            />
          ) : (
            <VStack gap={4}>
              <Text color="secondary">Nothing assigned to you.</Text>
              {unassigned.length > 0 ? (
                <VStack gap={3}>
                  <Heading level={3}>Unassigned</Heading>
                  <TicketTable
                    rows={unassigned}
                    now={now}
                    density="compact"
                    columns={['number', 'device', 'status', 'due', 'priority']}
                    endCell={
                      can('tickets.edit')
                        ? (t) => (
                            <Button
                              label={`Take ${t.numberLabel}`}
                              size="sm"
                              isLoading={take.isPending && take.variables?.id === t.id}
                              onClick={() => take.mutate(t)}
                            >
                              Take
                            </Button>
                          )
                        : undefined
                    }
                  />
                </VStack>
              ) : null}
            </VStack>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}
