/**
 * Pattern-lock rules (DV3.3): dots 1–9 on a 3×3 grid, numbered left to right, top to bottom;
 * a valid pattern is 4–9 distinct dots, stored as the ordered sequence ("1-5-9-6").
 */
export const PATTERN_MIN = 4;
export const PATTERN_MAX = 9;

export type PatternKeyResult =
  | { kind: 'change'; value: number[] }
  | { kind: 'confirm' }
  | { kind: 'ignore' };

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

export function patternError(value: readonly number[]): string | null {
  if (value.length === 0) return 'Draw the pattern, or type the dot numbers';
  if (value.length < PATTERN_MIN) return `Use at least ${PATTERN_MIN} dots`;
  return null;
}

/** "1 → 5 → 9 → 6" for screen readers and the reveal. */
export function describePattern(value: readonly number[]): string {
  return value.length ? value.join(' → ') : 'No dots yet';
}

export function serializePattern(value: readonly number[]): string {
  return value.join('-');
}
