import { describe, expect, it } from 'vitest';
import { isPrototypeEnabled } from './prototypes';

describe('isPrototypeEnabled', () => {
  it('is on in dev and in the e2e build, off in production', () => {
    expect(isPrototypeEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isPrototypeEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isPrototypeEnabled({ NODE_ENV: 'production', NEXT_PUBLIC_PROTOTYPES: '1' })).toBe(true);
  });
});
