import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { errorCode, errorMessage, hasErrorCode } from './errors';

const err = (code: string, message = 'server says') =>
  new ApiRequestError({ statusCode: 409, code, message });

describe('errorMessage', () => {
  it('uses the contract copy for known codes', () => {
    expect(errorMessage(err('LAST_OWNER'))).toBe('A shop needs at least one active owner.');
    expect(errorMessage(err('SEAT_LIMIT_REACHED'))).toBe(
      'Your plan includes 5 users. Extra users are $5/month; billing arrives later.',
    );
  });

  it('fills placeholders from what the screen knows', () => {
    expect(errorMessage(err('ALREADY_MEMBER'), { email: 'sam@x.com' })).toBe(
      'sam@x.com is already on your team.',
    );
  });

  it("falls back to the API's message when a placeholder is unknown or there is no copy", () => {
    expect(errorMessage(err('MEMBER_DEACTIVATED', 'Sam Lee was deactivated.'))).toBe(
      'Sam Lee was deactivated.',
    );
    expect(errorMessage(err('RATE_LIMITED', 'Slow down'))).toBe('Slow down');
    expect(errorMessage(err('SOMETHING_NEW', 'New thing'))).toBe('New thing');
  });

  it('handles non-API errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('x')).toBe('Something went wrong. Please try again.');
  });

  it('reads codes', () => {
    expect(errorCode(err('LAST_OWNER'))).toBe('LAST_OWNER');
    expect(errorCode(err('NOPE'))).toBeNull();
    expect(hasErrorCode(err('INVITE_EXPIRED'), 'INVITE_EXPIRED', 'INVITE_REVOKED')).toBe(true);
  });
});
