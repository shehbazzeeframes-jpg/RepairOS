'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { DateTimeInput, type ISODateTimeString } from '@astryxdesign/core/DateTimeInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  CreateTimeEntryInput,
  DeleteTimeEntryInput,
  TimeEntry,
  UpdateTimeEntryInput,
} from '@repairos/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { z, type ZodError } from 'zod';
import { errorStatus } from '@/components/form';
import { apiFetch, isApiRequestError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  formatDateTime,
  hourFormatFor,
  utcToZonedLocal,
  zonedLocalToUtc,
  type ShopClock,
} from '@/lib/timezone';

type Field = 'userId' | 'clockInAt' | 'clockOutAt' | 'reason';
type FieldErrors = Partial<Record<Field, string>>;

function issuesToFields(issues: { path: (string | number)[]; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (key === 'userId' || key === 'clockInAt' || key === 'clockOutAt' || key === 'reason') {
      out[key] ??= issue.message;
    }
  }
  return out;
}

const zodFields = (err: ZodError) => issuesToFields(err.issues);

export interface StaffOption {
  userId: string;
  name: string;
}

/** Add a missing entry (entry = null) or fix one. Times are picked in shop time. */
export function EntryDialog({
  entry,
  staffName,
  staffOptions,
  shop,
  onClose,
  onSaved,
}: {
  entry: TimeEntry | null;
  staffName?: string;
  /** Add mode: who the entry can be for. */
  staffOptions: StaffOption[];
  shop: ShopClock;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const showToast = useToast();
  const [userId, setUserId] = useState(entry?.userId ?? '');
  const [clockIn, setClockIn] = useState(
    entry ? utcToZonedLocal(entry.clockInAt, shop.timezone) : '',
  );
  const [clockOut, setClockOut] = useState(
    entry?.clockOutAt ? utcToZonedLocal(entry.clockOutAt, shop.timezone) : '',
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: CreateTimeEntryInput | UpdateTimeEntryInput) =>
      entry
        ? apiFetch(`/api/time-entries/${entry.id}`, TimeEntry, { method: 'PATCH', json: body })
        : apiFetch('/api/time-entries', TimeEntry, { method: 'POST', json: body }),
    onSuccess: async () => {
      showToast({ body: entry ? 'Time entry updated' : 'Time entry added' });
      onClose();
      await onSaved();
    },
    onError: (err) => {
      if (isApiRequestError(err)) setErrors(issuesToFields(err.body.issues ?? []));
    },
  });

  const toUtc = (local: string) =>
    local ? zonedLocalToUtc(local.slice(0, 16), shop.timezone) : undefined;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const local: FieldErrors = {};
    if (!entry && !userId) local.userId = 'Choose a staff member';
    if (!clockIn) local.clockInAt = 'Choose the clock-in time';
    if (!entry && !clockOut) local.clockOutAt = 'Choose the clock-out time';
    const inAt = toUtc(clockIn);
    const outAt = toUtc(clockOut);
    const parsed = entry
      ? UpdateTimeEntryInput.safeParse({
          ...(inAt && inAt !== entry.clockInAt ? { clockInAt: inAt } : {}),
          ...(outAt && outAt !== entry.clockOutAt ? { clockOutAt: outAt } : {}),
          reason,
        })
      : CreateTimeEntryInput.safeParse({ userId, clockInAt: inAt, clockOutAt: outAt, reason });
    const all = { ...(parsed.success ? {} : zodFields(parsed.error)), ...local };
    setErrors(all);
    if (!parsed.success || Object.keys(local).length > 0) return;
    save.mutate(parsed.data);
  };

  const hourFormat = hourFormatFor(shop.locale);
  const title = entry ? `Fix time entry${staffName ? ` for ${staffName}` : ''}` : 'Add time entry';
  const bannerError =
    save.isError && Object.keys(errors).length === 0 ? errorMessage(save.error) : null;

  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={520}>
      <DialogHeader
        title={title}
        subtitle={`Times are in shop time (${shop.timezone}). The reason is kept in the audit log.`}
        onOpenChange={(open) => !open && onClose()}
      />
      <form onSubmit={onSubmit} noValidate aria-label={title}>
        <VStack gap={5} padding={6}>
          {bannerError ? (
            <Banner status="error" title="Could not save" description={bannerError} />
          ) : null}
          <FormLayout defaultOptionality="required">
            {entry ? null : (
              <Selector
                label="Staff member"
                placeholder="Choose a person"
                value={userId || undefined}
                onChange={(v) => setUserId(v ?? '')}
                options={staffOptions.map((s) => ({ value: s.userId, label: s.name }))}
                status={errorStatus(errors.userId)}
              />
            )}
            <DateTimeInput
              label="Clock in"
              value={(clockIn || undefined) as ISODateTimeString | undefined}
              onChange={(v) => setClockIn(v ?? '')}
              hourFormat={hourFormat}
              timeIncrement={5}
              weekStartsOn="mon"
              presentation="popover"
              status={errorStatus(errors.clockInAt)}
            />
            <DateTimeInput
              label="Clock out"
              value={(clockOut || undefined) as ISODateTimeString | undefined}
              onChange={(v) => setClockOut(v ?? '')}
              hourFormat={hourFormat}
              timeIncrement={5}
              weekStartsOn="mon"
              presentation="popover"
              isOptional={entry !== null && entry.clockOutAt === null}
              description={
                entry && entry.clockOutAt === null
                  ? 'Still open. Set a clock-out time to close it.'
                  : undefined
              }
              status={errorStatus(errors.clockOutAt)}
            />
            <TextArea
              label="Reason"
              value={reason}
              onChange={setReason}
              rows={2}
              maxLength={200}
              placeholder="e.g. Forgot to clock out"
              status={errorStatus(errors.reason)}
            />
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={save.isPending ? 'Saving…' : entry ? 'Save entry' : 'Add entry'}
              isLoading={save.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

/** Delete with a required reason (kept in the audit log with the old times). */
export function DeleteEntryDialog({
  entry,
  staffName,
  shop,
  onClose,
  onDeleted,
}: {
  entry: TimeEntry;
  staffName: string;
  shop: ShopClock;
  onClose: () => void;
  onDeleted: () => Promise<unknown>;
}) {
  const showToast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const remove = useMutation({
    mutationFn: (body: DeleteTimeEntryInput) =>
      apiFetch(`/api/time-entries/${entry.id}`, z.unknown(), { method: 'DELETE', json: body }),
    onSuccess: async () => {
      showToast({ body: 'Time entry deleted' });
      onClose();
      await onDeleted();
    },
  });
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={480}>
      <DialogHeader title="Delete time entry?" onOpenChange={(open) => !open && onClose()} />
      <form
        noValidate
        aria-label="Delete time entry"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = DeleteTimeEntryInput.safeParse({ reason });
          if (!parsed.success) return setError(parsed.error.issues[0]?.message);
          setError(undefined);
          remove.mutate(parsed.data);
        }}
      >
        <VStack gap={5} padding={6}>
          <Text>
            {staffName}, clocked in {formatDateTime(entry.clockInAt, shop)}. The entry is removed
            from the timesheet; the audit log keeps a copy.
          </Text>
          {remove.isError ? (
            <Banner
              status="error"
              title="Could not delete"
              description={errorMessage(remove.error)}
            />
          ) : null}
          <TextArea
            label="Reason"
            isRequired
            value={reason}
            onChange={setReason}
            rows={2}
            maxLength={200}
            placeholder="e.g. Duplicate entry"
            status={errorStatus(error)}
          />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="destructive"
              label={remove.isPending ? 'Deleting…' : 'Delete entry'}
              isLoading={remove.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}
