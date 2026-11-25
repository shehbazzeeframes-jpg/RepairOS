'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Selector } from '@astryxdesign/core/Selector';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CountryCode,
  CreateShopInput,
  MARKET_DEFAULTS,
  POSTCODE_LABELS,
  Shop,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { ErrorState } from '@/components/ErrorState';
import { FullPageLoader } from '@/components/FullPageLoader';
import { apiFetch, isApiRequestError } from '@/lib/api';
import { describeTaxDefaults, formatMoney } from '@/lib/format';
import { COUNTRY_OPTIONS } from '@/lib/markets';
import { errorMessage } from '@/lib/errors';
import { meQueryKey } from '@/lib/me';
import { SHOP_SCOPE } from '@/lib/queries';
import { useSessionGate } from '@/lib/session-gate';
import { useSignOut } from '@/lib/shops';

type FormInput = z.input<typeof CreateShopInput>;

const FIELD_NAMES = ['name', 'country', 'phone', 'addressLine1', 'city', 'postcode'] as const;
type FieldName = (typeof FIELD_NAMES)[number];

/** Drop empty optional strings so the API applies its own defaults. */
function toPayload(values: CreateShopInput): CreateShopInput {
  const out: CreateShopInput = { name: values.name, country: values.country };
  if (values.phone) out.phone = values.phone;
  if (values.addressLine1) out.addressLine1 = values.addressLine1;
  if (values.city) out.city = values.city;
  if (values.postcode) out.postcode = values.postcode;
  return out;
}

/** Friendlier copy for the contract's built-in Zod messages. */
const shopErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const field = issue.path[0];
  if (field === 'country') return { message: 'Select the country your shop is in' };
  if (issue.code === 'too_small' && field === 'name') {
    return {
      message:
        typeof ctx.data === 'string' && ctx.data.trim() === ''
          ? 'Enter your shop name'
          : `Use at least ${String(issue.minimum)} characters`,
    };
  }
  if (issue.code === 'too_big')
    return { message: `Use ${String(issue.maximum)} characters or fewer` };
  return { message: ctx.defaultError };
};

function MarketSummary({ country }: { country: CountryCode | undefined }) {
  if (!country) {
    return (
      <Text color="secondary">
        Pick a country to see the currency and tax settings your shop starts with.
      </Text>
    );
  }
  const market = MARKET_DEFAULTS[country];
  return (
    <Card variant="muted" padding={4} width="100%">
      <VStack gap={3}>
        <MetadataList
          title={<Text weight="semibold">Your shop starts with</Text>}
          label={{ position: 'start', width: 120 }}
        >
          <MetadataListItem label="Currency">
            {market.currency} · e.g.{' '}
            {formatMoney(12900, { currency: market.currency, locale: market.locale })}
          </MetadataListItem>
          <MetadataListItem label="Tax">{describeTaxDefaults(country)}</MetadataListItem>
          <MetadataListItem label="Time zone">{market.timezone}</MetadataListItem>
        </MetadataList>
        <Text type="supporting" color="secondary">
          You can change these later in Settings.
        </Text>
      </VStack>
    </Card>
  );
}

function Onboarding() {
  const searchParams = useSearchParams();
  const newShop = searchParams.get('new') === '1';
  const gate = useSessionGate('onboarding', { newShop });
  const signOut = useSignOut();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { control, handleSubmit, setError } = useForm<FormInput, unknown, CreateShopInput>({
    // zod 3 types ParseParams with every key required; the resolver only reads errorMap.
    resolver: zodResolver(CreateShopInput, { errorMap: shopErrorMap } as z.ParseParams),
    defaultValues: {
      name: '',
      country: undefined,
      phone: '',
      addressLine1: '',
      city: '',
      postcode: '',
    },
  });
  const country = useWatch({ control, name: 'country' });

  const createShop = useMutation({
    mutationFn: (input: CreateShopInput) =>
      apiFetch('/api/shops', Shop, { method: 'POST', json: toPayload(input) }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: [SHOP_SCOPE] });
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      router.replace('/');
    },
    onError: (err) => {
      // Map API field issues back onto the form; anything else shows in the banner.
      if (isApiRequestError(err)) {
        for (const issue of err.body.issues ?? []) {
          const field = issue.path[0];
          if (typeof field === 'string' && (FIELD_NAMES as readonly string[]).includes(field)) {
            setError(field as FieldName, { type: 'server', message: issue.message });
          }
        }
      }
    },
  });

  if (gate.status === 'loading') return <FullPageLoader />;
  if (gate.status === 'error')
    return <ErrorState message={gate.error.message} onRetry={gate.retry} />;

  const onSubmit = handleSubmit((values) => createShop.mutate(values));
  const errorStatus = (message: string | undefined) =>
    message ? { type: 'error' as const, message } : undefined;

  return (
    <AuthLayout
      width={560}
      title={newShop && gate.me?.activeShop ? 'Set up another shop' : 'Set up your shop'}
      subtitle="This is what customers see on receipts and messages."
      footer={
        <Text color="secondary">
          {newShop && gate.me?.activeShop ? (
            <>
              <Link href="/">Back to {gate.me.activeShop.name}</Link>
              {' · '}
            </>
          ) : null}
          Signed in as {gate.me?.user.email}.{' '}
          <Link
            href="/sign-in"
            onClick={(e) => {
              e.preventDefault();
              void signOut();
            }}
          >
            Sign out
          </Link>
        </Text>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Set up your shop">
        <FormLayout defaultOptionality="required">
          {createShop.isError ? (
            <Banner
              status="error"
              title="Could not create your shop"
              description={errorMessage(createShop.error)}
            />
          ) : null}
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <TextInput
                label="Shop name"
                placeholder="Fix It Phones"
                autoComplete="organization"
                value={field.value}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                ref={field.ref}
                htmlName={field.name}
                hasAutoFocus
                status={errorStatus(fieldState.error?.message)}
              />
            )}
          />
          <Controller
            control={control}
            name="country"
            render={({ field, fieldState }) => (
              <Selector
                label="Country"
                description="Sets your currency, tax and date formats."
                placeholder="Select a country"
                options={COUNTRY_OPTIONS}
                value={field.value}
                onChange={(v) => field.onChange(v ?? undefined)}
                ref={field.ref}
                htmlName={field.name}
                status={errorStatus(fieldState.error?.message)}
              />
            )}
          />
          <MarketSummary country={country} />
          <Controller
            control={control}
            name="phone"
            render={({ field, fieldState }) => (
              <TextInput
                label="Shop phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                isOptional
                description="Shown on receipts. Any format is fine."
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                ref={field.ref}
                htmlName={field.name}
                status={errorStatus(fieldState.error?.message)}
              />
            )}
          />
          <Controller
            control={control}
            name="addressLine1"
            render={({ field, fieldState }) => (
              <TextInput
                label="Address"
                autoComplete="address-line1"
                isOptional
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                ref={field.ref}
                htmlName={field.name}
                status={errorStatus(fieldState.error?.message)}
              />
            )}
          />
          <FormLayout direction="horizontal">
            <Controller
              control={control}
              name="city"
              render={({ field, fieldState }) => (
                <TextInput
                  label="City"
                  autoComplete="address-level2"
                  isOptional
                  value={field.value ?? ''}
                  onChange={(v) => field.onChange(v)}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  htmlName={field.name}
                  status={errorStatus(fieldState.error?.message)}
                />
              )}
            />
            <Controller
              control={control}
              name="postcode"
              render={({ field, fieldState }) => (
                <TextInput
                  label={country ? POSTCODE_LABELS[country] : 'Postcode'}
                  autoComplete="postal-code"
                  isOptional
                  value={field.value ?? ''}
                  onChange={(v) => field.onChange(v)}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  htmlName={field.name}
                  status={errorStatus(fieldState.error?.message)}
                />
              )}
            />
          </FormLayout>
          <Button
            type="submit"
            label={createShop.isPending ? 'Creating shop…' : 'Create shop'}
            variant="primary"
            size="lg"
            width="100%"
            isLoading={createShop.isPending}
          />
        </FormLayout>
      </form>
    </AuthLayout>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Onboarding />
    </Suspense>
  );
}
