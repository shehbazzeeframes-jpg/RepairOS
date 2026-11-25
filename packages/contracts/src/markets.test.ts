import { describe, expect, it } from 'vitest';
import { CreateShopInput, MARKET_DEFAULTS } from './index';

describe('market defaults', () => {
  it('UK prices include 20% VAT', () => {
    expect(MARKET_DEFAULTS.GB.pricesIncludeTax).toBe(true);
    expect(MARKET_DEFAULTS.GB.taxRates[0]?.rateBps).toBe(2000);
  });
  it('rejects unsupported countries', () => {
    expect(CreateShopInput.safeParse({ name: 'Fix It', country: 'FR' }).success).toBe(false);
  });
});
