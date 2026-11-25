import { describe, expect, it } from 'vitest';
import { extractLinks, isDevOutboxEnabled, recipients } from './dev-outbox';

describe('dev outbox', () => {
  it('is a 404 in production builds unless the e2e flag is set', () => {
    expect(isDevOutboxEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevOutboxEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isDevOutboxEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isDevOutboxEnabled({ NODE_ENV: 'production', NEXT_PUBLIC_DEV_OUTBOX: '1' })).toBe(true);
  });

  it('finds invite and reset links and makes them app paths', () => {
    const links = extractLinks({
      text: 'Help: https://repairos.app/help\nAccept: http://localhost:3000/invite/abc_DEF-123',
      html: '<a href="http://localhost:3000/reset-password?token=t1&amp;x=1">Reset</a>',
    });
    expect(links).toEqual([
      { url: 'http://localhost:3000/invite/abc_DEF-123', appPath: '/invite/abc_DEF-123' },
      {
        url: 'http://localhost:3000/reset-password?token=t1&x=1',
        appPath: '/reset-password?token=t1&x=1',
      },
      { url: 'https://repairos.app/help', appPath: null },
    ]);
  });

  it('joins recipients', () => {
    expect(recipients({ to: ['a@x.com', 'b@x.com'] })).toBe('a@x.com, b@x.com');
    expect(recipients({ to: 'a@x.com' })).toBe('a@x.com');
  });
});
