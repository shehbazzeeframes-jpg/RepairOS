import { describe, expect, it } from 'vitest';
import { CreateShopInput, MARKET_DEFAULTS, canBeDefaultFor, normalizeTimezone } from './index';

describe('market defaults', () => {
  it('UK prices include 20% VAT', () => {
    expect(MARKET_DEFAULTS.GB.pricesIncludeTax).toBe(true);
    expect(MARKET_DEFAULTS.GB.taxRates[0]?.rateMilliPct).toBe(20000);
  });
  it('PK has 18% goods GST and 16% services tax', () => {
    expect(MARKET_DEFAULTS.PK.taxRates.map((r) => [r.name, r.rateMilliPct, r.appliesTo])).toEqual([
      ['GST', 18000, 'goods'],
      ['Sales tax on services', 16000, 'services'],
    ]);
  });
  it.each(['US', 'GB', 'PK'] as const)('%s has exactly one compatible default for goods and for services', (c) => {
    const rates = MARKET_DEFAULTS[c].taxRates;
    const goods = rates.filter((r) => r.isDefaultGoods);
    const services = rates.filter((r) => r.isDefaultServices);
    expect(goods).toHaveLength(1);
    expect(services).toHaveLength(1);
    expect(canBeDefaultFor(goods[0]!.appliesTo, 'goods')).toBe(true);
    expect(canBeDefaultFor(services[0]!.appliesTo, 'services')).toBe(true);
  });
  it.each(['US', 'GB', 'PK'] as const)('%s default timezone is in its allow-list', (c) => {
    expect(normalizeTimezone(MARKET_DEFAULTS[c].timezone, c)).toBe(MARKET_DEFAULTS[c].timezone);
  });
  it('rejects unsupported countries', () => {
    expect(CreateShopInput.safeParse({ name: 'Fix It', country: 'FR' }).success).toBe(false);
  });
});
