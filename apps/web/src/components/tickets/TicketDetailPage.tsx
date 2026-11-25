'use client';

/*
 * Ticket detail (spec §7; template work-item-detail): header with status menu and actions, cards in
 * the main column (customer, device, intake, details) and the activity timeline in a 360 rail.
 * One column below 900px.
 */

import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { useHotkeys, useMediaQuery } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { DevicePhoneMobileIcon, PrinterIcon } from '@heroicons/react/24/outline';
import {
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CHECKLIST_RESULT_LABELS,
  DEVICE_TYPE_LABELS,
  PREFERRED_CHANNEL_LABELS,
  STATUS_CATEGORY_LABELS,
  TICKET_PRIORITY_LABELS,
  accessoriesSummary,
  deviceLabel,
  maskIdentifier,
  withinReopenWindow,
  type ChecklistResult,
  type StatusCategory,
  type TicketDetail,
  type TicketStatus,
} from '@repairos/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NoAccess } from '@/components/PageStates';
import { useCan } from '@/components/RequirePermission';
import { DueChip } from '@/components/ui/DueChip';
import { MoneyText } from '@/components/ui/MoneyText';
import { PhoneText } from '@/components/ui/PhoneText';
import { ShortcutHint } from '@/components/ui/ShortcutHint';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { addRecent, removeRecent } from '@/lib/recent-items';
import { useSession } from '@/lib/shop-context';
import { useTicket, useTicketStatuses } from '@/lib/sprint2-queries';
import { formatDateTime } from '@/lib/timezone';
import { AssigneeText } from './TicketTable';
import { AssignDialog, CancelDialog, EditDetailsDialog, ReopenDialog } from './TicketDialogs';
import { PasscodeReveal } from './PasscodeReveal';
import { TicketTimeline } from './TicketTimeline';
import { collectBlockedReason, statusMenuTargets, useStatusChanger } from './status-change';

type DialogKind = 'assign' | 'cancel' | 'reopen' | 'edit' | null;

const RESULT_VARIANT: Record<ChecklistResult, 'error' | 'success' | 'neutral'> = {
  FAIL: 'error',
  PASS: 'success',
  UNTESTED: 'neutral',
};

function CardSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `card-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <Card padding={5}>
      <VStack gap={4} as="section" aria-labelledby={id}>
        <HStack gap={3} hAlign="between" vAlign="center">
          <Heading level={2} id={id}>
            {title}
          </Heading>
          {action}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}

function Identifier({ label, value }: { label: string; value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <HStack gap={2} vAlign="center">
      <Text hasTabularNumbers>
        {label} {shown ? value : maskIdentifier(value)}
      </Text>
      {value.length > 4 ? (
        <Link
          href="#"
          type="supporting"
          label={`${shown ? 'Hide' : 'Show'} ${label}`}
          onClick={(e) => {
            e.preventDefault();
            setShown((s) => !s);
          }}
        >
          {shown ? 'Hide' : 'Show'}
        </Link>
      ) : null}
    </HStack>
  );
}

function StatusMenu({
  ticket,
  statuses,
  isOpen,
  onOpenChange,
  onPick,
}: {
  ticket: TicketDetail;
  statuses: readonly TicketStatus[];
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (s: TicketStatus) => void;
}) {
  const { me } = useSession();
  const targets = statusMenuTargets(ticket.status, statuses, me.permissions);
  const blocked = collectBlockedReason(ticket.status, statuses, me.permissions);
  const groups = (['OPEN', 'WAITING', 'READY', 'CLOSED'] as StatusCategory[])
    .map((c) => ({ c, items: targets.filter((s) => s.category === c) }))
    .filter((g) => g.items.length);
  return (
    <DropdownMenu
      button={{
        label: 'Change status',
        variant: 'secondary',
        isDisabled: targets.length === 0 && !blocked,
      }}
      isMenuOpen={isOpen}
      onOpenChange={onOpenChange}
      menuWidth={300}
    >
      {groups.map((g) => (
        <DropdownMenuGroup key={g.c} title={STATUS_CATEGORY_LABELS[g.c]}>
          {g.items.map((s) => (
            <DropdownMenuItem key={s.id} label={<StatusBadge {...s} />} onClick={() => onPick(s)} />
          ))}
        </DropdownMenuGroup>
      ))}
      {blocked ? (
        <>
          <DropdownMenuDivider />
          <DropdownMenuItem
            label={<StatusBadge {...blocked.status} />}
            description={blocked.message}
            isDisabled
          />
        </>
      ) : null}
    </DropdownMenu>
  );
}

function DetailSkeleton() {
  return (
    <VStack gap={5} aria-busy="true" aria-label="Loading ticket">
      <Skeleton width={320} height={36} />
      <Skeleton height={160} />
      <Skeleton height={160} index={1} />
    </VStack>
  );
}

export function TicketDetailPage({ id }: { id: string }) {
  const { me, shop } = useSession();
  const can = useCan();
  const query = useTicket(id);
  const statuses = useTicketStatuses();
  const changer = useStatusChanger();
  const isWide = useMediaQuery('(min-width: 1000px)');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const composerRef = useRef<HTMLElement>(null);
  const ticket = query.data;

  useEffect(() => {
    if (ticket)
      addRecent(me.user.id, shop.id, {
        kind: 'ticket',
        id: ticket.id,
        label: `${ticket.numberLabel} · ${ticket.customer.displayName}`,
      });
  }, [ticket, me.user.id, shop.id]);
  useEffect(() => {
    if (hasErrorCode(query.error, 'NOT_FOUND')) removeRecent(me.user.id, shop.id, 'ticket', id);
  }, [query.error, me.user.id, shop.id, id]);

  const isClosed = ticket?.status.category === 'CLOSED';
  const canEdit = can('tickets.edit');
  const focusComposer = () =>
    composerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  useHotkeys([
    {
      keys: 's',
      onPress: () => canEdit && !isClosed && setStatusOpen(true),
      isDisabled: !ticket || dialog !== null,
    },
    {
      keys: 'a',
      onPress: () => canEdit && !isClosed && setDialog('assign'),
      isDisabled: !ticket || dialog !== null,
    },
    { keys: 'm', onPress: focusComposer, isDisabled: !ticket || dialog !== null || !canEdit },
  ]);

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError || !ticket) {
    if (hasErrorCode(query.error, 'FORBIDDEN')) return <NoAccess />;
    return (
      <EmptyState
        headingLevel={1}
        title={
          hasErrorCode(query.error, 'NOT_FOUND')
            ? "We can't find that ticket."
            : "We couldn't load this ticket"
        }
        description={hasErrorCode(query.error, 'NOT_FOUND') ? undefined : errorMessage(query.error)}
        actions={<Button label="Back to tickets" href="/tickets" />}
      />
    );
  }

  const allStatuses = statuses.data?.items ?? [];
  const canReopen =
    isClosed &&
    can('tickets.cancel') &&
    !!ticket.closedAt &&
    withinReopenWindow(ticket.closedAt) &&
    !!ticket.reopenableUntil;
  const moreItems: DropdownMenuOption[] = [];
  if (canEdit && !isClosed)
    moreItems.push({ label: 'Edit details', onClick: () => setDialog('edit') });
  if (can('tickets.cancel') && !isClosed)
    moreItems.push({
      label: 'Cancel ticket…',
      variant: 'destructive',
      onClick: () => setDialog('cancel'),
    });
  if (canReopen) moreItems.push({ label: 'Reopen…', onClick: () => setDialog('reopen') });
  if (ticket.status.systemRole === 'COLLECTED' && can('tickets.create'))
    moreItems.push({
      label: 'Create warranty ticket',
      href: `/tickets/new?warrantyOf=${ticket.id}`,
    });
  if (isClosed && !canReopen && ticket.status.systemRole === 'CANCELLED' && can('tickets.create'))
    moreItems.push({
      label: 'New ticket for this device',
      href: `/tickets/new?customerId=${ticket.customer.id}&deviceId=${ticket.device.id}`,
    });

  const c = ticket.customer;
  const d = ticket.device;
  const checklistRows = CHECKLIST_ITEMS_BY_DEVICE_TYPE[d.type]
    .map((i) => ({
      id: i.key,
      label: i.label,
      result: (ticket.checklist[i.key] ?? 'UNTESTED') as ChecklistResult,
    }))
    .sort((a, b) => (a.result === 'FAIL' ? 0 : 1) - (b.result === 'FAIL' ? 0 : 1));
  const tested = checklistRows.some((r) => r.result !== 'UNTESTED');

  const details = (
    <CardSection
      title="Details"
      action={
        canEdit && !isClosed ? (
          <Button
            label="Edit due and priority"
            size="sm"
            variant="ghost"
            onClick={() => setDialog('edit')}
          >
            Edit
          </Button>
        ) : undefined
      }
    >
      <MetadataList label={{ position: 'start', width: 120 }}>
        <MetadataListItem label="Priority">
          {TICKET_PRIORITY_LABELS[ticket.priority]}
        </MetadataListItem>
        <MetadataListItem label="Due">
          <DueChip
            dueAt={ticket.dueAt}
            hasTime={ticket.dueHasTime}
            category={ticket.status.category}
            shop={shop}
            format="absolute"
          />
        </MetadataListItem>
        <MetadataListItem label="Assignee">
          <AssigneeText assignee={ticket.assignee} />
        </MetadataListItem>
        <MetadataListItem label="Created">
          {ticket.createdBy ? `${ticket.createdBy.name}, ` : ''}
          {formatDateTime(ticket.createdAt, shop)}
        </MetadataListItem>
        {ticket.warrantyOf ? (
          <MetadataListItem label="Checked in from">
            <Link href={`/tickets/${ticket.warrantyOf.id}`}>{ticket.warrantyOf.numberLabel}</Link>
          </MetadataListItem>
        ) : null}
        {ticket.reopenCount > 0 ? (
          <MetadataListItem label="Reopened">{`${ticket.reopenCount} ${ticket.reopenCount === 1 ? 'time' : 'times'}`}</MetadataListItem>
        ) : null}
        {ticket.cancelReason ? (
          <MetadataListItem label="Cancelled">{ticket.cancelNote ?? ''}</MetadataListItem>
        ) : null}
      </MetadataList>
    </CardSection>
  );

  const main = (
    <VStack gap={5}>
      <CardSection title="Customer">
        <VStack gap={3}>
          {c.erased ? (
            <Text>Erased customer</Text>
          ) : (
            <>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Link href={`/customers/${c.id}`} weight="semibold">
                  {c.displayName}
                </Link>
                {c.archived ? <Badge label="Archived" /> : null}
                {c.preferredChannel ? (
                  <Text type="supporting" color="secondary">
                    Prefers {PREFERRED_CHANNEL_LABELS[c.preferredChannel]}
                  </Text>
                ) : null}
              </HStack>
              {c.phones.map((p) => (
                <PhoneText
                  key={p.id}
                  e164={p.e164}
                  shopCountry={shop.country}
                  isCallable
                  hasWhatsApp={p.id === c.whatsappPhoneId && p.label !== 'LANDLINE'}
                />
              ))}
              {c.email ? <Link href={`mailto:${c.email}`}>{c.email}</Link> : null}
              {c.notes ? (
                <Banner status="info" title="Customer note" description={c.notes} />
              ) : null}
            </>
          )}
        </VStack>
      </CardSection>

      <CardSection title="Device">
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon
              icon={DevicePhoneMobileIcon}
              size="sm"
              color="secondary"
              label={DEVICE_TYPE_LABELS[d.type]}
            />
            <Text weight="semibold">{deviceLabel(d)}</Text>
            {d.colour ? <Text color="secondary">{d.colour}</Text> : null}
          </HStack>
          <HStack gap={4} wrap="wrap">
            {d.imei ? <Identifier label="IMEI" value={d.imei} /> : null}
            {d.serial ? <Identifier label="Serial" value={d.serial} /> : null}
          </HStack>
          <PasscodeReveal
            ticketId={ticket.id}
            device={d}
            isClosed={!!isClosed}
            canReveal={can('tickets.view_passcode')}
          />
          {d.previousTicketCount > 0 ? (
            <Link href={`/tickets?view=all&deviceId=${d.id}`}>
              {`${d.previousTicketCount} previous ${d.previousTicketCount === 1 ? 'ticket' : 'tickets'}`}
            </Link>
          ) : null}
        </VStack>
      </CardSection>

      <CardSection
        title="Intake"
        action={
          canEdit && !isClosed ? (
            <Button label="Edit details" size="sm" onClick={() => setDialog('edit')} />
          ) : undefined
        }
      >
        <VStack gap={4}>
          {ticket.issues.length ? (
            <HStack gap={2} wrap="wrap">
              {ticket.issues.map((i) => (
                <Token key={i.label} label={i.label} />
              ))}
            </HStack>
          ) : null}
          {ticket.description ? <Text wordBreak="break-word">{ticket.description}</Text> : null}
          {tested ? (
            <Table
              data={checklistRows}
              idKey="id"
              density="compact"
              columns={[
                {
                  key: 'label',
                  header: 'Checklist item',
                  width: proportional(1, { minWidth: 140 }),
                },
                {
                  key: 'result',
                  header: 'Result',
                  width: pixel(120),
                  renderCell: (r) => (
                    <Badge
                      variant={RESULT_VARIANT[r.result]}
                      label={CHECKLIST_RESULT_LABELS[r.result]}
                    />
                  ),
                },
              ]}
            />
          ) : (
            <Text color="secondary">Pre-repair checklist: not tested</Text>
          )}
          <MetadataList label={{ position: 'start', width: 120 }}>
            {ticket.conditionNotes ? (
              <MetadataListItem label="Condition">{ticket.conditionNotes}</MetadataListItem>
            ) : null}
            <MetadataListItem label="Accessories">
              {accessoriesSummary(ticket.accessories, ticket.accessoriesOther)}
            </MetadataListItem>
            <MetadataListItem label="Estimate">
              <MoneyText
                amountMinor={ticket.estimate?.amountMinor}
                currency={ticket.estimate?.currency ?? shop.currency}
                locale={shop.locale}
                taxNote={ticket.estimateIncludesTax ? 'incl' : 'excl'}
                emptyText="No estimate"
              />
            </MetadataListItem>
          </MetadataList>
        </VStack>
      </CardSection>
      {!isWide ? details : null}
    </VStack>
  );

  const rail = (
    <VStack gap={5}>
      {isWide ? details : null}
      <TicketTimeline ticketId={ticket.id} canWrite={canEdit} composerRef={composerRef} />
    </VStack>
  );

  return (
    <VStack gap={5}>
      <title>{`${ticket.numberLabel} · RepairOS`}</title>
      <VStack gap={3}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Heading level={1}>{ticket.numberLabel}</Heading>
          <StatusBadge {...ticket.status} />
          {ticket.priority === 'URGENT' ? <Badge variant="warning" label="Urgent" /> : null}
          {ticket.warrantyOf ? (
            <Link
              href={`/tickets/${ticket.warrantyOf.id}`}
            >{`Warranty for ${ticket.warrantyOf.numberLabel}`}</Link>
          ) : null}
          {ticket.warrantyTickets.map((w) => (
            <Link key={w.id} href={`/tickets/${w.id}`}>{`Warranty ticket: ${w.numberLabel}`}</Link>
          ))}
          <DueChip
            dueAt={ticket.dueAt}
            hasTime={ticket.dueHasTime}
            category={ticket.status.category}
            shop={shop}
            format="absolute"
          />
          {ticket.assignee ? (
            <HStack gap={1.5} vAlign="center">
              <Avatar name={ticket.assignee.name} size="xsm" tooltip={false} />
              <Text>{ticket.assignee.name}</Text>
            </HStack>
          ) : null}
        </HStack>
        <HStack gap={2} wrap="wrap" vAlign="center">
          {canEdit && !isClosed ? (
            <StatusMenu
              ticket={ticket}
              statuses={allStatuses}
              isOpen={statusOpen}
              onOpenChange={setStatusOpen}
              onPick={(s) => {
                setStatusOpen(false);
                changer.request(ticket, s);
              }}
            />
          ) : null}
          {canEdit && !isClosed ? (
            <Button label="Assign" onClick={() => setDialog('assign')} />
          ) : null}
          {canEdit ? <Button label="Add note" variant="ghost" onClick={focusComposer} /> : null}
          <DropdownMenu
            button={{
              label: 'Print',
              variant: 'ghost',
              icon: <Icon icon={PrinterIcon} />,
              isDisabled: true,
              tooltip: 'Coming in Sprint 3',
            }}
            items={[
              { label: 'Intake receipt', isDisabled: true },
              { label: 'Device label', isDisabled: true },
            ]}
          />
          {moreItems.length ? (
            <MoreMenu
              label={`More actions for ${ticket.numberLabel}`}
              items={moreItems}
              alignment="end"
            />
          ) : null}
          {canEdit && !isClosed ? (
            <HStack gap={3} wrap="wrap" aria-label="Ticket shortcuts" role="group">
              <ShortcutHint keys="s" label="Status" />
              <ShortcutHint keys="a" label="Assign" />
              <ShortcutHint keys="m" label="Note" />
            </HStack>
          ) : null}
        </HStack>
        {isClosed ? (
          <Text color="secondary">
            {canReopen && ticket.reopenableUntil
              ? `Closed. You can reopen it until ${formatDateTime(ticket.reopenableUntil, shop)}.`
              : 'Closed. Notes can still be added.'}
          </Text>
        ) : null}
      </VStack>

      {isWide ? (
        <Layout
          height="auto"
          content={
            <LayoutContent isScrollable={false} label="Ticket">
              <VStack paddingInlineEnd={6}>{main}</VStack>
            </LayoutContent>
          }
          end={
            <LayoutPanel width={380} label="Activity" isScrollable={false}>
              {rail}
            </LayoutPanel>
          }
        />
      ) : (
        <VStack gap={5}>
          {main}
          {rail}
        </VStack>
      )}

      {dialog === 'assign' ? (
        <AssignDialog ticket={ticket} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelDialog ticket={ticket} statuses={allStatuses} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'reopen' ? (
        <ReopenDialog ticket={ticket} statuses={allStatuses} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'edit' ? (
        <EditDetailsDialog ticket={ticket} onClose={() => setDialog(null)} />
      ) : null}
      {changer.dialogs}
    </VStack>
  );
}
