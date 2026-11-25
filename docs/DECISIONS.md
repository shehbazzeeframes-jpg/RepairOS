# Decision Log

Decisions made by the tech lead under the product owner's standing instruction to "move forward with best approaches". Pricing is confirmed with the product owner before launch.

| Date | Decision | Reason | Revisit |
|---|---|---|---|
| 2026-11-25 | Launch segment: phone & computer repair; markets US, UK, Pakistan | Product owner | — |
| 2026-11-25 | Standard plan $50/store/month (£40 UK), 5 users, 300 SMS | Product owner | — |
| 2026-11-25 | Pakistan working price **PKR 5,999/month**, WhatsApp messages instead of SMS; stored as configuration | $50 is too high for most PK shops | **Confirm with product owner before the PK beta** |
| 2026-11-25 | Keep Astryx **neutral** theme; brand colour and logo applied as theme tokens in Sprint 7 | Lets features ship now; re-theming is a token change | Sprint 7 |
| 2026-11-25 | Sprint 1 D1–D10 (tax defaults per goods/services, rates in thousandths of a percent, fixed role matrix, forgot password, file outbox in dev, invite link copy for WhatsApp, …) | See `docs/stories/sprint1-shop-and-people.md` | — |
| 2026-11-25 | Mailpit removed; dev emails go to a file outbox shown at `/dev/outbox` | Works without Docker; one mechanism | — |
