'use client';

/*
 * Settings → Ticket statuses (spec §8.1, A9): rename, recolour, re-categorise, hide, notify flag,
 * requires-note, and reorder (drag handle, or Move up / Move down for the keyboard). System
 * statuses (Received, Collected, Cancelled) can be renamed and recoloured only.
 */

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { createReorderable } from '@astryxdesign/core';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { PlusIcon } from '@heroicons/react/24/outline';
import {
  API_ERROR_MESSAGES,
  CreateTicketStatusInput,
  MAX_TICKET_STATUSES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  STATUS_COLOURS,
  StatusName,
  TICKET_STATUS_PATHS,
  TicketStatus,
  TicketStatusListResponse,
  checkStatusCreate,
  checkStatusUpdate,
  type StatusCategory,
  type StatusColour,
  type UpdateTicketStatusInput,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { apiFetch } from '@/lib/api';
import { errorMessage, fillTemplate } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { useTicketStatuses } from '@/lib/sprint2-queries';

const updatePath = (id: string) =>
  TICKET_STATUS_PATHS.update.replace(':id', encodeURIComponent(id));

/** Contract rule result → copy. */
function ruleMessage(r: ReturnType<typeof checkStatusUpdate>): string | null {
  if (r.ok) return null;
  const template = API_ERROR_MESSAGES[r.code] ?? "That change isn't allowed.";
  return fillTemplate(template, r.vars ?? {}) ?? template;
}

/** Pure: the ids after moving `id` to index `to`. */
export function moveId(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

function StatusDialog({
  status,
  all,
  onClose,
}: {
  status: TicketStatus | null;
  all: readonly TicketStatus[];
  onClose: () => void;
}) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [name, setName] = useState(status?.name ?? '');
  const [category, setCategory] = useState<StatusCategory>(status?.category ?? 'OPEN');
  const [colour, setColour] = useState<StatusColour>(status?.colour ?? 'blue');
  const [notify, setNotify] = useState(status?.notifyCustomer ?? false);
  const [requiresNote, setRequiresNote] = useState(status?.requiresNote ?? false);
  const [tried, setTried] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const nameCheck = StatusName.safeParse(name);

  const patch: UpdateTicketStatusInput = {};
  if (status) {
    if (name.trim() !== status.name) patch.name = name;
    if (category !== status.category) patch.category = category;
    if (colour !== status.colour) patch.colour = colour;
    if (notify !== status.notifyCustomer) patch.notifyCustomer = notify;
    if (requiresNote !== status.requiresNote) patch.requiresNote = requiresNote;
  }
  const rule = status
    ? ruleMessage(checkStatusUpdate(all, status.id, patch))
    : ruleMessage(checkStatusCreate(all, { name }));

  const save = useMutation({
    mutationFn: () =>
      status
        ? apiFetch(updatePath(status.id), TicketStatus, { method: 'PATCH', json: patch })
        : apiFetch(TICKET_STATUS_PATHS.create, TicketStatus, {
            method: 'POST',
            json: CreateTicketStatusInput.parse({
              name,
              category,
              colour,
              notifyCustomer: notify,
              requiresNote,
            }),
          }),
    onSuccess: (s) => {
      void queryClient.invalidateQueries({ queryKey: qk.statuses(shop.id) });
      void queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shop.id) });
      showToast({ body: status ? `${s.name} saved` : `${s.name} added` });
      onClose();
    },
  });

  const submit = () => {
    setTried(true);
    if (!nameCheck.success || rule) return;
    if (status && Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    if (status && patch.category && status.ticketCount > 0 && !confirmMove) {
      setConfirmMove(true);
      return;
    }
    save.mutate();
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={560}>
      <DialogHeader
        title={status ? `Edit ${status.name}` : 'Add status'}
        onOpenChange={(o) => !o && onClose()}
      />
      <form
        noValidate
        aria-label={status ? `Edit ${status.name}` : 'Add status'}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <VStack gap={5} padding={6}>
          {save.isError ? (
            <Banner
              status="error"
              title="Couldn't save the status"
              description={errorMessage(save.error)}
            />
          ) : null}
          {tried && rule ? <Banner status="error" title={rule} /> : null}
          <FormLayout>
            <TextInput
              label="Name"
              isRequired
              hasAutoFocus
              value={name}
              onChange={setName}
              status={
                tried && !nameCheck.success
                  ? { type: 'error', message: nameCheck.error.issues[0]?.message }
                  : undefined
              }
            />
            <VStack gap={2}>
              <Text weight="medium">Category</Text>
              <SegmentedControl
                label="Category"
                value={category}
                onChange={(v) => setCategory(v as StatusCategory)}
                isDisabled={!!status?.systemRole}
              >
                {STATUS_CATEGORIES.map((c) => (
                  <SegmentedControlItem key={c} value={c} label={STATUS_CATEGORY_LABELS[c]} />
                ))}
              </SegmentedControl>
              {status?.systemRole ? (
                <Text type="supporting" color="secondary">
                  System statuses keep their category.
                </Text>
              ) : category === 'CLOSED' ? (
                <Text type="supporting" color="secondary">
                  Custom closed statuses are offered when cancelling a ticket.
                </Text>
              ) : null}
            </VStack>
            <RadioList
              label="Colour"
              orientation="horizontal"
              value={colour}
              onChange={(v) => setColour(v as StatusColour)}
            >
              {STATUS_COLOURS.map((c) => (
                <RadioListItem key={c} value={c} label={c} />
              ))}
            </RadioList>
            <HStack gap={2} vAlign="center">
              <Text type="supporting" color="secondary">
                Preview:
              </Text>
              <StatusBadge name={name || 'Status'} category={category} colour={colour} />
            </HStack>
            <Switch
              label="Notify the customer when a ticket moves here"
              description="Messages start in Sprint 3"
              value={notify}
              onChange={setNotify}
            />
            <Switch
              label="Requires a note"
              description="Staff must say why when they choose it"
              value={requiresNote}
              onChange={setRequiresNote}
            />
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={status ? 'Save status' : 'Add status'}
              isLoading={save.isPending}
            />
          </HStack>
        </VStack>
      </form>
      <AlertDialog
        isOpen={confirmMove}
        onOpenChange={(o) => !o && setConfirmMove(false)}
        title="Move tickets to another category?"
        description={`${status?.ticketCount ?? 0} tickets will move from ${STATUS_CATEGORY_LABELS[status?.category ?? 'OPEN']} to ${STATUS_CATEGORY_LABELS[category]}.`}
        actionLabel="Move them"
        actionVariant="primary"
        onAction={() => {
          setConfirmMove(false);
          save.mutate();
        }}
      />
    </Dialog>
  );
}

export function TicketStatusesPage() {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const statuses = useTicketStatuses();
  const [editing, setEditing] = useState<{ status: TicketStatus | null } | null>(null);
  const items = useMemo(
    () => [...(statuses.data?.items ?? [])].sort((a, b) => a.position - b.position),
    [statuses.data],
  );

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch(TICKET_STATUS_PATHS.order, TicketStatusListResponse, {
        method: 'PUT',
        json: { ids },
      }),
    onMutate: async (ids) => {
      const key = qk.statuses(shop.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TicketStatusListResponse>(key);
      if (previous) {
        const byId = new Map(previous.items.map((s) => [s.id, s]));
        queryClient.setQueryData<TicketStatusListResponse>(key, {
          items: ids.map((id, position) => ({ ...byId.get(id)!, position })),
        });
      }
      return { previous };
    },
    onSuccess: (data) => queryClient.setQueryData(qk.statuses(shop.id), data),
    onError: (err, _ids, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(qk.statuses(shop.id), ctx.previous);
      showToast({ body: errorMessage(err), type: 'error' });
    },
  });
  const patch = useMutation({
    mutationFn: ({ s, body }: { s: TicketStatus; body: UpdateTicketStatusInput }) =>
      apiFetch(updatePath(s.id), TicketStatus, { method: 'PATCH', json: body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.statuses(shop.id) }),
    onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
  });

  const ids = items.map((s) => s.id);
  const move = (id: string, to: number) => reorder.mutate(moveId(ids, id, to));
  // Made each render: the latest onReorder is the one called (Astryx createReorderable docs).
  const reorderable = createReorderable({ onReorder: ({ key, to }) => move(String(key), to) });

  const setPatch = (s: TicketStatus, body: UpdateTicketStatusInput) => {
    const msg = ruleMessage(checkStatusUpdate(items, s.id, body));
    if (msg) {
      showToast({ body: msg, type: 'error' });
      return;
    }
    patch.mutate({ s, body });
  };

  return (
    <VStack gap={5}>
      <title>Ticket statuses · RepairOS</title>
      <HStack gap={4} hAlign="between" vAlign="end" wrap="wrap">
        <PageIntro
          title="Ticket statuses"
          description="Rename and order the steps a repair goes through. Categories decide where tickets show up: In progress, Waiting, Ready, Closed."
        />
        <Button
          label="Add status"
          variant="primary"
          icon={<Icon icon={PlusIcon} />}
          isDisabled={items.length >= MAX_TICKET_STATUSES}
          tooltip={
            items.length >= MAX_TICKET_STATUSES ? 'You can have up to 20 statuses.' : undefined
          }
          onClick={() => setEditing({ status: null })}
        />
      </HStack>
      <Banner
        status="info"
        title="Statuses can't be deleted. Hide one to stop using it; tickets already in it stay there."
      />
      {statuses.isPending ? (
        <RowsSkeleton rows={9} label="Loading statuses" />
      ) : statuses.isError ? (
        <LoadError error={statuses.error} onRetry={() => void statuses.refetch()} />
      ) : (
        <List hasDividers reorderable={reorderable} aria-label="Ticket statuses">
          {items.map((s, i) => {
            const menu: DropdownMenuOption[] = [
              { label: 'Edit…', onClick: () => setEditing({ status: s }) },
              { label: 'Move up', isDisabled: i === 0, onClick: () => move(s.id, i - 1) },
              {
                label: 'Move down',
                isDisabled: i === items.length - 1,
                onClick: () => move(s.id, i + 1),
              },
            ];
            if (!s.systemRole) {
              menu.push({
                label: s.isHidden ? 'Show' : 'Hide',
                onClick: () => setPatch(s, { isHidden: !s.isHidden }),
              });
            }
            return (
              <ListItem
                key={s.id}
                itemKey={s.id}
                label={
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <StatusBadge {...s} />
                    {s.systemRole ? <Badge label="System" /> : null}
                    {s.isHidden ? <Badge label="Hidden" /> : null}
                    {s.requiresNote ? <Badge label="Needs a note" variant="info" /> : null}
                  </HStack>
                }
                description={`${STATUS_CATEGORY_LABELS[s.category]} · ${s.ticketCount} ${s.ticketCount === 1 ? 'ticket' : 'tickets'}`}
                endContent={
                  <HStack gap={3} vAlign="center">
                    <Switch
                      label={`Notify customer when a ticket moves to ${s.name}`}
                      isLabelHidden
                      value={s.notifyCustomer}
                      onChange={(v) => setPatch(s, { notifyCustomer: v })}
                    />
                    <MoreMenu label={`Actions for ${s.name}`} alignment="end" items={menu} />
                  </HStack>
                }
              />
            );
          })}
        </List>
      )}
      <Text type="supporting" color="secondary">
        The switch on each row turns on customer notifications for that status. Messages start in
        Sprint 3.
      </Text>
      {editing ? (
        <StatusDialog status={editing.status} all={items} onClose={() => setEditing(null)} />
      ) : null}
    </VStack>
  );
}
