import { describe, expect, it } from 'vitest';
import {
  filterIssues,
  imeiError,
  mockCheckInContext,
  searchCustomers,
  searchModels,
  seedFromTyped,
} from './check-in-model';

describe('check-in prototype model', () => {
  it('finds customers by name words in any order, phone digits and IMEI', () => {
    expect(searchCustomers('khan ali').map((m) => m.customer.displayName)).toEqual(['Ali Khan']);
    expect(searchCustomers('07400 123456').map((m) => m.customer.displayName)).toEqual([
      'Ali Khan',
    ]);
    expect(searchCustomers('5010').map((m) => m.customer.displayName)).toEqual(['Sarah Jones']);
    const scan = searchCustomers('356938035643809');
    expect(scan[0]?.customer.displayName).toBe('Ali Khan');
    expect(scan[0]?.device?.model).toBe('iPhone 13');
    expect(searchCustomers('a')).toEqual([]);
  });

  it('places typed text into the quick form (TK2.1)', () => {
    expect(seedFromTyped('Priya Shah')).toEqual({
      firstName: 'Priya',
      lastName: 'Shah',
      phone: '',
      email: '',
    });
    expect(seedFromTyped('0300 1234567').phone).toBe('0300 1234567');
    expect(seedFromTyped('a@b.co').email).toBe('a@b.co');
  });

  it('uses the contract IMEI copy', () => {
    expect(imeiError('')).toBeNull();
    expect(imeiError('356938035643809')).toBeNull();
    expect(imeiError('356938035643808')).toMatch(/^This IMEI isn't valid/);
    expect(imeiError('35693803564380')).toMatch(/IMEI has 15 digits$/);
  });

  it('searches the whole catalogue in one box', () => {
    expect(searchModels('iph 13')[0]).toEqual({
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 13',
    });
    expect(searchModels('ps5').length + searchModels('playstation 5').length).toBeGreaterThan(0);
  });

  it('filters issue chips by word prefix first', () => {
    expect(filterIssues('scr', 'PHONE')[0]).toBe('SCREEN_CRACKED');
    expect(filterIssues('', 'CONSOLE')).toContain('CONTROLLER_DRIFT');
  });

  it('builds a valid check-in context with the default due 2 open days ahead', () => {
    const ctx = mockCheckInContext(
      {
        country: 'GB',
        currency: 'GBP',
        locale: 'en-GB',
        timezone: 'Europe/London',
        pricesIncludeTax: true,
      },
      // Saturday 28 Nov 2026: Sunday is closed, so 2 open days = Tuesday 1 Dec.
      new Date('2026-11-28T12:00:00Z'),
    );
    expect(ctx.defaultDue.date).toBe('2026-12-01');
  });
});
