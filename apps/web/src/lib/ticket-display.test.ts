import { describe, expect, it } from 'vitest';
import { CATEGORY_TONE, canBeOverdue, describeDue, statusTone } from './ticket-display';

const UK = { timezone: 'Europe/London', locale: 'en-GB' };
const US = { timezone: 'America/New_York', locale: 'en-US' };
// Wed 25 Nov 2026, 10:00 in London (UTC+0 in winter).
const NOW = Date.parse('2026-11-25T10:00:00Z');

describe('statusTone', () => {
  it('uses the category tone when the status has no colour', () => {
    expect(statusTone('OPEN')).toBe('info');
    expect(statusTone('WAITING', null)).toBe('warning');
    expect(statusTone('READY')).toBe('success');
    expect(statusTone('CLOSED')).toBe('neutral');
  });
  it('lets a configured colour win', () => {
    expect(statusTone('OPEN', 'purple')).toBe('purple');
  });
  it('covers every category', () => {
    expect(Object.keys(CATEGORY_TONE).sort()).toEqual(['CLOSED', 'OPEN', 'READY', 'WAITING']);
  });
});

describe('canBeOverdue', () => {
  it('is true only for open and waiting (DU1.2)', () => {
    expect(canBeOverdue('OPEN')).toBe(true);
    expect(canBeOverdue('WAITING')).toBe(true);
    expect(canBeOverdue('READY')).toBe(false);
    expect(canBeOverdue('CLOSED')).toBe(false);
  });
});

describe('describeDue', () => {
  it('shows today with the time when one was set, as a "today" tone', () => {
    const d = describeDue(
      { dueAt: '2026-11-25T17:00:00Z', hasTime: true, category: 'OPEN' },
      UK,
      NOW,
    );
    expect(d).toMatchObject({ label: 'Today 17:00', tone: 'today', isOverdue: false });
    expect(d.absolute).toBe('Wed, 25 Nov 2026, 17:00');
  });

  it('hides the closing time for a date-only due', () => {
    const d = describeDue(
      { dueAt: '2026-11-26T18:00:00Z', hasTime: false, category: 'OPEN' },
      UK,
      NOW,
    );
    expect(d.label).toBe('Tomorrow');
    expect(d.absolute).toBe('Thu, 26 Nov 2026');
    expect(d.tone).toBe('normal');
  });

  it('uses the weekday within a week and a short date after that', () => {
    expect(
      describeDue({ dueAt: '2026-11-27T18:00:00Z', hasTime: false, category: 'OPEN' }, UK, NOW)
        .label,
    ).toBe('Fri');
    expect(
      describeDue({ dueAt: '2026-12-09T18:00:00Z', hasTime: false, category: 'OPEN' }, UK, NOW)
        .label,
    ).toBe('9 Dec');
    expect(
      describeDue({ dueAt: '2027-01-09T18:00:00Z', hasTime: false, category: 'OPEN' }, UK, NOW)
        .label,
    ).toBe('9 Jan 2027');
  });

  it('counts overdue days in the shop time zone', () => {
    const one = describeDue(
      { dueAt: '2026-11-24T18:00:00Z', hasTime: false, category: 'WAITING' },
      UK,
      NOW,
    );
    expect(one).toMatchObject({ label: '1 day overdue', tone: 'overdue', isOverdue: true });
    const two = describeDue(
      { dueAt: '2026-11-23T18:00:00Z', hasTime: false, category: 'OPEN' },
      UK,
      NOW,
    );
    expect(two.label).toBe('2 days overdue');
  });

  it('is overdue since a time earlier today', () => {
    const d = describeDue(
      { dueAt: '2026-11-25T09:00:00Z', hasTime: true, category: 'OPEN' },
      UK,
      NOW,
    );
    expect(d).toMatchObject({ label: 'Overdue since 09:00', tone: 'overdue' });
  });

  it('never marks ready or closed tickets overdue', () => {
    const d = describeDue(
      { dueAt: '2026-11-24T18:00:00Z', hasTime: false, category: 'READY' },
      UK,
      NOW,
    );
    expect(d).toMatchObject({ label: 'Yesterday', tone: 'normal', isOverdue: false });
  });

  it('uses the shop day, not UTC: 03:00 UTC is still "yesterday" evening in New York', () => {
    // 25 Nov 03:00 UTC = 24 Nov 22:00 in New York; now = 25 Nov 05:00 New York.
    const d = describeDue(
      { dueAt: '2026-11-25T03:00:00Z', hasTime: true, category: 'OPEN' },
      US,
      Date.parse('2026-11-25T10:00:00Z'),
    );
    expect(d.label).toBe('1 day overdue');
    expect(d.absolute).toBe('Tue, Nov 24, 2026, 10:00 PM');
  });

  it('formats 12h for en-US', () => {
    const d = describeDue(
      { dueAt: '2026-11-25T22:00:00Z', hasTime: true, category: 'OPEN' },
      US,
      Date.parse('2026-11-25T14:00:00Z'),
    );
    expect(d.label).toBe('Today 5:00 PM');
  });
});
