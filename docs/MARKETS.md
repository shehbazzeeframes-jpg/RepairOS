# Launch Markets: US, UK, Pakistan

Every rule here is shop-level configuration, never hard-coded. The shop picks its country at sign-up, and defaults are filled from this table.

| | United States | United Kingdom | Pakistan |
|---|---|---|---|
| Currency | USD ($) | GBP (£) | PKR (Rs) |
| Tax name | Sales tax | VAT | GST / Provincial sales tax on services |
| Default rate | 0% (shop enters local combined rate, e.g. 8.875%) | 20% standard | 18% goods GST; services tax varies by province (e.g. Punjab 16%, Sindh 15%); shop sets both |
| Prices shown | Tax-exclusive (tax added at checkout) | Tax-inclusive (VAT in price) | Configurable; default tax-exclusive |
| Separate tax on parts vs labour | Common (some states don't tax labour) | No | Yes (goods vs services) |
| Phone format | E.164, +1 | E.164, +44 | E.164, +92 (mobile 03xx) |
| Date format | MM/DD/YYYY | DD/MM/YYYY | DD/MM/YYYY |
| Customer messaging | SMS (Twilio, needs 10DLC registration) | SMS (Twilio, alphanumeric sender allowed) | **WhatsApp** is the main channel; SMS through a local gateway (Twilio delivery to PK is unreliable and expensive) |
| Receipt/invoice extras | — | VAT number on invoice if registered | NTN/STRN on invoice if registered; FBR POS integration is required for some retailers (Phase 2 review) |
| Subscription price | $50/mo | £40/mo | Needs a local price (see open decision) |

## What this means for the build
- **Tax engine:** a shop has 1..n tax rates; each catalog item (service or part) has a tax class; a shop setting decides inclusive vs exclusive pricing. All tax math is in one tested module in `packages/contracts` (pure functions), with rounding per line and half-up to the currency's minor unit.
- **Money:** integer minor units; USD/GBP have 2 decimals. PKR has 2 in ISO but is shown without decimals.
- **Phones:** stored in E.164 using `libphonenumber-js`, with the shop's country as the default region.
- **Messaging:** `MessagingProvider` interface with channels `sms` and `whatsapp`. Sprint 3 adapters: Twilio SMS (US/UK), Twilio WhatsApp / Meta WhatsApp Cloud API (PK + optional elsewhere). Templates per channel.
- **Locale:** `en-US`, `en-GB` in MVP; Urdu UI is a later decision (Astryx supports RTL and i18n).
- **Billing:** Stripe Billing with prices in USD and GBP. Stripe does not onboard Pakistani merchants, but a US/UK-registered RepairOS can still charge Pakistani shops' cards. Local PK payment (JazzCash/Easypaisa/bank transfer) is a Phase 2 option.

## Open decision (product owner)
- **Pakistan price:** $50/month is high for most Pakistani repair shops. Suggestion: PKR 4,999–7,999/month, possibly with fewer included SMS (WhatsApp is cheaper). Decide before the PK beta.
