'use client';

/*
 * Check-in prototype (Sprint 2 A1, spec docs/screens/sprint2.md §2). Local mock data only.
 *
 * One page, eight sections in a 760 column, a pinned footer with the running summary and
 * "Create ticket". Sections that are pickers (Customer, Device) collapse to a one-line summary with a
 * "Change" button once chosen; the rest stay open. Focus moves forward on every confirm so the
 * returning-customer path never needs Tab:
 *
 *   type in Customer search → ↵ (first match) → ↵ (first device) → type issue → ↵ → ⌘↵ create
 *
 * The page counts keystrokes and time from load to create and shows them in the success banner, so
 * a hallway test gets numbers without extra tooling.
 */

import { Badge } from '@astryxdesign/core/Badge';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
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
import { CheckCircleIcon, PlusIcon } from '@heroicons/react/20/solid';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { PatternLockInput } from '@/components/ui/PatternLockInput';
import { PhoneText } from '@/components/ui/PhoneText';
import { ShortcutHint, ShortcutHints } from '@/components/ui/ShortcutHint';
import { patternError } from '@/lib/pattern-lock';
import { useSession } from '@/lib/shop-context';
import { addDays, formatLocalDate, todayInZone } from '@/lib/timezone';
import {
  ACCESSORIES,
  CHECKLIST,
  DEVICE_TYPE_LABEL,
  LOCK_LABEL,
  TECHNICIANS,
  filterIssues,
  imeiError,
  searchCustomers,
  searchModels,
  seedFromTyped,
  type DeviceType,
  type LockType,
  type MockCustomer,
  type MockDevice,
} from './check-in-model';

// ---------- Types ----------

type CheckState = 'PASS' | 'FAIL' | 'UNTESTED';

interface NewCustomer {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  consentSms: boolean;
  consentEmail: boolean;
  consentWhatsapp: boolean;
}

interface NewDevice {
  type: DeviceType;
  brand: string;
  model: string;
  colour: string;
  imei: string;
  lockType: LockType;
  pin: string;
  pattern: number[];
}

type CustomerItem = {
  id: string;
  label: string;
  auxiliaryData: { customer?: MockCustomer; device?: MockDevice; isNew?: boolean };
};

type ModelItem = {
  id: string;
  label: string;
  auxiliaryData: { type?: DeviceType; brand?: string; model: string };
};

const EMPTY_DEVICE: NewDevice = {
  type: 'PHONE',
  brand: '',
  model: '',
  colour: '',
  imei: '',
  lockType: 'NONE',
  pin: '',
  pattern: [],
};

const NEW_DEVICE = '__new__';

/** Keys that are typing, so single-letter shortcuts must not fire. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['radio', 'checkbox', 'button', 'submit'].includes(el.type);
  }
  return el.getAttribute('role') === 'combobox';
}

/** Today + n open days, skipping Sundays (mock business hours: closed Sunday). */
function defaultDue(today: string, openDays: number): string {
  let d = today;
  let left = openDays;
  while (left > 0) {
    d = addDays(d, 1);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) left -= 1;
  }
  return d;
}

/** Focus the control a visible label names (Astryx inputs take no id/ref, their labels do). */
function focusField(el: HTMLElement | null, label: string) {
  requestAnimationFrame(() => {
    const match = [...(el?.querySelectorAll('label') ?? [])].find((l) =>
      (l.textContent ?? '').trim().startsWith(label),
    );
    const id = match?.getAttribute('for');
    if (id) document.getElementById(id)?.focus();
  });
}

function focusIn(el: HTMLElement | null, selector: string) {
  // After a state change the target renders on the next frame.
  requestAnimationFrame(() => {
    const target = el?.querySelector<HTMLElement>(selector);
    target?.focus();
  });
}

const deviceLabel = (d: { brand: string; model: string }) => `${d.brand} ${d.model}`.trim();

// ---------- Section frame ----------

function SectionCard({
  index,
  title,
  summary,
  isDone,
  onChange,
  changeLabel,
  isOptional,
  children,
  sectionRef,
}: {
  index: number;
  title: string;
  summary?: ReactNode;
  isDone?: boolean;
  onChange?: () => void;
  changeLabel?: string;
  isOptional?: boolean;
  children?: ReactNode;
  sectionRef?: React.Ref<HTMLElement>;
}) {
  const headingId = `checkin-s${index}`;
  return (
    <Card padding={5}>
      <VStack gap={4} as="section" aria-labelledby={headingId} ref={sectionRef}>
        <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
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
            <Button label={changeLabel ?? `Change ${title.toLowerCase()}`} size="sm" variant="ghost" onClick={onChange}>
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
  const { shop } = useSession();
  const today = todayInZone(shop.timezone);

  // Instrumentation (DoD: time-to-create and keystrokes).
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
  const [issues, setIssues] = useState<string[]>([]);
  const [description, setDescription] = useState('');

  const [checklist, setChecklist] = useState<Record<string, CheckState>>(
    () => Object.fromEntries(CHECKLIST.map((c) => [c, 'UNTESTED'])) as Record<string, CheckState>,
  );
  const [conditionNotes, setConditionNotes] = useState('');
  const [accessories, setAccessories] = useState<string[]>([]);
  const [estimate, setEstimate] = useState('');
  const [due, setDue] = useState<string>(() => defaultDue(today, 2));
  const [priority, setPriority] = useState('NORMAL');
  const [technician, setTechnician] = useState<string>('');

  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<null | { number: string; seconds: number; keys: number; summary: string }>(
    null,
  );

  const customerRef = useRef<HTMLElement>(null);
  const deviceRef = useRef<HTMLElement>(null);
  const issuesRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);

  // ----- Derived -----
  const devices = useMemo(
    () => [...(customer?.devices ?? [])].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed)),
    [customer],
  );
  const chosenDevice = devices.find((d) => d.id === deviceChoice) ?? null;
  const customerName = customer
    ? customer.name
    : newCustomer
      ? `${newCustomer.firstName} ${newCustomer.lastName}`.trim()
      : '';
  const deviceName = chosenDevice
    ? deviceLabel(chosenDevice)
    : newDevice && newDevice.model
      ? deviceLabel(newDevice)
      : '';
  const filteredIssues = filterIssues(issueFilter);
  const failCount = Object.values(checklist).filter((v) => v === 'FAIL').length;
  const passCount = Object.values(checklist).filter((v) => v === 'PASS').length;

  const problems: { key: 'customer' | 'device' | 'issues'; text: string }[] = [];
  if (!customerDone) {
    problems.push({
      key: 'customer',
      text: newCustomer ? 'Finish the new customer' : 'Choose a customer',
    });
  }
  if (!deviceDone) {
    problems.push({
      key: 'device',
      text: 'Choose a device',
    });
  }
  if (issues.length === 0 && !description.trim()) {
    problems.push({
      key: 'issues',
      text: 'Pick an issue or describe the problem',
    });
  }

  const summaryLine = [
    customerName || 'No customer',
    deviceName || 'No device',
    issues.length ? issues.join(', ') : description.trim() ? 'Described' : 'No issue',
    `Due ${formatLocalDate(due, shop.locale, false)}`,
    priority === 'URGENT' ? 'Urgent' : null,
    TECHNICIANS.find((t) => t.id === technician)?.name ?? 'Unassigned',
  ]
    .filter(Boolean)
    .join(' · ');

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
    setCreated({ number: 'T-1042', seconds, keys: keystrokes.current, summary: summaryLine });
  };

  const pickCustomer = (item: CustomerItem | null) => {
    if (!item) return;
    if (item.auxiliaryData.isNew) {
      const seed = seedFromTyped(query);
      setCustomer(null);
      setNewCustomer({ ...seed, consentSms: false, consentEmail: false, consentWhatsapp: false });
      setNewDevice({ ...EMPTY_DEVICE });
      setDeviceChoice(NEW_DEVICE);
      focusIn(customerRef.current, seed.firstName ? 'input[type="tel"]' : 'input');
      return;
    }
    const c = item.auxiliaryData.customer!;
    setCustomer(c);
    setNewCustomer(null);
    setCustomerDone(true);
    const sorted = [...c.devices].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
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
    const ok = newCustomer.firstName.trim() && (newCustomer.phone.trim() || newCustomer.email.trim());
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
    if (newCustomer) {
      focusIn(customerRef.current, 'input');
      return;
    }
    setCustomer(null);
    setQuery('');
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
    focusIn(deviceRef.current, 'input[role="combobox"], input');
  };

  const toggleIssue = (issue: string) =>
    setIssues((prev) => (prev.includes(issue) ? prev.filter((i) => i !== issue) : [...prev, issue]));

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
    if (e.key === 'Escape' && newCustomer && !customerDone && customerRef.current?.contains(e.target as Node)) {
      e.preventDefault();
      setNewCustomer(null);
      setNewDevice(null);
      focusIn(customerRef.current, 'input');
    }
  };

  const onDeviceListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'radio') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (deviceChoice === NEW_DEVICE) startNewDevice();
        else confirmDevice();
      } else if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        startNewDevice();
      }
    }
  };

  const onChecklistKeyDown = (e: KeyboardEvent<HTMLElement>, item: string, idx: number) => {
    const map: Record<string, CheckState> = { p: 'PASS', f: 'FAIL', u: 'UNTESTED' };
    const next = map[e.key.toLowerCase()];
    if (!next || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setChecklist((c) => ({ ...c, [item]: next }));
    // Move down to the next row's segmented control (P/F/U "set and move down").
    const nextRow = e.currentTarget.nextElementSibling;
    if (idx < CHECKLIST.length - 1) {
      nextRow
        ?.querySelector<HTMLElement>('[aria-checked="true"], input:checked, [role="radio"]')
        ?.focus();
    }
  };

  // ----- Customer search source -----
  const customerSource = useMemo(
    () => ({
      bootstrap: () => [] as CustomerItem[],
      search: (q: string): CustomerItem[] => {
        const matches = searchCustomers(q).map<CustomerItem>((m) => ({
          id: m.customer.id,
          label: m.customer.name,
          auxiliaryData: { customer: m.customer, device: m.device },
        }));
        return [...matches, { id: '__new_customer__', label: `New customer “${q.trim()}”`, auxiliaryData: { isNew: true } }];
      },
    }),
    [],
  );

  const modelSource = useMemo(
    () => ({
      bootstrap: () => [] as ModelItem[],
      search: (q: string): ModelItem[] => [
        ...searchModels(q).map<ModelItem>((m) => ({
          id: `${m.brand}|${m.model}`,
          label: `${m.brand} ${m.model}`,
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
          status="success"
          title={`Ticket ${created.number} created`}
          description={created.summary}
        >
          <Text>
            Checked in in {created.seconds.toFixed(1)} s with {created.keys} keystrokes.
          </Text>
        </Banner>
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

  return (
    <VStack gap={4} maxWidth={760} as="form" aria-labelledby="checkin-title" onKeyDown={onFormKeyDown} onSubmit={(e: React.FormEvent) => e.preventDefault()}>
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
            { keys: 'enter', label: 'Choose / next' },
            { keys: 'mod+enter', label: 'Create ticket' },
            { keys: '/', label: 'Customer search' },
            { keys: 'escape', label: 'Close / cancel' },
          ]}
        />
      </VStack>

      {/* 1. Customer */}
      <SectionCard
        index={1}
        title="Customer"
        isDone={customerDone}
        summary={customer ? `${customer.name}` : nc ? `${customerName} (new)` : undefined}
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
                  <TypeaheadItem item={item} icon={<Icon icon={PlusIcon} size="sm" />} description="Add them without leaving check-in" />
                ) : (
                  <TypeaheadItem
                    item={item}
                    description={[
                      item.auxiliaryData.customer!.archived ? 'Archived · Restore and use' : null,
                      item.auxiliaryData.device
                        ? `IMEI match: ${deviceLabel(item.auxiliaryData.device)}`
                        : item.auxiliaryData.customer!.devices[0]
                          ? deviceLabel(item.auxiliaryData.customer!.devices[0])
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
                status={showErrors && !nc.firstName.trim() ? { type: 'error', message: 'Enter a first name' } : undefined}
              />
              <TextInput label="Last name" isOptional value={nc.lastName} onChange={(v) => setNewCustomer({ ...nc, lastName: v })} />
              <TextInput
                label="Phone"
                type="tel"
                inputMode="tel"
                value={nc.phone}
                onChange={(v) => setNewCustomer({ ...nc, phone: v })}
                onEnter={confirmNewCustomer}
                description="Mobile · used for repair updates"
                status={
                  showErrors && !nc.phone.trim() && !nc.email.trim()
                    ? { type: 'error', message: 'Add a phone number or an email' }
                    : undefined
                }
              />
              <TextInput label="Email" type="email" isOptional value={nc.email} onChange={(v) => setNewCustomer({ ...nc, email: v })} onEnter={confirmNewCustomer} />
            </Grid>
            <Collapsible
              defaultIsOpen={false}
              trigger={<Text weight="medium">Marketing consent · none given</Text>}
            >
              <VStack gap={2} paddingBlockStart={2}>
                <Switch label="Marketing by SMS" value={nc.consentSms} onChange={(v) => setNewCustomer({ ...nc, consentSms: v })} />
                <Switch label="Marketing by email" value={nc.consentEmail} onChange={(v) => setNewCustomer({ ...nc, consentEmail: v })} />
                <Switch label="Marketing by WhatsApp" value={nc.consentWhatsapp} onChange={(v) => setNewCustomer({ ...nc, consentWhatsapp: v })} />
              </VStack>
            </Collapsible>
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Button label="Use this customer" variant="secondary" onClick={confirmNewCustomer} />
              <ShortcutHint keys="enter" label="in Phone or Email" />
              <ShortcutHint keys="escape" label="back to search" />
            </HStack>
          </VStack>
        ) : null}

        {customerDone && customer ? (
          <VStack gap={3}>
            <HStack gap={4} wrap="wrap" vAlign="center">
              <PhoneText e164={customer.phone} shopCountry={shop.country} isCallable />
              {customer.email ? <Text color="secondary">{customer.email}</Text> : null}
            </HStack>
            {customer.note ? <Banner status="info" title="Customer note" description={customer.note} /> : null}
            {customer.archived ? (
              <Banner status="warning" title="Restored" description="This customer was archived. Creating the ticket restores them." />
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
                    DEVICE_TYPE_LABEL[d.type],
                    d.colour,
                    d.imei ? `IMEI …${d.imei.slice(-4)}` : null,
                    d.lockType === 'NONE' ? 'No lock' : `${LOCK_LABEL[d.lockType]} on file`,
                    d.openTicket ? `${d.openTicket} is still open` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
              <RadioListItem value={NEW_DEVICE} label="New device" description="Press D from the list" />
            </RadioList>
            {chosenDevice?.openTicket ? (
              <Banner
                status="warning"
                title={`${chosenDevice.openTicket} is still open for this device`}
                description="You can still check it in, for example for a second fault."
              />
            ) : null}
            <ShortcutHints
              label="Device list shortcuts"
              hints={[
                { keys: 'up+down', label: 'Choose' },
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
                setNewDevice({ ...nd, model: a.model, brand: a.brand ?? nd.brand, type: a.type ?? nd.type });
                focusField(deviceRef.current, 'IMEI');
              }}
              minQueryLength={1}
              maxMenuItems={8}
              status={showErrors && !nd.model ? { type: 'error', message: 'Enter the model' } : undefined}
            />
            <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
              <Selector
                label="Type"
                value={nd.type}
                onChange={(v) => v && setNewDevice({ ...nd, type: v as DeviceType })}
                options={Object.entries(DEVICE_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
              />
              <TextInput label="Brand" value={nd.brand} onChange={(v) => setNewDevice({ ...nd, brand: v })} />
              <TextInput label="Colour" isOptional value={nd.colour} onChange={(v) => setNewDevice({ ...nd, colour: v })} />
            </Grid>
            <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
              <TextInput
                  label="IMEI"
                  isOptional
                  inputMode="numeric"
                  description="Scan it, or dial *#06#"
                  value={nd.imei}
                  onChange={(v) => setNewDevice({ ...nd, imei: v })}
                  // A scanner ends with Enter: move on instead of submitting (DV edge case).
                  onEnter={() =>
                  focusIn(deviceRef.current, '[role="radiogroup"][aria-label="Lock"] [aria-checked="true"]')
                }
                  status={nd.imei && imeiProblem && (showErrors || nd.imei.replace(/\D/g, '').length >= 15) ? { type: 'error', message: imeiProblem } : undefined}
                />
              <TextInput label="Serial number" isOptional value="" onChange={() => undefined} />
            </Grid>
            <VStack gap={2}>
              <Text weight="medium">Lock</Text>
              <SegmentedControl label="Lock" value={nd.lockType} onChange={(v) => setNewDevice({ ...nd, lockType: v as LockType })}>
                {(Object.keys(LOCK_LABEL) as LockType[]).map((k) => (
                  <SegmentedControlItem key={k} value={k} label={LOCK_LABEL[k]} />
                ))}
              </SegmentedControl>
            </VStack>
            {nd.lockType === 'PIN' || nd.lockType === 'PASSWORD' ? (
              <TextInput
                label={nd.lockType === 'PIN' ? 'PIN / passcode' : 'Password'}
                type="password"
                inputMode={nd.lockType === 'PIN' ? 'numeric' : 'text'}
                autoComplete="off"
                value={nd.pin}
                onChange={(v) => setNewDevice({ ...nd, pin: v })}
                onEnter={confirmDevice}
                description="Encrypted. Shown to staff only on an open ticket, and deleted when the repair is closed."
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
              <Button label="Use this device" variant="secondary" onClick={confirmDevice} />
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
            placeholder="Type to filter, ↵ to add (e.g. scr → Screen cracked)"
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
                ? { type: 'error', message: 'Pick at least one issue or describe the problem' }
                : undefined
            }
          />
          <ToggleButtonGroup
            label="Common issues"
            type="multiple"
            value={issues}
            onChange={(v) => setIssues((v as string[]) ?? [])}
            size="sm"
          >
            {(issueFilter.trim() ? filteredIssues : filterIssues('')).map((issue) => (
              <ToggleButton key={issue} value={issue} label={issue}>
                {issue}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          {issueFilter.trim() && filteredIssues[0] ? (
            <ShortcutHint keys="enter" label={`${issues.includes(filteredIssues[0]) ? 'removes' : 'adds'} “${filteredIssues[0]}”`} />
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
              Pre-repair checklist · {passCount} pass · {failCount} fail · {CHECKLIST.length - passCount - failCount} untested
            </Text>
          }
        >
          <VStack gap={3} paddingBlockStart={3}>
            <HStack gap={2} wrap="wrap">
              <Button
                label="All pass"
                size="sm"
                onClick={() => setChecklist(Object.fromEntries(CHECKLIST.map((c) => [c, 'PASS'])) as Record<string, CheckState>)}
              />
              <Button
                label="Won't power on (all untested)"
                size="sm"
                onClick={() => setChecklist(Object.fromEntries(CHECKLIST.map((c) => [c, 'UNTESTED'])) as Record<string, CheckState>)}
              />
              <ShortcutHint keys="p" label="pass" />
              <ShortcutHint keys="f" label="fail" />
              <ShortcutHint keys="u" label="untested" />
            </HStack>
            <VStack gap={1}>
              {CHECKLIST.map((item, idx) => (
                <HStack key={item} gap={3} vAlign="center" hAlign="between" data-check-row onKeyDown={(e: KeyboardEvent<HTMLElement>) => onChecklistKeyDown(e, item, idx)}>
                  <Text>{item}</Text>
                  <SegmentedControl label={item} size="sm" value={checklist[item] ?? 'UNTESTED'} onChange={(v) => setChecklist((c) => ({ ...c, [item]: v as CheckState }))}>
                    <SegmentedControlItem value="PASS" label="Pass" />
                    <SegmentedControlItem value="FAIL" label="Fail" />
                    <SegmentedControlItem value="UNTESTED" label="Untested" />
                  </SegmentedControl>
                </HStack>
              ))}
            </VStack>
            <TextArea label="Condition notes" isOptional rows={2} value={conditionNotes} onChange={setConditionNotes} placeholder="e.g. scratches on the back, dent on the corner" />
          </VStack>
        </Collapsible>
      </SectionCard>

      {/* 5. Accessories */}
      <SectionCard index={5} title="Accessories left" isOptional>
        <ToggleButtonGroup label="Accessories left with the device" type="multiple" value={accessories} onChange={(v) => setAccessories((v as string[]) ?? [])} size="sm">
          {ACCESSORIES.map((a) => (
            <ToggleButton key={a} value={a} label={a}>
              {a}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Text type="supporting" color="secondary">
          {accessories.length ? `Left: ${accessories.join(', ')}` : 'Nothing left with the device'}
        </Text>
      </SectionCard>

      {/* 6. Estimate, due, priority, technician */}
      <SectionCard index={6} title="Estimate, due date and technician">
        <Grid columns={{ minWidth: 200, max: 2 }} gap={4}>
          <InputGroup label="Estimate (approximate)" isOptional description={shop.pricesIncludeTax ? 'Including tax' : 'Excluding tax'}>
            <InputGroupText>{shop.currency === 'GBP' ? '£' : shop.currency === 'USD' ? '$' : 'Rs'}</InputGroupText>
            <TextInput label="Amount" isLabelHidden inputMode="decimal" value={estimate} onChange={setEstimate} placeholder="0.00" />
          </InputGroup>
          <DateInput
            label="Due"
            value={due as ISODateString}
            onChange={(v) => v && setDue(v)}
            min={today as ISODateString}
            description="2 open days, by closing time"
            presentation="popover"
          />
          <VStack gap={2}>
            <Text weight="medium">Priority</Text>
            <SegmentedControl label="Priority" value={priority} onChange={setPriority}>
              <SegmentedControlItem value="NORMAL" label="Normal" />
              <SegmentedControlItem value="URGENT" label="Urgent" />
            </SegmentedControl>
          </VStack>
          <Selector
            label="Technician"
            value={technician}
            onChange={(v) => setTechnician(v ?? '')}
            options={[
              { value: '', label: 'Unassigned' },
              ...TECHNICIANS.map((t) => ({ value: t.id, label: t.name, description: t.role })),
            ]}
          />
        </Grid>
      </SectionCard>

      {/* Footer: pinned summary + create */}
      <Card padding={4} elevation="med" style={{ position: 'sticky', bottom: 'var(--spacing-4)' }}>
        <VStack gap={2} as="section" aria-label="Ticket summary" ref={footerRef}>
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
        </VStack>
      </Card>
    </VStack>
  );
}
