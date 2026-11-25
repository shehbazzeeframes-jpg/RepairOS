/**
 * The two Sprint 2 contract additions the web depends on, each called from this one place so the
 * tech lead can reconcile them when the backend branch lands (feat/sprint2-api, commit 2367930).
 *
 * - R1/R2 one-box model search: `ModelSuggestionsQuery.type` optional and items `{ type, brand, model,
 *   source, useCount }`. Until that commit is merged into this branch the schema is mirrored here
 *   exactly; once merged, replace `ModelSuggestionsResponseR1` with the contract's
 *   `ModelSuggestionsResponse`.
 * - R5 archived customers in check-in search: GET /api/customers?archived=true (rows carry
 *   `archivedAt`; contract `CustomerListQuery.archived`).
 * - R7 (formatPhone by calling code) needs nothing here: `PhoneText` already calls `formatPhone`.
 */
import {
  CUSTOMER_ACTION_PATHS,
  CustomerListResponse,
  DEVICE_ACTION_PATHS,
  DeviceType,
  type CustomerListItem,
  type DeviceTypeValue,
} from '@repairos/contracts';
import { z } from 'zod';
import { apiFetch } from './api';

/** Mirror of contract 2367930 `ModelSuggestionsResponse` (R1). */
export const ModelSuggestionsResponseR1 = z.object({
  items: z.array(
    z.object({
      type: DeviceType,
      brand: z.string(),
      model: z.string(),
      source: z.enum(['shop', 'catalogue']),
      useCount: z.number().int().min(0),
    }),
  ),
});
export type ModelSuggestionR1 = z.infer<typeof ModelSuggestionsResponseR1>['items'][number];

/** GET /api/devices/model-suggestions?q=&type=&brand= (type/brand optional: R1). */
export function fetchModelSuggestions(
  opts: { q: string; type?: DeviceTypeValue | null; brand?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<ModelSuggestionR1[]> {
  const params = new URLSearchParams();
  if (opts.q.trim()) params.set('q', opts.q.trim());
  if (opts.type) params.set('type', opts.type);
  if (opts.brand?.trim()) params.set('brand', opts.brand.trim());
  params.set('limit', String(opts.limit ?? 8));
  return apiFetch(`${DEVICE_ACTION_PATHS.modelSuggestions}?${params.toString()}`, ModelSuggestionsResponseR1, {
    signal,
  }).then((r) => r.items);
}

/** Check-in customer search incl. archived customers (R5). The list API's page sizes start at 25. */
export function searchCheckInCustomers(q: string, signal?: AbortSignal): Promise<CustomerListItem[]> {
  const params = new URLSearchParams({ q: q.trim(), archived: 'true', limit: '25' });
  return apiFetch(`${CUSTOMER_ACTION_PATHS.list}?${params.toString()}`, CustomerListResponse, {
    signal,
  }).then((r) => r.items.slice(0, 8));
}
