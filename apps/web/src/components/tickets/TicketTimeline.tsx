'use client';

/*
 * Ticket timeline (spec §7.4): oldest → newest, newest at the bottom, "Show earlier" pages back with
 * `olderCursor`. Notes show their visibility with an icon and words (never colour alone); a note is
 * editable by its author for 10 minutes. The composer sits under the list.
 */

import { Avatar } from '@astryxdesign/core/Avatar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { EyeIcon, LockClosedIcon, WrenchScrewdriverIcon } from '@heroicons/react/20/solid';
import {
  CreateTicketNoteInput,
  NOTE_VISIBILITY_LABELS,
  TicketNote,
  UpdateTicketNoteInput,
  canEditNote,
  ticketPath,
  type NoteVisibility,
  type TicketTimelineItem,
  type TimelineFilter,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type Ref } from 'react';
import { ShortcutHint } from '@/components/ui/ShortcutHint';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { useTimeline } from '@/lib/sprint2-queries';
import { asItem, timelineSentence } from '@/lib/timeline-text';

function Actor({ name }: { name: string | null }) {
  return name ? (
    <Avatar name={name} size="sm" tooltip={false} />
  ) : (
    <Icon icon={WrenchScrewdriverIcon} size="sm" color="secondary" label="RepairOS" />
  );
}

function When({ at }: { at: string }) {
  return <Timestamp value={at} format="relative" />;
}

function NoteRow({
  note,
  ticketId,
  canWrite,
}: {
  note: TicketNote;
  ticketId: string;
  canWrite: boolean;
}) {
  const { me, shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const editable =
    canWrite &&
    note.canEdit &&
    canEditNote({ authorUserId: note.author.userId, createdAt: note.createdAt }, me.user.id);
  const save = useMutation({
    mutationFn: (body: string) =>
      apiFetch(ticketPath('note', { id: ticketId, noteId: note.id }), TicketNote, {
        method: 'PATCH',
        json: UpdateTicketNoteInput.parse({ body }),
      }),
    onSuccess: () => {
      setEditing(null);
      showToast({ body: 'Note updated' });
      void queryClient.invalidateQueries({
        queryKey: [...qk.ticketsAll(shop.id), 'timeline', ticketId],
      });
    },
    onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
  });
  const isCustomer = note.visibility === 'CUSTOMER';
  const body = (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text weight="medium">{note.author.name}</Text>
        <HStack gap={1} vAlign="center">
          <Icon icon={isCustomer ? EyeIcon : LockClosedIcon} size="xsm" color="secondary" />
          <Text type="supporting" color="secondary">
            {NOTE_VISIBILITY_LABELS[note.visibility]}
          </Text>
        </HStack>
        <When at={note.createdAt} />
        {note.editedAt ? (
          <Text type="supporting" color="secondary">
            edited
          </Text>
        ) : null}
        {editable && editing === null ? (
          <Link
            href="#"
            type="supporting"
            onClick={(e) => {
              e.preventDefault();
              setEditing(note.body);
            }}
          >
            Edit
          </Link>
        ) : null}
      </HStack>
      {editing !== null ? (
        <VStack gap={2}>
          <TextArea
            label="Edit note"
            isLabelHidden
            rows={3}
            maxLength={2000}
            value={editing}
            onChange={setEditing}
            hasAutoFocus
          />
          <HStack gap={2}>
            <Button
              label="Save note"
              size="sm"
              variant="primary"
              isLoading={save.isPending}
              onClick={() => save.mutate(editing)}
            />
            <Button label="Cancel" size="sm" variant="ghost" onClick={() => setEditing(null)} />
          </HStack>
        </VStack>
      ) : (
        <Text wordBreak="break-word">{note.body}</Text>
      )}
    </VStack>
  );
  return (
    <HStack gap={3} vAlign="start" role="listitem">
      <Actor name={note.author.name} />
      {isCustomer ? (
        <Card variant="blue" padding={3} width="100%">
          {body}
        </Card>
      ) : (
        <VStack width="100%">{body}</VStack>
      )}
    </HStack>
  );
}

function EventRow({ item }: { item: TicketTimelineItem }) {
  const { shop } = useSession();
  const status = asItem(item, 'status_changed');
  return (
    <HStack gap={3} vAlign="start" role="listitem">
      <Actor name={item.actor?.name ?? null} />
      <VStack gap={1}>
        {status ? (
          <HStack gap={1.5} vAlign="center" wrap="wrap">
            <Text>{item.actor?.name ?? 'RepairOS'} changed status</Text>
            <StatusBadge {...status.data.from} />
            <Text aria-label="to">→</Text>
            <StatusBadge {...status.data.to} />
          </HStack>
        ) : (
          <Text wordBreak="break-word">{timelineSentence(item, shop)}</Text>
        )}
        {status?.data.notifyPending ? (
          <Text type="supporting" color="secondary">
            Customer will be notified
          </Text>
        ) : null}
        <When at={item.createdAt} />
      </VStack>
    </HStack>
  );
}

export function TicketTimeline({
  ticketId,
  canWrite,
  composerRef,
}: {
  ticketId: string;
  canWrite: boolean;
  composerRef?: Ref<HTMLElement>;
}) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const timeline = useTimeline(ticketId, filter);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<NoteVisibility>('INTERNAL');
  const [tried, setTried] = useState(false);

  const add = useMutation({
    mutationFn: (input: CreateTicketNoteInput) =>
      apiFetch(ticketPath('notes', { id: ticketId }), TicketNote, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      setBody('');
      setTried(false);
      showToast({ body: 'Note added' });
      void queryClient.invalidateQueries({
        queryKey: [...qk.ticketsAll(shop.id), 'timeline', ticketId],
      });
    },
    onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
  });
  const parsed = CreateTicketNoteInput.safeParse({ body, visibility });
  const post = () => {
    setTried(true);
    if (parsed.success) add.mutate({ body: parsed.data.body, visibility: parsed.data.visibility });
  };

  // pages[0] is the newest page; each page is oldest → newest.
  const items = [...(timeline.data?.pages ?? [])].reverse().flatMap((p) => p.items);

  return (
    <VStack gap={4} as="section" aria-labelledby="activity-title">
      <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
        <Heading level={2} id="activity-title">
          Activity
        </Heading>
        <SegmentedControl
          label="Show"
          size="sm"
          value={filter}
          onChange={(v) => setFilter(v as TimelineFilter)}
        >
          <SegmentedControlItem value="all" label="All" />
          <SegmentedControlItem value="notes" label="Notes" />
          <SegmentedControlItem value="status" label="Status changes" />
        </SegmentedControl>
      </HStack>
      {timeline.isPending ? (
        <VStack gap={3} aria-busy="true" aria-label="Loading activity">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} index={i} height={48} />
          ))}
        </VStack>
      ) : timeline.isError ? (
        <Banner
          status="error"
          title="Couldn't load the activity"
          description={errorMessage(timeline.error)}
          endContent={
            <Button label="Try again" size="sm" onClick={() => void timeline.refetch()} />
          }
        />
      ) : (
        <VStack gap={4} role="list" aria-label="Ticket activity">
          {timeline.hasNextPage ? (
            <Button
              label="Show earlier"
              variant="ghost"
              size="sm"
              isLoading={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
            />
          ) : null}
          {items.length === 0 ? (
            <Text color="secondary">Nothing here yet.</Text>
          ) : (
            items.map((item) => {
              const note = asItem(item, 'note_added');
              return note ? (
                <NoteRow
                  key={item.id}
                  note={note.data.note}
                  ticketId={ticketId}
                  canWrite={canWrite}
                />
              ) : (
                <EventRow key={item.id} item={item} />
              );
            })
          )}
        </VStack>
      )}
      {canWrite ? (
        <Card padding={4} elevation="low">
          <VStack
            gap={3}
            as="form"
            aria-label="Add a note"
            ref={composerRef}
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              post();
            }}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                post();
              }
            }}
          >
            <TextArea
              label="Add a note"
              isLabelHidden
              placeholder="Add a note"
              rows={3}
              maxLength={2000}
              value={body}
              onChange={setBody}
              status={
                tried && !parsed.success
                  ? { type: 'error', message: parsed.error.issues[0]?.message ?? 'Write a note' }
                  : undefined
              }
            />
            <SegmentedControl
              label="Note visibility"
              size="sm"
              value={visibility}
              onChange={(v) => setVisibility(v as NoteVisibility)}
            >
              <SegmentedControlItem value="INTERNAL" label={NOTE_VISIBILITY_LABELS.INTERNAL} />
              <SegmentedControlItem value="CUSTOMER" label={NOTE_VISIBILITY_LABELS.CUSTOMER} />
            </SegmentedControl>
            {visibility === 'CUSTOMER' ? (
              <Text type="supporting" color="secondary">
                Customers will see this on their repair status page (from Sprint 3).
              </Text>
            ) : null}
            <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
              <ShortcutHint keys="mod+enter" label="Post" />
              <Button type="submit" label="Add note" variant="primary" isLoading={add.isPending} />
            </HStack>
          </VStack>
        </Card>
      ) : null}
    </VStack>
  );
}
