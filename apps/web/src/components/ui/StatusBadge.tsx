import { Badge } from '@astryxdesign/core/Badge';
import { Icon } from '@astryxdesign/core/Icon';
import {
  ArchiveBoxIcon,
  CheckCircleIcon,
  PauseCircleIcon,
  WrenchIcon,
} from '@heroicons/react/16/solid';
import type { ComponentType, SVGProps } from 'react';
import {
  CATEGORY_LABEL,
  statusTone,
  type StatusCategory,
  type StatusTone,
} from '@/lib/ticket-display';

/** One glyph per category, so the category reads without colour (story §3, a11y). */
const CATEGORY_ICON: Record<StatusCategory, ComponentType<SVGProps<SVGSVGElement>>> = {
  OPEN: WrenchIcon,
  WAITING: PauseCircleIcon,
  READY: CheckCircleIcon,
  CLOSED: ArchiveBoxIcon,
};

export interface StatusBadgeProps {
  /** The shop's own name for the status ("In repair", "Awaiting parts"). */
  name: string;
  category: StatusCategory;
  /** The colour picked in Settings → Ticket statuses; the category's tone when unset. */
  colour?: StatusTone | null;
}

/**
 * A ticket status. The category drives the default tone and the icon; the shop's colour, when set,
 * only changes the tone. The badge's accessible text is "{name} ({category})".
 */
export function StatusBadge({ name, category, colour }: StatusBadgeProps) {
  return (
    <Badge
      label={name}
      variant={statusTone(category, colour)}
      icon={<Icon icon={CATEGORY_ICON[category]} size="xsm" label={CATEGORY_LABEL[category]} />}
    />
  );
}
