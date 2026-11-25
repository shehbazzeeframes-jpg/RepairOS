import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { classifyModels, MODEL_CLASSES, TENANT_MODELS } from './models';

describe('model classification', () => {
  it('classifies every Prisma model as tenant, shop, auth or global', () => {
    expect(MODEL_CLASSES.unclassified).toEqual([]);
    expect(MODEL_CLASSES.kinds.size).toBe(Prisma.dmmf.datamodel.models.length);
  });

  it('derives tenant models from the shopId field', () => {
    expect([...TENANT_MODELS].sort()).toEqual(['AuditLog', 'Location', 'Membership', 'TaxRate']);
    for (const m of Prisma.dmmf.datamodel.models) {
      const hasShopId = m.fields.some((f) => f.name === 'shopId');
      expect(MODEL_CLASSES.kinds.get(m.name) === 'tenant', m.name).toBe(hasShopId);
    }
  });

  it('flags a new model that has no shopId and no explicit class', () => {
    const c = classifyModels([
      { name: 'Widget', fields: [{ name: 'id' }] },
      { name: 'Part', fields: [{ name: 'shopId' }] },
    ]);
    expect(c.unclassified).toEqual(['Widget']);
    expect(c.tenantModels).toEqual(['Part']);
  });
});
