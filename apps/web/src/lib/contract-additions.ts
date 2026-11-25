/**
 * The two Sprint 2 contract additions the web depends on, each called from this one place.
 *
 * - R1/R2 one-box model search: `ModelSuggestionsQuery.type` optional and items `{ type, brand, model,
 *   source, useCount }` (contract `ModelSuggestionsResponse`).
 * - R5 archived customers in check-in search: GET /api/customers?archived=true (rows carry
 *   `archivedAt`; contract `CustomerListQuery.archived`).
 * - R7 (formatPhone by calling code) needs nothing here: `PhoneText` already calls `formatPhone`.
 */
import {
  CUSTOMER_ACTION_PATHS,
  CustomerListResponse,
  DEVICE_ACTION_PATHS,
  ModelSuggestionsResponse,
  type CustomerListItem,
  type DeviceTypeValue,
} from '@repairos/contracts';
import { apiFetch } from './api';

export type ModelSuggestionR1 = ModelSuggestionsResponse['items'][number];

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
  return apiFetch(
    `${DEVICE_ACTION_PATHS.modelSuggestions}?${params.toString()}`,
    ModelSuggestionsResponse,
    {
      signal,
    },
  ).then((r) => r.items);
}

/** Check-in customer search incl. archived customers (R5). The list API's page sizes start at 25. */
export function searchCheckInCustomers(
  q: string,
  signal?: AbortSignal,
): Promise<CustomerListItem[]> {
  const params = new URLSearchParams({ q: q.trim(), archived: 'true', limit: '25' });
  return apiFetch(`${CUSTOMER_ACTION_PATHS.list}?${params.toString()}`, CustomerListResponse, {
    signal,
  }).then((r) => r.items.slice(0, 8));
}
