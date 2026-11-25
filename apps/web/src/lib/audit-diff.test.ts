import { describe, expect, it } from 'vitest';
import { auditDiff, auditEntityText, fieldLabel, formatAuditValue } from './audit-diff';

const shop = { timezone: 'Europe/London', locale: 'en-GB' };

describe('auditDiff', () => {
  it('shows only changed fields with readable values', () => {
    const rows = auditDiff(
      {
        before: { name: 'VAT', rateMilliPct: 20000, isDefaultGoods: false, appliesTo: 'all' },
        after: { name: 'VAT', rateMilliPct: 8875, isDefaultGoods: true, appliesTo: 'goods' },
      },
      shop,
    );
    expect(rows).toEqual([
      { key: 'rateMilliPct', label: 'Rate', before: '20%', after: '8.875%' },
      { key: 'isDefaultGoods', label: 'Default for goods', before: 'No', after: 'Yes' },
      {
        key: 'appliesTo',
        label: 'Applies to',
        before: 'All items',
        after: 'Goods (parts & accessories)',
      },
    ]);
  });

  it('shows only "after" for a created record and only "before" for a deleted one', () => {
    expect(auditDiff({ before: null, after: { role: 'FRONT_DESK' } }, shop)).toEqual([
      { key: 'role', label: 'Role', before: null, after: 'Front desk' },
    ]);
    expect(
      auditDiff(
        { before: { clockInAt: '2026-07-01T08:00:00.000Z', reason: 'Duplicate' }, after: null },
        shop,
      ),
    ).toEqual([
      { key: 'clockInAt', label: 'Clock in', before: '1 Jul 2026, 09:00', after: null },
      { key: 'reason', label: 'Reason', before: 'Duplicate', after: null },
    ]);
  });

  it('formats a field added or cleared as an em dash', () => {
    expect(auditDiff({ before: { phone: null }, after: { phone: '+442071234567' } }, shop)).toEqual(
      [{ key: 'phone', label: 'Phone', before: '—', after: '+442071234567' }],
    );
  });

  it('summarises a business-hours week Monday first', () => {
    const week = [
      { weekday: 0, isOpen: false, opensAt: null, closesAt: null },
      { weekday: 1, isOpen: true, opensAt: '10:00', closesAt: '19:00' },
    ];
    expect(formatAuditValue('days', week, shop)).toBe('Mon 10:00–19:00, Sun closed');
  });

  it('labels time zones, statuses and unknown keys', () => {
    expect(formatAuditValue('timezone', 'America/Chicago', shop)).toBe('Central Time (Chicago)');
    expect(formatAuditValue('status', 'DEACTIVATED', shop)).toBe('Deactivated');
    expect(fieldLabel('someNewField')).toBe('Some new field');
  });

  it('describes the entity', () => {
    expect(auditEntityText({ entityType: 'TaxRate', entityLabel: 'VAT' })).toBe('Tax rate: VAT');
    expect(auditEntityText({ entityType: 'Shop', entityLabel: null })).toBe('Shop');
  });
});
