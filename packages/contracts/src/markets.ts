import { z } from 'zod';

/** Launch markets. ISO 3166-1 alpha-2 (UK is "GB"). See docs/MARKETS.md. */
export const CountryCode = z.enum(['US', 'GB', 'PK']);
export type CountryCode = z.infer<typeof CountryCode>;

export const CurrencyCode = z.enum(['USD', 'GBP', 'PKR']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export interface MarketDefaults {
  currency: CurrencyCode;
  locale: 'en-US' | 'en-GB';
  timezone: string;
  pricesIncludeTax: boolean;
  taxRates: { name: string; rateBps: number; appliesTo: 'all' | 'goods' | 'services' }[];
  /** Digits shown in the UI (PKR is shown without decimals). Storage is always minor units. */
  displayFractionDigits: number;
}

/** rateBps = basis points: 2000 = 20.00% */
export const MARKET_DEFAULTS: Record<CountryCode, MarketDefaults> = {
  US: {
    currency: 'USD', locale: 'en-US', timezone: 'America/New_York', pricesIncludeTax: false,
    taxRates: [{ name: 'Sales tax', rateBps: 0, appliesTo: 'all' }], displayFractionDigits: 2,
  },
  GB: {
    currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', pricesIncludeTax: true,
    taxRates: [{ name: 'VAT', rateBps: 2000, appliesTo: 'all' }], displayFractionDigits: 2,
  },
  PK: {
    currency: 'PKR', locale: 'en-GB', timezone: 'Asia/Karachi', pricesIncludeTax: false,
    taxRates: [
      { name: 'GST', rateBps: 1800, appliesTo: 'goods' },
      { name: 'Sales tax on services', rateBps: 1600, appliesTo: 'services' },
    ],
    displayFractionDigits: 0,
  },
};
