'use client';

/*
 * Status changes (spec §7.2), shared by the ticket detail header and the list's row menus:
 * - a target with `requiresNote` (Unrepairable) asks for a note first;
 * - COLLECTED asks to confirm the hand-back (with the accessories);
 * - anything else changes at once, optimistically, with a toast.
 */

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  InlineNoteInput,
  NOTE_VISIBILITY_LABELS,
  TicketDetail,
  accessoriesSummary,
  allowedTargetStatuses,
  canTransition,
  ticketPath,
  type AccessoryCode,
  type NoteVisibility,
  type Permission,
  type StatusRef,
  type TicketListResponse,
  type TicketStatus,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useShopId } from '@/lib/shop-context';

export interface StatusTicket {
  id: string;
  numberLabel: string;
  status: StatusRef;
  /** Known on the detail page; the list doesn't carry them. */
  accessories?: AccessoryCode[];
  accessoriesOther?: string | null;
}

const toRef = (s: TicketStatus): StatusRef => ({
  id: s.id,
  name: s.name,
  category: s.category,
  colour: s.colour,
  systemRole: s.systemRole,
});

/** Statuses the Change status menu offers (hidden never; Collected only from READY with tickets.cancel). */
export function statusMenuTargets(
  from: StatusRef,
  statuses: readonly TicketStatus[],
  permissions: readonly Permission[],
): TicketStatus[] {
  return allowedTargetStatuses(from, statuses, { permissions, via: 'status' });
}

/**
 * The "not allowed" explanation row for the common case: a Collected status the ticket can't move
 * to yet (OPEN/WAITING), with `COLLECT_NOT_READY_MESSAGE`.
 */
export function collectBlockedReason(
  from: StatusRef,
  statuses: readonly TicketStatus[],
  permissions: readonly Permission[],
): { status: TicketStatus; message: string } | null {
  const collected = statuses.find((s) => s.systemRole === 'COLLECTED' && !s.isHidden);
  if (!collected || from.category === 'CLOSED' || from.category === 'READY') return null;
  const r = canTransition(from, collected, { permissions, via: 'status' });
  return !r.ok && r.code === 'TRANSITION_NOT_ALLOWED' && r.message
    ? { status: collected, message: r.message }
    : null;
}

export function useStatusChanger() {
  const shopId = useShopId();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [noteFor, setNoteFor] = useState<{ ticket: StatusTicket; target: TicketStatus } | null>(
    null,
  );
  const [collectFor, setCollectFor] = useState<{
    ticket: StatusTicket;
    target: TicketStatus;
  } | null>(null);

  const change = useMutation({
    mutationFn: (v: {
      ticket: StatusTicket;
      target: TicketStatus;
      note?: { body: string; visibility: NoteVisibility };
    }) =>
      apiFetch(ticketPath('status', { id: v.ticket.id }), TicketDetail, {
        method: 'POST',
        json: { statusId: v.target.id, ...(v.note ? { note: v.note } : {}) },
      }),
    onMutate: async ({ ticket, target }) => {
      // Optimistic: the badge changes now, everywhere this ticket shows.
      const detailKey = qk.ticket(shopId, ticket.id);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData<TicketDetail>(detailKey);
      if (previous) queryClient.setQueryData(detailKey, { ...previous, status: toRef(target) });
      queryClient.setQueriesData<TicketListResponse>(
        { queryKey: [...qk.ticketsAll(shopId), 'list'] },
        (old) =>
          old
            ? {
                ...old,
                items: old.items.map((i) =>
                  i.id === ticket.id ? { ...i, status: toRef(target) } : i,
                ),
              }
            : old,
      );
      return { previous };
    },
    onSuccess: (detail, { target }) => {
      queryClient.setQueryData(qk.ticket(shopId, detail.id), detail);
      setNoteFor(null);
      setCollectFor(null);
      showToast({ body: `Status changed to ${target.name}` });
    },
    onError: (err, { ticket }, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(qk.ticket(shopId, ticket.id), ctx.previous);
      if (hasErrorCode(err, 'STATUS_HIDDEN')) {
        void queryClient.invalidateQueries({ queryKey: qk.statuses(shopId) });
      }
      setCollectFor(null);
      showToast({ body: errorMessage(err), type: 'error' });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shopId) }),
  });

  /** Ask for whatever the target needs, or change at once. */
  const request = (ticket: StatusTicket, target: TicketStatus) => {
    if (target.requiresNote) setNoteFor({ ticket, target });
    else if (target.systemRole === 'COLLECTED') setCollectFor({ ticket, target });
    else change.mutate({ ticket, target });
  };

  const dialogs: ReactNode = (
    <>
      {noteFor ? (
        <StatusNoteDialog
          ticket={noteFor.ticket}
          target={noteFor.target}
          isSaving={change.isPending}
          error={change.isError ? change.error : null}
          onClose={() => setNoteFor(null)}
          onSave={(note) => change.mutate({ ...noteFor, note })}
        />
      ) : null}
      <AlertDialog
        isOpen={collectFor !== null}
        onOpenChange={(open) => !open && setCollectFor(null)}
        title="Hand the device back"
        description={
          collectFor?.ticket.accessories
            ? `Hand the device and these accessories back: ${accessoriesSummary(collectFor.ticket.accessories, collectFor.ticket.accessoriesOther)}.`
            : 'Hand the device and any accessories left with it back to the customer.'
        }
        actionLabel="Mark collected"
        actionVariant="primary"
        isActionLoading={change.isPending}
        onAction={() => collectFor && change.mutate(collectFor)}
      />
    </>
  );

  return { request, dialogs, isPending: change.isPending };
}

function StatusNoteDialog({
  ticket,
  target,
  isSaving,
  error,
  onClose,
  onSave,
}: {
  ticket: StatusTicket;
  target: TicketStatus;
  isSaving: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (note: { body: string; visibility: NoteVisibility }) => void;
}) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<NoteVisibility>('CUSTOMER');
  const [tried, setTried] = useState(false);
  const parsed = InlineNoteInput.safeParse({ body, visibility });
  const problem = tried && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const isUnrepairable = target.name.toLowerCase().includes('unrepairable');

  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={520}>
      <DialogHeader
        title={`Mark as ${target.name}`}
        subtitle={ticket.numberLabel}
        onOpenChange={(open) => !open && onClose()}
      />
      <form
        noValidate
        aria-label={`Mark as ${target.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (parsed.success) onSave(parsed.data);
        }}
      >
        <VStack gap={5} padding={6}>
          {error ? (
            <Banner
              status="error"
              title="Couldn't change the status"
              description={errorMessage(error)}
            />
          ) : null}
          <FormLayout>
            <TextArea
              label={isUnrepairable ? "Why can't it be repaired?" : 'Note'}
              isRequired
              rows={3}
              maxLength={2000}
              hasAutoFocus
              value={body}
              onChange={setBody}
              status={problem ? { type: 'error', message: problem } : undefined}
            />
            <SegmentedControl
              label="Who can see this note"
              value={visibility}
              onChange={(v) => setVisibility(v as NoteVisibility)}
            >
              <SegmentedControlItem value="CUSTOMER" label={NOTE_VISIBILITY_LABELS.CUSTOMER} />
              <SegmentedControlItem value="INTERNAL" label={NOTE_VISIBILITY_LABELS.INTERNAL} />
            </SegmentedControl>
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={`Mark as ${target.name}`}
              isLoading={isSaving}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}
