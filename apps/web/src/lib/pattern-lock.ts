/**
 * Input model for the 3×3 pattern grid. The rules themselves are the contract's `PatternLock`
 * (4–9 distinct dots 1–9) and `formatPattern` ("1-5-9-6"); this adds the keyboard/tap behaviour.
 */
import { PatternLock, formatPattern } from '@repairos/contracts';

export const PATTERN_MIN = 4;
export const PATTERN_MAX = 9;

export type PatternKeyResult =
  { kind: 'change'; value: number[] } | { kind: 'confirm' } | { kind: 'ignore' };

/** Keyboard model: a digit adds that dot, Backspace removes the last, Delete clears, Enter confirms. */
export function patternKey(value: readonly number[], key: string): PatternKeyResult {
  if (/^[1-9]$/.test(key)) {
    const dot = Number(key);
    if (value.includes(dot) || value.length >= PATTERN_MAX) return { kind: 'ignore' };
    return { kind: 'change', value: [...value, dot] };
  }
  if (key === 'Backspace') {
    return value.length ? { kind: 'change', value: value.slice(0, -1) } : { kind: 'ignore' };
  }
  if (key === 'Delete') return value.length ? { kind: 'change', value: [] } : { kind: 'ignore' };
  if (key === 'Enter') return { kind: 'confirm' };
  return { kind: 'ignore' };
}

/** Pointer model: tapping an unused dot adds it; tapping the last dot again takes it back. */
export function patternTap(value: readonly number[], dot: number): number[] {
  if (value[value.length - 1] === dot) return value.slice(0, -1);
  if (value.includes(dot) || value.length >= PATTERN_MAX) return [...value];
  return [...value, dot];
}

/** Field message from the contract schema ("Connect at least 4 dots"); a hint when nothing is drawn. */
export function patternError(value: readonly number[]): string | null {
  if (value.length === 0) return 'Draw the pattern, or type the dot numbers';
  const parsed = PatternLock.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Check the pattern');
}

/** "1 → 5 → 9 → 6" for screen readers and the reveal. */
export function describePattern(value: readonly number[]): string {
  return value.length ? value.join(' → ') : 'No dots yet';
}

export const serializePattern = formatPattern;
