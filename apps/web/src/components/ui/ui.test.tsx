import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { phoneDisplay } from '@/lib/phone-display';
import { DueChip } from './DueChip';
import { MoneyText } from './MoneyText';
import { PhoneText } from './PhoneText';
import { ShortcutHint, ShortcutHints } from './ShortcutHint';
import { StatusBadge } from './StatusBadge';

const render = (node: React.ReactNode) => renderToStaticMarkup(node);
const UK = { timezone: 'Europe/London', locale: 'en-GB' };
const NOW = Date.parse('2026-11-25T10:00:00Z');

describe('StatusBadge', () => {
  it('takes its tone from the category', () => {
    const html = render(<StatusBadge name="Awaiting parts" category="WAITING" />);
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('Awaiting parts');
    // The category is named by the icon, so it isn't colour-only.
    expect(html).toContain('aria-label="Waiting"');
  });

  it('uses the shop colour when one is set, keeping the category icon', () => {
    const html = render(<StatusBadge name="Unrepairable" category="READY" colour="orange" />);
    expect(html).toContain('data-variant="orange"');
    expect(html).toContain('aria-label="Ready"');
  });
});

describe('MoneyText', () => {
  it('formats minor units with the shared helper and tabular figures', () => {
    const html = render(<MoneyText amountMinor={12950} currency="USD" locale="en-US" />);
    expect(html).toContain('$129.50');
  });

  it('adds the tax note', () => {
    const html = render(<MoneyText amountMinor={8000} currency="GBP" locale="en-GB" taxNote="incl" />);
    expect(html).toContain('£80.00 incl. tax');
  });

  it('shows PKR without decimals', () => {
    const html = render(<MoneyText amountMinor={499900} currency="PKR" locale="en-GB" />);
    expect(html).toContain('Rs 4,999');
  });

  it('shows the empty text when there is no amount', () => {
    expect(render(<MoneyText amountMinor={null} currency="GBP" locale="en-GB" />)).toContain('—');
    expect(
      render(<MoneyText amountMinor={undefined} currency="GBP" locale="en-GB" emptyText="No estimate" />),
    ).toContain('No estimate');
  });
});

describe('DueChip', () => {
  it('is plain text for a normal due date', () => {
    const html = render(
      <DueChip dueAt="2026-11-26T18:00:00Z" hasTime={false} category="OPEN" shop={UK} now={NOW} />,
    );
    expect(html).toContain('Tomorrow');
    expect(html).not.toContain('astryx-badge');
  });

  it('is a warning badge when due today', () => {
    const html = render(
      <DueChip dueAt="2026-11-25T17:00:00Z" hasTime category="OPEN" shop={UK} now={NOW} />,
    );
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('Today 17:00');
  });

  it('is an error badge when overdue', () => {
    const html = render(
      <DueChip dueAt="2026-11-23T18:00:00Z" hasTime={false} category="WAITING" shop={UK} now={NOW} />,
    );
    expect(html).toContain('data-variant="error"');
    expect(html).toContain('2 days overdue');
  });

  it('shows the full date in absolute format and keeps the overdue count', () => {
    expect(
      render(
        <DueChip
          dueAt="2026-11-27T18:00:00Z"
          hasTime={false}
          category="OPEN"
          shop={UK}
          now={NOW}
          format="absolute"
        />,
      ),
    ).toContain('Fri, 27 Nov 2026');
    expect(
      render(
        <DueChip
          dueAt="2026-11-24T18:00:00Z"
          hasTime={false}
          category="OPEN"
          shop={UK}
          now={NOW}
          format="absolute"
        />,
      ),
    ).toContain('1 day overdue · Tue, 24 Nov 2026');
  });

  it('never shows ready tickets as overdue', () => {
    const html = render(
      <DueChip dueAt="2026-11-20T18:00:00Z" hasTime={false} category="READY" shop={UK} now={NOW} />,
    );
    expect(html).not.toContain('overdue');
    expect(html).not.toContain('data-variant="error"');
  });
});

describe('ShortcutHint', () => {
  it('renders the keys with an accessible name and the action', () => {
    const html = render(<ShortcutHint keys="mod+enter" label="Create ticket" />);
    expect(html).toMatch(/aria-label="(Control|Command) \+ Enter"/);
    expect(html).toContain('Create ticket');
  });

  it('groups several hints under a label', () => {
    const html = render(
      <ShortcutHints
        label="Check-in shortcuts"
        hints={[
          { keys: '/', label: 'Search' },
          { keys: 'escape', label: 'Close' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Check-in shortcuts"');
    expect(html).toContain('Search');
    expect(html).toContain('Close');
  });
});

describe('phoneDisplay / PhoneText', () => {
  it('shows a domestic number in national format with a tel link', () => {
    expect(phoneDisplay('+447400123456', 'GB')).toEqual({
      text: '07400 123456',
      telHref: 'tel:+447400123456',
      whatsappHref: null,
    });
  });

  it('shows a foreign number in international format', () => {
    expect(phoneDisplay('+923001234567', 'GB').text).toBe('+92 300 1234567');
  });

  it('builds the WhatsApp link from the digits only when asked', () => {
    expect(phoneDisplay('+923001234567', 'PK', { whatsapp: true }).whatsappHref).toBe(
      'https://wa.me/923001234567',
    );
  });

  it('renders a callable number with a WhatsApp link and a label', () => {
    const html = render(
      <PhoneText e164="+923001234567" shopCountry="PK" isCallable hasWhatsApp label="Mobile" />,
    );
    expect(html).toContain('href="tel:+923001234567"');
    expect(html).toContain('0300 1234567');
    expect(html).toContain('href="https://wa.me/923001234567"');
    expect(html).toContain('Mobile');
  });

  it('renders plain text when not callable', () => {
    const html = render(<PhoneText e164="+12125550142" shopCountry="US" />);
    expect(html).toContain('(212) 555-0142');
    expect(html).not.toContain('href=');
  });
});
