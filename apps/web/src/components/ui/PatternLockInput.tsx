'use client';

import { Grid } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { VStack } from '@astryxdesign/core/VStack';
import { useId, type KeyboardEvent } from 'react';
import { RovingGroup } from './RovingGroup';
import { describePattern, patternError, patternKey, patternTap } from '@/lib/pattern-lock';

export interface PatternLockInputProps {
  label?: string;
  value: number[];
  onChange?: (value: number[]) => void;
  /** Enter inside the grid (move on to the next field). */
  onConfirm?: () => void;
  /** Reveal mode: shows the stored order, no input. */
  isReadOnly?: boolean;
  /** Show the "at least 4 dots" message (after a submit attempt). */
  hasError?: boolean;
}

/**
 * 3×3 pattern grid (DV3.3) from Astryx ToggleButtons. Pointer: tap dots in order (tap the last one
 * again to undo). Keyboard: the grid is one Tab stop; type the dot numbers 1–9 (or arrow to a dot
 * and press Space), Backspace removes the last dot, Delete clears, Enter confirms. The sequence is always shown and announced as text.
 */
export function PatternLockInput({
  label = 'Pattern',
  value,
  onChange,
  onConfirm,
  isReadOnly,
  hasError,
}: PatternLockInputProps) {
  const id = useId();
  const error = hasError ? patternError(value) : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (isReadOnly || e.metaKey || e.ctrlKey || e.altKey) return;
    const result = patternKey(value, e.key);
    if (result.kind === 'ignore') return;
    e.preventDefault();
    e.stopPropagation();
    if (result.kind === 'change') onChange?.(result.value);
    else onConfirm?.();
  };

  return (
    <VStack gap={2}>
      <Text weight="medium" id={`${id}-label`}>
        {label}
      </Text>
      {!isReadOnly ? (
        <Text type="supporting" color="secondary" id={`${id}-help`}>
          Tap the dots in order, or type their numbers (1 is top left, 9 bottom right).
        </Text>
      ) : null}
      <RovingGroup>
        <Grid
          columns={3}
          gap={2}
          width="fit-content"
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help ${id}-seq`}
          onKeyDown={onKeyDown}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((dot) => {
            const step = value.indexOf(dot);
            const isOn = step >= 0;
            return (
              <ToggleButton
                key={dot}
                size="lg"
                label={isOn ? `Dot ${dot}, step ${step + 1}` : `Dot ${dot}`}
                isPressed={isOn}
                isDisabled={isReadOnly && !isOn}
                onPressedChange={() => {
                  if (!isReadOnly) onChange?.(patternTap(value, dot));
                }}
              >
                {isReadOnly && isOn ? `${step + 1}` : `${dot}`}
              </ToggleButton>
            );
          })}
        </Grid>
      </RovingGroup>
      <Text
        id={`${id}-seq`}
        type="supporting"
        color={error ? 'primary' : 'secondary'}
        aria-live="polite"
        hasTabularNumbers
      >
        {error ? `${error}. ` : ''}
        {isReadOnly ? `Order: ${describePattern(value)}` : `Pattern: ${describePattern(value)}`}
        {value.length ? ` (${value.length} dots)` : ''}
      </Text>
    </VStack>
  );
}
