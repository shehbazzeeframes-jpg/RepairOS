import { z } from 'zod';
import {
  CursorQuery,
  EmailAddress,
  IdParam,
  IsoDateTime,
  LocalDate,
  OptionalQueryBoolean,
  PageSizeQuery,
  QueryBoolean,
  RecordVersion,
  SearchText,
  queryList,
} from './common';
import { CountryCode } from './markets';
import { checkCountryFields, normalizePhone, normalizePostcode, normalizeRegion, optionalText } from './validators';

/**
 * Customers (Sprint 2 story §1, decisions A2, A5, A6, A11, A17).
 *
 * Validation is in two layers, like shops: the exported `*Input` objects check shape only; the API (and web forms)
 * MUST parse with the country-aware factory (`createCustomerSchema(shop.country)`, `updateCustomerSchema(country)`),
 * which also validates + normalises phones (E.164, shop country as default region; +international accepted from any
 * country), postcode and region. Issue paths are field names (`["phones", 1, "number"]`) so errors map onto fields.
 * Erased customers are 404 NOT_FOUND on every customer route (except where noted) and never appear in lists,
 * duplicate checks or search.
 */

export const CustomerKind = z.enum(['PERSON', 'BUSINESS']);
export type CustomerKind = z.infer<typeof CustomerKind>;

export const PhoneLabel = z.enum(['MOBILE', 'LANDLINE', 'WORK', 'OTHER']);
export type PhoneLabel = z.infer<typeof PhoneLabel>;
export const PHONE_LABELS: Record<PhoneLabel, string> = { MOBILE: 'Mobile', LANDLINE: 'Landline', WORK: 'Work', OTHER: 'Other' };

export const PreferredChannel = z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'CALL']);
export type PreferredChannel = z.infer<typeof PreferredChannel>;
export const PREFERRED_CHANNEL_LABELS: Record<PreferredChannel, string> = {
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  CALL: 'Phone call',
};

export const MAX_CUSTOMER_PHONES = 3;
export const MAX_CUSTOMER_TAGS = 10;

/** Default preferred contact (CU1.4): PK → WhatsApp, US/GB → SMS; Email when the customer has no phone. */
export function defaultPreferredChannel(country: CountryCode, hasPhone = true): PreferredChannel {
  if (!hasPhone) return 'EMAIL';
  return country === 'PK' ? 'WHATSAPP' : 'SMS';
}

/** Stored display name: Person "First Last" (last optional), Business "Business name". */
export function customerDisplayName(c: {
  kind: CustomerKind;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
}): string {
  if (c.kind === 'BUSINESS') return (c.businessName ?? '').trim();
  return [c.firstName, c.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * Splits what was typed in check-in customer search into the quick-create form (TK2.1):
 * contains "@" → email; mostly digits (+, spaces, dashes, brackets allowed, ≥ 4 digits) → phone;
 * else first word → firstName, rest → lastName.
 */
export function splitQuickCreateText(
  text: string,
): { email: string } | { phone: string } | { firstName: string; lastName: string | null } {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.includes('@')) return { email: t };
  if (/^\+?[\d\s\-().]+$/.test(t) && t.replace(/\D/g, '').length >= 4) return { phone: t };
  const [first = '', ...rest] = t.split(' ');
  return { firstName: first, lastName: rest.length ? rest.join(' ') : null };
}

// ---------- Tags ----------

const Tag = z.string().trim().min(1, 'Tags need at least 1 character').max(30, 'Use 30 characters or fewer per tag');

/** 0–10 tags, each 1–30 chars trimmed; duplicates compared case-insensitively are dropped (first casing kept). */
export const CustomerTags = z
  .array(Tag)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })
  .refine((tags) => tags.length <= MAX_CUSTOMER_TAGS, `Use up to ${MAX_CUSTOMER_TAGS} tags`);

// ---------- Consent ----------

export const ConsentChannel = z.enum(['SMS', 'EMAIL', 'WHATSAPP']);
export type ConsentChannel = z.infer<typeof ConsentChannel>;
export const CONSENT_CHANNEL_LABELS: Record<ConsentChannel, string> = {
  SMS: 'Marketing by SMS',
  EMAIL: 'Marketing by email',
  WHATSAPP: 'Marketing by WhatsApp',
};

/** Only MARKETING in Sprint 2; the enum is ready for more purposes. */
export const ConsentPurpose = z.enum(['MARKETING']);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

export const ConsentState = z.enum(['GRANTED', 'WITHDRAWN']);
export type ConsentState = z.infer<typeof ConsentState>;

export const ConsentSource = z.enum(['IN_STORE_VERBAL', 'IN_STORE_SIGNED', 'ONLINE_FORM', 'IMPORT', 'CUSTOMER_REQUEST']);
export type ConsentSource = z.infer<typeof ConsentSource>;
export const CONSENT_SOURCE_LABELS: Record<ConsentSource, string> = {
  IN_STORE_VERBAL: 'In store – verbal',
  IN_STORE_SIGNED: 'In store – signed form',
  ONLINE_FORM: 'Website/online form',
  IMPORT: 'Imported',
  CUSTOMER_REQUEST: 'Customer request',
};

/** CU4.4 helper text (a warning, never a block). */
export const TCPA_VERBAL_SMS_WARNING =
  'US law (TCPA) expects written consent for marketing texts. Use a signed form or online form.';

/**
 * One consent switch change. Granting requires a `source`; withdrawing defaults the source to CUSTOMER_REQUEST.
 * `note` ≤ 200. The server sets the timestamp and the recording staff member.
 */
export const ConsentChangeInput = z
  .object({
    channel: ConsentChannel,
    purpose: ConsentPurpose.default('MARKETING'),
    state: ConsentState,
    source: ConsentSource.optional(),
    note: optionalText(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.state === 'GRANTED' && !v.source) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'Choose how consent was given' });
    }
  })
  .transform((v) => ({ ...v, source: v.source ?? ('CUSTOMER_REQUEST' as ConsentSource) }));
export type ConsentChangeInput = z.input<typeof ConsentChangeInput>;
export type ConsentChange = z.output<typeof ConsentChangeInput>;

const ConsentChanges = z
  .array(ConsentChangeInput)
  .max(3)
  .refine((cs) => new Set(cs.map((c) => c.channel)).size === cs.length, 'Give each channel once');

/** True when the US TCPA warning should show for this change (US shop, SMS, granted, verbal). */
export function showTcpaWarning(
  country: CountryCode,
  change: { channel: ConsentChannel; state: ConsentState; source?: ConsentSource | null },
): boolean {
  return country === 'US' && change.channel === 'SMS' && change.state === 'GRANTED' && change.source === 'IN_STORE_VERBAL';
}

/** Append-only consent history row (no edit/delete API). */
export const ConsentEvent = z.object({
  id: z.string(),
  channel: ConsentChannel,
  purpose: ConsentPurpose,
  state: ConsentState,
  source: ConsentSource,
  note: z.string().nullable(),
  /** null = system (e.g. import) */
  recordedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  createdAt: IsoDateTime,
});
export type ConsentEvent = z.infer<typeof ConsentEvent>;

/** Current state of one channel = its latest event ("SMS marketing: Yes, since 12/03/2026, in store – verbal, by Sam"). */
export const CurrentConsent = z.object({
  granted: z.boolean(),
  /** createdAt of the latest event; null = never recorded (not granted) */
  since: IsoDateTime.nullable(),
  source: ConsentSource.nullable(),
  recordedByName: z.string().nullable(),
});
export type CurrentConsent = z.infer<typeof CurrentConsent>;

export const ConsentSummary = z.object({ SMS: CurrentConsent, EMAIL: CurrentConsent, WHATSAPP: CurrentConsent });
export type ConsentSummary = z.infer<typeof ConsentSummary>;

/** Derives current consent per channel from events (any order): latest event per channel wins; none = not granted. */
export function currentConsent(
  events: readonly Pick<ConsentEvent, 'channel' | 'state' | 'source' | 'createdAt' | 'recordedBy'>[],
): ConsentSummary {
  const none: CurrentConsent = { granted: false, since: null, source: null, recordedByName: null };
  const out: ConsentSummary = { SMS: none, EMAIL: none, WHATSAPP: none };
  const latest = new Map<ConsentChannel, (typeof events)[number]>();
  for (const e of events) {
    const prev = latest.get(e.channel);
    if (!prev || e.createdAt >= prev.createdAt) latest.set(e.channel, e);
  }
  for (const [channel, e] of latest) {
    out[channel] = { granted: e.state === 'GRANTED', since: e.createdAt, source: e.source, recordedByName: e.recordedBy?.name ?? null };
  }
  return out;
}

/**
 * Drops changes that would not change the current state (granting an already-granted channel, withdrawing one
 * that isn't granted). The API appends events only for what this returns, so saving a form twice adds nothing.
 */
export function effectiveConsentChanges<T extends { channel: ConsentChannel; state: ConsentState }>(
  current: ConsentSummary,
  changes: readonly T[],
): T[] {
  return changes.filter((c) => current[c.channel].granted !== (c.state === 'GRANTED'));
}

/**
 * POST /api/customers/:id/consents · permission `customers.manage` → 200 `CustomerDetail`.
 * Appends one event per effective change (`effectiveConsentChanges`), updates the denormalised
 * `marketingSms/Email/WhatsappAt`. Not audited (own history). Works on archived customers.
 * Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND (incl. erased).
 */
export const AppendConsentsInput = z.object({ changes: ConsentChanges.refine((c) => c.length >= 1, 'Change at least one channel') }).strict();
export type AppendConsentsInput = z.input<typeof AppendConsentsInput>;

/**
 * GET /api/customers/:id/consents · permission `customers.view` → 200 `ConsentHistoryResponse`, newest first.
 * Errors: 404 NOT_FOUND.
 */
export const ConsentHistoryResponse = z.object({ items: z.array(ConsentEvent) });
export type ConsentHistoryResponse = z.infer<typeof ConsentHistoryResponse>;

// ---------- Create / update ----------

/**
 * One phone row. `number` in any format. Exactly one `isPrimary` (none flagged → the first). At most one
 * `isWhatsapp` (none flagged → the primary). `id` (update only) keeps an existing phone row.
 */
export const CustomerPhoneInput = z
  .object({
    id: z.string().min(1).optional(),
    number: z.string().trim().min(1, 'Enter a phone number').max(32),
    label: PhoneLabel.default('MOBILE'),
    isPrimary: z.boolean().optional(),
    isWhatsapp: z.boolean().optional(),
  })
  .strict();
export type CustomerPhoneInput = z.input<typeof CustomerPhoneInput>;

const PhonesInput = z
  .array(CustomerPhoneInput)
  .max(MAX_CUSTOMER_PHONES, `Add up to ${MAX_CUSTOMER_PHONES} phone numbers`)
  .superRefine((phones, ctx) => {
    if (phones.filter((p) => p.isPrimary).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose one primary number' });
    }
    if (phones.filter((p) => p.isWhatsapp).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose one WhatsApp number' });
    }
  });

const customerFields = {
  kind: CustomerKind.default('PERSON'),
  firstName: optionalText(60),
  lastName: optionalText(60),
  businessName: optionalText(120),
  businessContactName: optionalText(120),
  email: z
    .union([z.literal(''), z.null(), EmailAddress])
    .optional()
    .transform((v) => (v ? v : null)),
  phones: PhonesInput.default([]),
  /** Always in the shop's country (MVP). */
  addressLine1: optionalText(120),
  addressLine2: optionalText(120),
  city: optionalText(80),
  region: optionalText(80),
  postcode: optionalText(20),
  notes: optionalText(2000),
  tags: CustomerTags.default([]),
  /** Default: `defaultPreferredChannel(shop.country, hasPhone)`. */
  preferredChannel: PreferredChannel.optional(),
  serviceOptOutSms: z.boolean().default(false),
  serviceOptOutEmail: z.boolean().default(false),
  serviceOptOutWhatsapp: z.boolean().default(false),
};

interface CustomerRecordLike {
  kind: CustomerKind;
  firstName?: string | null;
  businessName?: string | null;
  email?: string | null;
  phones?: readonly unknown[];
  preferredChannel?: PreferredChannel | null;
}

/**
 * Record-level rules (A2), shared by create and by the API on the merged result of a PATCH:
 * Person → firstName; Business → businessName; at least one phone or email; preferred Email needs an email,
 * SMS/WhatsApp/Call need a phone.
 */
export function customerRecordIssues(c: CustomerRecordLike): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const hasPhone = (c.phones?.length ?? 0) > 0;
  if (c.kind === 'PERSON' && !c.firstName) issues.push({ path: ['firstName'], message: 'Enter a first name' });
  if (c.kind === 'BUSINESS' && !c.businessName) issues.push({ path: ['businessName'], message: 'Enter a business name' });
  if (!hasPhone && !c.email) issues.push({ path: ['phones'], message: 'Add a phone number or an email' });
  if (c.preferredChannel === 'EMAIL' && !c.email) issues.push({ path: ['preferredChannel'], message: 'Add an email to contact them by email' });
  if (c.preferredChannel && c.preferredChannel !== 'EMAIL' && !hasPhone) {
    issues.push({ path: ['preferredChannel'], message: 'Add a phone number for this contact method' });
  }
  return issues;
}

/**
 * Shape of POST /api/customers (and `newCustomer` in check-in). Parse with `createCustomerSchema(country)`.
 *
 * POST /api/customers · permission `customers.manage` → 201 `CustomerDetail`.
 * Creates the customer, phones and one consent event per granted channel in `consents` (only GRANTED makes sense on
 * create; WITHDRAWN entries are ignored). Duplicates are allowed (A5): the API never blocks on them.
 * Not audited. Errors: 400 VALIDATION_FAILED.
 */
export const CreateCustomerInput = z
  .object({ ...customerFields, consents: ConsentChanges.default([]) })
  .strict()
  .superRefine((v, ctx) => {
    for (const i of customerRecordIssues(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, ...i });
  });
export type CreateCustomerInput = z.input<typeof CreateCustomerInput>;

/** A phone after normalisation. */
export interface NormalizedPhone {
  id?: string;
  e164: string;
  label: PhoneLabel;
  isPrimary: boolean;
  isWhatsapp: boolean;
  position: number;
}

function normalizePhones(
  phones: readonly z.output<typeof CustomerPhoneInput>[],
  country: CountryCode,
  ctx: z.RefinementCtx,
): NormalizedPhone[] {
  const out: NormalizedPhone[] = [];
  const seen = new Set<string>();
  phones.forEach((p, i) => {
    const e164 = normalizePhone(p.number, country);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phones', i, 'number'], message: 'Enter a valid phone number' });
      return;
    }
    if (seen.has(e164)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phones', i, 'number'], message: 'This number is already listed' });
      return;
    }
    seen.add(e164);
    out.push({ ...(p.id ? { id: p.id } : {}), e164, label: p.label, isPrimary: !!p.isPrimary, isWhatsapp: !!p.isWhatsapp, position: i });
  });
  const primary = out.findIndex((p) => p.isPrimary);
  out.forEach((p, i) => (p.isPrimary = i === (primary === -1 ? 0 : primary)));
  if (!out.some((p) => p.isWhatsapp)) {
    const prim = out.find((p) => p.isPrimary);
    if (prim) prim.isWhatsapp = true;
  }
  return out;
}

function checkAddress(v: { postcode?: string | null; region?: string | null }, country: CountryCode, ctx: z.RefinementCtx) {
  checkCountryFields({ postcode: v.postcode ?? null, region: v.region ?? null }, country, ctx);
}

/**
 * Country-aware create schema. Output: normalised phones (`NormalizedPhone[]`: E.164, exactly one primary, the
 * WhatsApp number), canonical postcode/region, `preferredChannel` defaulted, `displayName` derived.
 */
export function createCustomerSchema(country: CountryCode) {
  return CreateCustomerInput.superRefine((v, ctx) => checkAddress(v, country, ctx)).transform((v, ctx) => {
    const phones = normalizePhones(v.phones, country, ctx);
    return {
      ...v,
      phones,
      postcode: v.postcode ? normalizePostcode(v.postcode, country) : null,
      region: v.region ? normalizeRegion(v.region, country) : null,
      preferredChannel: v.preferredChannel ?? defaultPreferredChannel(country, phones.length > 0),
      displayName: customerDisplayName(v),
      consents: v.consents.filter((c) => c.state === 'GRANTED'),
    };
  });
}
export type CreateCustomerData = z.output<ReturnType<typeof createCustomerSchema>>;

/** undefined = unchanged; null or "" = clear. */
const clearable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

/**
 * PATCH /api/customers/:id · permission `customers.manage` → 200 `CustomerDetail`. Parse with
 * `updateCustomerSchema(country)`. Partial; `version` required (409 STALE_RECORD with `STALE_CUSTOMER_MESSAGE` on
 * mismatch). `phones`, when given, REPLACES the list (rows with `id` keep identity; others are new). `consents`
 * appends effective changes like POST …/consents. The API re-checks `customerRecordIssues` on the merged record.
 * Not audited (CU3.3). Errors: 400 VALIDATION_FAILED, 404 NOT_FOUND (incl. erased), 409 STALE_RECORD.
 */
export const UpdateCustomerInput = z
  .object({
    version: RecordVersion,
    kind: CustomerKind.optional(),
    firstName: clearable(60),
    lastName: clearable(60),
    businessName: clearable(120),
    businessContactName: clearable(120),
    email: z
      .union([z.literal(''), z.null(), EmailAddress])
      .optional()
      .transform((v) => (v === undefined ? undefined : v ? v : null)),
    phones: PhonesInput.optional(),
    addressLine1: clearable(120),
    addressLine2: clearable(120),
    city: clearable(80),
    region: clearable(80),
    postcode: clearable(20),
    notes: clearable(2000),
    tags: CustomerTags.optional(),
    preferredChannel: PreferredChannel.optional(),
    serviceOptOutSms: z.boolean().optional(),
    serviceOptOutEmail: z.boolean().optional(),
    serviceOptOutWhatsapp: z.boolean().optional(),
    consents: ConsentChanges.optional(),
  })
  .strict();
export type UpdateCustomerInput = z.input<typeof UpdateCustomerInput>;

export function updateCustomerSchema(country: CountryCode) {
  return UpdateCustomerInput.superRefine((v, ctx) => checkAddress(v, country, ctx)).transform((v, ctx) => ({
    ...v,
    phones: v.phones === undefined ? undefined : normalizePhones(v.phones, country, ctx),
    postcode: v.postcode === undefined ? undefined : v.postcode ? normalizePostcode(v.postcode, country) : null,
    region: v.region === undefined ? undefined : v.region ? normalizeRegion(v.region, country) : null,
  }));
}
export type UpdateCustomerData = z.output<ReturnType<typeof updateCustomerSchema>>;

// ---------- Reads ----------

export const CustomerPhone = z.object({
  id: z.string(),
  /** E.164; display with `formatPhone(e164, shop.country)` */
  e164: z.string(),
  label: PhoneLabel,
  isPrimary: z.boolean(),
  position: z.number().int(),
});
export type CustomerPhone = z.infer<typeof CustomerPhone>;

/** `https://wa.me/<digits>` for an E.164 number. The web hides it for numbers libphonenumber types as fixed-line. */
export function whatsappLink(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}`;
}

export const CustomerListItem = z.object({
  id: z.string(),
  kind: CustomerKind,
  displayName: z.string(),
  /** Business contact person (shown under a business name). */
  businessContactName: z.string().nullable(),
  primaryPhone: z.string().nullable(),
  email: z.string().nullable(),
  tags: z.array(z.string()),
  openTicketCount: z.number().int().min(0),
  lastVisitAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  archivedAt: IsoDateTime.nullable(),
});
export type CustomerListItem = z.infer<typeof CustomerListItem>;

/**
 * GET /api/customers/:id · permission `customers.view` → 200 `CustomerDetail`. Erased → 404 NOT_FOUND
 * (UI: "This customer was erased."). Works for archived customers.
 */
export const CustomerDetail = CustomerListItem.extend({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  businessName: z.string().nullable(),
  phones: z.array(CustomerPhone),
  /** Phone id used for WhatsApp; null when no phones. */
  whatsappPhoneId: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postcode: z.string().nullable(),
  /** "Customer note", highlighted on the detail page and shown as a callout in check-in. */
  notes: z.string().nullable(),
  preferredChannel: PreferredChannel,
  serviceOptOutSms: z.boolean(),
  serviceOptOutEmail: z.boolean(),
  serviceOptOutWhatsapp: z.boolean(),
  consent: ConsentSummary,
  ticketCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  version: RecordVersion,
  createdBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  updatedAt: IsoDateTime,
});
export type CustomerDetail = z.infer<typeof CustomerDetail>;

export const CustomerSort = z.enum(['name', 'last_visit', 'created']);
export type CustomerSort = z.infer<typeof CustomerSort>;
export const CUSTOMER_SORT_LABELS: Record<CustomerSort, string> = {
  name: 'Name A–Z',
  last_visit: 'Last visit (newest)',
  created: 'Created (newest)',
};

/**
 * GET /api/customers?q&type&tags&hasOpen&consent&createdFrom&createdTo&archived&sort&cursor&limit
 * · permission `customers.view` → 200 `CustomerListResponse`.
 * - `q` (2–100): name contains (case/accent-insensitive, any word order; business + contact name too), phone
 *   (normalised with the shop country: valid → exact E.164; else ≥ 4 digits → digits substring), email contains.
 * - `type` PERSON|BUSINESS; `tags` any-of (case-insensitive); `hasOpen=true` open tickets > 0;
 *   `consent` = channels whose marketing consent is currently granted (all listed must be granted);
 *   `createdFrom`/`createdTo` inclusive shop-local dates; `archived=true` also includes archived rows (badge;
 *   `archivedAt` set). R5: check-in's customer search uses `archived=true` to offer "Restore and use"; default false.
 * - `sort` default `name`; keyset cursor; `limit` 25/50/100.
 * Erased customers are never listed. Errors: 400 VALIDATION_FAILED (incl. bad cursor).
 */
export const CustomerListQuery = z
  .object({
    q: SearchText.optional(),
    type: CustomerKind.optional(),
    tags: queryList(Tag, MAX_CUSTOMER_TAGS),
    hasOpen: OptionalQueryBoolean,
    consent: queryList(ConsentChannel, 3),
    createdFrom: LocalDate.optional(),
    createdTo: LocalDate.optional(),
    archived: QueryBoolean,
    sort: CustomerSort.default('name'),
    cursor: CursorQuery,
    limit: PageSizeQuery,
  })
  .refine((v) => !v.createdFrom || !v.createdTo || v.createdTo >= v.createdFrom, {
    message: 'End date must be on or after start date',
    path: ['createdTo'],
  });
export type CustomerListQuery = z.infer<typeof CustomerListQuery>;

export const CustomerListResponse = z.object({
  items: z.array(CustomerListItem),
  /** null = last page */
  nextCursor: z.string().nullable(),
  /** Matches for the same filters, capped at LIST_TOTAL_CAP. */
  total: z.number().int().min(0),
  totalCapped: z.boolean(),
});
export type CustomerListResponse = z.infer<typeof CustomerListResponse>;

/**
 * GET /api/customers/duplicates?phone=&email=&excludeId= · permission `customers.view` → 200 `DuplicateCheckResponse`.
 * At least one of phone/email. `phone` in any format is normalised with the shop country; an invalid phone or email
 * is ignored (→ no matches, never 400 for that alone). Exact match on any of a customer's phones or on email,
 * INCLUDING archived customers, excluding erased ones and `excludeId` (the customer being edited).
 * Up to 3 items, newest visit first; `more` = how many further matches. Warning only (A5).
 */
export const DuplicateCheckQuery = z
  .object({
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().max(254).optional(),
    excludeId: IdParam.optional(),
  })
  .refine((v) => !!v.phone || !!v.email, { message: 'Give a phone or an email', path: ['phone'] });
export type DuplicateCheckQuery = z.infer<typeof DuplicateCheckQuery>;

export const DuplicateMatch = z.object({
  id: z.string(),
  displayName: z.string(),
  primaryPhone: z.string().nullable(),
  email: z.string().nullable(),
  lastVisitAt: IsoDateTime.nullable(),
  openTicketCount: z.number().int().min(0),
  /** "Archived" badge + "Restore and use" */
  archived: z.boolean(),
  /** Which input matched. */
  matchedOn: z.array(z.enum(['phone', 'email'])),
});
export type DuplicateMatch = z.infer<typeof DuplicateMatch>;

export const DuplicateCheckResponse = z.object({
  items: z.array(DuplicateMatch).max(3),
  /** "and {n} more" */
  more: z.number().int().min(0),
});
export type DuplicateCheckResponse = z.infer<typeof DuplicateCheckResponse>;

/** Debounce for the duplicate check (CU2.1). */
export const DUPLICATE_CHECK_DEBOUNCE_MS = 300;

/**
 * GET /api/customers/tags?q= · permission `customers.view` → 200 `CustomerTagsResponse`: distinct tags in the shop
 * (non-erased customers), most used first, max 50, filtered by `q` (case-insensitive contains).
 */
export const CustomerTagsQuery = z.object({ q: z.string().trim().max(30).optional() });
export type CustomerTagsQuery = z.infer<typeof CustomerTagsQuery>;
export const CustomerTagsResponse = z.object({ tags: z.array(z.string()) });
export type CustomerTagsResponse = z.infer<typeof CustomerTagsResponse>;

// ---------- Archive / restore / export / erase ----------

/**
 * POST /api/customers/:id/archive · permission `customers.manage`, no body → 200 `CustomerDetail`.
 * Audits `customer.archived`. Hidden from lists, global search and check-in search by default.
 * Errors: 404 NOT_FOUND, 409 CUSTOMER_HAS_OPEN_TICKETS ({n} = tickets in open/waiting/ready). Already archived → 200.
 *
 * POST /api/customers/:id/restore · permission `customers.manage`, no body → 200 `CustomerDetail`.
 * Audits `customer.restored`. Errors: 404 NOT_FOUND (incl. erased). Already active → 200 no-op.
 */
export const CUSTOMER_ACTION_PATHS = {
  list: '/api/customers',
  duplicates: '/api/customers/duplicates',
  tags: '/api/customers/tags',
  detail: '/api/customers/:id',
  consents: '/api/customers/:id/consents',
  archive: '/api/customers/:id/archive',
  restore: '/api/customers/:id/restore',
  export: '/api/customers/:id/export',
  erase: '/api/customers/:id/erase',
  devices: '/api/customers/:id/devices',
} as const;

/**
 * GET /api/customers/:id/export · permission `customers.export_delete` → 200 `application/json`,
 * `Content-Disposition: attachment; filename="customer-{id}-{YYYY-MM-DD}.json"` (shop-local date), body
 * `CustomerExport`. Synchronous. Works for archived customers. Audits `customer.exported` (counts only).
 * Devices never include passcodes; tickets include only CUSTOMER-visible notes (A11).
 * Errors: 404 NOT_FOUND (incl. erased).
 */
export const CustomerExport = z.object({
  exportedAt: IsoDateTime,
  shop: z.object({ name: z.string() }),
  customer: CustomerDetail.omit({ version: true, consent: true }),
  consentHistory: z.array(ConsentEvent),
  devices: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      brand: z.string(),
      model: z.string(),
      colour: z.string().nullable(),
      imei: z.string().nullable(),
      serial: z.string().nullable(),
      notes: z.string().nullable(),
      passcodeOnFile: z.boolean(),
      createdAt: IsoDateTime,
    }),
  ),
  tickets: z.array(
    z.object({
      number: z.string(),
      deviceId: z.string(),
      createdAt: IsoDateTime,
      closedAt: IsoDateTime.nullable(),
      status: z.string(),
      statusHistory: z.array(z.object({ status: z.string(), at: IsoDateTime })),
      issues: z.array(z.string()),
      description: z.string().nullable(),
      checklist: z.record(z.string()),
      accessories: z.array(z.string()),
      estimate: z.object({ amountMinor: z.number().int(), currency: z.string() }).nullable(),
      customerVisibleNotes: z.array(z.object({ body: z.string(), createdAt: IsoDateTime })),
    }),
  ),
});
export type CustomerExport = z.infer<typeof CustomerExport>;

/** `customer-{id}-{YYYY-MM-DD}.json` */
export function customerExportFilename(customerId: string, localDate: string): string {
  return `customer-${customerId}-${localDate}.json`;
}

/**
 * POST /api/customers/:id/erase · permission `customers.export_delete` → 200 `EraseCustomerResponse`.
 * One transaction (A11, tech-lead clarification): name → "Erased customer"; business name/contact, phones, email,
 * address, notes, tags, consent history deleted; preferred contact cleared; denormalised search columns cleared;
 * each device keeps type/brand/model and loses IMEI, serial, colour, notes, passcode; tickets stay (incl. notes);
 * `erasedAt` + `archivedAt` set; audits `customer.erased` with counts only. Irreversible.
 * Errors: 400 VALIDATION_FAILED (confirm ≠ "ERASE"), 404 NOT_FOUND (incl. already erased),
 * 409 CUSTOMER_HAS_OPEN_TICKETS.
 */
export const EraseCustomerInput = z.object({ confirm: z.literal('ERASE', { errorMap: () => ({ message: 'Type ERASE to confirm' }) }) }).strict();
export type EraseCustomerInput = z.infer<typeof EraseCustomerInput>;

export const EraseCustomerResponse = z.object({
  id: z.string(),
  erasedAt: IsoDateTime,
  counts: z.object({ phones: z.number().int(), devices: z.number().int(), tickets: z.number().int(), consentEvents: z.number().int() }),
});
export type EraseCustomerResponse = z.infer<typeof EraseCustomerResponse>;

/** Display name stored on an erased customer. */
export const ERASED_CUSTOMER_NAME = 'Erased customer';
