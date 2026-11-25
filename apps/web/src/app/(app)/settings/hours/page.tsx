'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TimeInput } from '@astryxdesign/core/TimeInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  BusinessHoursResponse,
  UpdateBusinessHoursInput,
  WEEKDAY_LABELS,
  weekdayDisplayOrder,
  type BusinessHoursWeek,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { errorStatus } from '@/components/form';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission, useCan } from '@/components/RequirePermission';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { qk, useShopSettings } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { hourFormatFor } from '@/lib/timezone';

type HoursInput = z.input<typeof UpdateBusinessHoursInput>;
type HoursOutput = z.output<typeof UpdateBusinessHoursInput>;
type TimeValue = Parameters<typeof TimeInput>[0]['value'];

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

function HoursEditor({ week }: { week: BusinessHoursWeek }) {
  const { shop } = useSession();
  const canManage = useCan()('settings.manage');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const hourFormat = hourFormatFor(shop.locale);

  const {
    control,
    handleSubmit,
    reset,
    getValues,
    setValue,
    formState: { isDirty },
  } = useForm<HoursInput, unknown, HoursOutput>({
    resolver: zodResolver(UpdateBusinessHoursInput) as unknown as Resolver<
      HoursInput,
      unknown,
      HoursOutput
    >,
    defaultValues: { days: week },
  });
  const days = useWatch({ control, name: 'days' });

  const save = useMutation({
    mutationFn: (input: HoursOutput) =>
      apiFetch('/api/shop/hours', BusinessHoursResponse, { method: 'PUT', json: input }),
    onSuccess: async (saved) => {
      reset({ days: saved.days });
      showToast({ body: 'Business hours saved' });
      await queryClient.invalidateQueries({ queryKey: qk.shopSettings(shop.id) });
    },
  });

  const copyMonday = () => {
    const monday = getValues('days.1');
    for (const d of WEEKDAYS.slice(1)) {
      setValue(`days.${d}.isOpen`, monday.isOpen, { shouldDirty: true });
      setValue(`days.${d}.opensAt`, monday.opensAt ?? '10:00', { shouldDirty: true });
      setValue(`days.${d}.closesAt`, monday.closesAt ?? '19:00', { shouldDirty: true });
    }
  };

  const onSubmit = handleSubmit((values) => save.mutate(values));
  const order = weekdayDisplayOrder(shop.country);

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Business hours">
      <VStack gap={5} maxWidth={640}>
        {save.isError ? (
          <Banner
            status="error"
            title="Could not save hours"
            description={errorMessage(save.error)}
          />
        ) : null}
        {canManage ? (
          <HStack>
            <Button
              label="Copy Monday to all weekdays"
              variant="secondary"
              size="sm"
              onClick={copyMonday}
            />
          </HStack>
        ) : null}
        <VStack gap={0}>
          {order.map((weekday, i) => {
            const day = days[weekday];
            const label = WEEKDAY_LABELS[weekday];
            return (
              <Fragment key={weekday}>
                {i > 0 ? <Divider /> : null}
                <HStack gap={4} vAlign="start" paddingBlock={3} wrap="wrap">
                  <HStack gap={3} vAlign="center" width={200} minHeight={36}>
                    <Controller
                      control={control}
                      name={`days.${weekday}.isOpen`}
                      render={({ field }) => (
                        <Switch
                          label={`${label} open`}
                          isLabelHidden
                          value={field.value}
                          isDisabled={!canManage}
                          onChange={(open) => {
                            field.onChange(open);
                            if (open && !getValues(`days.${weekday}.opensAt`)) {
                              setValue(`days.${weekday}.opensAt`, '10:00');
                              setValue(`days.${weekday}.closesAt`, '19:00');
                            }
                          }}
                        />
                      )}
                    />
                    <Text weight="semibold">{label}</Text>
                  </HStack>
                  {day?.isOpen ? (
                    <HStack gap={3} vAlign="start">
                      {(['opensAt', 'closesAt'] as const).map((key) => (
                        <Fragment key={key}>
                          {key === 'closesAt' ? (
                            <HStack minHeight={36} vAlign="center">
                              <Text color="secondary">to</Text>
                            </HStack>
                          ) : null}
                          <Controller
                            control={control}
                            name={`days.${weekday}.${key}`}
                            render={({ field, fieldState }) => (
                              <TimeInput
                                label={`${label} ${key === 'opensAt' ? 'opens' : 'closes'}`}
                                isLabelHidden
                                width={150}
                                increment={15}
                                hourFormat={hourFormat}
                                presentation="text-input"
                                isDisabled={!canManage}
                                value={(field.value ?? undefined) as TimeValue}
                                onChange={(v) => field.onChange(v ?? null)}
                                status={errorStatus(fieldState.error?.message)}
                              />
                            )}
                          />
                        </Fragment>
                      ))}
                    </HStack>
                  ) : (
                    <HStack minHeight={36} vAlign="center">
                      <Text color="secondary">Closed</Text>
                    </HStack>
                  )}
                </HStack>
              </Fragment>
            );
          })}
        </VStack>
        {canManage ? (
          <HStack gap={2}>
            <Button
              type="submit"
              variant="primary"
              label={save.isPending ? 'Saving…' : 'Save hours'}
              isLoading={save.isPending}
              isDisabled={!isDirty}
            />
            <Button
              label="Discard"
              variant="ghost"
              isDisabled={!isDirty || save.isPending}
              onClick={() => reset({ days: week })}
            />
          </HStack>
        ) : null}
      </VStack>
    </form>
  );
}

function BusinessHours() {
  const query = useShopSettings();
  return (
    <>
      <title>Business hours · RepairOS</title>
      <PageIntro
        title="Business hours"
        description="When your shop is open. Shown on receipts and used for bookings later."
      />
      {query.isPending ? (
        <RowsSkeleton rows={7} label="Loading business hours" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <HoursEditor key={query.data.shop.updatedAt} week={query.data.hours} />
      )}
    </>
  );
}

export default function HoursPage() {
  return (
    <RequirePermission permission="settings.view">
      <BusinessHours />
    </RequirePermission>
  );
}
