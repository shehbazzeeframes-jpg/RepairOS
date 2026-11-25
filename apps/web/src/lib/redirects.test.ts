import { MeResponse, permissionsFor } from '@repairos/contracts';
import { describe, expect, it } from 'vitest';
import { invitePath, redirectFor } from './redirects';

const user = { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' };
const shop = {
  id: 's1',
  name: 'Fix It',
  country: 'US',
  currency: 'USD',
  locale: 'en-US',
  timezone: 'America/New_York',
  pricesIncludeTax: false,
  phone: null,
  createdAt: '2026-11-20T09:00:00.000Z',
};
const noShop = MeResponse.parse({
  user,
  memberships: [],
  activeShop: null,
  role: null,
  permissions: [],
  accessRemoved: null,
});
const withShop = MeResponse.parse({
  user,
  memberships: [{ shopId: 's1', shopName: 'Fix It', role: 'OWNER', status: 'ACTIVE' }],
  activeShop: shop,
  role: 'OWNER',
  permissions: permissionsFor('OWNER'),
  accessRemoved: null,
});
const removed = MeResponse.parse({
  ...noShop,
  accessRemoved: { shopId: 's9', shopName: 'Old Shop' },
});
const removedButFellBack = MeResponse.parse({
  ...withShop,
  accessRemoved: { shopId: 's9', shopName: 'Old Shop' },
});
const TOKEN = 'a'.repeat(43);

describe('redirectFor', () => {
  it('sends signed-out users to sign-in from gated pages', () => {
    expect(redirectFor('app', null)).toBe('/sign-in');
    expect(redirectFor('onboarding', null)).toBe('/sign-in');
    expect(redirectFor('access-removed', null)).toBe('/sign-in');
    expect(redirectFor('guest', null)).toBeNull();
  });

  it('sends users without a shop to onboarding', () => {
    expect(redirectFor('app', noShop)).toBe('/onboarding');
    expect(redirectFor('onboarding', noShop)).toBeNull();
    expect(redirectFor('guest', noShop)).toBe('/onboarding');
    expect(redirectFor('access-removed', noShop)).toBe('/onboarding');
  });

  it('lets users with a shop into the app', () => {
    expect(redirectFor('app', withShop)).toBeNull();
    expect(redirectFor('onboarding', withShop)).toBe('/');
    expect(redirectFor('guest', withShop)).toBe('/');
    expect(redirectFor('access-removed', withShop)).toBe('/');
  });

  it('keeps a user with a shop on onboarding when creating another shop', () => {
    expect(redirectFor('onboarding', withShop, { newShop: true })).toBeNull();
  });

  it('shows access-removed, not onboarding, when every membership is deactivated', () => {
    expect(redirectFor('app', removed)).toBe('/access-removed');
    expect(redirectFor('guest', removed)).toBe('/access-removed');
    expect(redirectFor('access-removed', removed)).toBeNull();
    // They may still choose "Create your own shop".
    expect(redirectFor('onboarding', removed)).toBeNull();
  });

  it('keeps a user in the app when the API fell back to another shop', () => {
    expect(redirectFor('app', removedButFellBack)).toBeNull();
    expect(redirectFor('access-removed', removedButFellBack)).toBe('/');
  });

  it('never redirects public pages such as /invite/*', () => {
    for (const me of [null, noShop, withShop, removed]) {
      expect(redirectFor('public', me)).toBeNull();
    }
  });

  it('returns signed-in users from sign-in/sign-up to their invite', () => {
    expect(redirectFor('guest', noShop, { invite: TOKEN })).toBe(`/invite/${TOKEN}`);
    expect(redirectFor('guest', withShop, { invite: TOKEN })).toBe(`/invite/${TOKEN}`);
    expect(redirectFor('guest', null, { invite: TOKEN })).toBeNull();
  });

  it('ignores malformed invite tokens', () => {
    expect(redirectFor('guest', noShop, { invite: '../../evil' })).toBe('/onboarding');
    expect(invitePath('short')).toBeNull();
    expect(invitePath(null)).toBeNull();
    expect(invitePath(TOKEN)).toBe(`/invite/${TOKEN}`);
  });
});
