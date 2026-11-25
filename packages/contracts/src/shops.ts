import { z } from 'zod';
import { CountryCode, CurrencyCode } from './markets';

export const Role = z.enum(['OWNER', 'MANAGER', 'FRONT_DESK', 'TECHNICIAN']);
export type Role = z.infer<typeof Role>;

/** POST /api/shops: create a shop during onboarding; caller becomes OWNER and it becomes the active shop. */
export const CreateShopInput = z.object({
  name: z.string().trim().min(2).max(80),
  country: CountryCode,
  timezone: z.string().min(1).optional(), // defaults from MARKET_DEFAULTS
  phone: z.string().trim().max(32).optional(), // any format; API normalises to E.164
  addressLine1: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(20).optional(),
});
export type CreateShopInput = z.infer<typeof CreateShopInput>;

export const Shop = z.object({
  id: z.string(),
  name: z.string(),
  country: CountryCode,
  currency: CurrencyCode,
  locale: z.string(),
  timezone: z.string(),
  pricesIncludeTax: z.boolean(),
  phone: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Shop = z.infer<typeof Shop>;

export const Membership = z.object({ shopId: z.string(), shopName: z.string(), role: Role });
export type Membership = z.infer<typeof Membership>;

/** GET /api/me: 401 when signed out. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string().email() }),
  memberships: z.array(Membership),
  /** null until onboarding creates a shop, so the web app sends the user to /onboarding */
  activeShop: Shop.nullable(),
  role: Role.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** POST /api/me/active-shop */
export const SetActiveShopInput = z.object({ shopId: z.string() });

/** Standard error body for every non-2xx response. */
export const ApiError = z.object({
  statusCode: z.number(),
  code: z.string(), // e.g. VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND
  message: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** GET /api/health */
export const HealthResponse = z.object({ status: z.literal('ok'), db: z.enum(['up', 'down']), version: z.string() });
