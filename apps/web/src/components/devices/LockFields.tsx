'use client';

/* Lock type + PIN/password field or pattern grid (spec §2.3 Device, §5 Lock). */

import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { LOCK_TYPE_LABELS, PasswordCode, PinCode, type LockType } from '@repairos/contracts';
import { PatternLockInput } from '@/components/ui/PatternLockInput';
import type { LockDraft } from '@/lib/check-in';
import { patternError } from '@/lib/pattern-lock';

export const PASSCODE_NOTE =
  'Encrypted. Staff see it only on an open ticket; deleted when the repair is closed.';

/** Field message for the secret (contract copy), or null when fine. */
export function lockProblem(lock: LockDraft): string | null {
  if (lock.lockType === 'PIN') {
    const r = PinCode.safeParse(lock.secret);
    return r.success ? null : (r.error.issues[0]?.message ?? 'Use 4–16 digits');
  }
  if (lock.lockType === 'PASSWORD') {
    const r = PasswordCode.safeParse(lock.secret);
    return r.success ? null : (r.error.issues[0]?.message ?? 'Enter the password');
  }
  if (lock.lockType === 'PATTERN') return patternError(lock.pattern);
  return null;
}

export function LockFields({
  value,
  onChange,
  onConfirm,
  showErrors,
  note = PASSCODE_NOTE,
  reenterHint,
}: {
  value: LockDraft;
  onChange: (next: LockDraft) => void;
  /** ↵ in the PIN/password field or the pattern grid. */
  onConfirm?: () => void;
  showErrors?: boolean;
  note?: string;
  /** "Enter the passcode again" after a draft restore. */
  reenterHint?: boolean;
}) {
  const problem = showErrors ? lockProblem(value) : null;
  return (
    <VStack gap={3}>
      <VStack gap={2}>
        <Text weight="medium">Lock</Text>
        <SegmentedControl
          label="Lock"
          value={value.lockType}
          onChange={(v) => onChange({ ...value, lockType: v as LockType })}
        >
          {(Object.keys(LOCK_TYPE_LABELS) as LockType[]).map((k) => (
            <SegmentedControlItem key={k} value={k} label={LOCK_TYPE_LABELS[k]} />
          ))}
        </SegmentedControl>
      </VStack>
      {value.lockType === 'PIN' || value.lockType === 'PASSWORD' ? (
        <TextInput
          label={LOCK_TYPE_LABELS[value.lockType]}
          type="password"
          inputMode={value.lockType === 'PIN' ? 'numeric' : 'text'}
          autoComplete="off"
          value={value.secret}
          onChange={(secret) => onChange({ ...value, secret })}
          onEnter={onConfirm}
          description={reenterHint ? `Enter the passcode again. ${note}` : note}
          status={problem ? { type: 'error', message: problem } : undefined}
        />
      ) : null}
      {value.lockType === 'PATTERN' ? (
        <PatternLockInput
          value={value.pattern}
          onChange={(pattern) => onChange({ ...value, pattern })}
          onConfirm={onConfirm}
          hasError={showErrors}
        />
      ) : null}
    </VStack>
  );
}
