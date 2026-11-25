import { z } from 'zod';

/** Launch markets. ISO 3166-1 alpha-2 (UK is "GB"). See docs/MARKETS.md. */
export const CountryCode = z.enum(['US', 'GB', 'PK']);
export type CountryCode = z.infer<typeof CountryCode>;

export const CurrencyCode = z.enum(['USD', 'GBP', 'PKR']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** What a tax rate applies to: all items, goods (parts & accessories) or services (labour). */
export const TaxAppliesTo = z.enum(['all', 'goods', 'services']);
export type TaxAppliesTo = z.infer<typeof TaxAppliesTo>;

export interface MarketTaxRateDefault {
  name: string;
  /** Thousandths of a percent (D2): 8875 = 8.875%, 20000 = 20%. */
  rateMilliPct: number;
  appliesTo: TaxAppliesTo;
  /** D1: exactly one default for goods and one for services per shop; an `all` rate may be both. */
  isDefaultGoods: boolean;
  isDefaultServices: boolean;
}

export interface MarketDefaults {
  currency: CurrencyCode;
  locale: 'en-US' | 'en-GB';
  timezone: string;
  pricesIncludeTax: boolean;
  taxRates: MarketTaxRateDefault[];
  /** Digits shown in the UI (PKR is shown without decimals). Storage is always minor units. */
  displayFractionDigits: number;
}

export const MARKET_DEFAULTS: Record<CountryCode, MarketDefaults> = {
  US: {
    currency: 'USD', locale: 'en-US', timezone: 'America/New_York', pricesIncludeTax: false,
    taxRates: [{ name: 'Sales tax', rateMilliPct: 0, appliesTo: 'all', isDefaultGoods: true, isDefaultServices: true }],
    displayFractionDigits: 2,
  },
  GB: {
    currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', pricesIncludeTax: true,
    taxRates: [{ name: 'VAT', rateMilliPct: 20000, appliesTo: 'all', isDefaultGoods: true, isDefaultServices: true }],
    displayFractionDigits: 2,
  },
  PK: {
    currency: 'PKR', locale: 'en-GB', timezone: 'Asia/Karachi', pricesIncludeTax: false,
    taxRates: [
      { name: 'GST', rateMilliPct: 18000, appliesTo: 'goods', isDefaultGoods: true, isDefaultServices: false },
      { name: 'Sales tax on services', rateMilliPct: 16000, appliesTo: 'services', isDefaultGoods: false, isDefaultServices: true },
    ],
    displayFractionDigits: 0,
  },
};
