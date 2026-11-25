import { MeResponse } from '@repairos/contracts';
import { describe, expect, it } from 'vitest';
import { redirectFor } from './redirects';

const user = { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' };
const noShop = MeResponse.parse({ user, memberships: [], activeShop: null, role: null });
const withShop = MeResponse.parse({
  user,
  memberships: [{ shopId: 's1', shopName: 'Fix It', role: 'OWNER' }],
  activeShop: {
    id: 's1',
    name: 'Fix It',
    country: 'US',
    currency: 'USD',
    locale: 'en-US',
    timezone: 'America/New_York',
    pricesIncludeTax: false,
    phone: null,
    createdAt: '2026-11-20T09:00:00.000Z',
  },
  role: 'OWNER',
});

describe('redirectFor', () => {
  it('sends signed-out users to sign-in from app and onboarding', () => {
    expect(redirectFor('app', null)).toBe('/sign-in');
    expect(redirectFor('onboarding', null)).toBe('/sign-in');
    expect(redirectFor('guest', null)).toBeNull();
  });

  it('sends users without a shop to onboarding', () => {
    expect(redirectFor('app', noShop)).toBe('/onboarding');
    expect(redirectFor('onboarding', noShop)).toBeNull();
    expect(redirectFor('guest', noShop)).toBe('/onboarding');
  });

  it('lets users with a shop into the app', () => {
    expect(redirectFor('app', withShop)).toBeNull();
    expect(redirectFor('onboarding', withShop)).toBe('/');
    expect(redirectFor('guest', withShop)).toBe('/');
  });
});
