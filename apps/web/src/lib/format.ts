import {
  MARKET_DEFAULTS,
  formatRate,
  type CountryCode,
  type CurrencyCode,
} from '@repairos/contracts';

/**
 * ISO 4217 minor-unit exponent: how many minor units make one major unit in storage.
 * Not taken from Intl: CLDR reports PKR with 0 digits, but ISO (and our storage) uses 2.
 */
export const MINOR_UNIT_EXPONENT: Record<CurrencyCode, number> = { USD: 2, GBP: 2, PKR: 2 };

export interface MoneyFormatContext {
  currency: CurrencyCode;
  /** BCP 47 locale from the shop, e.g. en-US / en-GB. */
  locale: string;
}

/** Digits shown in the UI for a currency, from MARKET_DEFAULTS (PKR is shown without decimals). */
export function displayFractionDigits(currency: CurrencyCode): number {
  const market = Object.values(MARKET_DEFAULTS).find((m) => m.currency === currency);
  return market?.displayFractionDigits ?? MINOR_UNIT_EXPONENT[currency];
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function moneyFormatter(locale: string, currency: CurrencyCode): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    const digits = displayFractionDigits(currency);
    const options: Intl.NumberFormatOptions = {
      style: 'currency',
      currency,
      // "Rs" rather than "PKR" for Pakistan; "$" and "£" are unchanged.
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    };
    try {
      fmt = new Intl.NumberFormat(locale, options);
    } catch {
      fmt = new Intl.NumberFormat('en-US', options);
    }
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * Format an integer amount in minor units (cents, pence, paisa) for display.
 * formatMoney(12950, { currency: 'USD', locale: 'en-US' }) → "$129.50"
 * formatMoney(499900, { currency: 'PKR', locale: 'en-GB' }) → "Rs 4,999"
 */
export function formatMoney(amountMinor: number, ctx: MoneyFormatContext): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`formatMoney expects integer minor units, got ${amountMinor}`);
  }
  const major = amountMinor / 10 ** MINOR_UNIT_EXPONENT[ctx.currency];
  return moneyFormatter(ctx.locale, ctx.currency).format(major);
}

/** Plain-language summary of the tax defaults a new shop in this country gets. */
export function describeTaxDefaults(country: CountryCode): string {
  const market = MARKET_DEFAULTS[country];
  const rates = market.taxRates.filter((r) => r.rateMilliPct > 0);
  if (rates.length === 0) {
    const name = market.taxRates[0]?.name ?? 'Tax';
    return `Prices exclude ${name.toLowerCase()}. Add your local rate in Settings.`;
  }
  const list = rates
    .map((r) => {
      const scoped = r.appliesTo !== 'all' && !r.name.toLowerCase().includes(r.appliesTo);
      const scope = scoped ? ` on ${r.appliesTo}` : '';
      return `${r.name} ${formatRate(r.rateMilliPct, market.locale)}${scope}`;
    })
    .join(', ');
  return market.pricesIncludeTax ? `Prices include ${list}` : `Prices exclude tax: ${list}`;
}
