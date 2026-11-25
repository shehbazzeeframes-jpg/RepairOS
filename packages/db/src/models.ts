import { Prisma } from '@prisma/client';

/**
 * Every Prisma model is exactly one of:
 *  - tenant: has a `shopId` column (derived from the DMMF, never hand-listed) + an RLS policy;
 *  - the tenant root `Shop` (scoped by its own `id`);
 *  - auth: Better Auth tables. The scoped client refuses Session/Account/Verification and only
 *    reads User through the current shop's memberships;
 *  - global: shared reference data with no tenant (none yet; add deliberately, with review).
 * Unclassified models make the scoped client throw (fail closed) and fail the models test.
 */
export const SHOP_MODEL = 'Shop';
export const USER_MODEL = 'User';
export const AUTH_MODELS = ['User', 'Session', 'Account', 'Verification'] as const;
export const GLOBAL_MODELS: readonly string[] = [];

export type ModelKind = 'tenant' | 'shop' | 'auth' | 'global';

interface ModelShape {
  name: string;
  fields: readonly { name: string }[];
}

export interface ModelClasses {
  kinds: ReadonlyMap<string, ModelKind>;
  tenantModels: readonly string[];
  unclassified: readonly string[];
}

export function classifyModels(models: readonly ModelShape[]): ModelClasses {
  const kinds = new Map<string, ModelKind>();
  const unclassified: string[] = [];
  for (const m of models) {
    if (m.name === SHOP_MODEL) kinds.set(m.name, 'shop');
    else if (m.fields.some((f) => f.name === 'shopId')) kinds.set(m.name, 'tenant');
    else if ((AUTH_MODELS as readonly string[]).includes(m.name)) kinds.set(m.name, 'auth');
    else if (GLOBAL_MODELS.includes(m.name)) kinds.set(m.name, 'global');
    else unclassified.push(m.name);
  }
  const tenantModels = [...kinds].filter(([, k]) => k === 'tenant').map(([n]) => n);
  return { kinds, tenantModels, unclassified };
}

/** Classification of the generated client's models. */
export const MODEL_CLASSES: ModelClasses = classifyModels(Prisma.dmmf.datamodel.models);
/** Models carrying `shopId` (derived from the schema). */
export const TENANT_MODELS: readonly string[] = MODEL_CLASSES.tenantModels;
