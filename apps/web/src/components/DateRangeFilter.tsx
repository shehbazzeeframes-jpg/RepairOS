'use client';

import {
  DateRangeInput,
  type DateRange,
  type DateRangePreset,
} from '@astryxdesign/core/DateRangeInput';
import { daysInRange } from '@repairos/contracts';
import { errorStatus } from './form';
import type { LocalDateRange } from '@/lib/timezone';

type ISODate = DateRange['start'];

export interface NamedRange {
  label: string;
  range: LocalDateRange;
}

/** DateRangeInput over shop-local "YYYY-MM-DD" strings, weeks starting Monday. */
export function DateRangeFilter({
  label,
  value,
  onChange,
  presets,
  maxDays,
  max,
  error,
}: {
  label: string;
  value: LocalDateRange;
  onChange: (range: LocalDateRange) => void;
  presets: NamedRange[];
  maxDays: number;
  /** Latest selectable date (today in shop time). */
  max?: string;
  error?: string;
}) {
  const tooLong = daysInRange(value.from, value.to) > maxDays;
  return (
    <DateRangeInput
      label={label}
      value={{ start: value.from as ISODate, end: value.to as ISODate }}
      onChange={(r) => {
        if (r) onChange({ from: r.start, to: r.end });
      }}
      hasClear={false}
      weekStartsOn="mon"
      maxRangeSpan={maxDays}
      max={max as ISODate | undefined}
      width={300}
      presets={presets.map((p): DateRangePreset => ({
        label: p.label,
        getRange: () => ({ start: p.range.from as ISODate, end: p.range.to as ISODate }),
      }))}
      status={errorStatus(
        error ?? (tooLong ? `Choose a range of ${maxDays} days or fewer` : undefined),
      )}
    />
  );
}
