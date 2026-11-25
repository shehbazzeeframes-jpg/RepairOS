'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Switch } from '@astryxdesign/core/Switch';
import { Table } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { PlusIcon } from '@heroicons/react/24/outline';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreateTaxRateInput,
  RatePercentInput,
  TAX_APPLIES_TO_LABELS,
  TaxAppliesTo,
  TaxRate,
  TaxSettings,
  UpdateTaxRateInput,
  canBeDefaultFor,
  formatRate,
  type CountryCode,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { FormSelector, FormTextInput } from '@/components/form';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission, useCan } from '@/components/RequirePermission';
import { apiFetch } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { meQueryKey } from '@/lib/me';
import { qk, useShopSettings, useTaxRates } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';

const MARKET_HINT: Record<CountryCode, string> = {
  GB: 'UK shops usually show prices including VAT.',
  US: 'US shops usually add sales tax at checkout, so prices exclude it.',
  PK: 'Pakistani shops usually show prices before GST.',
};

const RateForm = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(40, 'Use 40 characters or fewer'),
  rate: RatePercentInput,
  appliesTo: TaxAppliesTo,
  isDefaultGoods: z.boolean(),
  isDefaultServices: z.boolean(),
});
type RateFormInput = z.input<typeof RateForm>;
type RateFormOutput = z.output<typeof RateForm>;

function useInvalidateTax() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: qk.taxRatesAll });
}

function RateDialog({
  rate,
  isOpen,
  onClose,
  locale,
}: {
  /** null = add */
  rate: TaxRate | null;
  isOpen: boolean;
  onClose: () => void;
  locale: string;
}) {
  const showToast = useToast();
  const invalidate = useInvalidateTax();
  const { control, handleSubmit, setError } = useForm<RateFormInput, unknown, RateFormOutput>({
    resolver: zodResolver(RateForm) as unknown as Resolver<RateFormInput, unknown, RateFormOutput>,
    defaultValues: rate
      ? {
          name: rate.name,
          rate: formatRate(rate.rateMilliPct, 'en-US').replace(/[%,\s]/g, ''),
          appliesTo: rate.appliesTo,
          isDefaultGoods: rate.isDefaultGoods,
          isDefaultServices: rate.isDefaultServices,
        }
      : { name: '', rate: '', appliesTo: 'all', isDefaultGoods: false, isDefaultServices: false },
  });
  const appliesTo = useWatch({ control, name: 'appliesTo' });

  const save = useMutation({
    mutationFn: (values: RateFormOutput) => {
      if (!rate) {
        const input = CreateTaxRateInput.parse({
          name: values.name,
          rateMilliPct: values.rate,
          appliesTo: values.appliesTo,
          ...(values.isDefaultGoods ? { isDefaultGoods: true } : {}),
          ...(values.isDefaultServices ? { isDefaultServices: true } : {}),
        });
        return apiFetch('/api/shop/tax-rates', TaxRate, { method: 'POST', json: input });
      }
      const input = UpdateTaxRateInput.parse({
        ...(values.name !== rate.name ? { name: values.name } : {}),
        ...(values.rate !== rate.rateMilliPct ? { rateMilliPct: values.rate } : {}),
        ...(values.appliesTo !== rate.appliesTo ? { appliesTo: values.appliesTo } : {}),
        ...(values.isDefaultGoods && !rate.isDefaultGoods ? { isDefaultGoods: true } : {}),
        ...(values.isDefaultServices && !rate.isDefaultServices ? { isDefaultServices: true } : {}),
      });
      return apiFetch(`/api/shop/tax-rates/${rate.id}`, TaxRate, { method: 'PATCH', json: input });
    },
    onSuccess: async (saved) => {
      showToast({ body: rate ? `${saved.name} updated` : `${saved.name} added` });
      onClose();
      await invalidate();
    },
    onError: (err) => {
      if (hasErrorCode(err, 'TAX_RATE_NAME_TAKEN')) {
        setError('name', { type: 'server', message: errorMessage(err) });
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    if (rate) {
      const unchanged =
        values.name === rate.name &&
        values.rate === rate.rateMilliPct &&
        values.appliesTo === rate.appliesTo &&
        values.isDefaultGoods === rate.isDefaultGoods &&
        values.isDefaultServices === rate.isDefaultServices;
      if (unchanged) return onClose();
    }
    save.mutate(values);
  });

  const defaultBox = (kind: 'goods' | 'services') => {
    const name = kind === 'goods' ? 'isDefaultGoods' : 'isDefaultServices';
    const isCurrent = rate
      ? kind === 'goods'
        ? rate.isDefaultGoods
        : rate.isDefaultServices
      : false;
    const compatible = canBeDefaultFor(appliesTo, kind);
    return (
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <CheckboxInput
            label={kind === 'goods' ? 'Default for goods' : 'Default for services'}
            description={
              isCurrent
                ? 'To move the default, make another rate the default.'
                : kind === 'goods'
                  ? 'New parts and accessories use this rate.'
                  : 'New repair services use this rate.'
            }
            value={compatible && field.value}
            onChange={(checked) => field.onChange(checked)}
            isDisabled={isCurrent || !compatible}
            disabledMessage={
              !compatible
                ? `A ${appliesTo} rate can't be the ${kind} default.`
                : 'This rate is already the default.'
            }
          />
        )}
      />
    );
  };

  const nonApiValidation = save.isError && !hasErrorCode(save.error, 'TAX_RATE_NAME_TAKEN');

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && onClose()} purpose="form" width={480}>
      <DialogHeader
        title={rate ? `Edit ${rate.name}` : 'Add tax rate'}
        subtitle={
          rate
            ? 'Changes apply to new sales only. Past invoices keep the rate they were charged at.'
            : undefined
        }
        onOpenChange={(open) => !open && onClose()}
      />
      <form onSubmit={onSubmit} noValidate aria-label={rate ? 'Edit tax rate' : 'Add tax rate'}>
        <VStack gap={5} padding={6}>
          {nonApiValidation ? (
            <Banner status="error" title="Could not save" description={errorMessage(save.error)} />
          ) : null}
          <FormLayout defaultOptionality="required">
            <FormTextInput control={control} name="name" label="Name" hasAutoFocus />
            <FormTextInput
              control={control}
              name="rate"
              label="Rate (%)"
              inputMode="decimal"
              placeholder="e.g. 8.875"
              description={`Up to 3 decimals, e.g. ${formatRate(8875, locale)}.`}
            />
            <FormSelector
              control={control}
              name="appliesTo"
              label="Applies to"
              options={TaxAppliesTo.options.map((v) => ({
                value: v,
                label: TAX_APPLIES_TO_LABELS[v],
              }))}
            />
            {defaultBox('goods')}
            {defaultBox('services')}
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={save.isPending ? 'Saving…' : rate ? 'Save rate' : 'Add rate'}
              isLoading={save.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

function PricesIncludeTax({ value, country }: { value: boolean; country: CountryCode }) {
  const canManage = useCan()('tax.manage');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const update = useMutation({
    mutationFn: (pricesIncludeTax: boolean) =>
      apiFetch('/api/shop/tax-settings', TaxSettings, {
        method: 'PATCH',
        json: { pricesIncludeTax },
      }),
    onSuccess: async (saved) => {
      setConfirming(null);
      showToast({
        body: saved.pricesIncludeTax ? 'Prices now include tax' : 'Prices now exclude tax',
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.shopSettings }),
        queryClient.invalidateQueries({ queryKey: meQueryKey }),
      ]);
    },
    onError: (err) => {
      setConfirming(null);
      showToast({ body: errorMessage(err), type: 'error' });
    },
  });

  return (
    <>
      <Switch
        label="Prices include tax"
        description={`${MARKET_HINT[country]} Turn this on if the prices you enter already contain tax.`}
        value={value}
        isLoading={update.isPending}
        isDisabled={!canManage}
        disabledMessage="Your role can't change tax settings."
        onChange={(next) => setConfirming(next)}
      />
      <AlertDialog
        isOpen={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? 'Show prices including tax?' : 'Show prices excluding tax?'}
        description="This changes how prices are entered and shown from now on. Past sales don't change."
        actionLabel="Change setting"
        actionVariant="primary"
        isActionLoading={update.isPending}
        onAction={() => confirming !== null && update.mutate(confirming)}
      />
    </>
  );
}

function RatesTable({ showArchived, locale }: { showArchived: boolean; locale: string }) {
  const canManage = useCan()('tax.manage');
  const query = useTaxRates(showArchived);
  const invalidate = useInvalidateTax();
  const showToast = useToast();
  const [editing, setEditing] = useState<TaxRate | 'new' | null>(null);
  const [archiving, setArchiving] = useState<TaxRate | null>(null);

  const action = useMutation({
    mutationFn: ({
      rate,
      kind,
    }: {
      rate: TaxRate;
      kind: 'archive' | 'restore' | 'goods' | 'services';
    }) =>
      kind === 'archive' || kind === 'restore'
        ? apiFetch(`/api/shop/tax-rates/${rate.id}/${kind}`, TaxRate, { method: 'POST' })
        : apiFetch(`/api/shop/tax-rates/${rate.id}`, TaxRate, {
            method: 'PATCH',
            json: kind === 'goods' ? { isDefaultGoods: true } : { isDefaultServices: true },
          }),
    onSuccess: async (saved, { kind }) => {
      setArchiving(null);
      const verb = {
        archive: 'archived',
        restore: 'restored',
        goods: 'is now the goods default',
        services: 'is now the services default',
      }[kind];
      showToast({ body: `${saved.name} ${verb}` });
      await invalidate();
    },
    onError: (err) => {
      setArchiving(null);
      showToast({ body: errorMessage(err), type: 'error' });
    },
  });

  if (query.isPending) return <RowsSkeleton rows={3} label="Loading tax rates" />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  const rates = query.data.items;
  return (
    <VStack gap={3}>
      <Table
        data={rates}
        idKey="id"
        textOverflow="truncate"
        emptyState={false}
        columns={[
          {
            key: 'name',
            header: 'Name',
            renderCell: (r) => (
              <Text weight="medium" color={r.archivedAt ? 'secondary' : undefined}>
                {r.name}
              </Text>
            ),
          },
          {
            key: 'rate',
            header: 'Rate',
            width: { type: 'pixel', value: 110 },
            align: 'end',
            renderCell: (r) => <Text hasTabularNumbers>{formatRate(r.rateMilliPct, locale)}</Text>,
          },
          {
            key: 'appliesTo',
            header: 'Applies to',
            renderCell: (r) => TAX_APPLIES_TO_LABELS[r.appliesTo],
          },
          {
            key: 'defaults',
            header: 'Default',
            renderCell: (r) => (
              <HStack gap={1} wrap="wrap">
                {r.archivedAt ? <Badge label="Archived" /> : null}
                {r.isDefaultGoods ? <Badge variant="info" label="Goods default" /> : null}
                {r.isDefaultServices ? <Badge variant="info" label="Services default" /> : null}
              </HStack>
            ),
          },
          ...(canManage
            ? [
                {
                  key: 'actions',
                  header: <VisuallyHidden>Actions</VisuallyHidden>,
                  width: { type: 'pixel' as const, value: 64 },
                  align: 'end' as const,
                  renderCell: (r: TaxRate) => (
                    <MoreMenu
                      label={`Actions for ${r.name}`}
                      alignment="end"
                      items={
                        r.archivedAt
                          ? [
                              {
                                label: 'Restore',
                                onClick: () => action.mutate({ rate: r, kind: 'restore' }),
                              },
                            ]
                          : [
                              { label: 'Edit', onClick: () => setEditing(r) },
                              ...(!r.isDefaultGoods && canBeDefaultFor(r.appliesTo, 'goods')
                                ? [
                                    {
                                      label: 'Make goods default',
                                      onClick: () =>
                                        action.mutate({ rate: r, kind: 'goods' as const }),
                                    },
                                  ]
                                : []),
                              ...(!r.isDefaultServices && canBeDefaultFor(r.appliesTo, 'services')
                                ? [
                                    {
                                      label: 'Make services default',
                                      onClick: () =>
                                        action.mutate({ rate: r, kind: 'services' as const }),
                                    },
                                  ]
                                : []),
                              { type: 'divider' as const },
                              {
                                label: 'Archive…',
                                variant: 'destructive' as const,
                                onClick: () => setArchiving(r),
                              },
                            ]
                      }
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      {canManage ? (
        <HStack>
          <Button
            label="Add tax rate"
            variant="primary"
            icon={<Icon icon={PlusIcon} />}
            onClick={() => setEditing('new')}
          />
        </HStack>
      ) : null}
      {editing !== null ? (
        <RateDialog
          key={editing === 'new' ? 'new' : editing.id}
          rate={editing === 'new' ? null : editing}
          isOpen
          locale={locale}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <AlertDialog
        isOpen={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? 'rate'}?`}
        description="It won't be offered for new items or sales. Past records keep it, and you can restore it later."
        actionLabel="Archive"
        isActionLoading={action.isPending}
        onAction={() => archiving && action.mutate({ rate: archiving, kind: 'archive' })}
      />
    </VStack>
  );
}

function TaxSettingsPage() {
  const { shop } = useSession();
  const settings = useShopSettings();
  const [showArchived, setShowArchived] = useState(false);

  return (
    <>
      <title>Tax settings · RepairOS</title>
      <PageIntro
        title="Tax"
        description="How prices handle tax, and the rates your shop charges."
      />
      <VStack gap={4} maxWidth={640}>
        {settings.isPending ? (
          <RowsSkeleton rows={1} label="Loading tax settings" />
        ) : settings.isError ? (
          <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <PricesIncludeTax value={settings.data.shop.pricesIncludeTax} country={shop.country} />
        )}
      </VStack>
      <VStack gap={4}>
        <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={2}>Tax rates</Heading>
          <Switch
            label="Show archived"
            size="sm"
            labelPosition="start"
            value={showArchived}
            onChange={setShowArchived}
          />
        </HStack>
        <Banner
          status="info"
          title="Editing never changes past records"
          description="Every sale keeps the tax rate name and percentage it was charged at. Changes and archiving apply to new sales only."
        />
        <RatesTable showArchived={showArchived} locale={shop.locale} />
      </VStack>
    </>
  );
}

export default function TaxPage() {
  return (
    <RequirePermission permission="settings.view">
      <TaxSettingsPage />
    </RequirePermission>
  );
}
