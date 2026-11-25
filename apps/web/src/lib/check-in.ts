/**
 * Check-in model (spec §2, A1): the page state, the POST /api/tickets body built from it, the
 * browser draft (TK3: 24 h, per user + shop, never the passcode) and small search helpers.
 * Pure apart from the guarded storage functions, and unit-tested.
 */
import {
  CHECK_IN_DRAFT_TTL_HOURS,
  IMEI_ERROR,
  IMEI_LENGTH_HINT,
  ISSUE_LABELS,
  ISSUE_PRESETS_BY_DEVICE_TYPE,
  checkInDraftKey,
  isValidImei,
  normalizeImei,
  normalizePhone,
  parseMajorAmount,
  splitQuickCreateText,
  type AccessoryCode,
  type ChecklistItemKey,
  type ChecklistResult,
  type ConsentChannel,
  type ConsentSource,
  type CountryCode,
  type CreateTicketInput,
  type CurrencyCode,
  type DeviceTypeValue,
  type IssueCode,
  type LockType,
  type PasscodeInput,
  type TicketPriority,
} from '@repairos/contracts';
import { z } from 'zod';

export const NEW_DEVICE = '__new__';

export interface CustomerPick {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  email: string | null;
  archived: boolean;
}

export interface DevicePick {
  id: string;
  type: DeviceTypeValue;
  brand: string;
  model: string;
}

export interface NewCustomerDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  consents: Record<ConsentChannel, boolean>;
  consentSource: ConsentSource;
}

export interface LockDraft {
  lockType: LockType;
  /** PIN or password. Never stored in a draft. */
  secret: string;
  /** Pattern dots. Never stored in a draft. */
  pattern: number[];
}

export interface NewDeviceDraft extends LockDraft {
  type: DeviceTypeValue;
  brand: string;
  model: string;
  colour: string;
  imei: string;
  serial: string;
}

export interface CheckInState {
  customer: CustomerPick | null;
  newCustomer: NewCustomerDraft | null;
  customerDone: boolean;
  /** Radio value: an existing device id, NEW_DEVICE, or '' (nothing yet). */
  deviceChoice: string;
  /** The chosen existing device (from the customer's list or an IMEI lookup). */
  device: DevicePick | null;
  newDevice: NewDeviceDraft | null;
  /** Re-entered lock for an existing device whose passcode was deleted ("No passcode on file · Add"). */
  devicePasscode: LockDraft | null;
  deviceDone: boolean;
  issues: IssueCode[];
  description: string;
  checklist: Partial<Record<ChecklistItemKey, ChecklistResult>>;
  conditionNotes: string;
  accessories: AccessoryCode[];
  accessoriesOther: string;
  estimate: string;
  due: string;
  dueTime: string;
  priority: TicketPriority;
  assignee: string;
  warrantyOfTicketId: string | null;
}

export const EMPTY_LOCK: LockDraft = { lockType: 'NONE', secret: '', pattern: [] };

export const EMPTY_NEW_DEVICE: NewDeviceDraft = {
  type: 'PHONE',
  brand: '',
  model: '',
  colour: '',
  imei: '',
  serial: '',
  ...EMPTY_LOCK,
};

export function emptyCheckIn(defaultDue: string): CheckInState {
  return {
    customer: null,
    newCustomer: null,
    customerDone: false,
    deviceChoice: '',
    device: null,
    newDevice: null,
    devicePasscode: null,
    deviceDone: false,
    issues: [],
    description: '',
    checklist: {},
    conditionNotes: '',
    accessories: [],
    accessoriesOther: '',
    estimate: '',
    due: defaultDue,
    dueTime: '',
    priority: 'NORMAL',
    assignee: '',
    warrantyOfTicketId: null,
  };
}

// ---------- Body ----------

export function passcodeOf(lock: LockDraft): PasscodeInput {
  switch (lock.lockType) {
    case 'PIN':
    case 'PASSWORD':
      return { lockType: lock.lockType, value: lock.secret };
    case 'PATTERN':
      return { lockType: 'PATTERN', pattern: lock.pattern };
    default:
      return { lockType: lock.lockType };
  }
}

/** The POST /api/tickets body (sent with `Idempotency-Key` and `X-Shop-Id`). */
export function buildCreateTicketInput(s: CheckInState, currency: CurrencyCode): CreateTicketInput {
  const nc = s.newCustomer;
  const nd = s.newDevice;
  const estimateMinor = s.estimate.trim() ? parseMajorAmount(s.estimate, currency) : null;
  const existingDevice = s.deviceChoice !== NEW_DEVICE && s.device ? s.device : null;
  return {
    ...(s.customer
      ? { customerId: s.customer.id }
      : nc
        ? {
            newCustomer: {
              kind: 'PERSON',
              firstName: nc.firstName.trim() || null,
              lastName: nc.lastName.trim() || null,
              email: nc.email.trim() || null,
              phones: nc.phone.trim() ? [{ number: nc.phone.trim(), label: 'MOBILE' }] : [],
              consents: (Object.keys(nc.consents) as ConsentChannel[])
                .filter((c) => nc.consents[c])
                .map((channel) => ({
                  channel,
                  state: 'GRANTED' as const,
                  source: nc.consentSource,
                })),
            },
          }
        : {}),
    ...(existingDevice
      ? {
          deviceId: existingDevice.id,
          ...(s.devicePasscode ? { devicePasscode: passcodeOf(s.devicePasscode) } : {}),
        }
      : nd
        ? {
            newDevice: {
              type: nd.type,
              brand: nd.brand.trim(),
              model: nd.model.trim(),
              colour: nd.colour.trim() || null,
              imei: nd.imei.trim() || null,
              serial: nd.serial.trim() || null,
              notes: null,
              passcode: passcodeOf(nd),
            },
          }
        : {}),
    issues: s.issues.map((code) => ({ code })),
    description: s.description.trim() || null,
    checklist: s.checklist as Record<ChecklistItemKey, ChecklistResult>,
    conditionNotes: s.conditionNotes.trim() || null,
    accessories: s.accessories,
    accessoriesOther: s.accessories.includes('OTHER') ? s.accessoriesOther.trim() || null : null,
    estimate: estimateMinor === null ? null : { amountMinor: estimateMinor, currency },
    dueDate: s.due,
    dueTime: s.dueTime || null,
    priority: s.priority,
    assigneeUserId: s.assignee || null,
    ...(s.warrantyOfTicketId ? { warrantyOfTicketId: s.warrantyOfTicketId } : {}),
  };
}

export type ProblemKey = 'customer' | 'device' | 'issues';

/** What blocks Create, in page order ("Before creating: …"). */
export function checkInProblems(s: CheckInState): { key: ProblemKey; text: string }[] {
  const out: { key: ProblemKey; text: string }[] = [];
  if (!s.customerDone) {
    out.push({
      key: 'customer',
      text: s.newCustomer ? 'Finish the new customer' : 'Choose a customer',
    });
  }
  if (!s.deviceDone) out.push({ key: 'device', text: 'Choose a device' });
  if (s.issues.length === 0 && !s.description.trim()) {
    out.push({ key: 'issues', text: 'Pick an issue or describe the problem' });
  }
  return out;
}

// ---------- Draft (TK3) ----------

const DraftSchema = z.object({
  v: z.literal(1),
  savedAt: z.string(),
  idempotencyKey: z.string(),
  /** A passcode was entered and dropped: ask for it again. */
  hadSecret: z.boolean(),
  state: z.record(z.unknown()),
});
export type CheckInDraft = Omit<z.infer<typeof DraftSchema>, 'state'> & { state: CheckInState };

const hasSecret = (l: LockDraft | null) => !!l && (l.secret !== '' || l.pattern.length > 0);
const stripLock = <T extends LockDraft>(l: T): T => ({ ...l, secret: '', pattern: [] });

/** The state as stored: never the PIN, password or pattern. */
export function draftState(s: CheckInState): { state: CheckInState; hadSecret: boolean } {
  return {
    state: {
      ...s,
      newDevice: s.newDevice ? stripLock(s.newDevice) : null,
      devicePasscode: s.devicePasscode ? stripLock(s.devicePasscode) : null,
    },
    hadSecret: hasSecret(s.newDevice) || hasSecret(s.devicePasscode),
  };
}

/** Worth keeping as a draft: anything beyond the defaults. */
export function isWorthDrafting(s: CheckInState): boolean {
  return !!(
    s.customer ||
    s.newCustomer ||
    s.issues.length ||
    s.description.trim() ||
    s.conditionNotes.trim() ||
    s.accessories.length ||
    s.estimate.trim()
  );
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft(userId: string, shopId: string, now = Date.now()): CheckInDraft | null {
  try {
    const key = checkInDraftKey(userId, shopId);
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const parsed = DraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (now - Date.parse(parsed.data.savedAt) > CHECK_IN_DRAFT_TTL_HOURS * 3_600_000) {
      storage()?.removeItem(key);
      return null;
    }
    return parsed.data as unknown as CheckInDraft;
  } catch {
    return null;
  }
}

export function writeDraft(
  userId: string,
  shopId: string,
  s: CheckInState,
  idempotencyKey: string,
  now = new Date(),
): void {
  try {
    const { state, hadSecret } = draftState(s);
    const draft: CheckInDraft = {
      v: 1,
      savedAt: now.toISOString(),
      idempotencyKey,
      hadSecret,
      state,
    };
    storage()?.setItem(checkInDraftKey(userId, shopId), JSON.stringify(draft));
  } catch {
    // storage full or blocked: drafts are a convenience only
  }
}

export function clearDraft(userId: string, shopId: string): void {
  try {
    storage()?.removeItem(checkInDraftKey(userId, shopId));
  } catch {
    // ignore
  }
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.floor(Math.random() * 16) >> (Number(c) / 4))).toString(16),
      );
}

// ---------- Search helpers ----------

export interface QuickCustomerSeed {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

/** TK2.1 via the contract's `splitQuickCreateText`, as the quick form's four fields. */
export function seedFromTyped(typed: string): QuickCustomerSeed {
  const seed = { firstName: '', lastName: '', phone: '', email: '' };
  if (!typed.trim()) return seed;
  const split = splitQuickCreateText(typed);
  if ('email' in split) return { ...seed, email: split.email };
  if ('phone' in split) return { ...seed, phone: split.phone };
  return { ...seed, firstName: split.firstName, lastName: split.lastName ?? '' };
}

/** The first quick-form field the typed text didn't fill. */
export function firstEmptyQuickField(seed: QuickCustomerSeed): 'First name' | 'Phone' | 'Email' {
  if (!seed.firstName) return 'First name';
  if (!seed.phone) return 'Phone';
  return 'Email';
}

/** The contract's phone message (`createCustomerSchema` → phones.n.number). */
export const PHONE_ERROR = 'Enter a valid phone number';

/** Field message for a phone input (contract copy), null when empty or valid (CU1.2, BUG-01). */
export function phoneError(raw: string, country: CountryCode): string | null {
  return raw.trim() && !normalizePhone(raw, country) ? PHONE_ERROR : null;
}

/** Field message for the IMEI input (contract copy), null when empty or valid. */
export function imeiError(raw: string): string | null {
  const s = normalizeImei(raw);
  if (!s || isValidImei(s)) return null;
  return /^\d+$/.test(s) && (s.length === 14 || s.length === 16)
    ? `${IMEI_ERROR} ${IMEI_LENGTH_HINT}`
    : IMEI_ERROR;
}

/** A complete IMEI typed or scanned into a search box (the scanner path, R6). */
export function looksLikeImei(q: string): boolean {
  return /^[\d\s\-/]+$/.test(q.trim()) && isValidImei(q);
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Issue chips for a device type, matching the filter (word prefix first, then contains). */
export function filterIssues(query: string, type: DeviceTypeValue): IssueCode[] {
  const presets = ISSUE_PRESETS_BY_DEVICE_TYPE[type];
  const q = fold(query.trim());
  if (!q) return [...presets];
  const label = (c: IssueCode) => fold(ISSUE_LABELS[c]);
  const starts = presets.filter((c) =>
    label(c)
      .split(/[\s/]+/)
      .some((w) => w.startsWith(q)),
  );
  const contains = presets.filter((c) => !starts.includes(c) && label(c).includes(q));
  return [...starts, ...contains];
}
