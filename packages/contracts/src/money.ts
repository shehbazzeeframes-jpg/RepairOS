import { z } from 'zod';
import { CurrencyCode } from './markets';

/**
 * Money (CLAUDE.md rule 4): integer minor units + ISO currency. Storage is always ×100 (ISO 4217 exponent 2 for
 * USD, GBP and PKR); PKR is *shown* without decimals and entered in whole rupees (still stored ×100).
 */

/** ISO 4217 minor-unit exponent used for storage. Not taken from Intl (CLDR reports PKR with 0 digits). */
export const CURRENCY_MINOR_EXPONENT: Record<CurrencyCode, number> = { USD: 2, GBP: 2, PKR: 2 };

/** Currencies entered in whole major units only (amountMinor must be a multiple of 100). */
export const WHOLE_UNIT_CURRENCIES: readonly CurrencyCode[] = ['PKR'];

/** Non-negative integer amount in minor units. */
export const MinorAmount = z.number().int().min(0);

/** An amount with its currency, as returned by the API. */
export const Money = z.object({ amountMinor: z.number().int(), currency: CurrencyCode });
export type Money = z.infer<typeof Money>;

/** Upper bound for a ticket estimate: 1,000,000 major units. */
export const MAX_ESTIMATE_MINOR = 1_000_000 * 100;

/**
 * Ticket estimate input: 0 ≤ amountMinor ≤ 100,000,000 (1,000,000 major); whole rupees for PKR.
 * The API also requires `currency === shop.currency`, else 400 VALIDATION_FAILED at path `["estimate", "currency"]`.
 */
export const EstimateInput = z
  .object({ amountMinor: MinorAmount.max(MAX_ESTIMATE_MINOR, 'Use 1,000,000 or less'), currency: CurrencyCode })
  .strict()
  .refine((m) => !WHOLE_UNIT_CURRENCIES.includes(m.currency) || m.amountMinor % 100 === 0, {
    message: 'Use a whole amount',
    path: ['amountMinor'],
  });
export type EstimateInput = z.infer<typeof EstimateInput>;

/**
 * Parses what a person typed ("129.5", "1,299.99", "Rs 4,999.6") into minor units of `currency`.
 * Rounds half up at the minor unit; PKR is rounded to whole rupees (story §5.1). Unparsable → null.
 * String arithmetic only (no floating point).
 */
export function parseMajorAmount(input: string, currency: CurrencyCode): number | null {
  const s = input.replace(/[^\d.]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const [whole = '', frac = ''] = s.split('.');
  const exp = CURRENCY_MINOR_EXPONENT[currency];
  const padded = frac.padEnd(exp + 1, '0');
  let minor = Number(whole || '0') * 10 ** exp + Number(padded.slice(0, exp) || '0');
  if (Number(padded[exp]) >= 5) minor += 1;
  if (WHOLE_UNIT_CURRENCIES.includes(currency)) minor = Math.round(minor / 100) * 100;
  return Number.isSafeInteger(minor) ? minor : null;
}
