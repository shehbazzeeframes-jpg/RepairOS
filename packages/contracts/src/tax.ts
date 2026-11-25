import { z } from 'zod';
import { IsoDateTime, QueryBoolean } from './common';
import { TaxAppliesTo } from './markets';

/**
 * Tax rates (Sprint 1 story §4.2, decisions D1 + D2).
 *
 * Rates are integers in thousandths of a percent (`rateMilliPct`): 8875 = 8.875%, 20000 = 20%, 0 = 0%.
 *
 * Snapshot rule (binding for Sprints 3–5): editing or archiving a rate never changes past records.
 * Every ticket/invoice line stores the tax rate *name* and *rateMilliPct* it was calculated with.
 */

export const MAX_RATE_MILLI_PCT = 100_000;

export const RateMilliPct = z.number().int().min(0).max(MAX_RATE_MILLI_PCT);

/**
 * "8.875" / "8.875%" / " 20 " → 8875 / 20000. Max 3 decimal places, 0–100 %. Null when invalid.
 * String arithmetic only (no floating point).
 */
export function parseRatePercent(input: string): number | null {
  const s = input.trim().replace(/\s*%$/, '').trim();
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(3, '0'));
  const value = whole * 1000 + frac;
  return value <= MAX_RATE_MILLI_PCT ? value : null;
}

/** 8875 → "8.875%", 20000 → "20%", 16500 → "16.5%". Uses the locale's decimal separator. */
export function formatRate(rateMilliPct: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(
    rateMilliPct / 100_000,
  );
}

/** Form field: accepts "8.875" or "8.875%" and outputs `rateMilliPct`. */
export const RatePercentInput = z.string().transform((s, ctx) => {
  const v = parseRatePercent(s);
  if (v === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a rate from 0 to 100 with up to 3 decimals' });
    return z.NEVER;
  }
  return v;
});

export const TAX_APPLIES_TO_LABELS: Record<TaxAppliesTo, string> = {
  all: 'All items',
  goods: 'Goods (parts & accessories)',
  services: 'Services (labour)',
};

/** D1: a rate may be the goods default only if it applies to all/goods; services default only if all/services. */
export function canBeDefaultFor(appliesTo: TaxAppliesTo, kind: 'goods' | 'services'): boolean {
  return appliesTo === 'all' || appliesTo === kind;
}

export const TaxRate = z.object({
  id: z.string(),
  name: z.string(),
  rateMilliPct: RateMilliPct,
  appliesTo: TaxAppliesTo,
  isDefaultGoods: z.boolean(),
  isDefaultServices: z.boolean(),
  /** null = active. Archived rates are hidden from pickers but kept for history. */
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaxRate = z.infer<typeof TaxRate>;

const TaxRateName = z.string().trim().min(1, 'Enter a name').max(40, 'Use 40 characters or fewer');

/**
 * GET /api/shop/tax-rates?includeArchived=true|false (default false) · permission `settings.view`
 * → 200 `TaxRateListResponse`, sorted active first, then by name.
 */
export const TaxRateListQuery = z.object({ includeArchived: QueryBoolean });
export type TaxRateListQuery = z.infer<typeof TaxRateListQuery>;

export const TaxRateListResponse = z.object({ items: z.array(TaxRate) });
export type TaxRateListResponse = z.infer<typeof TaxRateListResponse>;

/**
 * POST /api/shop/tax-rates · permission `tax.manage` → 201 `TaxRate`. Audits `tax_rate.created`
 * (and `tax_rate.default_changed` when a default flag is set).
 * `isDefaultGoods`/`isDefaultServices` may only be `true` (moves the default badge from the previous rate);
 * omit to leave defaults unchanged.
 * Errors: 400 VALIDATION_FAILED (incl. default flag incompatible with `appliesTo`, path ["isDefaultGoods"|"isDefaultServices"]),
 * 409 TAX_RATE_NAME_TAKEN (case-insensitive among non-archived rates).
 */
export const CreateTaxRateInput = z
  .object({
    name: TaxRateName,
    rateMilliPct: RateMilliPct,
    appliesTo: TaxAppliesTo,
    isDefaultGoods: z.literal(true).optional(),
    isDefaultServices: z.literal(true).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.isDefaultGoods && !canBeDefaultFor(v.appliesTo, 'goods')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isDefaultGoods'], message: 'A services rate can’t be the goods default' });
    }
    if (v.isDefaultServices && !canBeDefaultFor(v.appliesTo, 'services')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isDefaultServices'], message: 'A goods rate can’t be the services default' });
    }
  });
export type CreateTaxRateInput = z.infer<typeof CreateTaxRateInput>;

/**
 * PATCH /api/shop/tax-rates/:id · permission `tax.manage` → 200 `TaxRate`.
 * Edit fields and/or set as default (flags only accept `true`; the previous default loses it).
 * Audits `tax_rate.updated` for field changes, `tax_rate.default_changed` for default moves.
 * Errors: 400 VALIDATION_FAILED (empty body; default incompatible with the resulting `appliesTo`),
 * 404 NOT_FOUND, 409 TAX_RATE_NAME_TAKEN, 409 TAX_RATE_ARCHIVED (restore first),
 * 409 TAX_RATE_IS_DEFAULT (changing `appliesTo` would make the current default incompatible).
 */
export const UpdateTaxRateInput = z
  .object({
    name: TaxRateName.optional(),
    rateMilliPct: RateMilliPct.optional(),
    appliesTo: TaxAppliesTo.optional(),
    isDefaultGoods: z.literal(true).optional(),
    isDefaultServices: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update');
export type UpdateTaxRateInput = z.infer<typeof UpdateTaxRateInput>;

/**
 * POST /api/shop/tax-rates/:id/archive · permission `tax.manage` → 200 `TaxRate`. Audits `tax_rate.archived`.
 * Errors: 404 NOT_FOUND, 409 TAX_RATE_IS_DEFAULT ("Choose another default first"), 409 LAST_TAX_RATE.
 * Archiving an already archived rate is a no-op 200.
 *
 * POST /api/shop/tax-rates/:id/restore · permission `tax.manage` → 200 `TaxRate`. Audits `tax_rate.restored`.
 * Errors: 404 NOT_FOUND, 409 TAX_RATE_NAME_TAKEN (an active rate now uses the name).
 * No request body for either.
 */
export const TAX_RATE_ARCHIVE_PATHS = {
  archive: '/api/shop/tax-rates/:id/archive',
  restore: '/api/shop/tax-rates/:id/restore',
} as const;

/**
 * PATCH /api/shop/tax-settings · permission `tax.manage` → 200 `TaxSettings`. Audits `shop.tax_settings_updated`.
 */
export const UpdateTaxSettingsInput = z.object({ pricesIncludeTax: z.boolean() }).strict();
export type UpdateTaxSettingsInput = z.infer<typeof UpdateTaxSettingsInput>;

export const TaxSettings = z.object({ pricesIncludeTax: z.boolean() });
export type TaxSettings = z.infer<typeof TaxSettings>;
