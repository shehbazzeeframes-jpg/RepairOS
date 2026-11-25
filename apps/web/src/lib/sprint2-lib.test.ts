import {
  RECENT_ITEMS_MAX,
  TicketListQuery,
  CustomerListQuery,
  recentItemsKey,
  type TicketTimelineItem,
} from '@repairos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './test-storage';
import {
  customerFiltersFrom,
  customerFiltersToApi,
  hasTicketFilters,
  pageRangeText,
  ticketFiltersFrom,
  ticketFiltersToApi,
  ticketFiltersToUrl,
} from './list-params';
import {
  addRecent,
  clearRecentForUser,
  readRecent,
  removeRecent,
  withRecent,
} from './recent-items';
import { dismissShopChanged, getShopChanged, noteShopChanged } from './shop-changed';
import { fieldLabel, formatFieldValue, timelineSentence } from './timeline-text';

const UK = { timezone: 'Europe/London', locale: 'en-GB' };

describe('ticket list params', () => {
  it('reads the URL, falling back to the default view, and drops junk', () => {
    const f = ticketFiltersFrom(
      new URLSearchParams(
        'status=a,b&category=OPEN,NOPE&priority=URGENT&deviceType=PHONE,TOASTER&limit=7',
      ),
      'mine',
    );
    expect(f).toMatchObject({
      view: 'mine',
      status: ['a', 'b'],
      category: ['OPEN'],
      priority: 'URGENT',
      deviceType: ['PHONE'],
      limit: 25,
    });
    expect(hasTicketFilters(f)).toBe(true);
  });

  it('keeps defaults out of the URL and sends what the API contract accepts', () => {
    const f = ticketFiltersFrom(new URLSearchParams('view=overdue&q=ali'), 'open');
    expect(ticketFiltersToUrl(f)).toBe('view=overdue&q=ali');
    const api = ticketFiltersToApi(f, 'cur_2');
    expect(api).toContain('cursor=cur_2');
    expect(TicketListQuery.safeParse(Object.fromEntries(new URLSearchParams(api))).success).toBe(
      true,
    );
    // A one-letter search stays in the box but isn't sent (SearchText is 2–100).
    expect(ticketFiltersToApi({ ...f, q: 'a' })).not.toContain('q=');
  });

  it('customer filters round-trip into a valid CustomerListQuery', () => {
    const f = customerFiltersFrom(
      new URLSearchParams(
        'q=khan&type=BUSINESS&tags=VIP&consent=SMS&archived=true&sort=last_visit',
      ),
    );
    const api = customerFiltersToApi(f);
    expect(api).toContain('archived=true');
    expect(CustomerListQuery.safeParse(Object.fromEntries(new URLSearchParams(api))).success).toBe(
      true,
    );
  });

  it('says how many results, with the 10,000+ cap', () => {
    expect(pageRangeText(2, 25, 25, 312, false)).toBe('Showing 26–50 of 312');
    expect(pageRangeText(1, 25, 25, 10000, true)).toBe('Showing 1–25 of 10,000+');
    expect(pageRangeText(1, 25, 0, 0, false)).toBe('No results');
  });
});

describe('recent items (A19)', () => {
  beforeEach(() => vi.stubGlobal('window', { localStorage: memoryStorage() }));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the newest first, de-duplicated and capped', () => {
    let list = withRecent([], { kind: 'ticket', id: 't1', label: 'T-1', openedAt: 'a' });
    for (let i = 0; i < 12; i++)
      list = withRecent(list, { kind: 'customer', id: `c${i}`, label: `C${i}`, openedAt: 'b' });
    list = withRecent(list, { kind: 'customer', id: 'c5', label: 'C5', openedAt: 'c' });
    expect(list).toHaveLength(RECENT_ITEMS_MAX);
    expect(list[0]).toMatchObject({ id: 'c5', openedAt: 'c' });
    expect(list.filter((i) => i.id === 'c5')).toHaveLength(1);
  });

  it('is per user + shop, drops 404s and clears on sign-out', () => {
    addRecent('u1', 's1', { kind: 'ticket', id: 't1', label: 'T-1' });
    addRecent('u1', 's2', { kind: 'ticket', id: 't2', label: 'T-2' });
    expect(readRecent('u1', 's1').map((i) => i.id)).toEqual(['t1']);
    expect(window.localStorage.getItem(recentItemsKey('u1', 's1'))).toContain('t1');
    removeRecent('u1', 's1', 'ticket', 't1');
    expect(readRecent('u1', 's1')).toEqual([]);
    clearRecentForUser('u1');
    expect(readRecent('u1', 's2')).toEqual([]);
  });

  it('survives broken storage', () => {
    window.localStorage.setItem(recentItemsKey('u1', 's1'), '{not json');
    expect(readRecent('u1', 's1')).toEqual([]);
  });
});

describe('shop-changed latch (A13)', () => {
  it('remembers the shop the page was on until dismissed', () => {
    noteShopChanged('shp_1');
    expect(getShopChanged()).toEqual({ fromShopId: 'shp_1' });
    noteShopChanged(null);
    expect(getShopChanged()).toEqual({ fromShopId: 'shp_1' });
    dismissShopChanged();
    expect(getShopChanged()).toBeNull();
  });
});

describe('timeline text', () => {
  const actor = { userId: 'u', name: 'Sam', active: true };
  const at = '2026-11-25T10:00:00.000Z';
  it('formats field changes for people', () => {
    expect(fieldLabel('checklist.SCREEN')).toBe('Screen/touch');
    expect(formatFieldValue('estimate', { amountMinor: 12950, currency: 'GBP' }, UK)).toBe(
      '£129.50',
    );
    expect(formatFieldValue('priority', 'URGENT', UK)).toBe('Urgent');
    expect(formatFieldValue('accessories', ['CASE', 'SIM_CARD'], UK)).toBe('Case, SIM card');
    expect(formatFieldValue('description', null, UK)).toBe('none');
  });

  it('writes a sentence per event and never crashes on reserved types', () => {
    const fields = {
      id: 'e1',
      type: 'fields_changed',
      createdAt: at,
      actor,
      data: { changes: [{ field: 'priority', before: 'NORMAL', after: 'URGENT' }] },
    } as TicketTimelineItem;
    expect(timelineSentence(fields, UK)).toBe('Sam edited priority: Normal → Urgent');
    const assigned = {
      id: 'e2',
      type: 'assigned',
      createdAt: at,
      actor,
      data: { from: actor, to: null },
    } as TicketTimelineItem;
    expect(timelineSentence(assigned, UK)).toBe('Sam unassigned it (was Sam)');
    const system = {
      id: 'e3',
      type: 'passcode_deleted',
      createdAt: at,
      actor: null,
      data: { reason: 'closed' },
    } as TicketTimelineItem;
    expect(timelineSentence(system, UK)).toBe('Passcode deleted on close');
    const reserved = {
      id: 'e4',
      type: 'payment_recorded',
      createdAt: at,
      actor,
      data: {},
    } as TicketTimelineItem;
    expect(timelineSentence(reserved, UK)).toBe('Activity');
  });
});
