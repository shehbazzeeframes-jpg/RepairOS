import { HStack } from '@astryxdesign/core/HStack';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import type { CountryCode } from '@repairos/contracts';
import { phoneDisplay } from '@/lib/phone-display';

export interface PhoneTextProps {
  /** Stored E.164 number. */
  e164: string;
  shopCountry: CountryCode;
  /** Render as a `tel:` link (customer card, ticket header). Plain text in dense tables. */
  isCallable?: boolean;
  /** Also offer a WhatsApp link (the customer's WhatsApp number; hidden for fixed lines). */
  hasWhatsApp?: boolean;
  /** "Mobile", "Work"… shown after the number in secondary text. */
  label?: string;
}

/** A phone number in the shop's national format (international for foreign numbers). */
export function PhoneText({ e164, shopCountry, isCallable, hasWhatsApp, label }: PhoneTextProps) {
  const p = phoneDisplay(e164, shopCountry, { whatsapp: hasWhatsApp });
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {isCallable ? (
        <Link href={p.telHref} label={`Call ${p.text}`}>
          {p.text}
        </Link>
      ) : (
        <Text hasTabularNumbers>{p.text}</Text>
      )}
      {label ? (
        <Text type="supporting" color="secondary">
          {label}
        </Text>
      ) : null}
      {p.whatsappHref ? (
        <Link href={p.whatsappHref} isExternalLink type="supporting" label={`WhatsApp ${p.text}`}>
          WhatsApp
        </Link>
      ) : null}
    </HStack>
  );
}
