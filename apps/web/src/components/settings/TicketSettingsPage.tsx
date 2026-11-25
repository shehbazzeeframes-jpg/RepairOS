'use client';

/* Settings → Tickets (spec §8.2): turnaround, number prefix + next number, passcode deletion on close. */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  MAX_TURNAROUND_DAYS,
  TICKET_SETTINGS_PATH,
  TicketNumberPrefix,
  TicketSettings,
  formatTicketNumber,
  isValidNextNumber,
  type UpdateTicketSettingsInput,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { useCan } from '@/components/RequirePermission';
import { apiFetch } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { useTicketSettings } from '@/lib/sprint2-queries';

function Editor({ settings }: { settings: TicketSettings }) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const isReadOnly = !useCan()('settings.manage');
  const [turnaround, setTurnaround] = useState(settings.defaultTurnaroundDays);
  const [prefix, setPrefix] = useState(settings.numberPrefix);
  const [next, setNext] = useState(settings.nextNumber);
  const [deletePasscode, setDeletePasscode] = useState(settings.deletePasscodeOnClose);
  const prefixCheck = TicketNumberPrefix.safeParse(prefix);
  const nextOk = isValidNextNumber(next, settings.highestUsedNumber);
  const lowMessage = `The next number must be higher than ${settings.highestUsedNumber ?? 0}, the highest number used.`;

  const body: UpdateTicketSettingsInput = {};
  if (turnaround !== settings.defaultTurnaroundDays) body.defaultTurnaroundDays = turnaround;
  if (prefixCheck.success && prefixCheck.data !== settings.numberPrefix)
    body.numberPrefix = prefixCheck.data;
  if (next !== settings.nextNumber) body.nextNumber = next;
  if (deletePasscode !== settings.deletePasscodeOnClose)
    body.deletePasscodeOnClose = deletePasscode;

  const save = useMutation({
    mutationFn: () =>
      apiFetch(TICKET_SETTINGS_PATH, TicketSettings, { method: 'PATCH', json: body }),
    onSuccess: (s) => {
      queryClient.setQueryData(qk.ticketSettings(shop.id), s);
      void queryClient.invalidateQueries({ queryKey: qk.checkInContext(shop.id) });
      void queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shop.id) });
      showToast({ body: 'Ticket settings saved' });
    },
  });

  return (
    <form
      noValidate
      aria-label="Ticket settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (!prefixCheck.success || !nextOk || Object.keys(body).length === 0) return;
        save.mutate();
      }}
    >
      <VStack gap={5} maxWidth={640}>
        {save.isError && !hasErrorCode(save.error, 'TICKET_NUMBER_TOO_LOW') ? (
          <Banner status="error" title="Couldn't save" description={errorMessage(save.error)} />
        ) : null}
        <FormLayout>
          <NumberInput
            label="Default turnaround"
            description="Counted in open days from your business hours. 0 = same day."
            units="open days"
            min={0}
            max={MAX_TURNAROUND_DAYS}
            isIntegerOnly
            value={turnaround}
            onChange={setTurnaround}
            isReadOnly={isReadOnly}
            width={220}
          />
          <TextInput
            label="Ticket number prefix"
            description="Changing the prefix changes how every ticket is shown; numbers stay."
            value={prefix}
            onChange={(v) => setPrefix(v.toUpperCase())}
            isReadOnly={isReadOnly}
            width={220}
            status={
              !prefixCheck.success
                ? { type: 'error', message: prefixCheck.error.issues[0]?.message }
                : undefined
            }
          />
          <NumberInput
            label="Next ticket number"
            min={(settings.highestUsedNumber ?? 0) + 1}
            isIntegerOnly
            value={next}
            onChange={setNext}
            isReadOnly={isReadOnly}
            width={220}
            status={
              !nextOk || hasErrorCode(save.error, 'TICKET_NUMBER_TOO_LOW')
                ? {
                    type: 'error',
                    message: hasErrorCode(save.error, 'TICKET_NUMBER_TOO_LOW')
                      ? errorMessage(save.error, {
                          highest: String(settings.highestUsedNumber ?? 0),
                        })
                      : lowMessage,
                  }
                : undefined
            }
          />
          <Text color="secondary" aria-live="polite">
            Next ticket: {formatTicketNumber(prefixCheck.success ? prefixCheck.data : prefix, next)}
          </Text>
          <Switch
            label="Delete passcode when the repair is closed"
            description="Recommended. Passcodes are kept only while a repair is open."
            value={deletePasscode}
            onChange={setDeletePasscode}
            isDisabled={isReadOnly}
          />
        </FormLayout>
        {isReadOnly ? (
          <Text color="secondary">Only owners and managers can change these settings.</Text>
        ) : (
          <HStack>
            <Button
              type="submit"
              variant="primary"
              label="Save changes"
              isLoading={save.isPending}
              isDisabled={Object.keys(body).length === 0}
            />
          </HStack>
        )}
      </VStack>
    </form>
  );
}

export function TicketSettingsPage() {
  const query = useTicketSettings();
  return (
    <VStack gap={5}>
      <title>Ticket settings · RepairOS</title>
      <PageIntro
        title="Tickets"
        description="Numbering, default due dates and passcode handling."
      />
      {query.isPending ? (
        <RowsSkeleton rows={4} label="Loading ticket settings" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Editor key={query.data.updatedAt} settings={query.data} />
      )}
    </VStack>
  );
}
