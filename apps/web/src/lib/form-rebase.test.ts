import { describe, expect, it } from 'vitest';
import { changedEntries, editedKeys, rebaseForm } from './form-rebase';

/** BUG-02: Reload after a version conflict keeps only what this person edited. */
describe('rebaseForm', () => {
  const base = {
    notes: '',
    priority: 'NORMAL',
    checklist: { SCREEN: 'PASS', POWERS_ON: 'UNTESTED' },
  };

  it('takes the server value for every field the person did not edit', () => {
    const mine = { ...base, priority: 'URGENT' };
    const fresh = { ...base, notes: 'Scratch on the back' };
    expect(rebaseForm(base, mine, fresh)).toEqual({
      notes: 'Scratch on the back',
      priority: 'URGENT',
      checklist: base.checklist,
    });
  });

  it('keeps an edit even when the server changed the same field', () => {
    const mine = { ...base, notes: 'Dent' };
    const fresh = { ...base, notes: 'Scratch' };
    expect(rebaseForm(base, mine, fresh).notes).toBe('Dent');
  });

  it('merges nested records entry by entry', () => {
    const mine = { ...base, checklist: { ...base.checklist, POWERS_ON: 'FAIL' } };
    const fresh = { ...base, checklist: { SCREEN: 'FAIL', POWERS_ON: 'UNTESTED' } };
    expect(rebaseForm(base, mine, fresh, ['checklist']).checklist).toEqual({
      SCREEN: 'FAIL',
      POWERS_ON: 'FAIL',
    });
  });
});

describe('editedKeys / changedEntries', () => {
  it('compare by value, arrays included', () => {
    expect(editedKeys({ a: [1], b: 'x' }, { a: [1], b: 'y' })).toEqual(['b']);
    expect(changedEntries({ a: [1], b: null }, { a: [1, 2], b: null })).toEqual({ a: [1, 2] });
  });
});
