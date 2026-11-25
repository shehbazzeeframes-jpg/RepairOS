'use client';

/*
 * Add / edit device (spec §5). Model suggestions are the one-box search (R1/R2) narrowed by the
 * chosen type and brand; IMEI is validated with the contract (Luhn, 15 digits) and looked up for an
 * ownership warning; the passcode is set, replaced or removed, never shown here.
 */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Link } from '@astryxdesign/core/Link';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { Typeahead } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import {
  CreateDeviceInput,
  DEVICE_ACTION_PATHS,
  DEVICE_BRANDS_BY_TYPE,
  DEVICE_COLOUR_SUGGESTIONS,
  DEVICE_TYPE_LABELS,
  Device,
  DeviceLookupResponse,
  IMEI_DEVICE_TYPES,
  LOCK_TYPE_LABELS,
  OTHER_BRAND,
  SERIAL_ERROR,
  UpdateDeviceInput,
  isValidImei,
  normalizeImei,
  normalizeSerial,
  type DeviceTypeValue,
} from '@repairos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { EMPTY_LOCK, imeiError, passcodeOf, type LockDraft } from '@/lib/check-in';
import { errorMessage } from '@/lib/errors';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { customerPath, fetchModelSuggestions } from '@/lib/sprint2-queries';
import { LockFields, lockProblem } from './LockFields';

type Item = {
  id: string;
  label: string;
  auxiliaryData?: { type?: DeviceTypeValue; brand?: string; model: string };
};

const devicePath = (key: keyof typeof DEVICE_ACTION_PATHS, id: string) =>
  DEVICE_ACTION_PATHS[key].replace(':id', encodeURIComponent(id));

export function DeviceDialog({
  customerId,
  device,
  onClose,
}: {
  customerId: string;
  /** null = add */
  device: Device | null;
  onClose: () => void;
}) {
  const { shop } = useSession();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [type, setType] = useState<DeviceTypeValue>(device?.type ?? 'PHONE');
  const brands = DEVICE_BRANDS_BY_TYPE[type];
  const initialBrandKnown = !device || brands.includes(device.brand);
  const [brandChoice, setBrandChoice] = useState(
    device ? (initialBrandKnown ? device.brand : OTHER_BRAND) : '',
  );
  const [brandOther, setBrandOther] = useState(device && !initialBrandKnown ? device.brand : '');
  const [model, setModel] = useState<Item | null>(
    device ? { id: 'current', label: device.model, auxiliaryData: { model: device.model } } : null,
  );
  const [colour, setColour] = useState<Item | null>(
    device?.colour ? { id: device.colour, label: device.colour } : null,
  );
  const [imei, setImei] = useState(device?.imei ?? '');
  const [serial, setSerial] = useState(device?.serial ?? '');
  const [notes, setNotes] = useState(device?.notes ?? '');
  const [lockMode, setLockMode] = useState<'keep' | 'replace'>(
    device?.passcodeOnFile ? 'keep' : 'replace',
  );
  const [lock, setLock] = useState<LockDraft>(
    device
      ? { ...EMPTY_LOCK, lockType: device.passcodeOnFile ? device.lockType : device.lockType }
      : EMPTY_LOCK,
  );
  const [tried, setTried] = useState(false);
  // Fields the person has typed in and left: their errors show from then on (spec §5 "on blur", BUG-04).
  const [blurred, setBlurred] = useState<{ imei?: boolean; serial?: boolean }>({});

  const brand = brandChoice === OTHER_BRAND ? brandOther.trim() : brandChoice;
  const hasImei = IMEI_DEVICE_TYPES.includes(type);
  const imeiProblem = hasImei ? imeiError(imei) : null;
  const serialProblem = serial.trim() && !normalizeSerial(serial) ? SERIAL_ERROR : null;
  const fullImei =
    hasImei && isValidImei(imei) && normalizeImei(imei) !== device?.imei
      ? normalizeImei(imei)
      : null;
  const owner = useQuery({
    queryKey: ['shop', shop.id, 'device-lookup', fullImei ?? '', customerId],
    queryFn: () =>
      apiFetch(
        `${DEVICE_ACTION_PATHS.lookup}?imei=${fullImei ?? ''}&customerId=${encodeURIComponent(customerId)}`,
        DeviceLookupResponse,
      ),
    enabled: !!fullImei,
  });
  const match = owner.data?.matches.find((m) => m.deviceId !== device?.id);

  const modelSource = useMemo(
    () => ({
      bootstrap: () => [] as Item[],
      search: async (q: string): Promise<Item[]> => {
        const items = await fetchModelSuggestions({ q, type, brand: brand || undefined }).catch(
          () => [],
        );
        return [
          ...items.map((m) => ({
            id: `${m.type}|${m.brand}|${m.model}`,
            label: m.model,
            auxiliaryData: m,
          })),
          { id: '__free__', label: `Use “${q.trim()}”`, auxiliaryData: { model: q.trim() } },
        ];
      },
    }),
    [type, brand],
  );
  const colourSource = useMemo(
    () => ({
      bootstrap: () => DEVICE_COLOUR_SUGGESTIONS.map((c) => ({ id: c, label: c })),
      search: (q: string) => [
        ...DEVICE_COLOUR_SUGGESTIONS.filter((c) => c.toLowerCase().includes(q.toLowerCase())).map(
          (c) => ({ id: c, label: c }),
        ),
        ...(DEVICE_COLOUR_SUGGESTIONS.some((c) => c.toLowerCase() === q.trim().toLowerCase())
          ? []
          : [{ id: q.trim(), label: q.trim() }]),
      ],
    }),
    [],
  );

  const modelText = model?.auxiliaryData?.model ?? model?.label ?? '';
  const body = {
    type,
    brand,
    model: modelText,
    colour: colour?.label ?? null,
    imei: hasImei ? imei.trim() || null : null,
    serial: serial.trim() || null,
    notes: notes.trim() || null,
    ...(lockMode === 'replace' &&
    (!device || lock.lockType !== device.lockType || lock.secret || lock.pattern.length)
      ? { passcode: passcodeOf(lock) }
      : {}),
  };
  const parsed = device ? UpdateDeviceInput.safeParse(body) : CreateDeviceInput.safeParse(body);
  const issue = (path: string) =>
    tried && !parsed.success
      ? parsed.error.issues.find((i) => i.path[0] === path)?.message
      : undefined;

  const save = useMutation({
    mutationFn: () =>
      device
        ? apiFetch(devicePath('update', device.id), Device, { method: 'PATCH', json: body })
        : apiFetch(customerPath('devices', customerId), Device, { method: 'POST', json: body }),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({
        queryKey: [...qk.customersAll(shop.id), 'devices', customerId],
      });
      void queryClient.invalidateQueries({ queryKey: qk.customer(shop.id, customerId) });
      showToast({ body: device ? 'Device saved' : `${d.brand} ${d.model} added` });
      onClose();
    },
  });

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={560}>
      <DialogHeader
        title={device ? 'Edit device' : 'Add device'}
        onOpenChange={(o) => !o && onClose()}
      />
      <form
        noValidate
        aria-label={device ? 'Edit device' : 'Add device'}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (
            !parsed.success ||
            imeiProblem ||
            serialProblem ||
            (lockMode === 'replace' && lockProblem(lock))
          )
            return;
          save.mutate();
        }}
      >
        <VStack gap={5} padding={6}>
          {save.isError ? (
            <Banner
              status="error"
              title="Couldn't save the device"
              description={errorMessage(save.error)}
            />
          ) : null}
          <FormLayout>
            <Selector
              label="Type"
              value={type}
              onChange={(v) => {
                if (!v) return;
                setType(v as DeviceTypeValue);
                if (
                  brandChoice &&
                  brandChoice !== OTHER_BRAND &&
                  !DEVICE_BRANDS_BY_TYPE[v as DeviceTypeValue].includes(brandChoice)
                )
                  setBrandChoice('');
              }}
              options={Object.entries(DEVICE_TYPE_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
              <Selector
                label="Brand"
                hasSearch
                value={brandChoice || undefined}
                placeholder="Choose a brand"
                onChange={(v) => setBrandChoice(v ?? '')}
                options={[...brands.filter((b) => b !== OTHER_BRAND), OTHER_BRAND].map((b) => ({
                  value: b,
                  label: b,
                }))}
                status={
                  issue('brand') && brandChoice !== OTHER_BRAND
                    ? { type: 'error', message: issue('brand') }
                    : undefined
                }
              />
              {brandChoice === OTHER_BRAND ? (
                <TextInput
                  label="Brand name"
                  value={brandOther}
                  onChange={setBrandOther}
                  status={issue('brand') ? { type: 'error', message: issue('brand') } : undefined}
                />
              ) : null}
            </Grid>
            <Typeahead<Item>
              label="Model"
              placeholder="e.g. iPhone 13"
              searchSource={modelSource}
              value={model}
              onChange={(item) => {
                setModel(item);
                const a = item?.auxiliaryData;
                if (a?.type) setType(a.type);
                if (a?.brand)
                  setBrandChoice(
                    DEVICE_BRANDS_BY_TYPE[a.type ?? type].includes(a.brand) ? a.brand : OTHER_BRAND,
                  );
                if (a?.brand && !DEVICE_BRANDS_BY_TYPE[a.type ?? type].includes(a.brand))
                  setBrandOther(a.brand);
              }}
              minQueryLength={1}
              status={issue('model') ? { type: 'error', message: issue('model') } : undefined}
            />
            <Typeahead<Item>
              label="Colour"
              isOptional
              searchSource={colourSource}
              value={colour}
              onChange={setColour}
              hasEntriesOnFocus
              minQueryLength={1}
            />
            <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
              {hasImei ? (
                <TextInput
                  label="IMEI"
                  isOptional
                  inputMode="numeric"
                  description="Scan it, or dial *#06#"
                  value={imei}
                  onChange={setImei}
                  onBlur={() => imei.trim() && setBlurred((b) => ({ ...b, imei: true }))}
                  status={
                    imeiProblem && (tried || blurred.imei || normalizeImei(imei).length >= 15)
                      ? { type: 'error', message: imeiProblem }
                      : undefined
                  }
                />
              ) : null}
              <TextInput
                label="Serial number"
                isOptional
                value={serial}
                onChange={setSerial}
                onBlur={() => serial.trim() && setBlurred((b) => ({ ...b, serial: true }))}
                status={
                  serialProblem && (tried || blurred.serial)
                    ? { type: 'error', message: serialProblem }
                    : undefined
                }
              />
            </Grid>
            {match ? (
              match.sameCustomer ? (
                <Banner
                  status="info"
                  title={`This customer already has this IMEI on their ${match.model}.`}
                />
              ) : (
                <Banner
                  status="warning"
                  title={`This IMEI is on ${match.customerDisplayName}'s ${match.model}${match.lastTicket ? ` (last ticket ${match.lastTicket.numberLabel})` : ''}.`}
                  endContent={
                    <Link href={`/customers/${match.customerId}`}>
                      Open {match.customerDisplayName}
                    </Link>
                  }
                />
              )
            ) : null}
            {device?.passcodeOnFile && lockMode === 'keep' ? (
              <HStack gap={3} vAlign="center" wrap="wrap">
                <Text>{LOCK_TYPE_LABELS[device.lockType]} on file</Text>
                <Button label="Replace" size="sm" onClick={() => setLockMode('replace')} />
                <Button
                  label="Remove"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLockMode('replace');
                    setLock(EMPTY_LOCK);
                  }}
                />
              </HStack>
            ) : (
              <LockFields value={lock} onChange={setLock} showErrors={tried} />
            )}
            {device ? (
              <Text type="supporting" color="secondary">
                Changing the passcode is recorded in the audit log.
              </Text>
            ) : null}
            <TextArea
              label="Notes"
              isOptional
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={setNotes}
            />
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={device ? 'Save device' : 'Add device'}
              isLoading={save.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}
