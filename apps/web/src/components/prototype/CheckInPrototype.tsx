'use client';

/*
 * Check-in prototype (Sprint 2 A1; spec docs/screens/sprint2.md §2). Local mock data only, contract
 * data and schemas everywhere else.
 *
 * One page, six section cards in a 760 column and a pinned footer with the running summary and
 * "Create ticket". Picker sections (Customer, Device) collapse to a one-line summary with "Change"
 * once chosen; the rest stay open. Focus moves forward on every confirm, so the returning-customer
 * path never needs Tab:
 *
 *   type in Customer search → ↵ (first match) → ↵ (first device) → type issue → ↵ → ⌘↵ create
 *
 * On create the page builds the POST /api/tickets body, checks it with `createTicketSchema(country)`
 * and shows the time and keystrokes since load, so a hallway test gets numbers without tooling.
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
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton';
import { Typeahead, TypeaheadItem } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import { CheckCircleIcon, CheckIcon, PlusIcon } from '@heroicons/react/20/solid';
import {
  ACCESSORY_CODES,
  ACCESSORY_LABELS,
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  CHECKLIST_RESULT_KEYS,
  CONSENT_SOURCE_LABELS,
  DEVICE_TYPE_LABELS,
  IMEI_DEVICE_TYPES,
  ISSUE_LABELS,
  LOCK_TYPE_LABELS,
  NO_ACCESSORIES_LABEL,
  TCPA_VERBAL_SMS_WARNING,
  createTicketSchema,
  deviceLabel,
  dueInputProblem,
  formatTicketNumber,
  maskIdentifier,
  parseMajorAmount,
  type AccessoryCode,
  type ChecklistItemKey,
  type ChecklistResult,
  type ConsentChannel,
  type ConsentSource,
  type CreateTicketInput,
  type Device,
  type DeviceTypeValue,
  type IssueCode,
  type LockType,
} from '@repairos/contracts';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PatternLockInput } from '@/components/ui/PatternLockInput';
import { PhoneText } from '@/components/ui/PhoneText';
import { RovingGroup } from '@/components/ui/RovingGroup';
import { ShortcutHint, ShortcutHints } from '@/components/ui/ShortcutHint';
import { patternError } from '@/lib/pattern-lock';
import { useSession } from '@/lib/shop-context';
import { formatLocalDate, todayInZone } from '@/lib/timezone';
import {
  MOCK_ASSIGNEES,
  filterIssues,
  imeiError,
  mockCheckInContext,
  searchCustomers,
  searchModels,
  seedFromTyped,
  type MockCustomer,
} from './check-in-model';

// ---------- Types ----------

interface NewCustomer {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  consents: Record<ConsentChannel, boolean>;
  consentSource: ConsentSource;
}

interface NewDevice {
  type: DeviceTypeValue;
  brand: string;
  model: string;
  colour: string;
  imei: string;
  lockType: LockType;
  secret: string;
  pattern: number[];
}

type CustomerItem = {
  id: string;
  label: string;
  auxiliaryData: { customer?: MockCustomer; device?: Device; isNew?: boolean };
};

type ModelItem = {
  id: string;
  label: string;
  auxiliaryData: { type?: DeviceTypeValue; brand?: string; model: string };
};

const EMPTY_DEVICE: NewDevice = {
  type: 'PHONE',
  brand: '',
  model: '',
  colour: '',
  imei: '',
  lockType: 'NONE',
  secret: '',
  pattern: [],
};

const NEW_DEVICE = '__new__';
const CONSENT_CHANNELS: { channel: ConsentChannel; label: string }[] = [
  { channel: 'SMS', label: 'Marketing by SMS' },
  { channel: 'EMAIL', label: 'Marketing by email' },
  { channel: 'WHATSAPP', label: 'Marketing by WhatsApp' },
];
const GRANT_SOURCES: ConsentSource[] = ['IN_STORE_VERBAL', 'IN_STORE_SIGNED', 'ONLINE_FORM'];
const CURRENCY_PREFIX = { GBP: '£', USD: '$', PKR: 'Rs' } as const;

/** Keys that are typing, so single-letter shortcuts must not fire. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement)
    return !['radio', 'checkbox', 'button', 'submit'].includes(el.type);
  return el.getAttribute('role') === 'combobox';
}

/**
 * Moves focus once the target has rendered, and keeps it there for a few frames: an Astryx Typeahead
 * moves focus to its selected-value chip right after a pick, which would otherwise win.
 */
function focusSoon(find: () => HTMLElement | null | undefined, frames = 4) {
  let n = 0;
  let cancelled = false;
  // The next key press is the person moving on: stop re-asserting focus from then on.
  const cancel = () => {
    cancelled = true;
  };
  window.addEventListener('keydown', cancel, { capture: true, once: true });
  const step = () => {
    if (cancelled) return;
    const el = find();
    if (el && document.activeElement !== el) el.focus();
    if (++n < frames) requestAnimationFrame(step);
    else window.removeEventListener('keydown', cancel, { capture: true });
  };
  requestAnimationFrame(step);
}

function focusIn(el: HTMLElement | null, selector: string) {
  focusSoon(() => el?.querySelector<HTMLElement>(selector));
}

/** Focus the control a visible label names (Astryx inputs take no id or ref; their labels point at them). */
function focusField(el: HTMLElement | null, label: string) {
  focusSoon(() => {
    const match = [...(el?.querySelectorAll('label') ?? [])].find((l) =>
      (l.textContent ?? '').trim().startsWith(label),
    );
    const id = match?.getAttribute('for');
    return id ? document.getElementById(id) : null;
  });
}

const byLastTicket = (a: Device, b: Device) =>
  (b.lastTicketAt ?? '').localeCompare(a.lastTicketAt ?? '');

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

// ---------- Page ----------

export function CheckInPrototype() {
  const { me, shop } = useSession();
  // GET /api/tickets/check-in-context in the real page.
  const [ctx] = useState(() => mockCheckInContext(shop));
  const today = todayInZone(ctx.timezone);

  // Instrumentation (DoD: time-to-create and keystrokes; PostHog `ticket_created` in the real page).
  const startedAt = useRef<number>(0);
  const keystrokes = useRef(0);
  useEffect(() => {
    startedAt.current = performance.now();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) keystrokes.current += 1;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ----- State -----
  const [query, setQuery] = useState('');
  const [customer, setCustomer] = useState<MockCustomer | null>(null);
  const [newCustomer, setNewCustomer] = useState<NewCustomer | null>(null);
  const [customerDone, setCustomerDone] = useState(false);

  const [deviceChoice, setDeviceChoice] = useState<string>(NEW_DEVICE);
  const [newDevice, setNewDevice] = useState<NewDevice | null>(null);
  const [modelItem, setModelItem] = useState<ModelItem | null>(null);
  const [deviceDone, setDeviceDone] = useState(false);

  const [issueFilter, setIssueFilter] = useState('');
  const [issues, setIssues] = useState<IssueCode[]>([]);
  const [description, setDescription] = useState('');

  const [checklist, setChecklist] = useState<Partial<Record<ChecklistItemKey, ChecklistResult>>>(
    {},
  );
  const [conditionNotes, setConditionNotes] = useState('');
  const [accessories, setAccessories] = useState<AccessoryCode[]>([]);
  const [accessoriesOther, setAccessoriesOther] = useState('');
  const [estimate, setEstimate] = useState('');
  const [due, setDue] = useState<string>(ctx.defaultDue.date);
  const [priority, setPriority] = useState<'NORMAL' | 'URGENT'>('NORMAL');
  const [assignee, setAssignee] = useState<string>('');

  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<null | {
    number: string;
    seconds: number;
    keys: number;
    summary: string;
    payloadOk: boolean;
    payloadIssues: string[];
  }>(null);

  const customerRef = useRef<HTMLElement>(null);
  const deviceRef = useRef<HTMLElement>(null);
  const issuesRef = useRef<HTMLElement>(null);

  // ----- Derived -----
  const devices = useMemo(() => [...(customer?.devices ?? [])].sort(byLastTicket), [customer]);
  const chosenDevice = devices.find((d) => d.id === deviceChoice) ?? null;
  const deviceType: DeviceTypeValue = chosenDevice?.type ?? newDevice?.type ?? 'PHONE';
  const checklistItems = CHECKLIST_ITEMS_BY_DEVICE_TYPE[deviceType];
  const customerName = customer
    ? customer.displayName
    : newCustomer
      ? `${newCustomer.firstName} ${newCustomer.lastName}`.trim()
      : '';
  const deviceName = chosenDevice
    ? deviceLabel(chosenDevice)
    : newDevice?.model
      ? deviceLabel(newDevice)
      : '';
  const filteredIssues = filterIssues(issueFilter, deviceType);
  const results = checklistItems.map((i) => checklist[i.key] ?? 'UNTESTED');
  const passCount = results.filter((r) => r === 'PASS').length;
  const failCount = results.filter((r) => r === 'FAIL').length;
  const estimateMinor = estimate.trim() ? parseMajorAmount(estimate, ctx.currency) : null;
  const dueProblem = dueInputProblem(due, null, new Date(), ctx.timezone);

  const problems: { key: 'customer' | 'device' | 'issues'; text: string }[] = [];
  if (!customerDone)
    problems.push({
      key: 'customer',
      text: newCustomer ? 'Finish the new customer' : 'Choose a customer',
    });
  if (!deviceDone) problems.push({ key: 'device', text: 'Choose a device' });
  if (issues.length === 0 && !description.trim()) {
    problems.push({ key: 'issues', text: 'Pick an issue or describe the problem' });
  }

  const summaryLine = [
    customerName || 'No customer',
    deviceName || 'No device',
    issues.length
      ? issues.map((c) => ISSUE_LABELS[c]).join(', ')
      : description.trim()
        ? 'Described'
        : 'No issue',
    `Due ${formatLocalDate(due, ctx.locale, false)}`,
    priority === 'URGENT' ? 'Urgent' : null,
    MOCK_ASSIGNEES.find((a) => a.userId === assignee)?.name ?? 'Unassigned',
  ]
    .filter(Boolean)
    .join(' · ');

  /** The POST /api/tickets body this page would send (with `Idempotency-Key` and `X-Shop-Id`). */
  const buildPayload = (): CreateTicketInput => {
    const nd = newDevice;
    const passcode =
      nd?.lockType === 'PIN' || nd?.lockType === 'PASSWORD'
        ? { lockType: nd.lockType, value: nd.secret }
        : nd?.lockType === 'PATTERN'
          ? { lockType: 'PATTERN' as const, pattern: nd.pattern }
          : nd
            ? { lockType: nd.lockType }
            : undefined;
    return {
      ...(customer
        ? { customerId: customer.id }
        : {
            newCustomer: {
              kind: 'PERSON',
              firstName: newCustomer?.firstName,
              lastName: newCustomer?.lastName,
              email: newCustomer?.email,
              phones: newCustomer?.phone ? [{ number: newCustomer.phone, label: 'MOBILE' }] : [],
              consents: CONSENT_CHANNELS.filter((c) => newCustomer?.consents[c.channel]).map(
                (c) => ({
                  channel: c.channel,
                  state: 'GRANTED' as const,
                  source: newCustomer?.consentSource,
                }),
              ),
            },
          }),
      ...(chosenDevice
        ? { deviceId: chosenDevice.id }
        : {
            newDevice: {
              type: nd?.type ?? 'PHONE',
              brand: nd?.brand ?? '',
              model: nd?.model ?? '',
              colour: nd?.colour || null,
              imei: nd?.imei || null,
              serial: null,
              notes: null,
              passcode: passcode as never,
            },
          }),
      issues: issues.map((code) => ({ code })),
      description: description || null,
      checklist,
      conditionNotes: conditionNotes || null,
      accessories,
      accessoriesOther: accessoriesOther || null,
      estimate:
        estimateMinor === null ? null : { amountMinor: estimateMinor, currency: ctx.currency },
      dueDate: due,
      dueTime: null,
      priority,
      assigneeUserId: assignee || null,
    };
  };

  // ----- Actions -----
  const sectionRefs = { customer: customerRef, device: deviceRef, issues: issuesRef };
  const create = () => {
    const first = problems[0];
    if (first) {
      setShowErrors(true);
      focusIn(sectionRefs[first.key].current, 'input');
      return;
    }
    const seconds = (performance.now() - startedAt.current) / 1000;
    const parsed = createTicketSchema(ctx.country).safeParse(buildPayload());
    setCreated({
      number: formatTicketNumber(ctx.numberPrefix, 1042),
      seconds,
      keys: keystrokes.current,
      summary: summaryLine,
      payloadOk: parsed.success,
      payloadIssues: parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  };

  const pickCustomer = (item: CustomerItem | null) => {
    if (!item) return;
    if (item.auxiliaryData.isNew) {
      const seed = seedFromTyped(query);
      setCustomer(null);
      setNewCustomer({
        ...seed,
        consents: { SMS: false, EMAIL: false, WHATSAPP: false },
        consentSource: 'IN_STORE_VERBAL',
      });
      setNewDevice({ ...EMPTY_DEVICE });
      setDeviceChoice(NEW_DEVICE);
      // Focus the first field the typed text didn't fill.
      focusField(
        customerRef.current,
        seed.firstName ? (seed.phone ? 'Email' : 'Phone') : 'First name',
      );
      return;
    }
    const c = item.auxiliaryData.customer!;
    setCustomer(c);
    setNewCustomer(null);
    setCustomerDone(true);
    const sorted = [...c.devices].sort(byLastTicket);
    if (item.auxiliaryData.device) {
      // Scanned IMEI: customer and device in one go.
      setDeviceChoice(item.auxiliaryData.device.id);
      setDeviceDone(true);
      focusIn(issuesRef.current, 'input');
    } else if (sorted.length > 0) {
      setDeviceChoice(sorted[0]!.id);
      setNewDevice(null);
      setDeviceDone(false);
      focusIn(deviceRef.current, 'input[type="radio"]:checked');
    } else {
      setDeviceChoice(NEW_DEVICE);
      setNewDevice({ ...EMPTY_DEVICE });
      focusIn(deviceRef.current, 'input');
    }
  };

  const confirmNewCustomer = () => {
    if (!newCustomer) return;
    const ok =
      newCustomer.firstName.trim() && (newCustomer.phone.trim() || newCustomer.email.trim());
    if (!ok) {
      setShowErrors(true);
      return;
    }
    setCustomerDone(true);
    focusIn(deviceRef.current, 'input');
  };

  const changeCustomer = () => {
    setCustomerDone(false);
    setDeviceDone(false);
    if (!newCustomer) {
      setCustomer(null);
      setQuery('');
    }
    focusIn(customerRef.current, 'input');
  };

  const confirmDevice = () => {
    if (deviceChoice === NEW_DEVICE) {
      if (!newDevice?.model.trim()) {
        setShowErrors(true);
        focusIn(deviceRef.current, 'input');
        return;
      }
      if (newDevice.lockType === 'PATTERN' && patternError(newDevice.pattern)) {
        setShowErrors(true);
        return;
      }
    }
    setDeviceDone(true);
    focusIn(issuesRef.current, 'input');
  };

  const startNewDevice = () => {
    setDeviceChoice(NEW_DEVICE);
    setNewDevice({ ...EMPTY_DEVICE });
    setModelItem(null);
    setDeviceDone(false);
    focusIn(deviceRef.current, 'input');
  };

  const toggleIssue = (code: IssueCode) =>
    setIssues((prev) => (prev.includes(code) ? prev.filter((i) => i !== code) : [...prev, code]));

  // ----- Keyboard -----
  const onFormKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      create();
      return;
    }
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      if (customerDone) changeCustomer();
      else focusIn(customerRef.current, 'input');
      return;
    }
    if (
      e.key === 'Escape' &&
      newCustomer &&
      !customerDone &&
      customerRef.current?.contains(e.target as Node)
    ) {
      e.preventDefault();
      setNewCustomer(null);
      setNewDevice(null);
      focusIn(customerRef.current, 'input');
    }
  };

  const onDeviceListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'radio') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (deviceChoice === NEW_DEVICE) startNewDevice();
      else confirmDevice();
    } else if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      startNewDevice();
    }
  };

  const onChecklistKeyDown = (e: KeyboardEvent<HTMLElement>, key: ChecklistItemKey) => {
    const result = CHECKLIST_RESULT_KEYS[e.key.toLowerCase() as 'p' | 'f' | 'u'];
    if (!result || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setChecklist((c) => ({ ...c, [key]: result }));
    // "Set and move down": focus the next row's segmented control.
    const next = e.currentTarget.nextElementSibling;
    focusSoon(() => next?.querySelector<HTMLElement>('[aria-checked="true"], input:checked'), 2);
  };

  // ----- Search sources (GET /api/customers?q= and model suggestions in the real page) -----
  const customerSource = useMemo(
    () => ({
      bootstrap: () => [] as CustomerItem[],
      search: (q: string): CustomerItem[] => [
        ...searchCustomers(q).map<CustomerItem>((m) => ({
          id: m.customer.id,
          label: m.customer.displayName,
          auxiliaryData: { customer: m.customer, device: m.device },
        })),
        {
          id: '__new_customer__',
          label: `New customer “${q.trim()}”`,
          auxiliaryData: { isNew: true },
        },
      ],
    }),
    [],
  );

  const modelSource = useMemo(
    () => ({
      bootstrap: () => [] as ModelItem[],
      search: (q: string): ModelItem[] => [
        ...searchModels(q).map<ModelItem>((m) => ({
          id: `${m.brand}|${m.model}`,
          label: deviceLabel(m),
          auxiliaryData: m,
        })),
        { id: '__free__', label: `Use “${q.trim()}”`, auxiliaryData: { model: q.trim() } },
      ],
    }),
    [],
  );

  // ----- Success -----
  if (created) {
    return (
      <VStack gap={6} maxWidth={760}>
        <Heading level={1}>New ticket</Heading>
        <Banner
          status={created.payloadOk ? 'success' : 'error'}
          title={`Ticket ${created.number} created`}
          description={`${created.summary}. Checked in in ${created.seconds.toFixed(1)} s with ${created.keys} keystrokes.`}
        />
        <Text color="secondary">
          {created.payloadOk
            ? 'The request body passes createTicketSchema for this shop: the page maps one to one onto POST /api/tickets.'
            : `The request body fails createTicketSchema: ${created.payloadIssues.join('; ')}`}
        </Text>
        <HStack gap={3}>
          <Button
            label={`Check in another device for ${customerName}`}
            variant="primary"
            onClick={() => window.location.reload()}
          />
          <Button label="Start over" onClick={() => window.location.reload()} />
        </HStack>
      </VStack>
    );
  }

  const nc = newCustomer;
  const nd = newDevice;
  const imeiProblem = nd ? imeiError(nd.imei) : null;
  const anyConsent = nc ? Object.values(nc.consents).some(Boolean) : false;

  return (
    <VStack
      gap={4}
      maxWidth={760}
      as="form"
      aria-labelledby="checkin-title"
      onKeyDown={onFormKeyDown}
      onSubmit={(e: React.FormEvent) => e.preventDefault()}
    >
      <VStack gap={2}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Heading level={1} id="checkin-title">
            New ticket
          </Heading>
          <Badge label="Prototype · mock data" variant="purple" />
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

      {/* 1. Customer */}
      <SectionCard
        index={1}
        title="Customer"
        isDone={customerDone}
        summary={customer ? customer.displayName : nc ? `${customerName} (new)` : undefined}
        onChange={changeCustomer}
        sectionRef={customerRef}
      >
        {!customerDone && !nc ? (
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
              debounceMs={150}
              maxMenuItems={9}
              hasAutoFocus
              emptySearchText="No customers found"
              renderItem={(item) =>
                item.auxiliaryData.isNew ? (
                  <TypeaheadItem
                    item={item}
                    icon={<Icon icon={PlusIcon} size="sm" />}
                    description="Add them without leaving check-in"
                  />
                ) : (
                  <TypeaheadItem
                    item={item}
                    description={[
                      item.auxiliaryData.customer!.archived ? 'Archived · Restore and use' : null,
                      item.auxiliaryData.device
                        ? `IMEI match: ${deviceLabel(item.auxiliaryData.device)}`
                        : item.auxiliaryData.customer!.devices[0]
                          ? deviceLabel(
                              [...item.auxiliaryData.customer!.devices].sort(byLastTicket)[0]!,
                            )
                          : 'No devices yet',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                )
              }
            />
            {showErrors ? (
              <Text type="supporting" color="secondary">
                Choose a customer, or pick “New customer” to add one.
              </Text>
            ) : null}
          </VStack>
        ) : null}

        {!customerDone && nc ? (
          <VStack gap={4}>
            <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
              <TextInput
                label="First name"
                isRequired
                value={nc.firstName}
                onChange={(v) => setNewCustomer({ ...nc, firstName: v })}
                status={
                  showErrors && !nc.firstName.trim()
                    ? { type: 'error', message: 'Enter a first name' }
                    : undefined
                }
              />
              <TextInput
                label="Last name"
                isOptional
                value={nc.lastName}
                onChange={(v) => setNewCustomer({ ...nc, lastName: v })}
              />
              <TextInput
                label="Phone"
                type="tel"
                inputMode="tel"
                value={nc.phone}
                onChange={(v) => setNewCustomer({ ...nc, phone: v })}
                onEnter={confirmNewCustomer}
                description="Mobile, for repair updates"
                status={
                  showErrors && !nc.phone.trim() && !nc.email.trim()
                    ? { type: 'error', message: 'Add a phone number or an email' }
                    : undefined
                }
              />
              <TextInput
                label="Email"
                type="email"
                isOptional
                value={nc.email}
                onChange={(v) => setNewCustomer({ ...nc, email: v })}
                onEnter={confirmNewCustomer}
              />
            </Grid>
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <Text weight="medium">
                  Marketing consent ·{' '}
                  {anyConsent
                    ? CONSENT_CHANNELS.filter((c) => nc.consents[c.channel])
                        .map((c) => c.channel)
                        .join(', ')
                    : 'none given'}
                </Text>
              }
            >
              <VStack gap={2} paddingBlockStart={2}>
                {CONSENT_CHANNELS.map((c) => (
                  <Switch
                    key={c.channel}
                    label={c.label}
                    value={nc.consents[c.channel]}
                    onChange={(v) =>
                      setNewCustomer({ ...nc, consents: { ...nc.consents, [c.channel]: v } })
                    }
                  />
                ))}
                {anyConsent ? (
                  <Selector
                    label="How was consent given?"
                    value={nc.consentSource}
                    onChange={(v) =>
                      v && setNewCustomer({ ...nc, consentSource: v as ConsentSource })
                    }
                    options={GRANT_SOURCES.map((s) => ({
                      value: s,
                      label: CONSENT_SOURCE_LABELS[s],
                    }))}
                    description={
                      ctx.country === 'US' &&
                      nc.consents.SMS &&
                      nc.consentSource === 'IN_STORE_VERBAL'
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

        {customerDone && customer ? (
          <VStack gap={3}>
            <HStack gap={4} wrap="wrap" vAlign="center">
              <PhoneText e164={customer.primaryPhone} shopCountry={ctx.country} isCallable />
              {customer.email ? <Text color="secondary">{customer.email}</Text> : null}
            </HStack>
            {customer.notes ? (
              <Banner status="info" title="Customer note" description={customer.notes} />
            ) : null}
            {customer.archived ? (
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
        isDone={deviceDone}
        summary={deviceName}
        onChange={() => {
          setDeviceDone(false);
          focusIn(deviceRef.current, 'input');
        }}
        sectionRef={deviceRef}
      >
        {!customerDone && !nc ? (
          <Text color="secondary">Choose the customer first. Their devices show here.</Text>
        ) : null}

        {(customerDone || nc) && !deviceDone && customer && devices.length > 0 ? (
          <VStack gap={2} onKeyDown={onDeviceListKeyDown}>
            <RadioList label="Device" isLabelHidden value={deviceChoice} onChange={setDeviceChoice}>
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
              <RadioListItem
                value={NEW_DEVICE}
                label="New device"
                description="Or press D in this list"
              />
            </RadioList>
            {chosenDevice?.openTicket ? (
              <Banner
                status="warning"
                title={`${chosenDevice.openTicket.numberLabel} is still open for this device`}
                description="You can still check it in, for example for a second fault."
              />
            ) : null}
            <ShortcutHints
              label="Device list shortcuts"
              hints={[
                { keys: ['up', 'down'], label: 'Choose' },
                { keys: 'enter', label: 'Use device' },
                { keys: 'd', label: 'New device' },
              ]}
            />
          </VStack>
        ) : null}

        {(customerDone || nc) && !deviceDone && deviceChoice === NEW_DEVICE && nd ? (
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
                  setNewDevice({ ...nd, model: '' });
                  return;
                }
                const a = item.auxiliaryData;
                const type = a.type ?? nd.type;
                setNewDevice({ ...nd, model: a.model, brand: a.brand ?? nd.brand, type });
                focusField(deviceRef.current, IMEI_DEVICE_TYPES.includes(type) ? 'IMEI' : 'Serial');
              }}
              minQueryLength={1}
              maxMenuItems={8}
              status={
                showErrors && !nd.model ? { type: 'error', message: 'Enter the model' } : undefined
              }
            />
            <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
              <Selector
                label="Type"
                value={nd.type}
                onChange={(v) => v && setNewDevice({ ...nd, type: v as DeviceTypeValue })}
                options={Object.entries(DEVICE_TYPE_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
              <TextInput
                label="Brand"
                value={nd.brand}
                onChange={(v) => setNewDevice({ ...nd, brand: v })}
              />
              <TextInput
                label="Colour"
                isOptional
                value={nd.colour}
                onChange={(v) => setNewDevice({ ...nd, colour: v })}
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
                  onChange={(v) => setNewDevice({ ...nd, imei: v })}
                  // A scanner ends with Enter: move on to Lock instead of submitting (DV edge case).
                  onEnter={() =>
                    focusIn(
                      deviceRef.current,
                      '[role="radiogroup"][aria-label="Lock"] [aria-checked="true"]',
                    )
                  }
                  status={
                    imeiProblem && (showErrors || nd.imei.replace(/\D/g, '').length >= 15)
                      ? { type: 'error', message: imeiProblem }
                      : undefined
                  }
                />
              ) : null}
              <TextInput label="Serial number" isOptional value="" onChange={() => undefined} />
            </Grid>
            <VStack gap={2}>
              <Text weight="medium">Lock</Text>
              <SegmentedControl
                label="Lock"
                value={nd.lockType}
                onChange={(v) => setNewDevice({ ...nd, lockType: v as LockType })}
              >
                {(Object.keys(LOCK_TYPE_LABELS) as LockType[]).map((k) => (
                  <SegmentedControlItem key={k} value={k} label={LOCK_TYPE_LABELS[k]} />
                ))}
              </SegmentedControl>
            </VStack>
            {nd.lockType === 'PIN' || nd.lockType === 'PASSWORD' ? (
              <TextInput
                label={LOCK_TYPE_LABELS[nd.lockType]}
                type="password"
                inputMode={nd.lockType === 'PIN' ? 'numeric' : 'text'}
                autoComplete="off"
                value={nd.secret}
                onChange={(v) => setNewDevice({ ...nd, secret: v })}
                onEnter={confirmDevice}
                description="Encrypted. Staff see it only on an open ticket; deleted when the repair is closed."
              />
            ) : null}
            {nd.lockType === 'PATTERN' ? (
              <PatternLockInput
                value={nd.pattern}
                onChange={(p) => setNewDevice({ ...nd, pattern: p })}
                onConfirm={confirmDevice}
                hasError={showErrors}
              />
            ) : null}
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Button label="Use this device" onClick={confirmDevice} />
              {devices.length > 0 ? (
                <Button
                  label="Back to their devices"
                  variant="ghost"
                  onClick={() => {
                    setDeviceChoice(devices[0]!.id);
                    focusIn(deviceRef.current, 'input[type="radio"]:checked');
                  }}
                />
              ) : null}
            </HStack>
          </VStack>
        ) : null}
      </SectionCard>

      {/* 3. Issues */}
      <SectionCard index={3} title="Issues" isDone={issues.length > 0} sectionRef={issuesRef}>
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
                setIssueFilter('');
              }
            }}
            status={
              showErrors && issues.length === 0 && !description.trim()
                ? { type: 'error', message: 'Choose an issue or describe the problem' }
                : undefined
            }
          />
          <RovingGroup>
            <ToggleButtonGroup
              label="Common issues"
              type="multiple"
              value={issues}
              onChange={(v) => setIssues(((v as string[]) ?? []) as IssueCode[])}
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
              label={`${issues.includes(filteredIssues[0]) ? 'removes' : 'adds'} “${ISSUE_LABELS[filteredIssues[0]]}”`}
            />
          ) : null}
          <TextArea
            label="Describe the problem"
            isOptional
            rows={2}
            maxLength={1000}
            value={description}
            onChange={setDescription}
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
                  setChecklist(Object.fromEntries(checklistItems.map((i) => [i.key, 'PASS'])))
                }
              />
              <Button
                label="Won't power on (all untested)"
                size="sm"
                onClick={() =>
                  setChecklist(Object.fromEntries(checklistItems.map((i) => [i.key, 'UNTESTED'])))
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
                    value={checklist[item.key] ?? 'UNTESTED'}
                    onChange={(v) =>
                      setChecklist((c) => ({ ...c, [item.key]: v as ChecklistResult }))
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
              value={conditionNotes}
              onChange={setConditionNotes}
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
            value={accessories}
            onChange={(v) => setAccessories(((v as string[]) ?? []) as AccessoryCode[])}
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
        {accessories.includes('OTHER') ? (
          <TextInput label="What else?" value={accessoriesOther} onChange={setAccessoriesOther} />
        ) : (
          <Text type="supporting" color="secondary">
            {accessories.length
              ? `Left: ${accessories.map((a) => ACCESSORY_LABELS[a]).join(', ')}`
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
            description={`${ctx.pricesIncludeTax ? 'incl. tax' : 'excl. tax'} · itemised quotes come with the price list`}
            status={
              estimate.trim() && estimateMinor === null
                ? { type: 'error', message: 'Enter an amount' }
                : undefined
            }
          >
            <InputGroupText>{CURRENCY_PREFIX[ctx.currency]}</InputGroupText>
            <TextInput
              label="Amount"
              isLabelHidden
              inputMode="decimal"
              value={estimate}
              onChange={setEstimate}
              placeholder={ctx.currency === 'PKR' ? '0' : '0.00'}
            />
          </InputGroup>
          <DateInput
            label="Due"
            value={due as ISODateString}
            onChange={(v) => v && setDue(v)}
            min={today as ISODateString}
            description={`${ctx.defaultTurnaroundDays} open days, by closing time`}
            presentation="popover"
            status={dueProblem ? { type: 'error', message: dueProblem } : undefined}
          />
          <VStack gap={2}>
            <Text weight="medium">Priority</Text>
            <SegmentedControl
              label="Priority"
              value={priority}
              onChange={(v) => setPriority(v as 'NORMAL' | 'URGENT')}
            >
              <SegmentedControlItem value="NORMAL" label="Normal" />
              <SegmentedControlItem value="URGENT" label="Urgent" />
            </SegmentedControl>
          </VStack>
          <Selector
            label="Technician"
            value={assignee}
            onChange={(v) => setAssignee(v ?? '')}
            options={[
              { value: '', label: 'Unassigned' },
              ...MOCK_ASSIGNEES.map((a) => ({
                value: a.userId,
                label: a.isSelf ? `${a.name} (you)` : a.name,
                description: a.role === 'TECHNICIAN' ? 'Technician' : 'Owner',
              })),
            ]}
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
          <HStack gap={4} vAlign="center" hAlign="between">
            <Text maxLines={1} color="secondary" aria-live="polite">
              {summaryLine}
            </Text>
            <HStack gap={3} vAlign="center">
              <Kbd keys="mod+enter" />
              <Button label="Create ticket" variant="primary" onClick={create} />
            </HStack>
          </HStack>
          <Text type="supporting" color="secondary">
            Signed in as {me.user.name}. Drafts are kept on this device for 24 hours, without the
            passcode.
          </Text>
        </VStack>
      </Card>
    </VStack>
  );
}
