'use client';

/*
 * Passcode reveal (spec §3.2, A15): POST (never GET), shown for PASSCODE_REVEAL_SECONDS, then
 * masked again. No copy button; the value never goes to the URL, title or storage, and is cleared
 * from state on hide and on unmount.
 */

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { LockClosedIcon } from '@heroicons/react/20/solid';
import {
  LOCK_TYPE_LABELS,
  PASSCODE_REVEAL_SECONDS,
  PasscodeReveal as PasscodeRevealSchema,
  passcodeRevealPath,
  type PasscodeReveal as Revealed,
  type TicketDevice,
} from '@repairos/contracts';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PatternLockInput } from '@/components/ui/PatternLockInput';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { describePattern } from '@/lib/pattern-lock';
import { useSession } from '@/lib/shop-context';
import { formatDateTime } from '@/lib/timezone';

export function PasscodeReveal({
  ticketId,
  device,
  isClosed,
  canReveal,
}: {
  ticketId: string;
  device: TicketDevice;
  isClosed: boolean;
  canReveal: boolean;
}) {
  const { me, shop } = useSession();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [left, setLeft] = useState(0);
  const [views, setViews] = useState({
    count: device.passcodeViewCount,
    by: device.passcodeLastViewedBy?.name ?? null,
    at: device.passcodeLastViewedAt,
  });

  const reveal = useMutation({
    mutationFn: () =>
      apiFetch(passcodeRevealPath(ticketId), PasscodeRevealSchema, { method: 'POST' }),
    onSuccess: (r) => {
      setRevealed(r);
      setLeft(PASSCODE_REVEAL_SECONDS);
      setViews({ count: r.viewCount, by: me.user.name, at: r.revealedAt });
    },
  });

  // Count down once a second; hide (and drop the value) at zero.
  useEffect(() => {
    if (!revealed) return;
    const t = window.setInterval(() => {
      setLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [revealed]);
  const shown = revealed && left > 0 ? revealed : null;
  // The value is dropped from state once the countdown ends (an interval tick, not render).
  useEffect(() => {
    if (!revealed || left > 0) return;
    const t = window.setTimeout(() => setRevealed(null), 0);
    return () => window.clearTimeout(t);
  }, [revealed, left]);

  if (!device.passcodeOnFile) return null;
  const label = `${LOCK_TYPE_LABELS[device.lockType]} on file`;
  const viewed =
    views.count > 0
      ? `Viewed ${views.count} ${views.count === 1 ? 'time' : 'times'}${
          views.by && views.at ? ` · last by ${views.by}, ${formatDateTime(views.at, shop)}` : ''
        }`
      : 'Not viewed yet';

  if (isClosed || !canReveal) {
    return (
      <HStack gap={2} vAlign="center">
        <Icon icon={LockClosedIcon} size="sm" color="secondary" />
        <Text>Passcode on file</Text>
      </HStack>
    );
  }

  return (
    <VStack gap={2}>
      {shown ? (
        <Card variant="muted" padding={4}>
          <VStack gap={3} aria-label="Revealed passcode" role="group">
            {shown.lockType === 'PATTERN' ? (
              <VStack gap={2}>
                <PatternLockInput label="Pattern" value={shown.pattern} isReadOnly />
                <Text type="supporting">Order: {describePattern(shown.pattern)}</Text>
              </VStack>
            ) : (
              <Text type="code" size="lg" weight="semibold">
                {shown.value}
              </Text>
            )}
            <ProgressBar
              label={`Hides in ${left} s`}
              value={left}
              max={PASSCODE_REVEAL_SECONDS}
              hasValueLabel
              formatValueLabel={(v) => `Hides in ${v} s`}
              variant="neutral"
            />
            {left === 10 ? (
              <VisuallyHidden aria-live="polite">Hides in 10 seconds</VisuallyHidden>
            ) : null}
            <HStack>
              <Button
                label="Hide now"
                variant="ghost"
                size="sm"
                onClick={() => setRevealed(null)}
              />
            </HStack>
          </VStack>
        </Card>
      ) : (
        <HStack gap={3} vAlign="center" wrap="wrap">
          <HStack gap={2} vAlign="center">
            <Icon icon={LockClosedIcon} size="sm" color="secondary" />
            <Text>{label}</Text>
          </HStack>
          <Button
            label="Show passcode"
            size="sm"
            isLoading={reveal.isPending}
            onClick={() => reveal.mutate()}
          />
        </HStack>
      )}
      {reveal.isError ? (
        <Text type="supporting" color="primary" role="alert">
          {errorMessage(reveal.error)}
        </Text>
      ) : null}
      <Text type="supporting" color="secondary">
        {viewed}
      </Text>
    </VStack>
  );
}
