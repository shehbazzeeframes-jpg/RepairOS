import { z } from 'zod';
import { IsoDateTime } from './common';
import { DEVICE_TYPES, IMEI_DEVICE_TYPES } from './device-catalogue';
import { optionalText } from './validators';

/**
 * Devices (Sprint 2 story §2). A device belongs to one customer; tickets reference one device (A21).
 * Passcodes are encrypted at rest (AES-256-GCM, `FIELD_ENCRYPTION_KEY` + key id) and are NEVER returned by normal
 * reads, logs, audit before/after, exports, drafts or the ticket timeline (A15). Reads return only `lockType`,
 * `passcodeOnFile` and `passcodeSetAt`.
 */

export const DeviceType = z.enum(DEVICE_TYPES);
export type DeviceType = z.infer<typeof DeviceType>;

// ---------- IMEI ----------

export const IMEI_ERROR = "This IMEI isn't valid. Check the 15 digits (dial *#06# on the phone).";
export const IMEI_LENGTH_HINT = 'IMEI has 15 digits';

/** Removes spaces, dashes and slashes (scanner/typing formats). Does not validate. */
export function normalizeImei(raw: string): string {
  return raw.replace(/[\s\-/]/g, '');
}

/** Luhn checksum over a digit string (any length ≥ 2). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** True when `raw` (after `normalizeImei`) is exactly 15 digits and passes Luhn. */
export function isValidImei(raw: string): boolean {
  const s = normalizeImei(raw);
  return /^\d{15}$/.test(s) && luhnValid(s);
}

/**
 * IMEI field: normalised (spaces/dashes/slashes removed), exactly 15 digits, Luhn-valid.
 * 14 or 16 digits (IMEISV) → message `IMEI_ERROR` + " " + `IMEI_LENGTH_HINT`; other failures → `IMEI_ERROR`.
 * Output: the 15-digit string (kept as a string: leading zeros matter).
 */
export const Imei = z.string().transform((raw, ctx) => {
  const s = normalizeImei(raw);
  if (/^\d{15}$/.test(s) && luhnValid(s)) return s;
  const lengthIssue = /^\d+$/.test(s) && s.length !== 15;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: lengthIssue ? `${IMEI_ERROR} ${IMEI_LENGTH_HINT}` : IMEI_ERROR });
  return z.NEVER;
});

// ---------- Serial ----------

export const SERIAL_ERROR = 'Use 4–30 letters and numbers';

/** Trimmed, spaces/dashes removed, upper-cased; must be 4–30 `[A-Z0-9]`. Null when invalid or empty. */
export function normalizeSerial(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{4,30}$/.test(s) ? s : null;
}

export const Serial = z.string().transform((raw, ctx) => {
  const s = normalizeSerial(raw);
  if (s) return s;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: SERIAL_ERROR });
  return z.NEVER;
});

/** Optional IMEI/serial: "", null or absent → null. Wrap in `.optional()` to keep absent as undefined (PATCH). */
const optionalOf = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([z.literal(''), z.null(), schema])
    .optional()
    .transform((v) => (v === '' || v === null || v === undefined ? null : (v as z.output<T>)));

// ---------- Passcode ----------

export const LockType = z.enum(['NONE', 'PIN', 'PASSWORD', 'PATTERN', 'NOT_SHARED']);
export type LockType = z.infer<typeof LockType>;

export const LOCK_TYPE_LABELS: Record<LockType, string> = {
  NONE: 'None',
  PIN: 'PIN/passcode',
  PASSWORD: 'Password',
  PATTERN: 'Pattern',
  NOT_SHARED: "Customer won't share",
};

/** Lock types that carry a secret value (encrypted at rest). */
export const SECRET_LOCK_TYPES: readonly LockType[] = ['PIN', 'PASSWORD', 'PATTERN'];

/**
 * 3×3 pattern lock: ordered dots, numbered 1–9 left-to-right, top-to-bottom; 4–9 distinct dots.
 * Stored (encrypted) as the dot sequence string `formatPattern(p)`, e.g. "1-5-9-6".
 */
export const PatternLock = z
  .array(z.number().int().min(1).max(9))
  .min(4, 'Connect at least 4 dots')
  .max(9)
  .refine((p) => new Set(p).size === p.length, 'Each dot can be used once');
export type PatternLock = z.infer<typeof PatternLock>;

/** [1, 5, 9, 6] → "1-5-9-6" */
export function formatPattern(p: readonly number[]): string {
  return p.join('-');
}

/** "1-5-9-6" → [1, 5, 9, 6]; null when not a valid `PatternLock`. */
export function parsePattern(s: string): PatternLock | null {
  if (!/^[1-9](-[1-9])*$/.test(s)) return null;
  const parsed = PatternLock.safeParse(s.split('-').map(Number));
  return parsed.success ? parsed.data : null;
}

/** PIN: digits only, 4–16 (a string: leading zeros are kept). */
export const PinCode = z.string().regex(/^\d{4,16}$/, 'Use 4–16 digits');
/** Password: any printable characters (no control characters), 1–64. Not trimmed. */
export const PasswordCode = z
  .string()
  .min(1, 'Enter the password')
  .max(64, 'Use 64 characters or fewer')
  .regex(/^[^\p{C}]+$/u, 'Use printable characters only');

/**
 * Passcode set/replace/clear. `NONE` and `NOT_SHARED` clear any stored secret.
 * Setting, changing or clearing writes `device.passcode_changed` (before/after `{ lockType }`, never the value) and
 * requires `customers.manage`. Never stored in web drafts (TK3.3).
 */
export const PasscodeInput = z.discriminatedUnion('lockType', [
  z.object({ lockType: z.literal('NONE') }).strict(),
  z.object({ lockType: z.literal('NOT_SHARED') }).strict(),
  z.object({ lockType: z.literal('PIN'), value: PinCode }).strict(),
  z.object({ lockType: z.literal('PASSWORD'), value: PasswordCode }).strict(),
  z.object({ lockType: z.literal('PATTERN'), pattern: PatternLock }).strict(),
]);
export type PasscodeInput = z.infer<typeof PasscodeInput>;

/** Rate limit on reveals per user per hour (DV4.4) → 429 RATE_LIMITED. */
export const PASSCODE_REVEALS_PER_HOUR = 30;
/** How long the UI shows a revealed passcode before masking it again (DV4.1). */
export const PASSCODE_REVEAL_SECONDS = 30;

/**
 * POST /api/tickets/:ticketId/passcode/reveal · permission `tickets.view_passcode`, no body → 200 `PasscodeReveal`.
 * Response header `Cache-Control: no-store`. Never a GET. Decrypts the passcode of the ticket's device, increments
 * the device's view count, audits `device.passcode_viewed` (after `{ deviceId, ticketId }`).
 * Errors: 403 FORBIDDEN, 403 PASSCODE_NOT_AVAILABLE (ticket in a closed category), 404 NOT_FOUND (ticket not in
 * this shop, or no passcode on file: lockType NONE/NOT_SHARED or deleted on close), 429 RATE_LIMITED
 * (> 30 reveals per user per hour), 500 PASSCODE_UNREADABLE (decryption failed; logged without the value).
 * The web shows it for `PASSCODE_REVEAL_SECONDS`, no copy button, never in URL/title/storage.
 */
export const PasscodeReveal = z.discriminatedUnion('lockType', [
  z.object({ lockType: z.literal('PIN'), value: z.string(), viewCount: z.number().int(), revealedAt: IsoDateTime }),
  z.object({ lockType: z.literal('PASSWORD'), value: z.string(), viewCount: z.number().int(), revealedAt: IsoDateTime }),
  z.object({ lockType: z.literal('PATTERN'), pattern: PatternLock, viewCount: z.number().int(), revealedAt: IsoDateTime }),
]);
export type PasscodeReveal = z.infer<typeof PasscodeReveal>;

export const passcodeRevealPath = (ticketId: string) => `/api/tickets/${encodeURIComponent(ticketId)}/passcode/reveal`;

// ---------- Device create / update ----------

const Brand = z.string().trim().min(1, 'Choose or type a brand').max(40);
const Model = z.string().trim().min(1, 'Type the model').max(60);

const deviceFields = {
  type: DeviceType,
  brand: Brand,
  model: Model,
  colour: optionalText(30),
  /** Only for PHONE, TABLET, WATCH (`IMEI_DEVICE_TYPES`). */
  imei: optionalOf(Imei),
  serial: optionalOf(Serial),
  notes: optionalText(1000),
};

const imeiTypeRule = (v: { type?: DeviceType; imei?: string | null }, ctx: z.RefinementCtx) => {
  if (v.imei && v.type && !IMEI_DEVICE_TYPES.includes(v.type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['imei'], message: 'IMEI is only recorded for phones, tablets and watches' });
  }
};

/**
 * POST /api/customers/:customerId/devices · permission `customers.manage` → 201 `Device`.
 * Optional `passcode` (default lockType NONE); a secret passcode audits `device.passcode_changed`.
 * Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND (customer), 409 CUSTOMER_ARCHIVED, 409 CUSTOMER_ERASED.
 * Also used nested as `newDevice` in check-in (`CreateTicketInput`).
 */
export const CreateDeviceInput = z
  .object({ ...deviceFields, passcode: PasscodeInput.optional() })
  .strict()
  .superRefine(imeiTypeRule);
export type CreateDeviceInput = z.infer<typeof CreateDeviceInput>;

/**
 * PATCH /api/devices/:id · permission `customers.manage` → 200 `Device`.
 * Partial; `null`/"" clears optional fields. `passcode` present = set/replace/clear (audits `device.passcode_changed`);
 * absent = unchanged. When `type` changes to one without IMEI, send `imei: null`.
 * Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND (incl. another shop's device), 409 CUSTOMER_ERASED (device of an
 * erased customer: it keeps only type/brand/model and cannot be edited).
 */
export const UpdateDeviceInput = z
  .object({
    type: DeviceType.optional(),
    brand: Brand.optional(),
    model: Model.optional(),
    colour: optionalText(30).optional(),
    imei: optionalOf(Imei).optional(),
    serial: optionalOf(Serial).optional(),
    notes: optionalText(1000).optional(),
    passcode: PasscodeInput.optional(),
  })
  .strict()
  .superRefine(imeiTypeRule);
export type UpdateDeviceInput = z.input<typeof UpdateDeviceInput>;
export type UpdateDeviceInputParsed = z.output<typeof UpdateDeviceInput>;

/**
 * POST /api/devices/:id/archive · permission `customers.manage`, no body → 200 `Device` (hidden from the customer's
 * device list and check-in device options; history kept). Not audited.
 * Errors: 404 NOT_FOUND, 409 DEVICE_HAS_OPEN_TICKETS (a ticket in open/waiting/ready). Already archived → 200 no-op.
 * POST /api/devices/:id/restore · permission `customers.manage`, no body → 200 `Device`. Already active → 200 no-op.
 */
export const DEVICE_ACTION_PATHS = {
  update: '/api/devices/:id',
  archive: '/api/devices/:id/archive',
  restore: '/api/devices/:id/restore',
  lookup: '/api/devices/lookup',
  modelSuggestions: '/api/devices/model-suggestions',
} as const;

const TicketLink = z.object({ id: z.string(), number: z.number().int(), numberLabel: z.string() });

/** Device as returned by every read. Never carries the passcode. IMEI/serial are full; the web masks to last 4. */
export const Device = z.object({
  id: z.string(),
  customerId: z.string(),
  type: DeviceType,
  brand: z.string(),
  model: z.string(),
  colour: z.string().nullable(),
  imei: z.string().nullable(),
  serial: z.string().nullable(),
  notes: z.string().nullable(),
  lockType: LockType,
  /** A secret (PIN/password/pattern) is stored. "Passcode on file". */
  passcodeOnFile: z.boolean(),
  passcodeSetAt: IsoDateTime.nullable(),
  /** "Viewed {n} times · last by {name}, {time}" */
  passcodeViewCount: z.number().int().min(0),
  passcodeLastViewedAt: IsoDateTime.nullable(),
  passcodeLastViewedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  ticketCount: z.number().int().min(0),
  /** The device's current non-closed ticket, if any ("T-1040 is still open for this device"). Latest when several. */
  openTicket: TicketLink.nullable(),
  /** Latest ticket created for this device (for "most recently used first"). */
  lastTicketAt: IsoDateTime.nullable(),
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Device = z.infer<typeof Device>;

/**
 * GET /api/customers/:customerId/devices?archived=false · permission `customers.view` → 200 `DeviceListResponse`.
 * Sorted most recently used first (lastTicketAt desc nulls last, then createdAt desc). `archived=true` includes
 * archived devices. Errors: 404 NOT_FOUND (customer).
 */
export const DeviceListResponse = z.object({ items: z.array(Device) });
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

/**
 * GET /api/devices/lookup?imei=|serial=&customerId= · permission `customers.view` → 200 `DeviceLookupResponse`.
 * Exactly one of `imei` / `serial` (normalised the same way as the form). Exact match on normalised value, across
 * non-erased customers in this shop, incl. archived devices/customers. `customerId` (the customer being edited)
 * fills `sameCustomer` so the web can offer "Use existing device" vs the "This IMEI is on {customer}'s {model}"
 * warning. Errors: 400 VALIDATION_FAILED.
 */
export const DeviceLookupQuery = z
  .object({
    imei: Imei.optional(),
    serial: Serial.optional(),
    customerId: z.string().min(1).optional(),
  })
  .refine((v) => (v.imei ? 1 : 0) + (v.serial ? 1 : 0) === 1, { message: 'Give an IMEI or a serial number', path: ['imei'] });
export type DeviceLookupQuery = z.infer<typeof DeviceLookupQuery>;

export const DeviceLookupMatch = z.object({
  deviceId: z.string(),
  customerId: z.string(),
  customerDisplayName: z.string(),
  customerArchived: z.boolean(),
  sameCustomer: z.boolean(),
  type: DeviceType,
  brand: z.string(),
  model: z.string(),
  /** "(last ticket T-1033)" */
  lastTicket: TicketLink.nullable(),
});
export type DeviceLookupMatch = z.infer<typeof DeviceLookupMatch>;

export const DeviceLookupResponse = z.object({ matches: z.array(DeviceLookupMatch).max(10) });
export type DeviceLookupResponse = z.infer<typeof DeviceLookupResponse>;

/**
 * GET /api/devices/model-suggestions?type=&brand=&q=&limit= · permission `customers.view`
 * → 200 `ModelSuggestionsResponse`. One-box search (R1): `type` and `brand` are optional, so `q=iph 13` alone returns
 * `{ type: 'PHONE', brand: 'Apple', model: 'iPhone 13', ... }` first and the form fills all three. Each word of `q`
 * must appear in "brand model". Catalogue + models this shop used before, de-duplicated; ranked by `suggestModels`
 * (R2): exact match, then shortest model, then shop use count, then catalogue order.
 */
export const ModelSuggestionsQuery = z.object({
  type: DeviceType.optional(),
  brand: z.string().trim().max(40).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ModelSuggestionsQuery = z.infer<typeof ModelSuggestionsQuery>;

export const ModelSuggestionsResponse = z.object({
  items: z.array(
    z.object({
      type: DeviceType,
      brand: z.string(),
      model: z.string(),
      source: z.enum(['shop', 'catalogue']),
      useCount: z.number().int().min(0),
    }),
  ),
});
export type ModelSuggestionsResponse = z.infer<typeof ModelSuggestionsResponse>;

/** "Apple iPhone 13" (brand + model; brand omitted when the model already starts with it). */
export function deviceLabel(d: { brand: string; model: string }): string {
  return d.model.toLowerCase().startsWith(d.brand.toLowerCase()) ? d.model : `${d.brand} ${d.model}`;
}

/** Last 4 characters masked display: "•••• 1234". */
export function maskIdentifier(value: string): string {
  return value.length <= 4 ? value : `•••• ${value.slice(-4)}`;
}
