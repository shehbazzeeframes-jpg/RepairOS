/**
 * Pure argument rewriting used by the `forShop` extension. Kept separate so it can be unit-tested
 * without a database.
 */

/** Models that carry a `shopId` column and an RLS policy. Add every new tenant model here. */
export const TENANT_MODELS = ['Location', 'Membership', 'TaxRate', 'AuditLog'] as const;
/** The tenant root: scoped by its own `id`. */
export const SHOP_MODEL = 'Shop';

export type TenantModel = (typeof TENANT_MODELS)[number];

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_DATA_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

/** Returns the column that identifies the tenant for this model, or null for non-tenant models. */
export function tenantKey(model: string | undefined): 'shopId' | 'id' | null {
  if (!model) return null;
  if (model === SHOP_MODEL) return 'id';
  return (TENANT_MODELS as readonly string[]).includes(model) ? 'shopId' : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function scopeWhere(where: unknown, key: string, shopId: string): Obj {
  const w: Obj = isObj(where) ? { ...where } : {};
  const existingAnd = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  // AND keeps any caller filter on the key (e.g. { shopId: otherShop } simply matches nothing)
  // and is accepted by unique where inputs (extendedWhereUnique).
  w.AND = [...existingAnd, { [key]: shopId }];
  return w;
}

function scopeCreateData(data: unknown, key: string, shopId: string, model: string): Obj {
  if (!isObj(data)) throw new TenantScopeError(`${model}: create data must be an object`);
  if (key === 'shopId' && 'shop' in data) {
    throw new TenantScopeError(`${model}: use shopId, not the "shop" relation, with the scoped client`);
  }
  const current = data[key];
  if (current !== undefined && current !== shopId) {
    throw new TenantScopeError(`${model}: cannot create a row for another shop`);
  }
  return { ...data, [key]: shopId };
}

function guardUpdateData(data: unknown, key: string, shopId: string, model: string): void {
  if (!isObj(data)) return;
  const v = data[key];
  if (v !== undefined && v !== shopId) {
    throw new TenantScopeError(`${model}: cannot move a row to another shop`);
  }
  if (key === 'shopId' && 'shop' in data) {
    throw new TenantScopeError(`${model}: cannot change the "shop" relation with the scoped client`);
  }
}

/**
 * Injects the tenant filter / value into Prisma operation args.
 * Non-tenant models are returned unchanged.
 */
export function scopeArgs<A>(model: string | undefined, operation: string, args: A, shopId: string): A {
  const key = tenantKey(model);
  if (!key || !model) return args;
  if (!shopId) throw new TenantScopeError('forShop: shopId is required');

  const a: Obj = isObj(args) ? { ...args } : {};

  if (WHERE_OPS.has(operation)) a.where = scopeWhere(a.where, key, shopId);

  if (CREATE_OPS.has(operation)) {
    a.data = Array.isArray(a.data)
      ? a.data.map((d) => scopeCreateData(d, key, shopId, model))
      : scopeCreateData(a.data, key, shopId, model);
  }

  if (UPDATE_DATA_OPS.has(operation)) guardUpdateData(a.data, key, shopId, model);

  if (operation === 'upsert') {
    a.create = scopeCreateData(a.create, key, shopId, model);
    guardUpdateData(a.update, key, shopId, model);
  }

  return a as A;
}
