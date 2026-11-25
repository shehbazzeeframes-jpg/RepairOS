'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CITY_LABELS,
  PK_PROVINCES,
  POSTCODE_LABELS,
  REGION_LABELS,
  ShopProfile,
  TIMEZONES_BY_COUNTRY,
  US_STATES,
  formatPhone,
  shopProfileSchema,
  timezoneLabel,
  type CountryCode,
  type UpdateShopProfileInput,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { FormSelector, FormTextInput, applyApiIssues } from '@/components/form';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission, useCan } from '@/components/RequirePermission';
import { apiFetch, isApiRequestError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { countryLabel } from '@/lib/markets';
import { meQueryKey } from '@/lib/me';
import { qk, useShopSettings } from '@/lib/queries';

interface ProfileForm {
  name: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postcode: string;
  timezone: string;
}

const FIELDS = [
  'name',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postcode',
  'timezone',
] as const;

const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function toForm(shop: ShopProfile): ProfileForm {
  return {
    name: shop.name,
    phone: shop.phone ? formatPhone(shop.phone, shop.country) : '',
    addressLine1: shop.addressLine1 ?? '',
    addressLine2: shop.addressLine2 ?? '',
    city: shop.city ?? '',
    region: shop.region ?? '',
    postcode: shop.postcode ?? '',
    timezone: shop.timezone,
  };
}

type Normalised = ReturnType<ReturnType<typeof shopProfileSchema>['parse']>;

/** Only fields whose normalised value differs from what is stored. */
function changedFields(shop: ShopProfile, values: Normalised): UpdateShopProfileInput {
  const out: Record<string, string | null> = {};
  for (const key of FIELDS) {
    const next = values[key] ?? null;
    const prev = shop[key] ?? null;
    if (values[key] !== undefined && next !== prev) out[key] = next;
  }
  return out as UpdateShopProfileInput;
}

function RegionField({
  country,
  control,
  isReadOnly,
}: {
  country: CountryCode;
  control: Control<ProfileForm, unknown, Normalised>;
  isReadOnly: boolean;
}) {
  const label = REGION_LABELS[country];
  if (country === 'GB') {
    return (
      <FormTextInput
        control={control}
        name="region"
        label={label}
        isOptional
        isReadOnly={isReadOnly}
        autoComplete="address-level1"
      />
    );
  }
  const options =
    country === 'US'
      ? US_STATES.map((code) => ({ value: code, label: US_STATE_NAMES[code] ?? code }))
      : PK_PROVINCES.map((p) => ({ value: p, label: p }));
  return (
    <FormSelector
      control={control}
      name="region"
      label={label}
      isOptional
      isClearable
      isReadOnly={isReadOnly}
      hasSearch={country === 'US'}
      placeholder={`Select a ${label.toLowerCase()}`}
      options={options}
    />
  );
}

function ProfileEditor({ shop }: { shop: ShopProfile }) {
  const queryClient = useQueryClient();
  const showToast = useToast();
  const canManage = useCan()('settings.manage');
  const isReadOnly = !canManage;
  const schema = useMemo(() => shopProfileSchema(shop.country), [shop.country]);
  const [pending, setPending] = useState<UpdateShopProfileInput | null>(null);

  const form = useForm<ProfileForm, unknown, Normalised>({
    resolver: zodResolver(schema) as unknown as Resolver<ProfileForm, unknown, Normalised>,
    defaultValues: toForm(shop),
  });
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { isDirty },
  } = form;

  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const save = useMutation({
    mutationFn: (input: UpdateShopProfileInput) =>
      apiFetch('/api/shop', ShopProfile, { method: 'PATCH', json: input }),
    onSuccess: async (updated) => {
      setPending(null);
      reset(toForm(updated));
      showToast({ body: 'Shop details saved' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.shopSettings }),
        queryClient.invalidateQueries({ queryKey: meQueryKey }),
      ]);
    },
    onError: (err) => {
      setPending(null);
      if (isApiRequestError(err)) applyApiIssues(err.body, FIELDS, setError);
    },
  });

  const onSubmit = handleSubmit((values) => {
    const input = changedFields(shop, values);
    if (Object.keys(input).length === 0) {
      reset(toForm(shop));
      return;
    }
    if (input.timezone !== undefined && input.timezone !== shop.timezone) setPending(input);
    else save.mutate(input);
  });

  const zones = TIMEZONES_BY_COUNTRY[shop.country];

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Shop details">
      <VStack gap={8} maxWidth={640}>
        {save.isError ? (
          <Banner
            status="error"
            title="Could not save your changes"
            description={errorMessage(save.error)}
          />
        ) : null}
        {isReadOnly ? (
          <Banner
            status="info"
            title="View only"
            description="Your role can see these details but not change them."
          />
        ) : null}

        <VStack gap={4}>
          <Heading level={2}>Shop details</Heading>
          <FormLayout defaultOptionality="optional">
            <FormTextInput
              control={control}
              name="name"
              label="Shop name"
              isRequired
              isReadOnly={isReadOnly}
              autoComplete="organization"
            />
            <FormTextInput
              control={control}
              name="phone"
              label="Shop phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              isReadOnly={isReadOnly}
              description="Shown on receipts. Any format is fine."
            />
          </FormLayout>
        </VStack>

        <VStack gap={4}>
          <Heading level={2}>Address</Heading>
          <FormLayout defaultOptionality="optional">
            <FormTextInput
              control={control}
              name="addressLine1"
              label="Address line 1"
              autoComplete="address-line1"
              isReadOnly={isReadOnly}
            />
            <FormTextInput
              control={control}
              name="addressLine2"
              label="Address line 2"
              autoComplete="address-line2"
              isReadOnly={isReadOnly}
            />
            <FormLayout direction="horizontal">
              <FormTextInput
                control={control}
                name="city"
                label={CITY_LABELS[shop.country]}
                autoComplete="address-level2"
                isReadOnly={isReadOnly}
              />
              <FormTextInput
                control={control}
                name="postcode"
                label={POSTCODE_LABELS[shop.country]}
                autoComplete="postal-code"
                isReadOnly={isReadOnly}
              />
            </FormLayout>
            <RegionField country={shop.country} control={control} isReadOnly={isReadOnly} />
          </FormLayout>
        </VStack>

        <VStack gap={4}>
          <Heading level={2}>Region & time</Heading>
          <FormSelector
            control={control}
            name="timezone"
            label="Time zone"
            isRequired
            isReadOnly={isReadOnly || zones.length === 1}
            description={
              zones.length === 1
                ? `${countryLabel(shop.country)} has one time zone.`
                : 'Times on tickets, timesheets and reports use this zone.'
            }
            options={zones.map((z) => ({ value: z.value, label: z.label }))}
          />
          <MetadataList label={{ position: 'start', width: 120 }}>
            <MetadataListItem label="Country">
              <HStack gap={2} vAlign="center">
                <Icon icon={LockClosedIcon} size="sm" color="secondary" />
                <Text>{countryLabel(shop.country)}</Text>
              </HStack>
            </MetadataListItem>
            <MetadataListItem label="Currency">
              <HStack gap={2} vAlign="center">
                <Icon icon={LockClosedIcon} size="sm" color="secondary" />
                <Text>{shop.currency}</Text>
              </HStack>
            </MetadataListItem>
          </MetadataList>
          <Text type="supporting" color="secondary">
            Country and currency can&apos;t be changed after the shop is created. All prices, tax
            and reports are recorded in {shop.currency}; changing it would misstate past sales. To
            trade in another country, create a new shop.
          </Text>
        </VStack>

        {canManage ? (
          <HStack gap={2}>
            <Button
              type="submit"
              label={save.isPending ? 'Saving…' : 'Save changes'}
              variant="primary"
              isLoading={save.isPending}
              isDisabled={!isDirty}
            />
            <Button
              label="Discard"
              variant="ghost"
              isDisabled={!isDirty || save.isPending}
              onClick={() => reset(toForm(shop))}
            />
          </HStack>
        ) : null}
      </VStack>

      <AlertDialog
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Change the time zone?"
        description={`Times on tickets, timesheets and reports will be shown in ${timezoneLabel(
          pending?.timezone ?? '',
        )}. Recorded times don't change.`}
        actionLabel="Change time zone"
        actionVariant="primary"
        isActionLoading={save.isPending}
        onAction={() => {
          if (pending) save.mutate(pending);
        }}
      />
    </form>
  );
}

function GeneralSettings() {
  const query = useShopSettings();
  return (
    <>
      <title>General settings · RepairOS</title>
      <PageIntro title="General" description="Your shop's name, contact details and time zone." />
      {query.isPending ? (
        <RowsSkeleton rows={6} label="Loading shop details" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ProfileEditor key={query.data.shop.updatedAt} shop={query.data.shop} />
      )}
    </>
  );
}

export default function GeneralSettingsPage() {
  return (
    <RequirePermission permission="settings.view">
      <GeneralSettings />
    </RequirePermission>
  );
}
