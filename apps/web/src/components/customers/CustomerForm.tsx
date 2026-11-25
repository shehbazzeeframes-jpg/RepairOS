'use client';

/*
 * Customer create / edit (spec §4.3; template settings, 640 column). Validated with the country-aware
 * contract schemas (`createCustomerSchema` / `updateCustomerSchema`), consent through ConsentEditor,
 * duplicates warned under the contact fields (never blocking).
 */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { Tokenizer } from '@astryxdesign/core/Tokenizer';
import { VStack } from '@astryxdesign/core/VStack';
import { PlusIcon, TrashIcon } from '@heroicons/react/20/solid';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CITY_LABELS,
  CUSTOMER_ACTION_PATHS,
  CustomerDetail,
  MAX_CUSTOMER_PHONES,
  MAX_CUSTOMER_TAGS,
  PHONE_LABELS,
  PK_PROVINCES,
  POSTCODE_LABELS,
  PREFERRED_CHANNEL_LABELS,
  REGION_LABELS,
  STALE_CUSTOMER_MESSAGE,
  US_STATES,
  createCustomerSchema,
  defaultPreferredChannel,
  formatPhone,
  normalizePhone,
  updateCustomerSchema,
  type CreateCustomerInput,
  type PhoneLabel,
  type PreferredChannel,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm, type Resolver } from 'react-hook-form';
import { FormTextArea, FormTextInput, errorStatus } from '@/components/form';
import { apiFetch, isApiRequestError } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { customerPath, useCustomerTags } from '@/lib/sprint2-queries';
import { CustomerDuplicatePanel } from './CustomerDuplicatePanel';
import {
  ConsentEditor,
  consentChangesFrom,
  consentValueFrom,
  missingConsentSources,
  type ConsentValue,
} from './ConsentEditor';

interface PhoneRow {
  id?: string;
  number: string;
  label: PhoneLabel;
  isPrimary: boolean;
  isWhatsapp: boolean;
}

export interface CustomerFormValues {
  version?: number;
  kind: 'PERSON' | 'BUSINESS';
  firstName: string;
  lastName: string;
  businessName: string;
  businessContactName: string;
  email: string;
  phones: PhoneRow[];
  preferredChannel: PreferredChannel;
  serviceOptOutSms: boolean;
  serviceOptOutEmail: boolean;
  serviceOptOutWhatsapp: boolean;
  tags: string[];
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postcode: string;
  notes: string;
}

export function formValuesFrom(
  c: CustomerDetail | null,
  country: 'US' | 'GB' | 'PK',
): CustomerFormValues {
  return {
    ...(c ? { version: c.version } : {}),
    kind: c?.kind ?? 'PERSON',
    firstName: c?.firstName ?? '',
    lastName: c?.lastName ?? '',
    businessName: c?.businessName ?? '',
    businessContactName: c?.businessContactName ?? '',
    email: c?.email ?? '',
    phones: c
      ? [...c.phones]
          .sort((a, b) => a.position - b.position)
          .map((p) => ({
            id: p.id,
            number: formatPhone(p.e164, country),
            label: p.label,
            isPrimary: p.isPrimary,
            isWhatsapp: p.id === c.whatsappPhoneId,
          }))
      : [{ number: '', label: 'MOBILE', isPrimary: true, isWhatsapp: true }],
    preferredChannel: c?.preferredChannel ?? defaultPreferredChannel(country),
    serviceOptOutSms: c?.serviceOptOutSms ?? false,
    serviceOptOutEmail: c?.serviceOptOutEmail ?? false,
    serviceOptOutWhatsapp: c?.serviceOptOutWhatsapp ?? false,
    tags: c?.tags ?? [],
    addressLine1: c?.addressLine1 ?? '',
    addressLine2: c?.addressLine2 ?? '',
    city: c?.city ?? '',
    region: c?.region ?? '',
    postcode: c?.postcode ?? '',
    notes: c?.notes ?? '',
  };
}

/** The request body from the form (empty phone rows dropped; the API normalises). */
export function customerBody(v: CustomerFormValues) {
  const phones = v.phones
    .filter((p) => p.number.trim())
    .map((p) => ({
      ...(p.id ? { id: p.id } : {}),
      number: p.number.trim(),
      label: p.label,
      isPrimary: p.isPrimary,
      isWhatsapp: p.label === 'LANDLINE' ? false : p.isWhatsapp,
    }));
  const person = v.kind === 'PERSON';
  return {
    ...(v.version !== undefined ? { version: v.version } : {}),
    kind: v.kind,
    firstName: person ? v.firstName.trim() || null : null,
    lastName: person ? v.lastName.trim() || null : null,
    businessName: person ? null : v.businessName.trim() || null,
    businessContactName: person ? null : v.businessContactName.trim() || null,
    email: v.email.trim() || null,
    phones,
    preferredChannel: v.preferredChannel,
    serviceOptOutSms: v.serviceOptOutSms,
    serviceOptOutEmail: v.serviceOptOutEmail,
    serviceOptOutWhatsapp: v.serviceOptOutWhatsapp,
    tags: v.tags,
    addressLine1: v.addressLine1.trim() || null,
    addressLine2: v.addressLine2.trim() || null,
    city: v.city.trim() || null,
    region: v.region.trim() || null,
    postcode: v.postcode.trim() || null,
    notes: v.notes.trim() || null,
  };
}

const FIELDS = [
  'kind',
  'firstName',
  'lastName',
  'businessName',
  'businessContactName',
  'email',
  'phones',
  'preferredChannel',
  'tags',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postcode',
  'notes',
] as const;

export function CustomerForm({ customer }: { customer: CustomerDetail | null }) {
  const { shop } = useSession();
  const router = useRouter();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!customer;
  const tagsQuery = useCustomerTags();
  const [consents, setConsents] = useState<ConsentValue>(() =>
    consentValueFrom(customer?.consent ?? null),
  );
  const [stale, setStale] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // The contract schema checks the request body (country rules: phones, postcode, region).
  const schema = useMemo(
    () => (isEdit ? updateCustomerSchema(shop.country) : createCustomerSchema(shop.country)),
    [isEdit, shop.country],
  );
  const resolver: Resolver<CustomerFormValues> = useMemo(() => {
    const inner = zodResolver(schema as never) as unknown as Resolver<CustomerFormValues>;
    return (values, ctx, opts) =>
      inner(customerBody(values) as unknown as CustomerFormValues, ctx, opts);
  }, [schema]);

  const form = useForm<CustomerFormValues>({
    resolver,
    defaultValues: formValuesFrom(customer, shop.country),
  });
  const { control, handleSubmit, watch, setValue, setError, getValues, formState } = form;
  const phones = useFieldArray({ control, name: 'phones' });
  const kind = watch('kind');
  const phoneRows = watch('phones');
  const email = watch('email');
  const hasAddress = !!(customer?.addressLine1 || customer?.city || customer?.postcode);

  useEffect(() => {
    if (!formState.isDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [formState.isDirty]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isEdit
        ? apiFetch(customerPath('detail', customer.id), CustomerDetail, {
            method: 'PATCH',
            json: body,
          })
        : apiFetch(CUSTOMER_ACTION_PATHS.list, CustomerDetail, { method: 'POST', json: body }),
    onSuccess: (c) => {
      queryClient.setQueryData(qk.customer(shop.id, c.id), c);
      void queryClient.invalidateQueries({ queryKey: qk.customersAll(shop.id) });
      form.reset(formValuesFrom(c, shop.country));
      showToast({ body: isEdit ? 'Customer saved' : 'Customer added' });
      router.push(`/customers/${c.id}`);
    },
    onError: (err) => {
      if (hasErrorCode(err, 'STALE_RECORD')) {
        setStale(true);
        return;
      }
      if (isApiRequestError(err)) {
        for (const i of err.body.issues ?? []) {
          const path = i.path.join('.');
          if ((FIELDS as readonly string[]).includes(String(i.path[0]))) {
            setError(path as never, { type: 'server', message: i.message });
          }
        }
      }
    },
  });

  const onValid = () => {
    setShowErrors(true);
    if (missingConsentSources(customer?.consent ?? null, consents).length) return;
    const changes = consentChangesFrom(customer?.consent ?? null, consents);
    const body = customerBody(getValues());
    save.mutate({
      ...body,
      ...(isEdit ? (changes.length ? { consents: changes } : {}) : { consents: changes }),
    });
  };

  const setExclusive = (index: number, key: 'isPrimary' | 'isWhatsapp') => {
    getValues('phones').forEach((_, i) =>
      setValue(`phones.${i}.${key}`, i === index, { shouldDirty: true }),
    );
  };

  const tagSource = useMemo(
    () => ({
      bootstrap: () => (tagsQuery.data?.tags ?? []).slice(0, 10).map((t) => ({ id: t, label: t })),
      search: (q: string) =>
        (tagsQuery.data?.tags ?? [])
          .filter((t) => t.toLowerCase().includes(q.toLowerCase()))
          .map((t) => ({ id: t, label: t })),
    }),
    [tagsQuery.data],
  );

  const regionOptions: { value: string; label: string }[] | null =
    shop.country === 'US'
      ? US_STATES.map((s) => ({ value: s, label: s }))
      : shop.country === 'PK'
        ? PK_PROVINCES.map((p) => ({ value: p, label: p }))
        : null;

  return (
    <VStack gap={6} maxWidth={640}>
      <title>
        {isEdit ? `Edit ${customer.displayName} · RepairOS` : 'New customer · RepairOS'}
      </title>
      <Heading level={1}>{isEdit ? `Edit ${customer.displayName}` : 'New customer'}</Heading>
      <form
        noValidate
        aria-label={isEdit ? 'Edit customer' : 'New customer'}
        onSubmit={handleSubmit(onValid, () => setShowErrors(true))}
      >
        <VStack gap={6}>
          {stale ? (
            <Banner
              status="warning"
              title={STALE_CUSTOMER_MESSAGE}
              description="Your changes are kept."
              endContent={
                <Button
                  label="Reload"
                  size="sm"
                  onClick={async () => {
                    const fresh = await queryClient.fetchQuery({
                      queryKey: qk.customer(shop.id, customer!.id),
                      queryFn: () => apiFetch(customerPath('detail', customer!.id), CustomerDetail),
                      staleTime: 0,
                    });
                    setValue('version', fresh.version);
                    setStale(false);
                    save.reset();
                  }}
                />
              }
            />
          ) : save.isError && !hasErrorCode(save.error, 'VALIDATION_FAILED') ? (
            <Banner
              status="error"
              title="Couldn't save the customer"
              description={errorMessage(save.error)}
            />
          ) : null}

          <VStack gap={4} as="section" aria-labelledby="who">
            <Heading level={2} id="who">
              Who
            </Heading>
            <Controller
              control={control}
              name="kind"
              render={({ field }) => (
                <SegmentedControl
                  label="Customer type"
                  value={field.value}
                  onChange={(v) => field.onChange(v)}
                >
                  <SegmentedControlItem value="PERSON" label="Person" />
                  <SegmentedControlItem value="BUSINESS" label="Business" />
                </SegmentedControl>
              )}
            />
            <FormLayout>
              {kind === 'PERSON' ? (
                <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
                  <FormTextInput
                    control={control}
                    name="firstName"
                    label="First name"
                    isRequired
                    hasAutoFocus={!isEdit}
                  />
                  <FormTextInput control={control} name="lastName" label="Last name" isOptional />
                </Grid>
              ) : (
                <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
                  <FormTextInput
                    control={control}
                    name="businessName"
                    label="Business name"
                    isRequired
                  />
                  <FormTextInput
                    control={control}
                    name="businessContactName"
                    label="Contact name"
                    isOptional
                  />
                </Grid>
              )}
            </FormLayout>
          </VStack>

          <VStack gap={4} as="section" aria-labelledby="contact">
            <Heading level={2} id="contact">
              Contact
            </Heading>
            {formState.errors.phones?.message || formState.errors.phones?.root?.message ? (
              <Text color="primary" role="alert">
                {formState.errors.phones?.message ?? formState.errors.phones?.root?.message}
              </Text>
            ) : null}
            {phones.fields.map((row, i) => (
              <VStack key={row.id} gap={2} role="group" aria-label={`Phone ${i + 1}`}>
                <HStack gap={3} vAlign="end" wrap="wrap">
                  <Controller
                    control={control}
                    name={`phones.${i}.number`}
                    render={({ field, fieldState }) => (
                      <TextInput
                        label={i === 0 ? 'Phone' : `Phone ${i + 1}`}
                        type="tel"
                        inputMode="tel"
                        width={220}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={() => {
                          const e164 = normalizePhone(field.value, shop.country);
                          if (e164) field.onChange(formatPhone(e164, shop.country));
                          field.onBlur();
                        }}
                        status={errorStatus(fieldState.error?.message)}
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name={`phones.${i}.label`}
                    render={({ field }) => (
                      <Selector
                        label="Label"
                        width={140}
                        value={field.value}
                        onChange={(v) => v && field.onChange(v)}
                        options={Object.entries(PHONE_LABELS).map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                    )}
                  />
                  <IconButton
                    label={`Remove phone ${i + 1}`}
                    icon={<Icon icon={TrashIcon} />}
                    variant="ghost"
                    isDisabled={phones.fields.length === 1 && !email}
                    onClick={() => phones.remove(i)}
                  />
                </HStack>
                <HStack gap={4} wrap="wrap">
                  <CheckboxInput
                    label="Primary"
                    value={!!phoneRows[i]?.isPrimary}
                    onChange={(v) => v && setExclusive(i, 'isPrimary')}
                  />
                  {phoneRows[i]?.label !== 'LANDLINE' ? (
                    <CheckboxInput
                      label="WhatsApp"
                      value={!!phoneRows[i]?.isWhatsapp}
                      onChange={(v) =>
                        v
                          ? setExclusive(i, 'isWhatsapp')
                          : setValue(`phones.${i}.isWhatsapp`, false)
                      }
                    />
                  ) : null}
                </HStack>
              </VStack>
            ))}
            {phones.fields.length < MAX_CUSTOMER_PHONES ? (
              <HStack>
                <Button
                  label="Add phone"
                  size="sm"
                  icon={<Icon icon={PlusIcon} />}
                  onClick={() =>
                    phones.append({
                      number: '',
                      label: 'MOBILE',
                      isPrimary: phones.fields.length === 0,
                      isWhatsapp: false,
                    })
                  }
                />
              </HStack>
            ) : null}
            <FormTextInput
              control={control}
              name="email"
              label="Email"
              type="email"
              isOptional
              width={360}
            />
            <CustomerDuplicatePanel
              phone={phoneRows.find((p) => p.number.trim())?.number ?? ''}
              email={email}
              excludeId={customer?.id}
              onUse={isEdit ? undefined : (m) => router.push(`/customers/${m.id}`)}
              useLabel="Open this customer"
            />
            <Controller
              control={control}
              name="preferredChannel"
              render={({ field, fieldState }) => (
                <VStack gap={2}>
                  <SegmentedControl
                    label="Preferred contact"
                    value={field.value}
                    onChange={(v) => field.onChange(v)}
                  >
                    {(Object.keys(PREFERRED_CHANNEL_LABELS) as PreferredChannel[]).map((p) => (
                      <SegmentedControlItem key={p} value={p} label={PREFERRED_CHANNEL_LABELS[p]} />
                    ))}
                  </SegmentedControl>
                  {fieldState.error ? (
                    <Text color="primary" role="alert">
                      {fieldState.error.message}
                    </Text>
                  ) : null}
                </VStack>
              )}
            />
          </VStack>

          <VStack gap={4} as="section" aria-labelledby="consent">
            <Heading level={2} id="consent">
              Marketing consent
            </Heading>
            <Text color="secondary">Never pre-ticked. Record how the customer agreed.</Text>
            <ConsentEditor
              value={consents}
              onChange={setConsents}
              current={customer?.consent ?? null}
              country={shop.country}
              showErrors={showErrors}
            />
            <Heading level={3}>Repair updates</Heading>
            {(['serviceOptOutSms', 'serviceOptOutEmail', 'serviceOptOutWhatsapp'] as const).map(
              (name) => (
                <Controller
                  key={name}
                  control={control}
                  name={name}
                  render={({ field }) => (
                    <Switch
                      label={`Don't send repair updates by ${{ serviceOptOutSms: 'SMS', serviceOptOutEmail: 'email', serviceOptOutWhatsapp: 'WhatsApp' }[name]}`}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              ),
            )}
          </VStack>

          <VStack gap={4} as="section" aria-labelledby="more">
            <Heading level={2} id="more">
              More
            </Heading>
            <Controller
              control={control}
              name="tags"
              render={({ field, fieldState }) => (
                <Tokenizer
                  label="Tags"
                  isOptional
                  searchSource={tagSource}
                  value={field.value.map((t) => ({ id: t, label: t }))}
                  onChange={(items) => field.onChange(items.map((i) => i.label))}
                  hasCreate
                  hasEntriesOnFocus
                  maxEntries={MAX_CUSTOMER_TAGS}
                  status={errorStatus(fieldState.error?.message)}
                />
              )}
            />
            <Collapsible
              defaultIsOpen={hasAddress}
              trigger={<Text weight="medium">{hasAddress ? 'Address' : 'Add address'}</Text>}
            >
              <VStack gap={3} paddingBlockStart={3}>
                <FormTextInput
                  control={control}
                  name="addressLine1"
                  label="Address line 1"
                  isOptional
                />
                <FormTextInput
                  control={control}
                  name="addressLine2"
                  label="Address line 2"
                  isOptional
                />
                <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
                  <FormTextInput
                    control={control}
                    name="city"
                    label={CITY_LABELS[shop.country]}
                    isOptional
                  />
                  {regionOptions ? (
                    <Controller
                      control={control}
                      name="region"
                      render={({ field, fieldState }) => (
                        <Selector
                          label={REGION_LABELS[shop.country]}
                          isOptional
                          hasClear
                          hasSearch
                          value={field.value || null}
                          onChange={(v) => field.onChange(v ?? '')}
                          options={regionOptions}
                          status={errorStatus(fieldState.error?.message)}
                        />
                      )}
                    />
                  ) : (
                    <FormTextInput
                      control={control}
                      name="region"
                      label={REGION_LABELS[shop.country]}
                      isOptional
                    />
                  )}
                  <FormTextInput
                    control={control}
                    name="postcode"
                    label={POSTCODE_LABELS[shop.country]}
                    isOptional
                  />
                </Grid>
              </VStack>
            </Collapsible>
            <FormTextArea
              control={control}
              name="notes"
              label="Customer note"
              isOptional
              rows={3}
              maxLength={2000}
              description="Shown on every ticket for this customer"
            />
          </VStack>

          <HStack gap={2}>
            <Button
              type="submit"
              variant="primary"
              label={isEdit ? 'Save changes' : 'Save customer'}
              isLoading={save.isPending}
            />
            <Button
              label="Cancel"
              variant="ghost"
              href={isEdit ? `/customers/${customer.id}` : '/customers'}
            />
          </HStack>
        </VStack>
      </form>
    </VStack>
  );
}

export type { CreateCustomerInput };
