import { describe, expect, it } from 'vitest';
import { scopeArgs, TenantScopeError } from './scope-args';

const A = 'shop_a';

describe('scopeArgs', () => {
  it('refuses Session, Account, Verification and unclassified models', () => {
    for (const m of ['Session', 'Account', 'Verification', 'SomethingNew']) {
      expect(() => scopeArgs(m, 'findMany', {}, A)).toThrow(TenantScopeError);
    }
  });

  it('limits User to reads of the current shop members', () => {
    expect(scopeArgs('User', 'findMany', { where: { email: 'x' } }, A)).toEqual({
      where: { email: 'x', AND: [{ memberships: { some: { shopId: A } } }] },
    });
    for (const op of ['create', 'update', 'delete', 'deleteMany', 'upsert']) {
      expect(() => scopeArgs('User', op, { where: {}, data: {} }, A)).toThrow(/read-only/);
    }
  });

  it('adds shopId to where for reads, keeping caller filters', () => {
    expect(scopeArgs('TaxRate', 'findMany', { where: { name: 'VAT' } }, A)).toEqual({
      where: { name: 'VAT', AND: [{ shopId: A }] },
    });
    expect(scopeArgs('TaxRate', 'findMany', undefined, A)).toEqual({ where: { AND: [{ shopId: A }] } });
  });

  it('a filter on another shop is ANDed, so it matches nothing', () => {
    expect(scopeArgs('TaxRate', 'findMany', { where: { shopId: 'shop_b' } }, A)).toEqual({
      where: { shopId: 'shop_b', AND: [{ shopId: A }] },
    });
  });

  it('scopes Shop by id', () => {
    expect(scopeArgs('Shop', 'findUnique', { where: { id: 'x' } }, A)).toEqual({
      where: { id: 'x', AND: [{ id: A }] },
    });
    expect(scopeArgs('Shop', 'create', { data: { name: 'n' } }, A)).toEqual({ data: { name: 'n', id: A } });
  });

  it('injects shopId into create and createMany', () => {
    expect(scopeArgs('Location', 'create', { data: { name: 'Main' } }, A)).toEqual({
      data: { name: 'Main', shopId: A },
    });
    expect(scopeArgs('TaxRate', 'createMany', { data: [{ name: 'a' }, { name: 'b' }] }, A)).toEqual({
      data: [
        { name: 'a', shopId: A },
        { name: 'b', shopId: A },
      ],
    });
  });

  it('rejects writes that target another shop', () => {
    expect(() => scopeArgs('Location', 'create', { data: { name: 'x', shopId: 'shop_b' } }, A)).toThrow(
      TenantScopeError,
    );
    expect(() =>
      scopeArgs('Location', 'update', { where: { id: '1' }, data: { shopId: 'shop_b' } }, A),
    ).toThrow(TenantScopeError);
    expect(() => scopeArgs('Location', 'create', { data: { shop: { connect: { id: A } } } }, A)).toThrow(
      TenantScopeError,
    );
  });

  it('scopes upsert where and create', () => {
    expect(
      scopeArgs('Membership', 'upsert', { where: { id: 'm' }, create: { role: 'OWNER' }, update: {} }, A),
    ).toEqual({ where: { id: 'm', AND: [{ shopId: A }] }, create: { role: 'OWNER', shopId: A }, update: {} });
  });
});
