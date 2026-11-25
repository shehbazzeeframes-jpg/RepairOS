import { formatDuration } from '@repairos/contracts';

/** Whole minutes between two instants (never negative). */
export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 60_000));
}

/** Top-bar style: "14m" under an hour, then "2h 14m" (contracts `formatDuration`). */
export function formatShortDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  return m < 60 ? `${m}m` : formatDuration(m);
}

/** "Clocked in 2h 14m" */
export function clockedInLabel(minutes: number): string {
  return `Clocked in ${formatShortDuration(minutes)}`;
}
