'use client';

/*
 * Customer detail (spec §4.2; template detail-page): summary header with actions, then tabs for
 * Tickets (the ticket list API with customerId), Devices and Details (address, consent + history).
 * Archive / restore, export (JSON download) and erase (typed confirmation; blocked while tickets are
 * open) live in the More menu.
 */

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { PlusIcon } from '@heroicons/react/24/outline';
import {
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCE_LABELS,
  CustomerDetail,
  DEVICE_ACTION_PATHS,
  DEVICE_TYPE_LABELS,
  Device,
  EraseCustomerInput,
  EraseCustomerResponse,
  PHONE_LABELS,
  PREFERRED_CHANNEL_LABELS,
  TicketListResponse,
  customerExportFilename,
  deviceLabel,
  maskIdentifier,
  ticketPath,
  type ConsentChannel,
  type ConsentSummary,
} from '@repairos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DeviceDialog } from '@/components/devices/DeviceDialog';
import { LoadError, NoAccess, RowsSkeleton } from '@/components/PageStates';
import { useCan } from '@/components/RequirePermission';
import { TicketTable } from '@/components/tickets/TicketTable';
import { PhoneText } from '@/components/ui/PhoneText';
import { apiFetch } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { addRecent, removeRecent } from '@/lib/recent-items';
import { useSession } from '@/lib/shop-context';
import {
  customerPath,
  useConsentHistory,
  useCustomer,
  useCustomerDevices,
} from '@/lib/sprint2-queries';
import { formatDateTime, formatLongDate, todayInZone } from '@/lib/timezone';
import {
  ConsentEditor,
  consentChangesFrom,
  consentValueFrom,
  missingConsentSources,
  type ConsentValue,
} from './ConsentEditor';

type TabKey = 'tickets' | 'devices' | 'details';

const devicePath = (key: 'archive' | 'restore', id: string) =>
  DEVICE_ACTION_PATHS[key].replace(':id', encodeURIComponent(id));

export function consentLine(
  consent: ConsentSummary,
  shop: { timezone: string; locale: string },
): string {
  return (['SMS', 'EMAIL', 'WHATSAPP'] as ConsentChannel[])
    .map((c) => {
      const label = { SMS: 'SMS marketing', EMAIL: 'Email', WHATSAPP: 'WhatsApp' }[c];
      const v = consent[c];
      return v.granted && v.since
        ? `${label}: Yes since ${formatLongDate(v.since, shop)}`
        : `${label}: No`;
    })
    .join(' · ');
}

function Identifier({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <HStack gap={2} vAlign="center">
      <Text hasTabularNumbers>{shown ? value : maskIdentifier(value)}</Text>
      {value.length > 4 ? (
        <Link
          href="#"
          type="supporting"
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

function ConsentDialog({ customer, onClose }: { customer: CustomerDetail; onClose: () => void }) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [value, setValue] = useState<ConsentValue>(() => consentValueFrom(customer.consent));
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      apiFetch(customerPath('consents', customer.id), CustomerDetail, {
        method: 'POST',
        json: { changes: consentChangesFrom(customer.consent, value) },
      }),
    onSuccess: (c) => {
      queryClient.setQueryData(qk.customer(shop.id, c.id), c);
      void queryClient.invalidateQueries({ queryKey: qk.consents(shop.id, c.id) });
      showToast({ body: 'Consent updated' });
      onClose();
    },
  });
  const changes = consentChangesFrom(customer.consent, value);
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={560}>
      <DialogHeader
        title="Change consent"
        subtitle={customer.displayName}
        onOpenChange={(o) => !o && onClose()}
      />
      <form
        noValidate
        aria-label="Change consent"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (missingConsentSources(customer.consent, value).length) return;
          if (changes.length === 0) {
            onClose();
            return;
          }
          save.mutate();
        }}
      >
        <VStack gap={5} padding={6}>
          {save.isError ? (
            <Banner
              status="error"
              title="Couldn't update consent"
              description={errorMessage(save.error)}
            />
          ) : null}
          <ConsentEditor
            value={value}
            onChange={setValue}
            current={customer.consent}
            country={shop.country}
            showErrors={tried}
          />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label="Save consent"
              isLoading={save.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

function EraseDialog({
  customer,
  onClose,
  onErased,
}: {
  customer: CustomerDetail;
  onClose: () => void;
  onErased: () => void;
}) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [confirm, setConfirm] = useState('');
  const blocked = customer.openTicketCount > 0;
  const erase = useMutation({
    mutationFn: () =>
      apiFetch(customerPath('erase', customer.id), EraseCustomerResponse, {
        method: 'POST',
        json: EraseCustomerInput.parse({ confirm }),
      }),
    onSuccess: () => {
      showToast({ body: 'Customer erased' });
      void queryClient.invalidateQueries({ queryKey: qk.customersAll(shop.id) });
      onClose();
      onErased();
    },
  });
  const openTickets = blocked || hasErrorCode(erase.error, 'CUSTOMER_HAS_OPEN_TICKETS');
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={520}>
      <DialogHeader
        title={`Erase ${customer.displayName}?`}
        onOpenChange={(o) => !o && onClose()}
      />
      <form
        noValidate
        aria-label={`Erase ${customer.displayName}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm === 'ERASE' && !blocked) erase.mutate();
        }}
      >
        <VStack gap={4} padding={6}>
          {openTickets ? (
            <Banner
              status="error"
              title={
                erase.error
                  ? errorMessage(erase.error, {
                      n: customer.openTicketCount ? String(customer.openTicketCount) : undefined,
                    })
                  : `Close or cancel this customer's ${customer.openTicketCount} open tickets first.`
              }
              endContent={<Link href={`/customers/${customer.id}?tab=tickets`}>See tickets</Link>}
            />
          ) : erase.isError ? (
            <Banner
              status="error"
              title="Couldn't erase the customer"
              description={errorMessage(erase.error)}
            />
          ) : null}
          <Text weight="medium">Removed</Text>
          <List density="compact" aria-label="Removed">
            <ListItem label="Name, phones, email, address, notes, tags and consent history" />
            <ListItem label="IMEI, serial, colour, notes and passcode of every device" />
          </List>
          <Text weight="medium">Kept</Text>
          <List density="compact" aria-label="Kept">
            <ListItem label="Tickets with numbers, dates, statuses, issues, checklist and estimate" />
            <ListItem label="Device type, brand and model" />
          </List>
          <Banner
            status="warning"
            title="Notes on tickets are kept as repair records. Remove personal details from them first if needed."
          />
          <TextInput
            label="Type ERASE to confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="off"
            isDisabled={blocked}
          />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="destructive"
              label="Erase customer"
              isDisabled={confirm !== 'ERASE' || blocked}
              isLoading={erase.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

export function CustomerDetailPage({ id }: { id: string }) {
  const { me, shop } = useSession();
  const can = useCan();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const query = useCustomer(id);
  const devices = useCustomerDevices(id, true);
  const consents = useConsentHistory(id, sp.get('tab') === 'details');
  const tickets = useQuery({
    queryKey: qk.tickets(shop.id, `customer:${id}`),
    queryFn: () =>
      apiFetch(
        `${ticketPath('list')}?view=all&customerId=${encodeURIComponent(id)}&sort=open_first&limit=50`,
        TicketListResponse,
      ),
  });
  const tab: TabKey =
    (['tickets', 'devices', 'details'] as const).find((t) => t === sp.get('tab')) ?? 'tickets';
  const [dialog, setDialog] = useState<'archive' | 'erase' | 'consent' | null>(null);
  const [deviceDialog, setDeviceDialog] = useState<{ device: Device | null } | null>(null);
  const [archivingDevice, setArchivingDevice] = useState<Device | null>(null);
  const [erased, setErased] = useState(false);
  const c = query.data;

  useEffect(() => {
    if (c) addRecent(me.user.id, shop.id, { kind: 'customer', id: c.id, label: c.displayName });
  }, [c, me.user.id, shop.id]);
  useEffect(() => {
    if (hasErrorCode(query.error, 'NOT_FOUND')) removeRecent(me.user.id, shop.id, 'customer', id);
  }, [query.error, me.user.id, shop.id, id]);

  const write = (next: CustomerDetail) => {
    queryClient.setQueryData(qk.customer(shop.id, next.id), next);
    void queryClient.invalidateQueries({ queryKey: qk.customersAll(shop.id) });
  };
  const archive = useMutation({
    mutationFn: (action: 'archive' | 'restore') =>
      apiFetch(customerPath(action, id), CustomerDetail, { method: 'POST' }),
    onSuccess: (next, action) => {
      write(next);
      setDialog(null);
      showToast({ body: action === 'archive' ? 'Customer archived' : 'Customer restored' });
    },
    onError: (err, action) => {
      if (action === 'restore') showToast({ body: errorMessage(err), type: 'error' });
    },
  });
  const deviceArchive = useMutation({
    mutationFn: ({ device, action }: { device: Device; action: 'archive' | 'restore' }) =>
      apiFetch(devicePath(action, device.id), Device, { method: 'POST' }),
    onSuccess: (_d, { action }) => {
      setArchivingDevice(null);
      void queryClient.invalidateQueries({
        queryKey: [...qk.customersAll(shop.id), 'devices', id],
      });
      showToast({ body: action === 'archive' ? 'Device archived' : 'Device restored' });
    },
    onError: (err, { action }) => {
      if (action === 'restore') showToast({ body: errorMessage(err), type: 'error' });
    },
  });
  const exportData = useMutation({
    mutationFn: () =>
      downloadFile(
        customerPath('export', id),
        customerExportFilename(id, todayInZone(shop.timezone)),
      ),
    onSuccess: () => showToast({ body: 'Export downloaded' }),
    onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
  });

  if (query.isPending) {
    return (
      <VStack gap={5} aria-busy="true" aria-label="Loading customer">
        <Skeleton width={320} height={36} />
        <RowsSkeleton rows={5} />
      </VStack>
    );
  }
  if (erased || hasErrorCode(query.error, 'NOT_FOUND', 'CUSTOMER_ERASED')) {
    return (
      <EmptyState
        headingLevel={1}
        title={
          erased || hasErrorCode(query.error, 'CUSTOMER_ERASED')
            ? 'This customer was erased.'
            : "We can't find that customer."
        }
        actions={<Button label="Back to customers" href="/customers" />}
      />
    );
  }
  if (hasErrorCode(query.error, 'FORBIDDEN')) return <NoAccess />;
  if (query.isError || !c)
    return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  const isArchived = !!c.archivedAt;
  const setTab = (t: string) => router.replace(`${pathname}?tab=${t}`, { scroll: false });
  const more: DropdownMenuOption[] = [];
  if (can('customers.manage')) {
    more.push(
      isArchived
        ? { label: 'Restore', onClick: () => archive.mutate('restore') }
        : { label: 'Archive…', onClick: () => setDialog('archive') },
    );
  }
  if (can('customers.export_delete')) {
    more.push({
      label: 'Export data',
      description: 'Download as JSON',
      onClick: () => exportData.mutate(),
    });
    more.push(
      { type: 'divider' },
      { label: 'Erase…', variant: 'destructive', onClick: () => setDialog('erase') },
    );
  }
  const deviceItems = devices.data?.items ?? [];

  return (
    <VStack gap={5}>
      <title>{`${c.displayName} · RepairOS`}</title>
      <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={1}>{c.displayName}</Heading>
            {c.kind === 'BUSINESS' ? <Badge label="Business" /> : null}
            {isArchived ? <Badge label="Archived" /> : null}
          </HStack>
          {c.businessContactName ? (
            <Text color="secondary">Contact: {c.businessContactName}</Text>
          ) : null}
          <HStack gap={4} wrap="wrap" vAlign="center">
            {[...c.phones]
              .sort((a, b) => a.position - b.position)
              .map((p) => (
                <PhoneText
                  key={p.id}
                  e164={p.e164}
                  shopCountry={shop.country}
                  isCallable
                  label={PHONE_LABELS[p.label]}
                  hasWhatsApp={p.id === c.whatsappPhoneId && p.label !== 'LANDLINE'}
                />
              ))}
            {c.email ? <Link href={`mailto:${c.email}`}>{c.email}</Link> : null}
          </HStack>
          <Text type="supporting" color="secondary">
            Prefers {PREFERRED_CHANNEL_LABELS[c.preferredChannel]} · {consentLine(c.consent, shop)}
          </Text>
          {c.tags.length ? (
            <HStack gap={1} wrap="wrap">
              {c.tags.map((t) => (
                <Token key={t} label={t} size="sm" />
              ))}
            </HStack>
          ) : null}
        </VStack>
        <HStack gap={2} vAlign="center">
          {can('tickets.create') && !isArchived ? (
            <Button
              label="New ticket"
              variant="primary"
              icon={<Icon icon={PlusIcon} />}
              href={`/tickets/new?customerId=${c.id}`}
            />
          ) : null}
          {can('customers.manage') ? (
            <Button label="Edit" href={`/customers/${c.id}/edit`} />
          ) : null}
          {more.length ? <MoreMenu label="More actions" alignment="end" items={more} /> : null}
        </HStack>
      </HStack>
      {c.notes ? <Banner status="info" title="Customer note" description={c.notes} /> : null}
      {isArchived ? (
        <Banner
          status="warning"
          title="Archived customer"
          description="Hidden from lists and search. Their tickets and history stay."
          endContent={
            can('customers.manage') ? (
              <Button label="Restore" size="sm" onClick={() => archive.mutate('restore')} />
            ) : undefined
          }
        />
      ) : null}

      <TabList value={tab} onChange={setTab} hasDivider aria-label="Customer sections">
        <Tab value="tickets" label="Tickets" endContent={<Badge label={String(c.ticketCount)} />} />
        <Tab value="devices" label="Devices" endContent={<Badge label={String(c.deviceCount)} />} />
        <Tab value="details" label="Details" />
      </TabList>

      {tab === 'tickets' ? (
        tickets.isPending ? (
          <RowsSkeleton rows={3} />
        ) : tickets.isError ? (
          <LoadError error={tickets.error} onRetry={() => void tickets.refetch()} />
        ) : (
          <TicketTable
            rows={tickets.data.items}
            now={Date.parse(tickets.data.serverNow)}
            columns={['number', 'device', 'status', 'created', 'due', 'assignee']}
            emptyState={<EmptyState isCompact title="No tickets yet. Check in a device." />}
          />
        )
      ) : null}

      {tab === 'devices' ? (
        <VStack gap={3}>
          {can('customers.manage') && !isArchived ? (
            <HStack>
              <Button
                label="Add device"
                icon={<Icon icon={PlusIcon} />}
                onClick={() => setDeviceDialog({ device: null })}
              />
            </HStack>
          ) : null}
          {devices.isPending ? (
            <RowsSkeleton rows={3} />
          ) : devices.isError ? (
            <LoadError error={devices.error} onRetry={() => void devices.refetch()} />
          ) : (
            <Table
              data={deviceItems}
              idKey="id"
              textOverflow="wrap"
              emptyState={<EmptyState isCompact title="No devices yet." />}
              columns={[
                {
                  key: 'device',
                  header: 'Device',
                  width: proportional(3, { minWidth: 160 }),
                  renderCell: (d) => (
                    <VStack gap={0.5}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Text weight="medium">{deviceLabel(d)}</Text>
                        {d.archivedAt ? <Badge label="Archived" /> : null}
                      </HStack>
                      <Text type="supporting" color="secondary">
                        {DEVICE_TYPE_LABELS[d.type]}
                        {d.colour ? ` · ${d.colour}` : ''}
                      </Text>
                    </VStack>
                  ),
                },
                {
                  key: 'id',
                  header: 'IMEI / serial',
                  width: proportional(2, { minWidth: 140 }),
                  renderCell: (d) =>
                    d.imei || d.serial ? (
                      <Identifier value={(d.imei ?? d.serial) as string} />
                    ) : (
                      <Text color="secondary">—</Text>
                    ),
                },
                {
                  key: 'passcode',
                  header: 'Passcode on file',
                  width: pixel(132),
                  renderCell: (d) => <Text>{d.passcodeOnFile ? 'Yes' : 'No'}</Text>,
                },
                {
                  key: 'tickets',
                  header: 'Tickets',
                  width: pixel(80),
                  align: 'end',
                  renderCell: (d) => <Text hasTabularNumbers>{d.ticketCount}</Text>,
                },
                {
                  key: 'actions',
                  header: <VisuallyHidden>Actions</VisuallyHidden>,
                  width: pixel(56),
                  renderCell: (d) => {
                    const items: DropdownMenuOption[] = [];
                    if (can('customers.manage') && !d.archivedAt)
                      items.push({ label: 'Edit…', onClick: () => setDeviceDialog({ device: d }) });
                    if (can('tickets.create') && !d.archivedAt && !isArchived)
                      items.push({
                        label: 'New ticket for this device',
                        href: `/tickets/new?customerId=${c.id}&deviceId=${d.id}`,
                      });
                    if (d.ticketCount > 0)
                      items.push({
                        label: 'Ticket history',
                        href: `/tickets?view=all&deviceId=${d.id}`,
                      });
                    if (can('customers.manage'))
                      items.push(
                        d.archivedAt
                          ? {
                              label: 'Restore',
                              onClick: () => deviceArchive.mutate({ device: d, action: 'restore' }),
                            }
                          : { label: 'Archive…', onClick: () => setArchivingDevice(d) },
                      );
                    return items.length ? (
                      <MoreMenu
                        label={`Actions for ${deviceLabel(d)}`}
                        alignment="end"
                        items={items}
                      />
                    ) : null;
                  },
                },
              ]}
            />
          )}
        </VStack>
      ) : null}

      {tab === 'details' ? (
        <VStack gap={5}>
          <Card padding={5}>
            <MetadataList label={{ position: 'start', width: 140 }}>
              <MetadataListItem label="Address">
                {[c.addressLine1, c.addressLine2, c.city, c.region, c.postcode]
                  .filter(Boolean)
                  .join(', ') || '—'}
              </MetadataListItem>
              <MetadataListItem label="Repair updates">
                {[
                  c.serviceOptOutSms ? 'No SMS' : null,
                  c.serviceOptOutEmail ? 'No email' : null,
                  c.serviceOptOutWhatsapp ? 'No WhatsApp' : null,
                ]
                  .filter(Boolean)
                  .join(', ') || 'All channels'}
              </MetadataListItem>
              <MetadataListItem label="Created">
                {c.createdBy ? `${c.createdBy.name}, ` : ''}
                {formatDateTime(c.createdAt, shop)}
              </MetadataListItem>
              <MetadataListItem label="Updated">
                {formatDateTime(c.updatedAt, shop)}
              </MetadataListItem>
            </MetadataList>
          </Card>
          <Card padding={5}>
            <VStack gap={4} as="section" aria-labelledby="consent-title">
              <HStack gap={3} hAlign="between" vAlign="center">
                <Heading level={2} id="consent-title">
                  Consent
                </Heading>
                {can('customers.manage') ? (
                  <Button label="Change consent" size="sm" onClick={() => setDialog('consent')} />
                ) : null}
              </HStack>
              <MetadataList label={{ position: 'start', width: 200 }}>
                {(['SMS', 'EMAIL', 'WHATSAPP'] as ConsentChannel[]).map((ch) => {
                  const v = c.consent[ch];
                  return (
                    <MetadataListItem key={ch} label={CONSENT_CHANNEL_LABELS[ch]}>
                      {v.granted && v.since
                        ? `Yes, since ${formatLongDate(v.since, shop)}${v.source ? `, ${CONSENT_SOURCE_LABELS[v.source].toLowerCase()}` : ''}${v.recordedByName ? `, by ${v.recordedByName}` : ''}`
                        : 'No'}
                    </MetadataListItem>
                  );
                })}
              </MetadataList>
              <Heading level={3}>Consent history</Heading>
              {consents.isPending ? (
                <RowsSkeleton rows={2} />
              ) : (
                <Table
                  data={consents.data?.items ?? []}
                  idKey="id"
                  density="compact"
                  emptyState={<EmptyState isCompact title="No consent recorded yet." />}
                  columns={[
                    {
                      key: 'when',
                      header: 'When',
                      width: pixel(170),
                      renderCell: (e) => formatDateTime(e.createdAt, shop),
                    },
                    {
                      key: 'channel',
                      header: 'Channel',
                      width: proportional(2, { minWidth: 140 }),
                      renderCell: (e) => CONSENT_CHANNEL_LABELS[e.channel],
                    },
                    {
                      key: 'state',
                      header: 'Change',
                      width: pixel(110),
                      renderCell: (e) => (
                        <Badge
                          variant={e.state === 'GRANTED' ? 'success' : 'neutral'}
                          label={e.state === 'GRANTED' ? 'Granted' : 'Withdrawn'}
                        />
                      ),
                    },
                    {
                      key: 'source',
                      header: 'Source',
                      width: proportional(2, { minWidth: 120 }),
                      renderCell: (e) => CONSENT_SOURCE_LABELS[e.source],
                    },
                    {
                      key: 'by',
                      header: 'By',
                      width: proportional(1, { minWidth: 100 }),
                      renderCell: (e) => e.recordedBy?.name ?? 'System',
                    },
                    {
                      key: 'note',
                      header: 'Note',
                      width: proportional(2, { minWidth: 100 }),
                      renderCell: (e) => e.note ?? '',
                    },
                  ]}
                />
              )}
            </VStack>
          </Card>
        </VStack>
      ) : null}

      <AlertDialog
        isOpen={dialog === 'archive'}
        onOpenChange={(o) => {
          if (!o) {
            setDialog(null);
            archive.reset();
          }
        }}
        title={`Archive ${c.displayName}?`}
        description={
          hasErrorCode(archive.error, 'CUSTOMER_HAS_OPEN_TICKETS')
            ? errorMessage(archive.error, { n: String(c.openTicketCount) })
            : archive.isError
              ? errorMessage(archive.error)
              : "They'll be hidden from lists and search. Their tickets and history stay."
        }
        actionLabel="Archive"
        actionVariant="primary"
        isActionLoading={archive.isPending}
        onAction={() => archive.mutate('archive')}
      />
      <AlertDialog
        isOpen={archivingDevice !== null}
        onOpenChange={(o) => {
          if (!o) {
            setArchivingDevice(null);
            deviceArchive.reset();
          }
        }}
        title={`Archive ${archivingDevice ? deviceLabel(archivingDevice) : ''}?`}
        description={
          deviceArchive.isError
            ? errorMessage(deviceArchive.error)
            : "It's hidden from this customer's devices and check-in. Its tickets stay."
        }
        actionLabel="Archive"
        actionVariant="primary"
        isActionLoading={deviceArchive.isPending}
        onAction={() =>
          archivingDevice && deviceArchive.mutate({ device: archivingDevice, action: 'archive' })
        }
      />
      {dialog === 'erase' ? (
        <EraseDialog
          customer={c}
          onClose={() => setDialog(null)}
          onErased={() => {
            removeRecent(me.user.id, shop.id, 'customer', c.id);
            queryClient.removeQueries({ queryKey: qk.customer(shop.id, c.id) });
            setErased(true);
          }}
        />
      ) : null}
      {dialog === 'consent' ? <ConsentDialog customer={c} onClose={() => setDialog(null)} /> : null}
      {deviceDialog ? (
        <DeviceDialog
          customerId={c.id}
          device={deviceDialog.device}
          onClose={() => setDeviceDialog(null)}
        />
      ) : null}
    </VStack>
  );
}
