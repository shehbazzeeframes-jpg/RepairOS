'use client';

/*
 * Check-in (spec §2, A1), built from the approved prototype. One page, six section cards in a 760
 * column and a pinned footer with the running summary and "Create ticket". Picker sections
 * (Customer, Device) collapse to a one-line summary once chosen. Focus moves forward on every
 * confirm, so the returning-customer path never needs Tab:
 *
 *   type in Customer search → ↵ (first match) → ↵ (most recent device) → type issue → ↵ → ⌘↵
 *
 * Reads: check-in context, customer search (incl. archived, R5), IMEI lookup (scanner path, R6),
 * the customer's devices, duplicate check, one-box model search (R1/R2), assignees.
 * Create: POST /api/tickets with an Idempotency-Key per draft. Drafts stay in this browser for 24 h,
 * per user + shop, never with the passcode.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { InputGroup, InputGroupText } from '@astryxdesign/core/InputGroup';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Link } from '@astryxdesign/core/Link';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Switch } from '@astryxdesign/core/Switch';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput } from '@astryxdesign/core/TimeInput';
import { useToast } from '@astryxdesign/core/Toast';
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton';
import { Typeahead, TypeaheadItem } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import { CheckCircleIcon, CheckIcon, PlusIcon } from '@heroicons/react/20/solid';
import {
  ACCESSORY_CODES,
  ACCESSORY_LABELS,
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CHECKLIST_RESULT_KEYS,
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCE_LABELS,
  CustomerDetail,
  DEVICE_ACTION_PATHS,
  DEVICE_TYPE_LABELS,
  DeviceLookupResponse,
  IDEMPOTENCY_KEY_HEADER,
  IMEI_DEVICE_TYPES,
  ISSUE_LABELS,
  LIST_SEARCH_DEBOUNCE_MS,
  LOCK_TYPE_LABELS,
  MAX_TICKET_ISSUES,
  NO_ACCESSORIES_LABEL,
  SECRET_LOCK_TYPES,
  TCPA_VERBAL_SMS_WARNING,
  TicketDetail,
  accessoriesSummary,
  createTicketSchema,
  deviceLabel,
  dueInputProblem,
  formatPhone,
  isValidImei,
  maskIdentifier,
  normalizeImei,
  parseMajorAmount,
  showTcpaWarning,
  ticketPath,
  type AccessoryCode,
  type CheckInContext,
  type ChecklistItemKey,
  type ChecklistResult,
  type ConsentChannel,
  type ConsentSource,
  type CustomerListItem,
  type Device,
  type DeviceLookupMatch,
  type DeviceTypeValue,
  type DuplicateMatch,
  type IssueCode,
  type TicketPriority,
} from '@repairos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CustomerDuplicatePanel } from '@/components/customers/CustomerDuplicatePanel';
import { LockFields, lockProblem } from '@/components/devices/LockFields';
import { PhoneText } from '@/components/ui/PhoneText';
import { RovingGroup } from '@/components/ui/RovingGroup';
import { ShortcutHint, ShortcutHints } from '@/components/ui/ShortcutHint';
import { useCan } from '@/components/RequirePermission';
import { apiFetch, isApiRequestError } from '@/lib/api';
import {
  EMPTY_LOCK,
  EMPTY_NEW_DEVICE,
  NEW_DEVICE,
  buildCreateTicketInput,
  checkInProblems,
  clearDraft,
  emptyCheckIn,
  filterIssues,
  firstEmptyQuickField,
  imeiError,
  isWorthDrafting,
  phoneError,
  looksLikeImei,
  newIdempotencyKey,
  readDraft,
  seedFromTyped,
  writeDraft,
  type CheckInState,
  type CustomerPick,
  type DevicePick,
  type LockDraft,
  type NewDeviceDraft,
} from '@/lib/check-in';
import {
  fetchModelSuggestions,
  searchCheckInCustomers,
  type ModelSuggestionR1,
} from '@/lib/contract-additions';
import { errorCode, errorMessage } from '@/lib/errors';
import { focusField, focusIn, isTypingTarget } from '@/lib/focus';
import { qk } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import {
  customerPath,
  useAssignees,
  useCheckInContext,
  useCustomer,
  useCustomerDevices,
} from '@/lib/sprint2-queries';
import { formatDateTime, formatLocalDate, todayInZone } from '@/lib/timezone';

// ---------- Types ----------

type CustomerItem = {
  id: string;
  label: string;
  auxiliaryData: { customer?: CustomerListItem; match?: DeviceLookupMatch; isNew?: boolean };
};

type ModelItem = {
  id: string;
  label: string;
  auxiliaryData: { type?: DeviceTypeValue; brand?: string; model: string; source?: string };
};

const CONSENT_CHANNELS: ConsentChannel[] = ['SMS', 'EMAIL', 'WHATSAPP'];
const GRANT_SOURCES: ConsentSource[] = ['IN_STORE_VERBAL', 'IN_STORE_SIGNED', 'ONLINE_FORM'];
const CURRENCY_PREFIX = { GBP: '£', USD: '$', PKR: 'Rs' } as const;

const byLastTicket = (a: Device, b: Device) =>
  (b.lastTicketAt ?? '').localeCompare(a.lastTicketAt ?? '');

const pickFromListItem = (c: CustomerListItem): CustomerPick => ({
  id: c.id,
  displayName: c.displayName,
  primaryPhone: c.primaryPhone,
  email: c.email,
  archived: !!c.archivedAt,
});

const devicePick = (d: Pick<Device, 'id' | 'type' | 'brand' | 'model'>): DevicePick => ({
  id: d.id,
  type: d.type,
  brand: d.brand,
  model: d.model,
});

const isSecretLock = (l: LockDraft | null) => !!l && SECRET_LOCK_TYPES.includes(l.lockType);

// ---------- Section frame ----------

function SectionCard({
  index,
  title,
  summary,
  isDone,
  onChange,
  isOptional,
  children,
  sectionRef,
}: {
  index: number;
  title: string;
  summary?: ReactNode;
  isDone?: boolean;
  onChange?: () => void;
  isOptional?: boolean;
  children?: ReactNode;
  sectionRef?: React.Ref<HTMLElement>;
}) {
  const headingId = `checkin-s${index}`;
  return (
    <Card padding={5}>
      <VStack gap={4} as="section" aria-labelledby={headingId} ref={sectionRef}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <HStack gap={2} vAlign="center">
            {isDone ? (
              <Icon icon={CheckCircleIcon} size="sm" color="success" label="Done" />
            ) : (
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {index}
              </Text>
            )}
            <Heading level={2} id={headingId}>
              {title}
            </Heading>
            {isOptional ? (
              <Text type="supporting" color="secondary">
                Optional
              </Text>
            ) : null}
            {isDone && summary ? (
              <Text color="secondary" maxLines={1}>
                {summary}
              </Text>
            ) : null}
          </HStack>
          {isDone && onChange ? (
            <Button
              label={`Change ${title.toLowerCase()}`}
              size="sm"
              variant="ghost"
              onClick={onChange}
            >
              Change
            </Button>
          ) : null}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}

// ---------- Prefill wrapper ----------

export interface CheckInPrefill {
  customerId?: string | null;
  deviceId?: string | null;
  warrantyOf?: string | null;
}

/**
 * Loads what the URL names (?customerId, &deviceId, ?warrantyOf) before mounting the form, so the
 * form starts with those sections done (spec §2.9).
 */
export function CheckInPage({ prefill }: { prefill: CheckInPrefill }) {
  const warranty = useQuery({
    queryKey: ['shop', useSession().shop.id, 'tickets', 'detail', prefill.warrantyOf ?? ''],
    queryFn: () => apiFetch(ticketPath('detail', { id: prefill.warrantyOf ?? '' }), TicketDetail),
    enabled: !!prefill.warrantyOf,
  });
  const customerId = prefill.warrantyOf ? null : (prefill.customerId ?? null);
  const customer = useCustomer(customerId);
  const devices = useCustomerDevices(prefill.deviceId ? customerId : null);

  const loading =
    (!!prefill.warrantyOf && warranty.isPending) ||
    (!!customerId && customer.isPending) ||
    (!!prefill.deviceId && !!customerId && devices.isPending);
  if (loading) {
    return (
      <VStack gap={4} maxWidth={760} aria-busy="true" aria-label="Loading check-in">
        <Heading level={1}>New ticket</Heading>
        <Skeleton height={120} />
        <Skeleton height={120} index={1} />
      </VStack>
    );
  }

  let initial: Partial<CheckInState> | null = null;
  let warrantyLabel: string | null = null;
  if (warranty.data) {
    const t = warranty.data;
    warrantyLabel = t.numberLabel;
    initial = {
      customer: {
        id: t.customer.id,
        displayName: t.customer.displayName,
        primaryPhone: t.customer.phones.find((p) => p.isPrimary)?.e164 ?? null,
        email: t.customer.email,
        archived: t.customer.archived,
      },
      customerDone: true,
      deviceChoice: t.device.id,
      device: devicePick(t.device),
      deviceDone: true,
      warrantyOfTicketId: t.id,
    };
  } else if (customer.data) {
    const c = customer.data;
    const d = devices.data?.items.find((x) => x.id === prefill.deviceId);
    initial = {
      customer: pickFromListItem(c),
      customerDone: true,
      ...(d ? { deviceChoice: d.id, device: devicePick(d), deviceDone: true } : {}),
    };
  }
  return (
    <CheckInForm
      key={JSON.stringify(prefill)}
      initial={initial}
      warrantyLabel={warrantyLabel}
      prefillError={warranty.error ?? customer.error ?? null}
    />
  );
}

// ---------- Form ----------

function CheckInForm({
  initial,
  warrantyLabel,
  prefillError,
}: {
  initial: Partial<CheckInState> | null;
  warrantyLabel: string | null;
  prefillError: unknown;
}) {
  const { me, shop } = useSession();
  const can = useCan();
  const router = useRouter();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const canManageCustomers = can('customers.manage');
  const isWarranty = !!warrantyLabel;

  const ctxQuery = useCheckInContext();
  const ctx: CheckInContext | undefined = ctxQuery.data;
  const assignees = useAssignees();

  // Draft (TK3): restored only for a plain /tickets/new.
  const [restored] = useState(() => (initial ? null : readDraft(me.user.id, shop.id)));
  const [draftBanner, setDraftBanner] = useState(!!restored);
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => restored?.idempotencyKey ?? newIdempotencyKey(),
  );
  const [state, setState] = useState<CheckInState>(() => ({
    ...emptyCheckIn(''),
    ...(restored?.state ?? {}),
    ...(initial ?? {}),
  }));
  const set = (patch: Partial<CheckInState>) => setState((s) => ({ ...s, ...patch }));

  const [query, setQuery] = useState('');
  const [modelItem, setModelItem] = useState<ModelItem | null>(() =>
    state.newDevice?.model
      ? {
          id: 'restored',
          label: state.newDevice.model,
          auxiliaryData: { model: state.newDevice.model },
        }
      : null,
  );
  const [issueFilter, setIssueFilter] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  // Fields the person has typed in and left: their errors show from then on (spec §2.3 "on blur",
  // BUG-01/04). Focus passing through an empty field doesn't count.
  const [blurred, setBlurred] = useState<{ phone?: boolean; imei?: boolean }>({});
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({});
  const [showTime, setShowTime] = useState(!!state.dueTime);
  const [restoredNotice, setRestoredNotice] = useState(false);
  const [addPasscode, setAddPasscode] = useState(!!state.devicePasscode);

  const customerRef = useRef<HTMLElement>(null);
  const deviceRef = useRef<HTMLElement>(null);
  const issuesRef = useRef<HTMLElement>(null);
  const focusDevicesOnLoad = useRef(false);

  // ----- Data for the chosen customer -----
  const customerDetail = useCustomer(state.customer?.id ?? null);
  const devicesQuery = useCustomerDevices(state.customer?.id ?? null);
  const devices = useMemo(
    () => [...(devicesQuery.data?.items ?? [])].sort(byLastTicket),
    [devicesQuery.data],
  );

  // Effective device choice: the most recently used device until the person picks.
  const deviceChoice =
    state.deviceChoice ||
    (state.newCustomer ? NEW_DEVICE : devicesQuery.isSuccess ? (devices[0]?.id ?? NEW_DEVICE) : '');
  const chosenDevice = devices.find((d) => d.id === deviceChoice) ?? null;
  const devicePickNow: DevicePick | null =
    deviceChoice === NEW_DEVICE ? null : chosenDevice ? devicePick(chosenDevice) : state.device;
  const nd: NewDeviceDraft = state.newDevice ?? EMPTY_NEW_DEVICE;
  const isNewDevice = deviceChoice === NEW_DEVICE;
  const setNewDevice = (patch: Partial<NewDeviceDraft>) =>
    setState((s) => ({ ...s, newDevice: { ...(s.newDevice ?? EMPTY_NEW_DEVICE), ...patch } }));

  useEffect(() => {
    if (!focusDevicesOnLoad.current || !devicesQuery.isSuccess) return;
    focusDevicesOnLoad.current = false;
    if (devicesQuery.data.items.length > 0)
      focusIn(deviceRef.current, 'input[type="radio"]:checked', 8);
    else focusField(deviceRef.current, 'Model');
  }, [devicesQuery.isSuccess, devicesQuery.data]);

  // Prefilled sections: start where the work is.
  useEffect(() => {
    if (!initial) return;
    if (initial.deviceDone) focusIn(issuesRef.current, 'input');
    else if (initial.customerDone) focusDevicesOnLoad.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draft: written on every change (under the shop this page was rendered for), never the passcode.
  useEffect(() => {
    if (isWorthDrafting(state)) writeDraft(me.user.id, shop.id, state, idempotencyKey);
  }, [state, idempotencyKey, me.user.id, shop.id]);

  // ----- Derived -----
  const deviceType: DeviceTypeValue = devicePickNow?.type ?? (isNewDevice ? nd.type : 'PHONE');
  const checklistItems = CHECKLIST_ITEMS_BY_DEVICE_TYPE[deviceType];
  const nc = state.newCustomer;
  const phoneProblem = nc ? phoneError(nc.phone, ctx?.country ?? shop.country) : null;
  const customerName = state.customer
    ? state.customer.displayName
    : nc
      ? `${nc.firstName} ${nc.lastName}`.trim()
      : '';
  const deviceName = devicePickNow
    ? deviceLabel(devicePickNow)
    : isNewDevice && nd.model
      ? deviceLabel(nd)
      : '';
  const filteredIssues = filterIssues(issueFilter, deviceType);
  const results = checklistItems.map((i) => state.checklist[i.key] ?? 'UNTESTED');
  const passCount = results.filter((r) => r === 'PASS').length;
  const failCount = results.filter((r) => r === 'FAIL').length;
  const due = state.due || ctx?.defaultDue.date || '';
  const today = ctx ? todayInZone(ctx.timezone) : '';
  const currency = ctx?.currency ?? shop.currency;
  const estimateMinor = state.estimate.trim() ? parseMajorAmount(state.estimate, currency) : null;
  const dueProblem =
    ctx && due
      ? dueInputProblem(
          due,
          state.dueTime || null,
          new Date(ctx.serverNow) > new Date() ? new Date(ctx.serverNow) : new Date(),
          ctx.timezone,
        )
      : null;
  const effective: CheckInState = { ...state, deviceChoice, device: devicePickNow, due };
  const problems = checkInProblems(effective);
  const field = (path: string) => serverIssues[path];
  const assigneeName = assignees.data?.items.find((a) => a.userId === state.assignee)?.name;

  const summaryLine = [
    customerName || 'No customer',
    deviceName || 'No device',
    state.issues.length
      ? state.issues.map((c) => ISSUE_LABELS[c]).join(', ')
      : state.description.trim()
        ? 'Described'
        : 'No issue',
    due && ctx
      ? `Due ${formatLocalDate(due, ctx.locale, false)}${state.dueTime ? ` ${state.dueTime}` : ''}`
      : null,
    state.priority === 'URGENT' ? 'Urgent' : null,
    assigneeName ?? 'Unassigned',
  ]
    .filter(Boolean)
    .join(' · ');

  // ----- Mutations -----
  const restore = useMutation({
    mutationFn: (customerId: string) =>
      apiFetch(customerPath('restore', customerId), CustomerDetail, { method: 'POST' }),
    onSuccess: (c) => {
      queryClient.setQueryData(qk.customer(shop.id, c.id), c);
      void queryClient.invalidateQueries({ queryKey: qk.customersAll(shop.id) });
      setRestoredNotice(true);
    },
  });

  const create = useMutation({
    mutationFn: (body: ReturnType<typeof buildCreateTicketInput>) =>
      apiFetch(ticketPath('create'), TicketDetail, {
        method: 'POST',
        json: body,
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      }),
    onSuccess: (t) => {
      clearDraft(me.user.id, shop.id);
      void queryClient.invalidateQueries({ queryKey: qk.ticketsAll(shop.id) });
      void queryClient.invalidateQueries({ queryKey: qk.customersAll(shop.id) });
      router.push(`/tickets/${t.id}`);
      showToast({
        body: `Ticket ${t.numberLabel} created`,
        endContent: t.customer.erased ? undefined : (
          <Button
            size="sm"
            variant="ghost"
            label={`Check in another device for ${t.customer.displayName}`}
            href={`/tickets/new?customerId=${t.customer.id}`}
          />
        ),
      });
    },
    onError: (err) => {
      if (isApiRequestError(err) && err.body.issues?.length) {
        applyIssues(err.body.issues);
      }
      if (errorCode(err) === 'ASSIGNEE_NOT_ACTIVE') {
        setServerIssues((m) => ({
          ...m,
          assigneeUserId: errorMessage(err, { name: assigneeName }),
        }));
      }
    },
  });

  const applyIssues = (issues: { path: (string | number)[]; message: string }[]) => {
    const map: Record<string, string> = {};
    for (const i of issues) map[i.path.join('.')] ??= i.message;
    setServerIssues(map);
    setShowErrors(true);
    const keys = Object.keys(map);
    if (keys.some((k) => k.startsWith('newCustomer'))) set({ customerDone: false });
    if (keys.some((k) => k.startsWith('newDevice') || k.startsWith('devicePasscode')))
      set({ deviceDone: false });
  };

  // ----- Actions -----
  const sectionRefs = { customer: customerRef, device: deviceRef, issues: issuesRef };
  const submit = () => {
    if (create.isPending || create.isSuccess) return; // double ⌘↵ is ignored
    if (!ctx) return;
    const first = problems[0];
    if (first) {
      setShowErrors(true);
      focusIn(sectionRefs[first.key].current, 'input');
      return;
    }
    if (dueProblem) {
      setShowErrors(true);
      return;
    }
    const body = buildCreateTicketInput(effective, ctx.currency);
    const parsed = createTicketSchema(ctx.country).safeParse(body);
    if (!parsed.success) {
      applyIssues(parsed.error.issues);
      return;
    }
    setServerIssues({});
    create.mutate(body);
  };

  const chooseCustomer = (pick: CustomerPick, match?: DeviceLookupMatch) => {
    if (pick.archived) restore.mutate(pick.id);
    setState((s) => ({
      ...s,
      customer: { ...pick, archived: pick.archived },
      newCustomer: null,
      customerDone: true,
      ...(match
        ? {
            deviceChoice: match.deviceId,
            device: devicePick({
              id: match.deviceId,
              type: match.type,
              brand: match.brand,
              model: match.model,
            }),
            deviceDone: true,
          }
        : { deviceChoice: '', device: null, newDevice: null, deviceDone: false }),
    }));
    if (match) focusIn(issuesRef.current, 'input');
    else focusDevicesOnLoad.current = true;
  };

  const pickCustomer = (item: CustomerItem | null) => {
    if (!item) return;
    if (item.auxiliaryData.isNew) {
      const seed = seedFromTyped(query);
      setState((s) => ({
        ...s,
        customer: null,
        newCustomer: {
          ...seed,
          consents: { SMS: false, EMAIL: false, WHATSAPP: false },
          consentSource: 'IN_STORE_VERBAL',
        },
        deviceChoice: NEW_DEVICE,
        device: null,
        newDevice: { ...EMPTY_NEW_DEVICE },
        deviceDone: false,
      }));
      setModelItem(null);
      focusField(customerRef.current, firstEmptyQuickField(seed));
      return;
    }
    const m = item.auxiliaryData.match;
    if (m) {
      chooseCustomer(
        {
          id: m.customerId,
          displayName: m.customerDisplayName,
          primaryPhone: null,
          email: null,
          archived: m.customerArchived,
        },
        m,
      );
    } else if (item.auxiliaryData.customer) {
      chooseCustomer(pickFromListItem(item.auxiliaryData.customer));
    }
  };

  const useDuplicate = (m: DuplicateMatch) =>
    chooseCustomer({
      id: m.id,
      displayName: m.displayName,
      primaryPhone: m.primaryPhone,
      email: m.email,
      archived: m.archived,
    });

  const confirmNewCustomer = () => {
    if (!nc) return;
    const ok = nc.firstName.trim() && (nc.phone.trim() || nc.email.trim());
    if (!ok) {
      setShowErrors(true);
      return;
    }
    if (phoneError(nc.phone, ctx?.country ?? shop.country)) {
      // An invalid number would only fail at Create (BUG-01): stop here, on the field.
      setBlurred((b) => ({ ...b, phone: true }));
      focusField(customerRef.current, 'Phone');
      return;
    }
    set({ customerDone: true });
    focusField(deviceRef.current, 'Model');
  };

  const changeCustomer = () => {
    if (isWarranty) return;
    setState((s) => ({
      ...s,
      customerDone: false,
      deviceDone: false,
      ...(s.newCustomer ? {} : { customer: null, deviceChoice: '', device: null }),
    }));
    setRestoredNotice(false);
    setQuery('');
    focusIn(customerRef.current, 'input');
  };

  const confirmDevice = () => {
    if (isNewDevice) {
      if (!nd.model.trim() || imeiError(nd.imei) || lockProblem(nd)) {
        setShowErrors(true);
        if (!nd.model.trim()) focusField(deviceRef.current, 'Model');
        return;
      }
    } else if (state.devicePasscode && lockProblem(state.devicePasscode)) {
      setShowErrors(true);
      return;
    }
    set({ deviceDone: true, deviceChoice, device: devicePickNow });
    focusIn(issuesRef.current, 'input');
  };

  const startNewDevice = () => {
    setState((s) => ({
      ...s,
      deviceChoice: NEW_DEVICE,
      newDevice: s.newDevice ?? { ...EMPTY_NEW_DEVICE },
      deviceDone: false,
    }));
    focusField(deviceRef.current, 'Model');
  };

  const toggleIssue = (code: IssueCode) =>
    setState((s) => ({
      ...s,
      issues: s.issues.includes(code)
        ? s.issues.filter((i) => i !== code)
        : s.issues.length >= MAX_TICKET_ISSUES
          ? s.issues
          : [...s.issues, code],
    }));

  const discardDraft = () => {
    clearDraft(me.user.id, shop.id);
    setState({ ...emptyCheckIn('') });
    setIdempotencyKey(newIdempotencyKey());
    setModelItem(null);
    setDraftBanner(false);
    focusIn(customerRef.current, 'input');
  };

  // ----- Keyboard -----
  const onFormKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      if (state.customerDone) changeCustomer();
      else focusIn(customerRef.current, 'input');
      return;
    }
    if (
      e.key === 'Escape' &&
      nc &&
      !state.customerDone &&
      customerRef.current?.contains(e.target as Node)
    ) {
      e.preventDefault();
      setState((s) => ({ ...s, newCustomer: null, newDevice: null, deviceChoice: '' }));
      focusIn(customerRef.current, 'input');
    }
  };

  const onDeviceListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'radio') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (deviceChoice === NEW_DEVICE) startNewDevice();
      else confirmDevice();
    } else if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && canManageCustomers) {
      e.preventDefault();
      startNewDevice();
    }
  };

  const onChecklistKeyDown = (e: KeyboardEvent<HTMLElement>, key: ChecklistItemKey) => {
    const result = CHECKLIST_RESULT_KEYS[e.key.toLowerCase() as 'p' | 'f' | 'u'];
    if (!result || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setState((s) => ({ ...s, checklist: { ...s.checklist, [key]: result } }));
    const next = e.currentTarget.nextElementSibling;
    focusIn(next as HTMLElement | null, '[aria-checked="true"], input:checked', 2);
  };

  // ----- Search sources -----
  const customerSource = useMemo(() => {
    const ctl: { current: AbortController | null } = { current: null };
    return {
      bootstrap: () => [] as CustomerItem[],
      search: async (q: string): Promise<CustomerItem[]> => {
        ctl.current?.abort();
        const controller = new AbortController();
        ctl.current = controller;
        const signal = controller.signal;
        const newItem: CustomerItem[] = canManageCustomers
          ? [
              {
                id: '__new_customer__',
                label: `New customer “${q.trim()}”`,
                auxiliaryData: { isNew: true },
              },
            ]
          : [];
        try {
          if (looksLikeImei(q)) {
            // Scanner path (R6): a full IMEI selects the customer and the device.
            const r = await apiFetch(
              `${DEVICE_ACTION_PATHS.lookup}?imei=${encodeURIComponent(normalizeImei(q))}`,
              DeviceLookupResponse,
              { signal },
            );
            return [
              ...r.matches.map<CustomerItem>((m) => ({
                id: `dev:${m.deviceId}`,
                label: m.customerDisplayName,
                auxiliaryData: { match: m },
              })),
              ...newItem,
            ];
          }
          const rows = await searchCheckInCustomers(q, signal);
          return [
            ...rows.map<CustomerItem>((c) => ({
              id: c.id,
              label: c.displayName,
              auxiliaryData: { customer: c },
            })),
            ...newItem,
          ];
        } catch {
          return newItem;
        }
      },
      cancel: () => ctl.current?.abort(),
    };
  }, [canManageCustomers]);

  const modelSource = useMemo(() => {
    const ctl: { current: AbortController | null } = { current: null };
    return {
      bootstrap: () => [] as ModelItem[],
      search: async (q: string): Promise<ModelItem[]> => {
        ctl.current?.abort();
        const controller = new AbortController();
        ctl.current = controller;
        const items: ModelSuggestionR1[] = await fetchModelSuggestions(
          { q },
          controller.signal,
        ).catch(() => []);
        return [
          ...items.map<ModelItem>((m) => ({
            id: `${m.type}|${m.brand}|${m.model}`,
            label: deviceLabel(m),
            auxiliaryData: m,
          })),
          { id: '__free__', label: `Use “${q.trim()}”`, auxiliaryData: { model: q.trim() } },
        ];
      },
    };
  }, []);

  // IMEI on another customer's device (DV2.5).
  const fullImei = isNewDevice && isValidImei(nd.imei) ? normalizeImei(nd.imei) : null;
  const imeiOwner = useQuery({
    queryKey: ['shop', shop.id, 'device-lookup', fullImei ?? ''],
    queryFn: () =>
      apiFetch(`${DEVICE_ACTION_PATHS.lookup}?imei=${fullImei ?? ''}`, DeviceLookupResponse),
    enabled: !!fullImei,
  });
  const otherOwner = imeiOwner.data?.matches.find((m) => m.customerId !== state.customer?.id);

  const imeiProblem = isNewDevice ? imeiError(nd.imei) : null;
  const anyConsent = nc ? Object.values(nc.consents).some(Boolean) : false;
  const detail = customerDetail.data;
  const isArchivedPick = !!state.customer?.archived;
  const busy = create.isPending;

  return (
    <VStack
      gap={4}
      maxWidth={760}
      as="form"
      aria-labelledby="checkin-title"
      onKeyDown={onFormKeyDown}
      onSubmit={(e: React.FormEvent) => e.preventDefault()}
    >
      <title>New ticket · RepairOS</title>
      <VStack gap={2}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Heading level={1} id="checkin-title">
            New ticket
          </Heading>
          {warrantyLabel ? <Badge label={`Warranty for ${warrantyLabel}`} variant="info" /> : null}
        </HStack>
        <ShortcutHints
          label="Check-in shortcuts"
          hints={[
            { keys: 'enter', label: 'Choose and go on' },
            { keys: 'mod+enter', label: 'Create ticket' },
            { keys: '/', label: 'Customer search' },
            { keys: 'escape', label: 'Close or cancel' },
          ]}
        />
      </VStack>

      {draftBanner && restored ? (
        <Banner
          status="info"
          title={`Draft restored from ${formatDateTime(restored.savedAt, shop)}.`}
          description={
            restored.hadSecret ? 'Enter the passcode again: drafts never keep it.' : undefined
          }
          isDismissable
          onDismiss={() => setDraftBanner(false)}
          endContent={<Button label="Discard" size="sm" onClick={discardDraft} />}
        />
      ) : null}
      {prefillError ? (
        <Banner
          status="error"
          title="Couldn't load what this link pointed to"
          description={errorMessage(prefillError)}
        />
      ) : null}
      {ctxQuery.isError ? (
        <Banner
          status="error"
          title="Couldn't load check-in settings."
          endContent={
            <Button label="Try again" size="sm" onClick={() => void ctxQuery.refetch()} />
          }
        />
      ) : null}

      {/* 1. Customer */}
      <SectionCard
        index={1}
        title="Customer"
        isDone={state.customerDone}
        summary={
          state.customer ? state.customer.displayName : nc ? `${customerName} (new)` : undefined
        }
        onChange={isWarranty ? undefined : changeCustomer}
        sectionRef={customerRef}
      >
        {!state.customerDone && !nc ? (
          <VStack gap={2}>
            <Typeahead<CustomerItem>
              label="Find customer"
              isLabelHidden
              placeholder="Name, phone, email, or scan an IMEI"
              startIcon="search"
              searchSource={customerSource}
              value={null}
              onChange={pickCustomer}
              onChangeQuery={setQuery}
              minQueryLength={2}
              debounceMs={LIST_SEARCH_DEBOUNCE_MS}
              maxMenuItems={9}
              hasAutoFocus={!initial}
              emptySearchText="No customers found"
              renderItem={(item) => {
                const a = item.auxiliaryData;
                if (a.isNew) {
                  return (
                    <TypeaheadItem
                      item={item}
                      icon={<Icon icon={PlusIcon} size="sm" />}
                      description="Add them without leaving check-in"
                    />
                  );
                }
                if (a.match) {
                  return (
                    <TypeaheadItem
                      item={item}
                      description={[
                        a.match.customerArchived ? 'Archived · Restore and use' : null,
                        `IMEI match: ${deviceLabel(a.match)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  );
                }
                const c = a.customer!;
                return (
                  <TypeaheadItem
                    item={item}
                    description={[
                      c.archivedAt ? 'Archived · Restore and use' : null,
                      c.primaryPhone ? formatPhone(c.primaryPhone, shop.country) : (c.email ?? null),
                      c.openTicketCount ? `${c.openTicketCount} open` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                );
              }}
            />
            {showErrors ? (
              <Text type="supporting" color="secondary">
                {canManageCustomers
                  ? 'Choose a customer, or pick “New customer” to add one.'
                  : 'Choose a customer.'}
              </Text>
            ) : null}
          </VStack>
        ) : null}

        {!state.customerDone && nc ? (
          <VStack gap={4}>
            <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
              <TextInput
                label="First name"
                isRequired
                value={nc.firstName}
                onChange={(v) => set({ newCustomer: { ...nc, firstName: v } })}
                status={
                  (showErrors && !nc.firstName.trim()) || field('newCustomer.firstName')
                    ? {
                        type: 'error',
                        message: field('newCustomer.firstName') ?? 'Enter a first name',
                      }
                    : undefined
                }
              />
              <TextInput
                label="Last name"
                isOptional
                value={nc.lastName}
                onChange={(v) => set({ newCustomer: { ...nc, lastName: v } })}
              />
              <TextInput
                label="Phone"
                type="tel"
                inputMode="tel"
                value={nc.phone}
                onChange={(v) => set({ newCustomer: { ...nc, phone: v } })}
                onBlur={() => nc.phone.trim() && setBlurred((b) => ({ ...b, phone: true }))}
                onEnter={confirmNewCustomer}
                description="Mobile, for repair updates"
                status={
                  field('newCustomer.phones.0.number')
                    ? { type: 'error', message: field('newCustomer.phones.0.number') }
                    : phoneProblem && (blurred.phone || showErrors)
                      ? { type: 'error', message: phoneProblem }
                      : (showErrors && !nc.phone.trim() && !nc.email.trim()) ||
                          field('newCustomer.phones')
                        ? {
                            type: 'error',
                            message:
                              field('newCustomer.phones') ?? 'Add a phone number or an email',
                          }
                        : undefined
                }
              />
              <TextInput
                label="Email"
                type="email"
                isOptional
                value={nc.email}
                onChange={(v) => set({ newCustomer: { ...nc, email: v } })}
                onEnter={confirmNewCustomer}
                status={
                  field('newCustomer.email')
                    ? { type: 'error', message: field('newCustomer.email') }
                    : undefined
                }
              />
            </Grid>
            <CustomerDuplicatePanel phone={nc.phone} email={nc.email} onUse={useDuplicate} />
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <Text weight="medium">
                  Marketing consent ·{' '}
                  {anyConsent
                    ? CONSENT_CHANNELS.filter((c) => nc.consents[c]).join(', ')
                    : 'none given'}
                </Text>
              }
            >
              <VStack gap={2} paddingBlockStart={2}>
                {CONSENT_CHANNELS.map((c) => (
                  <Switch
                    key={c}
                    label={CONSENT_CHANNEL_LABELS[c]}
                    value={nc.consents[c]}
                    onChange={(v) =>
                      set({ newCustomer: { ...nc, consents: { ...nc.consents, [c]: v } } })
                    }
                  />
                ))}
                {anyConsent ? (
                  <Selector
                    label="How was consent given?"
                    value={nc.consentSource}
                    onChange={(v) =>
                      v && set({ newCustomer: { ...nc, consentSource: v as ConsentSource } })
                    }
                    options={GRANT_SOURCES.map((s) => ({
                      value: s,
                      label: CONSENT_SOURCE_LABELS[s],
                    }))}
                    description={
                      showTcpaWarning(ctx?.country ?? shop.country, {
                        channel: 'SMS',
                        state: nc.consents.SMS ? 'GRANTED' : 'WITHDRAWN',
                        source: nc.consentSource,
                      })
                        ? TCPA_VERBAL_SMS_WARNING
                        : undefined
                    }
                  />
                ) : null}
              </VStack>
            </Collapsible>
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Button label="Use this customer" onClick={confirmNewCustomer} />
              <ShortcutHint keys="enter" label="in Phone or Email" />
              <ShortcutHint keys="escape" label="back to search" />
            </HStack>
          </VStack>
        ) : null}

        {state.customerDone && state.customer ? (
          <VStack gap={3}>
            <HStack gap={4} wrap="wrap" vAlign="center">
              {(detail?.phones.find((p) => p.isPrimary)?.e164 ?? state.customer.primaryPhone) ? (
                <PhoneText
                  e164={
                    (detail?.phones.find((p) => p.isPrimary)?.e164 ??
                      state.customer.primaryPhone) as string
                  }
                  shopCountry={shop.country}
                  isCallable
                />
              ) : null}
              {(detail?.email ?? state.customer.email) ? (
                <Text color="secondary">{detail?.email ?? state.customer.email}</Text>
              ) : null}
            </HStack>
            {detail?.notes ? (
              <Banner status="info" title="Customer note" description={detail.notes} />
            ) : null}
            {isArchivedPick && restore.isPending ? (
              <Text color="secondary">Restoring this customer…</Text>
            ) : null}
            {isArchivedPick && restore.isError ? (
              <Banner
                status="error"
                title="Couldn't restore this customer"
                description={errorMessage(restore.error)}
                endContent={
                  <Button
                    label="Try again"
                    size="sm"
                    onClick={() => state.customer && restore.mutate(state.customer.id)}
                  />
                }
              />
            ) : null}
            {restoredNotice ? (
              <Banner
                status="warning"
                title="Archived customer"
                description="Restored. They're back in lists and search."
              />
            ) : null}
          </VStack>
        ) : null}
      </SectionCard>

      {/* 2. Device */}
      <SectionCard
        index={2}
        title="Device"
        isDone={state.deviceDone}
        summary={deviceName}
        onChange={
          isWarranty
            ? undefined
            : () => {
                set({ deviceDone: false });
                focusIn(deviceRef.current, 'input');
              }
        }
        sectionRef={deviceRef}
      >
        {!state.customerDone && !nc ? (
          <Text color="secondary">Choose the customer first. Their devices show here.</Text>
        ) : null}

        {state.customerDone && !state.deviceDone && state.customer && devicesQuery.isPending ? (
          <Skeleton height={64} />
        ) : null}

        {(state.customerDone || nc) && !state.deviceDone && state.customer && devices.length > 0 ? (
          <VStack gap={2} onKeyDown={onDeviceListKeyDown}>
            <RadioList
              label="Device"
              isLabelHidden
              value={deviceChoice}
              onChange={(v) => set({ deviceChoice: v })}
            >
              {devices.map((d) => (
                <RadioListItem
                  key={d.id}
                  value={d.id}
                  label={deviceLabel(d)}
                  description={[
                    DEVICE_TYPE_LABELS[d.type],
                    d.colour,
                    d.imei ? `IMEI ${maskIdentifier(d.imei)}` : null,
                    d.passcodeOnFile ? 'Passcode on file' : LOCK_TYPE_LABELS[d.lockType],
                    d.openTicket ? `${d.openTicket.numberLabel} still open` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
              {canManageCustomers ? (
                <RadioListItem
                  value={NEW_DEVICE}
                  label="New device"
                  description="Or press D in this list"
                />
              ) : null}
            </RadioList>
            {chosenDevice?.openTicket ? (
              <Banner
                status="warning"
                title={`${chosenDevice.openTicket.numberLabel} is still open for this device`}
                description="You can still check it in, for example for a second fault."
                endContent={
                  <Link href={`/tickets/${chosenDevice.openTicket.id}`}>
                    Open {chosenDevice.openTicket.numberLabel}
                  </Link>
                }
              />
            ) : null}
            {chosenDevice &&
            !chosenDevice.passcodeOnFile &&
            SECRET_LOCK_TYPES.includes(chosenDevice.lockType) &&
            canManageCustomers ? (
              addPasscode ? (
                <LockFields
                  value={state.devicePasscode ?? { ...EMPTY_LOCK, lockType: chosenDevice.lockType }}
                  onChange={(devicePasscode) => set({ devicePasscode })}
                  onConfirm={confirmDevice}
                  showErrors={showErrors}
                  reenterHint={!!restored?.hadSecret && isSecretLock(state.devicePasscode)}
                />
              ) : (
                <HStack gap={2} vAlign="center">
                  <Text type="supporting" color="secondary">
                    No passcode on file ·
                  </Text>
                  <Link
                    href="#"
                    type="supporting"
                    onClick={(e) => {
                      e.preventDefault();
                      setAddPasscode(true);
                      set({ devicePasscode: { ...EMPTY_LOCK, lockType: chosenDevice.lockType } });
                    }}
                  >
                    Add
                  </Link>
                </HStack>
              )
            ) : null}
            <ShortcutHints
              label="Device list shortcuts"
              hints={[
                { keys: ['up', 'down'], label: 'Choose' },
                { keys: 'enter', label: 'Use device' },
                ...(canManageCustomers ? [{ keys: 'd', label: 'New device' }] : []),
              ]}
            />
          </VStack>
        ) : null}

        {(state.customerDone || nc) && !state.deviceDone && isNewDevice && canManageCustomers ? (
          <VStack gap={4}>
            <Typeahead<ModelItem>
              label="Model"
              description="Search the catalogue; brand and type fill in. Any text is accepted."
              placeholder="e.g. iPhone 13, Galaxy A55, PS5"
              searchSource={modelSource}
              value={modelItem}
              onChange={(item) => {
                setModelItem(item);
                if (!item) {
                  setNewDevice({ model: '' });
                  return;
                }
                const a = item.auxiliaryData;
                const type = a.type ?? nd.type;
                setNewDevice({ model: a.model, brand: a.brand ?? nd.brand, type });
                focusField(deviceRef.current, IMEI_DEVICE_TYPES.includes(type) ? 'IMEI' : 'Serial');
              }}
              minQueryLength={1}
              maxMenuItems={8}
              status={
                (showErrors && !nd.model) || field('newDevice.model')
                  ? { type: 'error', message: field('newDevice.model') ?? 'Type the model' }
                  : undefined
              }
            />
            <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
              <Selector
                label="Type"
                value={nd.type}
                onChange={(v) => v && setNewDevice({ type: v as DeviceTypeValue })}
                options={Object.entries(DEVICE_TYPE_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
              <TextInput
                label="Brand"
                value={nd.brand}
                onChange={(brand) => setNewDevice({ brand })}
                status={
                  field('newDevice.brand')
                    ? { type: 'error', message: field('newDevice.brand') }
                    : undefined
                }
              />
              <TextInput
                label="Colour"
                isOptional
                value={nd.colour}
                onChange={(colour) => setNewDevice({ colour })}
              />
            </Grid>
            <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
              {IMEI_DEVICE_TYPES.includes(nd.type) ? (
                <TextInput
                  label="IMEI"
                  isOptional
                  inputMode="numeric"
                  description="Scan it, or dial *#06#"
                  value={nd.imei}
                  onChange={(imei) => setNewDevice({ imei })}
                  onBlur={() => nd.imei.trim() && setBlurred((b) => ({ ...b, imei: true }))}
                  // A scanner ends with Enter: move on to Lock instead of submitting.
                  onEnter={() =>
                    focusIn(
                      deviceRef.current,
                      '[role="radiogroup"][aria-label="Lock"] [aria-checked="true"]',
                    )
                  }
                  status={
                    field('newDevice.imei')
                      ? { type: 'error', message: field('newDevice.imei') }
                      : imeiProblem &&
                          (showErrors || blurred.imei || nd.imei.replace(/\D/g, '').length >= 15)
                        ? { type: 'error', message: imeiProblem }
                        : undefined
                  }
                />
              ) : null}
              <TextInput
                label="Serial number"
                isOptional
                value={nd.serial}
                onChange={(serial) => setNewDevice({ serial })}
                status={
                  field('newDevice.serial')
                    ? { type: 'error', message: field('newDevice.serial') }
                    : undefined
                }
              />
            </Grid>
            {otherOwner ? (
              <Banner
                status="warning"
                title={`This IMEI is on ${otherOwner.customerDisplayName}'s ${otherOwner.model}${otherOwner.lastTicket ? ` (last ticket ${otherOwner.lastTicket.numberLabel})` : ''}.`}
                endContent={
                  otherOwner.lastTicket ? (
                    <Link href={`/tickets/${otherOwner.lastTicket.id}`}>
                      Open {otherOwner.lastTicket.numberLabel}
                    </Link>
                  ) : undefined
                }
              />
            ) : null}
            <LockFields
              value={nd}
              onChange={(lock) => setNewDevice(lock)}
              onConfirm={confirmDevice}
              showErrors={showErrors}
              reenterHint={!!restored?.hadSecret && isSecretLock(nd)}
            />
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Button label="Use this device" onClick={confirmDevice} />
              {devices.length > 0 ? (
                <Button
                  label="Back to their devices"
                  variant="ghost"
                  onClick={() => {
                    set({ deviceChoice: devices[0]!.id });
                    focusIn(deviceRef.current, 'input[type="radio"]:checked');
                  }}
                />
              ) : null}
            </HStack>
          </VStack>
        ) : null}
      </SectionCard>

      {/* 3. Issues */}
      <SectionCard index={3} title="Issues" isDone={state.issues.length > 0} sectionRef={issuesRef}>
        <VStack gap={3}>
          <TextInput
            label="Find an issue"
            isLabelHidden
            placeholder="Type to filter, ↵ to add (scr → Screen cracked)"
            startIcon="search"
            value={issueFilter}
            onChange={setIssueFilter}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                const first = filteredIssues[0];
                if (issueFilter.trim() && first) {
                  toggleIssue(first);
                  setIssueFilter('');
                }
              } else if (e.key === 'Escape' && issueFilter) {
                e.preventDefault();
                e.stopPropagation();
                setIssueFilter('');
              }
            }}
            status={
              (showErrors && state.issues.length === 0 && !state.description.trim()) ||
              field('issues')
                ? {
                    type: 'error',
                    message: field('issues') ?? 'Choose an issue or describe the problem',
                  }
                : undefined
            }
          />
          <RovingGroup>
            <ToggleButtonGroup
              label="Common issues"
              type="multiple"
              value={state.issues}
              onChange={(v) =>
                set({
                  issues: (((v as string[]) ?? []) as IssueCode[]).slice(0, MAX_TICKET_ISSUES),
                })
              }
              size="sm"
            >
              {filteredIssues.map((code) => (
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
          {issueFilter.trim() && filteredIssues[0] ? (
            <ShortcutHint
              keys="enter"
              label={`${state.issues.includes(filteredIssues[0]) ? 'removes' : 'adds'} “${ISSUE_LABELS[filteredIssues[0]]}”`}
            />
          ) : null}
          <TextArea
            label="Describe the problem"
            isOptional
            rows={2}
            maxLength={1000}
            value={state.description}
            onChange={(description) => set({ description })}
            placeholder="What the customer told you, in their words"
          />
        </VStack>
      </SectionCard>

      {/* 4. Condition */}
      <SectionCard index={4} title="Condition" isOptional>
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text color="secondary">
              Pre-repair checklist · {passCount} pass · {failCount} fail ·{' '}
              {checklistItems.length - passCount - failCount} untested
            </Text>
          }
        >
          <VStack gap={3} paddingBlockStart={3}>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Button
                label="All pass"
                size="sm"
                onClick={() =>
                  set({ checklist: Object.fromEntries(checklistItems.map((i) => [i.key, 'PASS'])) })
                }
              />
              <Button
                label="Won't power on (all untested)"
                size="sm"
                onClick={() =>
                  set({
                    checklist: Object.fromEntries(checklistItems.map((i) => [i.key, 'UNTESTED'])),
                  })
                }
              />
              <ShortcutHint keys="p" label="pass" />
              <ShortcutHint keys="f" label="fail" />
              <ShortcutHint keys="u" label="untested" />
            </HStack>
            <VStack gap={1}>
              {checklistItems.map((item) => (
                <HStack
                  key={item.key}
                  gap={3}
                  vAlign="center"
                  hAlign="between"
                  onKeyDown={(e: KeyboardEvent<HTMLElement>) => onChecklistKeyDown(e, item.key)}
                >
                  <Text>{item.label}</Text>
                  <SegmentedControl
                    label={item.label}
                    size="sm"
                    value={state.checklist[item.key] ?? 'UNTESTED'}
                    onChange={(v) =>
                      setState((s) => ({
                        ...s,
                        checklist: { ...s.checklist, [item.key]: v as ChecklistResult },
                      }))
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
              value={state.conditionNotes}
              onChange={(conditionNotes) => set({ conditionNotes })}
              placeholder="e.g. scratches on the back, dent on the corner"
            />
          </VStack>
        </Collapsible>
      </SectionCard>

      {/* 5. Accessories */}
      <SectionCard index={5} title="Accessories left" isOptional>
        <RovingGroup>
          <ToggleButtonGroup
            label="Accessories left with the device"
            type="multiple"
            value={state.accessories}
            onChange={(v) => set({ accessories: ((v as string[]) ?? []) as AccessoryCode[] })}
            size="sm"
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
        {state.accessories.includes('OTHER') ? (
          <TextInput
            label="What else?"
            isRequired
            value={state.accessoriesOther}
            onChange={(accessoriesOther) => set({ accessoriesOther })}
            status={
              (showErrors && !state.accessoriesOther.trim()) || field('accessoriesOther')
                ? { type: 'error', message: field('accessoriesOther') ?? 'Say what else was left' }
                : undefined
            }
          />
        ) : (
          <Text type="supporting" color="secondary">
            {state.accessories.length
              ? `Left: ${accessoriesSummary(state.accessories)}`
              : NO_ACCESSORIES_LABEL}
          </Text>
        )}
      </SectionCard>

      {/* 6. Estimate, due, priority, technician */}
      <SectionCard index={6} title="Estimate, due date and technician">
        <Grid columns={{ minWidth: 200, max: 2 }} gap={4}>
          <InputGroup
            label="Estimate (approximate)"
            isOptional
            description={`${(ctx?.pricesIncludeTax ?? shop.pricesIncludeTax) ? 'incl. tax' : 'excl. tax'} · itemised quotes come with the price list`}
            status={
              field('estimate.amountMinor')
                ? { type: 'error', message: field('estimate.amountMinor') }
                : state.estimate.trim() && estimateMinor === null
                  ? { type: 'error', message: 'Enter an amount' }
                  : undefined
            }
          >
            <InputGroupText>{CURRENCY_PREFIX[currency]}</InputGroupText>
            <TextInput
              label="Amount"
              isLabelHidden
              inputMode="decimal"
              value={state.estimate}
              onChange={(estimate) => set({ estimate })}
              onBlur={() => {
                // PKR rounds to whole rupees as you leave the field.
                if (currency === 'PKR' && estimateMinor !== null)
                  set({ estimate: String(estimateMinor / 100) });
              }}
              placeholder={currency === 'PKR' ? '0' : '0.00'}
            />
          </InputGroup>
          <VStack gap={1}>
            {ctx ? (
              <DateInput
                label="Due"
                value={due as ISODateString}
                onChange={(v) => v && set({ due: v })}
                min={today as ISODateString}
                description={`${ctx.defaultTurnaroundDays} open days, by closing time`}
                presentation="popover"
                status={
                  dueProblem || field('dueDate')
                    ? { type: 'error', message: dueProblem ?? field('dueDate') }
                    : undefined
                }
              />
            ) : (
              <VStack gap={2} aria-busy="true" aria-label="Loading due date">
                <Text weight="medium">Due</Text>
                <Skeleton height={36} />
              </VStack>
            )}
            {showTime ? (
              <TimeInput
                label="Due time"
                isOptional
                hasClear
                increment={15}
                value={(state.dueTime || undefined) as never}
                onChange={(v) => set({ dueTime: v ?? '' })}
              />
            ) : (
              <Link
                href="#"
                type="supporting"
                onClick={(e) => {
                  e.preventDefault();
                  setShowTime(true);
                }}
              >
                Set a time
              </Link>
            )}
          </VStack>
          <VStack gap={2}>
            <Text weight="medium">Priority</Text>
            <SegmentedControl
              label="Priority"
              value={state.priority}
              onChange={(v) => set({ priority: v as TicketPriority })}
            >
              <SegmentedControlItem value="NORMAL" label="Normal" />
              <SegmentedControlItem value="URGENT" label="Urgent" />
            </SegmentedControl>
          </VStack>
          <Selector
            label="Technician"
            value={state.assignee}
            onChange={(v) => set({ assignee: v ?? '' })}
            isLoading={assignees.isPending}
            options={[
              { value: '', label: 'Unassigned' },
              ...(assignees.data?.items ?? []).map((a) => ({
                value: a.userId,
                label: a.isSelf ? `${a.name} (you)` : a.name,
                description: a.role === 'TECHNICIAN' ? 'Technician' : undefined,
              })),
            ]}
            status={
              field('assigneeUserId')
                ? { type: 'error', message: field('assigneeUserId') }
                : undefined
            }
          />
        </Grid>
      </SectionCard>

      {/* Footer: pinned summary + create. The one inline style: sticky positioning (as in the
          Astryx payment-form template's summary column), with a spacing token. */}
      <Card padding={4} elevation="med" style={{ position: 'sticky', bottom: 'var(--spacing-4)' }}>
        <VStack gap={2} as="section" aria-label="Ticket summary">
          {showErrors && problems.length > 0 ? (
            <Banner
              status="error"
              title={`Before creating: ${problems.map((p) => p.text.toLowerCase()).join(' · ')}`}
            />
          ) : null}
          {create.isError ? (
            <Banner
              status="error"
              title={
                errorCode(create.error) === 'ACTIVE_SHOP_CHANGED'
                  ? `You switched shop in another tab. This check-in is kept for ${shop.name}.`
                  : "Couldn't create the ticket"
              }
              description={
                errorCode(create.error) === 'ACTIVE_SHOP_CHANGED'
                  ? undefined
                  : errorMessage(create.error)
              }
              endContent={
                errorCode(create.error) === 'CUSTOMER_ARCHIVED' && state.customer ? (
                  <Button
                    label="Restore and use"
                    size="sm"
                    onClick={() => {
                      if (!state.customer) return;
                      restore.mutate(state.customer.id, { onSuccess: () => submit() });
                    }}
                  />
                ) : undefined
              }
            />
          ) : null}
          <HStack gap={4} vAlign="center" hAlign="between">
            <Text maxLines={1} color="secondary" aria-live="polite">
              {summaryLine}
            </Text>
            <HStack gap={3} vAlign="center">
              <Kbd keys="mod+enter" />
              <Button
                label={busy ? 'Creating…' : 'Create ticket'}
                variant="primary"
                isLoading={busy}
                isDisabled={!ctx || errorCode(create.error) === 'ACTIVE_SHOP_CHANGED'}
                tooltip={!ctx ? 'Loading shop settings…' : undefined}
                onClick={submit}
              />
            </HStack>
          </HStack>
          <Text type="supporting" color="secondary">
            Drafts are kept on this device for 24 hours, without the passcode.
          </Text>
        </VStack>
      </Card>
    </VStack>
  );
}
