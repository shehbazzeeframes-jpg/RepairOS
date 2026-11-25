import { Text } from '@astryxdesign/core/Text';
import type { CurrencyCode } from '@repairos/contracts';
import { formatMoney } from '@/lib/format';

export interface MoneyTextProps {
  /** Integer minor units (cents, pence, paisa). */
  amountMinor: number | null | undefined;
  currency: CurrencyCode;
  locale: string;
  /** Adds "incl. tax" / "excl. tax" after the amount (check-in estimate, ticket intake). */
  taxNote?: 'incl' | 'excl';
  /** Shown when there is no amount (default "—"). */
  emptyText?: string;
  type?: 'body' | 'large' | 'label' | 'supporting' | 'display-3';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  color?: 'primary' | 'secondary';
}

const TAX_NOTE = { incl: 'incl. tax', excl: 'excl. tax' } as const;

/** An amount in the shop currency with tabular figures, via the shared `formatMoney`. */
export function MoneyText({
  amountMinor,
  currency,
  locale,
  taxNote,
  emptyText = '—',
  type = 'body',
  weight,
  color,
}: MoneyTextProps) {
  if (amountMinor === null || amountMinor === undefined) {
    return (
      <Text type={type} color="secondary">
        {emptyText}
      </Text>
    );
  }
  const amount = formatMoney(amountMinor, { currency, locale });
  return (
    <Text type={type} weight={weight} color={color} hasTabularNumbers>
      {taxNote ? `${amount} ${TAX_NOTE[taxNote]}` : amount}
    </Text>
  );
}
