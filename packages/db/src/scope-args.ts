/**
 * Argument rewriting used by the `forShop` extension. Pure apart from the model classification,
 * so it can be unit-tested without a database.
 */
import { MODEL_CLASSES, type ModelClasses, SHOP_MODEL, USER_MODEL } from './models';

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const WHERE_OPS = new Set([...READ_OPS, 'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_DATA_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

/** Returns the column that identifies the tenant for this model, or null for non-tenant models. */
export function tenantKey(model: string | undefined, classes: ModelClasses = MODEL_CLASSES): 'shopId' | 'id' | null {
  if (!model) return null;
  const kind = classes.kinds.get(model);
  if (kind === 'shop') return 'id';
  if (kind === 'tenant') return 'shopId';
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function addAnd(where: unknown, filter: Obj): Obj {
  const w: Obj = isObj(where) ? { ...where } : {};
  const existingAnd = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  // AND keeps any caller filter (e.g. { shopId: otherShop } simply matches nothing)
  // and is accepted by unique where inputs (extendedWhereUnique).
  w.AND = [...existingAnd, filter];
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
 *  - tenant models: `shopId` in where/create; cross-shop writes throw.
 *  - Shop: same, keyed by `id`.
 *  - User: read-only, limited to members of the current shop.
 *  - Session / Account / Verification and unclassified models: throw.
 *  - global models: unchanged.
 */
export function scopeArgs<A>(
  model: string | undefined,
  operation: string,
  args: A,
  shopId: string,
  classes: ModelClasses = MODEL_CLASSES,
): A {
  if (!model) return args;
  if (!shopId) throw new TenantScopeError('forShop: shopId is required');
  const kind = classes.kinds.get(model);
  const a: Obj = isObj(args) ? { ...args } : {};

  if (kind === 'global') return args;

  if (kind === 'auth') {
    if (model !== USER_MODEL) {
      throw new TenantScopeError(`${model} is an auth table and is not available on the scoped client`);
    }
    if (!READ_OPS.has(operation)) {
      throw new TenantScopeError('User is read-only on the scoped client');
    }
    a.where = addAnd(a.where, { memberships: { some: { shopId } } });
    return a as A;
  }

  if (kind !== 'tenant' && kind !== 'shop') {
    throw new TenantScopeError(`${model} is not classified as tenant, auth or global (see packages/db/src/models.ts)`);
  }

  const key = kind === 'shop' ? 'id' : 'shopId';
  const target = kind === 'shop' ? SHOP_MODEL : model;

  if (WHERE_OPS.has(operation)) a.where = addAnd(a.where, { [key]: shopId });

  if (CREATE_OPS.has(operation)) {
    a.data = Array.isArray(a.data)
      ? a.data.map((d) => scopeCreateData(d, key, shopId, target))
      : scopeCreateData(a.data, key, shopId, target);
  }

  if (UPDATE_DATA_OPS.has(operation)) guardUpdateData(a.data, key, shopId, target);

  if (operation === 'upsert') {
    a.create = scopeCreateData(a.create, key, shopId, target);
    guardUpdateData(a.update, key, shopId, target);
  }

  return a as A;
}
