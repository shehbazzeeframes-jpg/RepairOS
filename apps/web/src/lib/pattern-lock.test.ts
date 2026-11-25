import { describe, expect, it } from 'vitest';
import {
  describePattern,
  patternError,
  patternKey,
  patternTap,
  serializePattern,
} from './pattern-lock';

describe('patternKey', () => {
  it('adds a digit once, in order', () => {
    expect(patternKey([1, 5], '9')).toEqual({ kind: 'change', value: [1, 5, 9] });
    expect(patternKey([1, 5], '5')).toEqual({ kind: 'ignore' });
    expect(patternKey([1], '0')).toEqual({ kind: 'ignore' });
  });
  it('Backspace removes the last dot, Delete clears, Enter confirms', () => {
    expect(patternKey([1, 5, 9], 'Backspace')).toEqual({ kind: 'change', value: [1, 5] });
    expect(patternKey([], 'Backspace')).toEqual({ kind: 'ignore' });
    expect(patternKey([1, 5], 'Delete')).toEqual({ kind: 'change', value: [] });
    expect(patternKey([1, 5, 9, 6], 'Enter')).toEqual({ kind: 'confirm' });
  });
  it('stops at 9 dots', () => {
    expect(patternKey([1, 2, 3, 4, 5, 6, 7, 8, 9], '1')).toEqual({ kind: 'ignore' });
  });
});

describe('patternTap', () => {
  it('adds an unused dot and undoes the last one', () => {
    expect(patternTap([1, 5], 9)).toEqual([1, 5, 9]);
    expect(patternTap([1, 5, 9], 9)).toEqual([1, 5]);
    expect(patternTap([1, 5, 9], 5)).toEqual([1, 5, 9]);
  });
});

describe('patternError / describe / serialize', () => {
  it('uses the contract rule (at least 4 dots)', () => {
    expect(patternError([])).toBe('Draw the pattern, or type the dot numbers');
    expect(patternError([1, 5, 9])).toBe('Connect at least 4 dots');
    expect(patternError([1, 5, 9, 6])).toBeNull();
  });
  it('describes and serialises the order', () => {
    expect(describePattern([1, 5, 9, 6])).toBe('1 → 5 → 9 → 6');
    expect(serializePattern([1, 5, 9, 6])).toBe('1-5-9-6');
  });
});
