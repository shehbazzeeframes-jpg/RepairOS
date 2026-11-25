import { z } from 'zod';
import { IsoDateTime } from './common';
import { CountryCode, CurrencyCode } from './markets';
import { Permission } from './permissions';
import { Role } from './roles';
import {
  checkCountryFields,
  normalizePhone,
  normalizePostcode,
  normalizeRegion,
  normalizeTimezone,
} from './validators';

const ShopName = z.string().trim().min(2).max(80);

/**
 * POST /api/shops · signed in (no shop needed) → 201 `Shop`.
 * Creates a shop during onboarding; caller becomes OWNER and it becomes the active shop.
 * Country-dependent fields are validated and normalised by the schema itself:
 * phone → E.164 (shop country as default region), postcode → canonical per country,
 * region → canonical, timezone → allow-listed IANA name (case-insensitive input). Empty strings → omitted.
 * Errors: 400 VALIDATION_FAILED (issue paths = field names), 403 SHOP_LIMIT_REACHED (already owns 3 shops),
 * 429 RATE_LIMITED (more than 5 shops per hour).
 * Web forms type their values with `z.input<typeof CreateShopInput>`; the API receives `CreateShopInput` (output).
 */
export const CreateShopInput = z
  .object({
    name: ShopName,
    country: CountryCode,
    timezone: z.string().min(1).max(64).optional(), // IANA name from TIMEZONES_BY_COUNTRY; defaults from MARKET_DEFAULTS
    phone: z.string().trim().max(32).optional(), // any format; normalised to E.164
    addressLine1: z.string().trim().max(120).optional(),
    addressLine2: z.string().trim().max(120).optional(),
    city: z.string().trim().max(80).optional(),
    region: z.string().trim().max(80).optional(),
    postcode: z.string().trim().max(20).optional(),
  })
  .superRefine((v, ctx) => checkCountryFields(v, v.country, ctx))
  .transform((v) => {
    const out: {
      name: string;
      country: CountryCode;
      timezone?: string;
      phone?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      region?: string;
      postcode?: string;
    } = { name: v.name, country: v.country };
    const timezone = normalizeTimezone(v.timezone, v.country);
    const phone = normalizePhone(v.phone, v.country);
    const region = normalizeRegion(v.region, v.country);
    const postcode = normalizePostcode(v.postcode, v.country);
    if (timezone) out.timezone = timezone;
    if (phone) out.phone = phone;
    if (v.addressLine1) out.addressLine1 = v.addressLine1;
    if (v.addressLine2) out.addressLine2 = v.addressLine2;
    if (v.city) out.city = v.city;
    if (region) out.region = region;
    if (postcode) out.postcode = postcode;
    return out;
  });
export type CreateShopInput = z.infer<typeof CreateShopInput>;

export const Shop = z.object({
  id: z.string(),
  name: z.string(),
  country: CountryCode,
  currency: CurrencyCode,
  locale: z.string(),
  timezone: z.string(),
  pricesIncludeTax: z.boolean(),
  phone: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Shop = z.infer<typeof Shop>;

/** Full profile for Settings → General. `phone` is E.164 (display with `formatPhone`). */
export const ShopProfile = Shop.extend({
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postcode: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type ShopProfile = z.infer<typeof ShopProfile>;

// ---------- Profile update ----------

/** undefined = leave unchanged; null or "" = clear. */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

/**
 * PATCH /api/shop · permission `settings.manage` → 200 `ShopProfile`. Audits `shop.updated` (changed fields only).
 * Partial update; `.strict()` so `country`/`currency` (read-only after creation) or any unknown key → 400 VALIDATION_FAILED.
 * This object only checks shape. The API (and the web form) MUST parse with `shopProfileSchema(shop.country)`,
 * which also validates + normalises phone/postcode/region/timezone for the shop's country.
 * Errors: 400 VALIDATION_FAILED.
 */
export const UpdateShopProfileInput = z
  .object({
    name: ShopName.optional(),
    phone: clearableText(32),
    addressLine1: clearableText(120),
    addressLine2: clearableText(120),
    city: clearableText(80),
    region: clearableText(80),
    postcode: clearableText(20),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type UpdateShopProfileInput = z.infer<typeof UpdateShopProfileInput>;

/** Country-aware version of `UpdateShopProfileInput`: validates and returns normalised values (E.164 phone etc.). */
export function shopProfileSchema(country: CountryCode) {
  return UpdateShopProfileInput.superRefine((v, ctx) => checkCountryFields(v, country, ctx)).transform((v) => ({
    ...v,
    ...(v.phone !== undefined ? { phone: v.phone === null ? null : normalizePhone(v.phone, country) } : {}),
    ...(v.postcode !== undefined ? { postcode: v.postcode === null ? null : normalizePostcode(v.postcode, country) } : {}),
    ...(v.region !== undefined ? { region: v.region === null ? null : normalizeRegion(v.region, country) } : {}),
    ...(v.timezone !== undefined ? { timezone: normalizeTimezone(v.timezone, country) ?? v.timezone } : {}),
  }));
}

// ---------- Business hours ----------

/** "HH:mm" 24h shop-local time, 15-minute steps (00, 15, 30, 45). */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, 'Use HH:mm in 15-minute steps');

/** 0 = Sunday … 6 = Saturday (JavaScript `Date#getDay` convention). Display order is per locale. */
export const Weekday = z.number().int().min(0).max(6);

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Display order: Sunday-first for US, Monday-first for GB/PK. */
export function weekdayDisplayOrder(country: CountryCode): number[] {
  return country === 'US' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
}

/**
 * One day. When `isOpen`, both times are required and `closesAt > opensAt` (same day, no overnight).
 * When closed, times are ignored on input and returned as null.
 */
export const BusinessHoursDay = z
  .object({
    weekday: Weekday,
    isOpen: z.boolean(),
    opensAt: TimeOfDay.nullable(),
    closesAt: TimeOfDay.nullable(),
  })
  .superRefine((d, ctx) => {
    if (!d.isOpen) return;
    if (!d.opensAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['opensAt'], message: 'Choose an opening time' });
    if (!d.closesAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closesAt'], message: 'Choose a closing time' });
    if (d.opensAt && d.closesAt && d.closesAt <= d.opensAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closesAt'], message: 'Closing time must be after opening time' });
    }
  })
  .transform((d) => (d.isOpen ? d : { ...d, opensAt: null, closesAt: null }));
export type BusinessHoursDay = z.infer<typeof BusinessHoursDay>;

/** Exactly 7 days, each weekday once, returned sorted by weekday 0..6. */
export const BusinessHoursWeek = z
  .array(BusinessHoursDay)
  .length(7)
  .superRefine((days, ctx) => {
    const seen = new Set(days.map((d) => d.weekday));
    if (seen.size !== 7) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give each weekday exactly once' });
  })
  .transform((days) => [...days].sort((a, b) => a.weekday - b.weekday));
export type BusinessHoursWeek = z.infer<typeof BusinessHoursWeek>;

/** D9: Mon–Sat 10:00–19:00, Sunday closed. Used for new shops and the migration of existing shops. */
export const DEFAULT_BUSINESS_HOURS: BusinessHoursWeek = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
  weekday === 0
    ? { weekday, isOpen: false, opensAt: null, closesAt: null }
    : { weekday, isOpen: true, opensAt: '10:00', closesAt: '19:00' },
);

/**
 * PUT /api/shop/hours · permission `settings.manage` → 200 `BusinessHoursResponse`.
 * Replaces the whole week. Audits `shop.hours_updated` (whole week before/after).
 * Errors: 400 VALIDATION_FAILED (paths like ["days", 2, "closesAt"]).
 */
export const UpdateBusinessHoursInput = z.object({ days: BusinessHoursWeek }).strict();
export type UpdateBusinessHoursInput = z.infer<typeof UpdateBusinessHoursInput>;

export const BusinessHoursResponse = z.object({ days: BusinessHoursWeek });
export type BusinessHoursResponse = z.infer<typeof BusinessHoursResponse>;

/**
 * GET /api/shop · permission `settings.view` → 200 `ShopSettingsResponse` (profile incl. pricesIncludeTax, plus hours).
 * Tax rates are listed separately (GET /api/shop/tax-rates).
 */
export const ShopSettingsResponse = z.object({
  shop: ShopProfile,
  hours: BusinessHoursWeek,
});
export type ShopSettingsResponse = z.infer<typeof ShopSettingsResponse>;

// ---------- Me ----------

export const MembershipStatus = z.enum(['ACTIVE', 'DEACTIVATED']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

/** In `MeResponse.memberships` only ACTIVE memberships are listed (status is always ACTIVE there). */
export const Membership = z.object({ shopId: z.string(), shopName: z.string(), role: Role, status: MembershipStatus });
export type Membership = z.infer<typeof Membership>;

/**
 * GET /api/me · signed in → 200 `MeResponse`; 401 UNAUTHENTICATED when signed out.
 *
 * How the web app routes on it:
 * - `activeShop !== null` → app. If `accessRemoved !== null` too, show the banner
 *   "You no longer have access to {accessRemoved.shopName}." (the API has fallen back to another ACTIVE membership
 *   and moved the session's active shop, so the banner appears once).
 * - `activeShop === null && accessRemoved !== null` → "Access removed" page (Sign out / Create your own shop),
 *   NOT onboarding. This is the "has memberships but all deactivated" case.
 * - `activeShop === null && accessRemoved === null` → onboarding.
 * - `/invite/*` is never redirected to onboarding.
 */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string().email() }),
  /** ACTIVE memberships only, oldest first. */
  memberships: z.array(Membership),
  /** null until onboarding creates a shop, or when every membership is deactivated */
  activeShop: Shop.nullable(),
  role: Role.nullable(),
  /** Permissions for `role` in the active shop (`permissionsFor(role)`); [] when no active shop. */
  permissions: z.array(Permission),
  /**
   * Non-null when the session's active shop is one where this user is now DEACTIVATED, or when the user has no
   * ACTIVE membership but at least one DEACTIVATED one (then the most recently deactivated shop).
   */
  accessRemoved: z.object({ shopId: z.string(), shopName: z.string() }).nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * POST /api/me/active-shop · signed in → 200 `MeResponse`.
 * Errors: 400 VALIDATION_FAILED, 403 FORBIDDEN (not an ACTIVE member of that shop, including deactivated).
 */
export const SetActiveShopInput = z.object({ shopId: z.string() });
export type SetActiveShopInput = z.infer<typeof SetActiveShopInput>;

/** GET /api/health */
export const HealthResponse = z.object({ status: z.literal('ok'), db: z.enum(['up', 'down']), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;
