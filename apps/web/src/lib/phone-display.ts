import { formatPhone, type CountryCode } from '@repairos/contracts';

export interface PhoneDisplay {
  /** National format for the shop's country, international otherwise ("07911 123456", "+92 300 1234567"). */
  text: string;
  /** `tel:` link with the E.164 number. */
  telHref: string;
  /** `https://wa.me/<digits>` (CU6.1); null when the caller says the number isn't on WhatsApp. */
  whatsappHref: string | null;
}

/** Everything a screen needs to show one stored (E.164) phone number. */
export function phoneDisplay(
  e164: string,
  shopCountry: CountryCode,
  options: { whatsapp?: boolean } = {},
): PhoneDisplay {
  const digits = e164.replace(/\D/g, '');
  return {
    text: formatPhone(e164, shopCountry),
    telHref: `tel:${e164}`,
    whatsappHref: options.whatsapp && digits ? `https://wa.me/${digits}` : null,
  };
}
