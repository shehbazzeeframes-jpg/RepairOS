import { Badge } from '@astryxdesign/core/Badge';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/16/solid';
import { describeDue, type DueInput } from '@/lib/ticket-display';
import type { ShopClock } from '@/lib/timezone';

export interface DueChipProps extends DueInput {
  shop: ShopClock;
  /** Injected clock: a list passes one `now` to every row so they agree. */
  now?: number;
  /** "absolute" shows the full date (ticket header); "relative" (default) the short form (lists). */
  format?: 'relative' | 'absolute';
}

/**
 * Due date of a ticket in shop time. Overdue (open/waiting and past due) is an error badge with a
 * warning glyph and "n days overdue"; due today is a warning badge; anything else is plain text.
 * The other form is always in the tooltip, so a list can stay short without losing precision.
 */
export function DueChip({ shop, now, format = 'relative', ...due }: DueChipProps) {
  const d = describeDue(due, shop, now);
  const visible = format === 'absolute' && !d.isOverdue ? d.absolute : d.label;
  const hint = visible === d.absolute ? d.label : d.absolute;

  let body;
  if (d.tone === 'overdue') {
    body = (
      <Badge
        variant="error"
        label={format === 'absolute' ? `${d.label} · ${d.absolute}` : d.label}
        icon={<Icon icon={ExclamationTriangleIcon} size="xsm" />}
      />
    );
  } else if (d.tone === 'today') {
    body = <Badge variant="warning" label={visible} icon={<Icon icon={ClockIcon} size="xsm" />} />;
  } else {
    body = (
      <Text color="secondary" hasTabularNumbers>
        {visible}
      </Text>
    );
  }
  return <Tooltip content={`Due ${hint}`}>{body}</Tooltip>;
}
