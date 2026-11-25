'use client';

/* Ticket detail dialogs (spec §7.5): Assign, Cancel, Reopen, Edit details. */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { InputGroup, InputGroupText } from '@astryxdesign/core/InputGroup';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput } from '@astryxdesign/core/TimeInput';
import { useToast } from '@astryxdesign/core/Toast';
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton';
import { VStack } from '@astryxdesign/core/VStack';
import { CheckIcon } from '@heroicons/react/20/solid';
import {
  ACCESSORY_CODES,
  ACCESSORY_LABELS,
  CANCEL_REASONS,
  CANCEL_REASONS_REQUIRING_RETURN,
  CANCEL_REASON_LABELS,
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CancelTicketInput,
  ISSUE_LABELS,
  ISSUE_PRESETS_BY_DEVICE_TYPE,
  ReopenTicketInput,
  SECRET_LOCK_TYPES,
  STALE_TICKET_MESSAGE,
  TicketDetail,
  TimelineResponse,
  UpdateTicketInput,
  accessoriesSummary,
  allowedTargetStatuses,
  dueInputProblem,
  parseMajorAmount,
  ticketPath,
  type AccessoryCode,
  type CancelReason,
  type ChecklistItemKey,
  type ChecklistResult,
  type CurrencyCode,
  type IssueCode,
  type TicketPriority,
  type TicketStatus,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RovingGroup } from '@/components/ui/RovingGroup';
import { apiFetch } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { useAssignees } from '@/lib/sprint2-queries';
import { todayInZone, utcToZonedLocal } from '@/lib/timezone';

const CURRENCY_PREFIX = { GBP: '£', USD: '$', PKR: 'Rs' } as const;

function useTicketWrite(ticket: TicketDetail) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  return (detail: TicketDetail) => {
    queryClient.setQueryData(qk.ticket(shop.id, ticket.id), detail);
    void queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shop.id) });
  };
}

function Footer({
  onClose,
  label,
  isLoading,
  variant = 'primary',
}: {
  onClose: () => void;
  label: string;
  isLoading: boolean;
  variant?: 'primary' | 'destructive';
}) {
  return (
    <HStack gap={2} hAlign="end">
      <Button label="Close" variant="ghost" onClick={onClose} />
      <Button type="submit" label={label} variant={variant} isLoading={isLoading} />
    </HStack>
  );
}

// ---------- Assign ----------

export function AssignDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const { me } = useSession();
  const showToast = useToast();
  const write = useTicketWrite(ticket);
  const assignees = useAssignees();
  const [userId, setUserId] = useState<string>(ticket.assignee?.userId ?? '');
  const assign = useMutation({
    mutationFn: (id: string | null) =>
      apiFetch(ticketPath('assign', { id: ticket.id }), TicketDetail, {
        method: 'POST',
        json: { userId: id },
      }),
    onSuccess: (d) => {
      write(d);
      showToast({ body: d.assignee ? `Assigned to ${d.assignee.name}` : 'Unassigned' });
      onClose();
    },
  });
  const chosenName = assignees.data?.items.find((a) => a.userId === userId)?.name;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={480}>
      <DialogHeader title={`Assign ${ticket.numberLabel}`} onOpenChange={(o) => !o && onClose()} />
      <form
        noValidate
        aria-label={`Assign ${ticket.numberLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          assign.mutate(userId || null);
        }}
      >
        <VStack gap={5} padding={6}>
          {assign.isError && !hasErrorCode(assign.error, 'ASSIGNEE_NOT_ACTIVE') ? (
            <Banner
              status="error"
              title="Couldn't assign"
              description={errorMessage(assign.error)}
            />
          ) : null}
          <Selector
            label="Technician"
            hasSearch
            isLoading={assignees.isPending}
            value={userId}
            onChange={(v) => setUserId(v ?? '')}
            options={[
              { value: '', label: 'Unassigned' },
              ...(assignees.data?.items ?? []).map((a) => ({
                value: a.userId,
                label: a.isSelf ? `${a.name} (you)` : a.name,
                description: a.role === 'TECHNICIAN' ? 'Technician' : undefined,
              })),
            ]}
            status={
              hasErrorCode(assign.error, 'ASSIGNEE_NOT_ACTIVE')
                ? { type: 'error', message: errorMessage(assign.error, { name: chosenName }) }
                : undefined
            }
          />
          <HStack gap={2} hAlign="between" wrap="wrap">
            {ticket.assignee?.userId !== me.user.id ? (
              <Button
                label="Take it myself"
                variant="secondary"
                onClick={() => assign.mutate(me.user.id)}
              />
            ) : (
              <Text color="secondary">Assigned to you</Text>
            )}
            <Footer onClose={onClose} label="Save" isLoading={assign.isPending} />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

// ---------- Cancel ----------

export function CancelDialog({
  ticket,
  statuses,
  onClose,
}: {
  ticket: TicketDetail;
  statuses: readonly TicketStatus[];
  onClose: () => void;
}) {
  const { me } = useSession();
  const showToast = useToast();
  const write = useTicketWrite(ticket);
  const targets = allowedTargetStatuses(ticket.status, statuses, {
    permissions: me.permissions,
    via: 'cancel',
  });
  const defaultTarget = targets.find((s) => s.systemRole === 'CANCELLED') ?? targets[0];
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [note, setNote] = useState('');
  const [returned, setReturned] = useState(false);
  const [statusId, setStatusId] = useState(defaultTarget?.id ?? '');
  const [tried, setTried] = useState(false);
  const input = {
    statusId: statusId || undefined,
    reason: reason || undefined,
    note: note || null,
    returnedConfirmed: returned,
  };
  const parsed = CancelTicketInput.safeParse(input);
  const issue = (path: string) =>
    tried && !parsed.success
      ? parsed.error.issues.find((i) => i.path[0] === path)?.message
      : undefined;
  const cancel = useMutation({
    mutationFn: (body: CancelTicketInput) =>
      apiFetch(ticketPath('cancel', { id: ticket.id }), TicketDetail, {
        method: 'POST',
        json: body,
      }),
    onSuccess: (d) => {
      write(d);
      showToast({ body: `${d.numberLabel} cancelled` });
      onClose();
    },
  });
  const needsReturn = reason !== '' && CANCEL_REASONS_REQUIRING_RETURN.includes(reason);
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={560}>
      <DialogHeader title={`Cancel ${ticket.numberLabel}`} onOpenChange={(o) => !o && onClose()} />
      <form
        noValidate
        aria-label={`Cancel ${ticket.numberLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (parsed.success) cancel.mutate(input as CancelTicketInput);
        }}
      >
        <VStack gap={5} padding={6}>
          {cancel.isError ? (
            <Banner
              status="error"
              title="Couldn't cancel the ticket"
              description={errorMessage(cancel.error)}
            />
          ) : null}
          <FormLayout>
            <RadioList
              label="Reason"
              isRequired
              value={reason}
              onChange={(v) => setReason(v as CancelReason)}
              status={issue('reason') ? { type: 'error', message: 'Choose a reason' } : undefined}
            >
              {CANCEL_REASONS.map((r) => (
                <RadioListItem key={r} value={r} label={CANCEL_REASON_LABELS[r]} />
              ))}
            </RadioList>
            <TextArea
              label="Note"
              isOptional={reason !== 'OTHER'}
              isRequired={reason === 'OTHER'}
              rows={2}
              maxLength={200}
              value={note}
              onChange={setNote}
              status={issue('note') ? { type: 'error', message: issue('note') } : undefined}
            />
            {needsReturn ? (
              <CheckboxInput
                label={`Device and accessories returned to the customer (${accessoriesSummary(ticket.accessories, ticket.accessoriesOther)})`}
                value={returned}
                onChange={setReturned}
                isRequired
                status={
                  issue('returnedConfirmed')
                    ? { type: 'error', message: issue('returnedConfirmed') ?? '' }
                    : undefined
                }
              />
            ) : null}
            {targets.length > 1 ? (
              <Selector
                label="Close as"
                value={statusId}
                onChange={(v) => setStatusId(v ?? '')}
                options={targets.map((s) => ({ value: s.id, label: s.name }))}
              />
            ) : null}
          </FormLayout>
          <Footer
            onClose={onClose}
            label="Cancel ticket"
            variant="destructive"
            isLoading={cancel.isPending}
          />
        </VStack>
      </form>
    </Dialog>
  );
}

// ---------- Reopen ----------

export function ReopenDialog({
  ticket,
  statuses,
  onClose,
}: {
  ticket: TicketDetail;
  statuses: readonly TicketStatus[];
  onClose: () => void;
}) {
  const { me } = useSession();
  const showToast = useToast();
  const write = useTicketWrite(ticket);
  const targets = allowedTargetStatuses(ticket.status, statuses, {
    permissions: me.permissions,
    via: 'reopen',
    closedAt: ticket.closedAt,
  });
  const [statusId, setStatusId] = useState(
    targets.find((s) => s.id === ticket.statusBeforeClose?.id)?.id ?? targets[0]?.id ?? '',
  );
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const parsed = ReopenTicketInput.safeParse({ statusId: statusId || undefined, reason });
  const reopen = useMutation({
    mutationFn: (body: ReopenTicketInput) =>
      apiFetch(ticketPath('reopen', { id: ticket.id }), TicketDetail, {
        method: 'POST',
        json: body,
      }),
    onSuccess: (d) => {
      write(d);
      showToast({ body: `${d.numberLabel} reopened` });
      onClose();
    },
  });
  const passcodeGone =
    !ticket.device.passcodeOnFile && SECRET_LOCK_TYPES.includes(ticket.device.lockType);
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={520}>
      <DialogHeader title={`Reopen ${ticket.numberLabel}`} onOpenChange={(o) => !o && onClose()} />
      <form
        noValidate
        aria-label={`Reopen ${ticket.numberLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (parsed.success) reopen.mutate(parsed.data);
        }}
      >
        <VStack gap={5} padding={6}>
          {reopen.isError ? (
            <Banner
              status="error"
              title="Couldn't reopen the ticket"
              description={errorMessage(reopen.error)}
            />
          ) : null}
          {passcodeGone ? (
            <Banner
              status="info"
              title="The passcode was deleted when this ticket closed. Ask the customer for it again."
            />
          ) : null}
          <FormLayout>
            <Selector
              label="Reopen to"
              value={statusId}
              onChange={(v) => setStatusId(v ?? '')}
              options={targets.map((s) => ({ value: s.id, label: s.name }))}
            />
            <TextArea
              label="Reason"
              isRequired
              rows={2}
              maxLength={200}
              value={reason}
              onChange={setReason}
              status={
                tried && !parsed.success
                  ? { type: 'error', message: parsed.error.issues[0]?.message ?? 'Give a reason' }
                  : undefined
              }
            />
          </FormLayout>
          <Footer onClose={onClose} label="Reopen ticket" isLoading={reopen.isPending} />
        </VStack>
      </form>
    </Dialog>
  );
}

// ---------- Edit details ----------

interface IntakeForm {
  issues: IssueCode[];
  customIssues: string[];
  description: string;
  checklist: Record<string, ChecklistResult>;
  conditionNotes: string;
  accessories: AccessoryCode[];
  accessoriesOther: string;
  estimate: string;
  dueDate: string;
  dueTime: string;
  priority: TicketPriority;
}

function majorText(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined) return '';
  return currency === 'PKR'
    ? String(Math.round(amountMinor / 100))
    : (amountMinor / 100).toFixed(2);
}

function formFrom(t: TicketDetail, timezone: string): IntakeForm {
  const local = utcToZonedLocal(t.dueAt, timezone);
  return {
    issues: t.issues.filter((i) => i.code).map((i) => i.code as IssueCode),
    customIssues: t.issues.filter((i) => !i.code).map((i) => i.label),
    description: t.description ?? '',
    checklist: { ...t.checklist },
    conditionNotes: t.conditionNotes ?? '',
    accessories: [...t.accessories],
    accessoriesOther: t.accessoriesOther ?? '',
    estimate: majorText(t.estimate?.amountMinor, t.estimate?.currency ?? ''),
    dueDate: local.slice(0, 10),
    dueTime: t.dueHasTime ? local.slice(11, 16) : '',
    priority: t.priority,
  };
}

/** Only what changed, with the version (PATCH /api/tickets/:id). */
export function intakeChanges(
  t: TicketDetail,
  f: IntakeForm,
  timezone: string,
  currency: CurrencyCode,
): UpdateTicketInput {
  const before = formFrom(t, timezone);
  const out: UpdateTicketInput = { version: t.version };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.issues, f.issues) || !same(before.customIssues, f.customIssues)) {
    out.issues = [
      ...f.issues.map((code) => ({ code })),
      ...f.customIssues.map((label) => ({ label })),
    ];
  }
  if (before.description !== f.description) out.description = f.description.trim() || null;
  const checklist: Record<string, ChecklistResult> = {};
  for (const [k, v] of Object.entries(f.checklist)) if (before.checklist[k] !== v) checklist[k] = v;
  if (Object.keys(checklist).length)
    out.checklist = checklist as Record<ChecklistItemKey, ChecklistResult>;
  if (before.conditionNotes !== f.conditionNotes)
    out.conditionNotes = f.conditionNotes.trim() || null;
  if (!same(before.accessories, f.accessories)) out.accessories = f.accessories;
  if (
    before.accessoriesOther !== f.accessoriesOther ||
    (!same(before.accessories, f.accessories) && f.accessories.includes('OTHER'))
  ) {
    out.accessoriesOther = f.accessoriesOther.trim() || null;
  }
  if (before.estimate !== f.estimate) {
    const minor = f.estimate.trim() ? parseMajorAmount(f.estimate, currency) : null;
    out.estimate = minor === null ? null : { amountMinor: minor, currency };
  }
  if (before.dueDate !== f.dueDate || before.dueTime !== f.dueTime) {
    out.dueDate = f.dueDate;
    out.dueTime = f.dueTime || null;
  }
  if (before.priority !== f.priority) out.priority = f.priority;
  return out;
}

export function EditDetailsDialog({
  ticket,
  onClose,
}: {
  ticket: TicketDetail;
  onClose: () => void;
}) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const write = useTicketWrite(ticket);
  const [form, setForm] = useState<IntakeForm>(() => formFrom(ticket, shop.timezone));
  const [stale, setStale] = useState<string | null>(null);
  const set = (patch: Partial<IntakeForm>) => setForm((f) => ({ ...f, ...patch }));
  const presets = ISSUE_PRESETS_BY_DEVICE_TYPE[ticket.device.type];
  const items = CHECKLIST_ITEMS_BY_DEVICE_TYPE[ticket.device.type];
  const today = todayInZone(shop.timezone);
  const dueProblem = dueInputProblem(form.dueDate, form.dueTime || null, new Date(), shop.timezone);
  const estimateBad =
    form.estimate.trim() !== '' && parseMajorAmount(form.estimate, shop.currency) === null;

  const save = useMutation({
    mutationFn: (body: UpdateTicketInput) =>
      apiFetch(ticketPath('detail', { id: ticket.id }), TicketDetail, {
        method: 'PATCH',
        json: body,
      }),
    onSuccess: (d) => {
      write(d);
      showToast({ body: 'Ticket saved' });
      onClose();
    },
    onError: async (err) => {
      if (!hasErrorCode(err, 'STALE_RECORD')) return;
      // "This ticket was changed by X": the newest timeline item says who.
      let who: string | null = null;
      try {
        const latest = await apiFetch(
          `${ticketPath('timeline', { id: ticket.id })}?filter=all&limit=1`,
          TimelineResponse,
        );
        who = latest.items[latest.items.length - 1]?.actor?.name ?? null;
      } catch {
        who = null;
      }
      setStale(who ? `This ticket was changed by ${who}.` : STALE_TICKET_MESSAGE);
    },
  });

  const submit = () => {
    if (dueProblem || estimateBad) return;
    const body = intakeChanges(ticket, form, shop.timezone, shop.currency);
    const parsed = UpdateTicketInput.safeParse(body);
    if (!parsed.success) {
      showToast({ body: parsed.error.issues[0]?.message ?? 'Check the details', type: 'error' });
      return;
    }
    if (Object.keys(body).length === 1) {
      onClose();
      return;
    }
    save.mutate(body);
  };

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={640}>
      <DialogHeader title={`Edit ${ticket.numberLabel}`} onOpenChange={(o) => !o && onClose()} />
      <form
        noValidate
        aria-label={`Edit ${ticket.numberLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <VStack gap={5} padding={6}>
          {stale ? (
            <Banner
              status="warning"
              title={stale}
              description="Your changes are kept. Reload to see theirs, then save again."
              endContent={
                <Button
                  label="Reload"
                  size="sm"
                  onClick={async () => {
                    await queryClient.refetchQueries({ queryKey: qk.ticket(shop.id, ticket.id) });
                    setStale(null);
                    save.reset();
                  }}
                />
              }
            />
          ) : save.isError ? (
            <Banner status="error" title="Couldn't save" description={errorMessage(save.error)} />
          ) : null}
          <FormLayout>
            <RovingGroup>
              <ToggleButtonGroup
                label="Issues"
                type="multiple"
                size="sm"
                value={form.issues}
                onChange={(v) => set({ issues: ((v as string[]) ?? []) as IssueCode[] })}
              >
                {presets.map((code) => (
                  <ToggleButton
                    key={code}
                    value={code}
                    label={ISSUE_LABELS[code]}
                    pressedIcon={<Icon icon={CheckIcon} size="sm" />}
                  >
                    {ISSUE_LABELS[code]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </RovingGroup>
            {form.customIssues.length ? (
              <Text type="supporting" color="secondary">
                Also: {form.customIssues.join(', ')}
              </Text>
            ) : null}
            <TextArea
              label="Describe the problem"
              isOptional
              rows={2}
              maxLength={1000}
              value={form.description}
              onChange={(description) => set({ description })}
            />
            <VStack gap={1}>
              <Text weight="medium">Pre-repair checklist</Text>
              {items.map((item) => (
                <HStack key={item.key} gap={3} vAlign="center" hAlign="between">
                  <Text>{item.label}</Text>
                  <SegmentedControl
                    label={item.label}
                    size="sm"
                    value={form.checklist[item.key] ?? 'UNTESTED'}
                    onChange={(v) =>
                      set({ checklist: { ...form.checklist, [item.key]: v as ChecklistResult } })
                    }
                  >
                    <SegmentedControlItem value="PASS" label="Pass" />
                    <SegmentedControlItem value="FAIL" label="Fail" />
                    <SegmentedControlItem value="UNTESTED" label="Untested" />
                  </SegmentedControl>
                </HStack>
              ))}
            </VStack>
            <TextArea
              label="Condition notes"
              isOptional
              rows={2}
              maxLength={1000}
              value={form.conditionNotes}
              onChange={(conditionNotes) => set({ conditionNotes })}
            />
            <RovingGroup>
              <ToggleButtonGroup
                label="Accessories left"
                type="multiple"
                size="sm"
                value={form.accessories}
                onChange={(v) => set({ accessories: ((v as string[]) ?? []) as AccessoryCode[] })}
              >
                {ACCESSORY_CODES.map((a) => (
                  <ToggleButton
                    key={a}
                    value={a}
                    label={ACCESSORY_LABELS[a]}
                    pressedIcon={<Icon icon={CheckIcon} size="sm" />}
                  >
                    {ACCESSORY_LABELS[a]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </RovingGroup>
            {form.accessories.includes('OTHER') ? (
              <TextInput
                label="What else?"
                value={form.accessoriesOther}
                onChange={(accessoriesOther) => set({ accessoriesOther })}
              />
            ) : null}
            <Grid columns={{ minWidth: 200, max: 2 }} gap={4}>
              <InputGroup
                label="Estimate (approximate)"
                isOptional
                description={ticket.estimateIncludesTax ? 'incl. tax' : 'excl. tax'}
                status={estimateBad ? { type: 'error', message: 'Enter an amount' } : undefined}
              >
                <InputGroupText>{CURRENCY_PREFIX[shop.currency]}</InputGroupText>
                <TextInput
                  label="Amount"
                  isLabelHidden
                  inputMode="decimal"
                  value={form.estimate}
                  onChange={(estimate) => set({ estimate })}
                />
              </InputGroup>
              <VStack gap={2}>
                <Text weight="medium">Priority</Text>
                <SegmentedControl
                  label="Priority"
                  value={form.priority}
                  onChange={(v) => set({ priority: v as TicketPriority })}
                >
                  <SegmentedControlItem value="NORMAL" label="Normal" />
                  <SegmentedControlItem value="URGENT" label="Urgent" />
                </SegmentedControl>
              </VStack>
              <DateInput
                label="Due"
                value={form.dueDate as ISODateString}
                onChange={(v) => v && set({ dueDate: v })}
                min={today as ISODateString}
                presentation="popover"
                status={dueProblem ? { type: 'error', message: dueProblem } : undefined}
              />
              <TimeInput
                label="Due time"
                isOptional
                hasClear
                increment={15}
                value={(form.dueTime || undefined) as never}
                onChange={(v) => set({ dueTime: v ?? '' })}
              />
            </Grid>
          </FormLayout>
          <Footer onClose={onClose} label="Save changes" isLoading={save.isPending} />
        </VStack>
      </form>
    </Dialog>
  );
}
