'use client';

/**
 * Sprint 2 reads (TanStack Query). Every response is parsed with the contract schema named in the
 * spec; keys are shop-scoped (`qk` in ./queries).
 */
import {
  AssigneesResponse,
  CUSTOMER_ACTION_PATHS,
  CheckInContext,
  ConsentHistoryResponse,
  CustomerDetail,
  CustomerListResponse,
  CustomerTagsResponse,
  DASHBOARD_PATH,
  DEVICE_ACTION_PATHS,
  DashboardSummary,
  DeviceListResponse,
  GLOBAL_SEARCH_PATH,
  GlobalSearchResponse,
  ModelSuggestionsResponse,
  TICKET_COUNTS_REFRESH_MS,
  TICKET_SETTINGS_PATH,
  TICKET_STATUS_PATHS,
  TicketCounts,
  TicketDetail,
  TicketListResponse,
  TicketSettings,
  TicketStatusListResponse,
  TimelineResponse,
  suggestModels,
  ticketPath,
  type GlobalSearchQuery,
  type ModelSuggestionsQuery,
  type SearchCustomerResult,
  type TimelineFilter,
} from '@repairos/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';
import { qk } from './queries';
import { useShopId } from './shop-context';

export const customerPath = (key: keyof typeof CUSTOMER_ACTION_PATHS, id: string) =>
  CUSTOMER_ACTION_PATHS[key].replace(':id', encodeURIComponent(id));

export function useTicketStatuses(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.statuses(shopId),
    queryFn: () => apiFetch(TICKET_STATUS_PATHS.list, TicketStatusListResponse),
    staleTime: 60_000,
    enabled,
  });
}

export function useAssignees(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.assignees(shopId),
    queryFn: () => apiFetch(ticketPath('assignees'), AssigneesResponse),
    staleTime: 60_000,
    enabled,
  });
}

/** View counts; refreshed on focus and every minute (TL1.9). Lists and dashboard share it. */
export function useTicketCounts(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.ticketCounts(shopId),
    queryFn: () => apiFetch(ticketPath('counts'), TicketCounts),
    refetchOnWindowFocus: true,
    refetchInterval: TICKET_COUNTS_REFRESH_MS,
    enabled,
  });
}

/** One page of GET /api/tickets; `search` already holds the cursor. */
export function useTicketList(search: string, enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.tickets(shopId, search),
    queryFn: () => apiFetch(`${ticketPath('list')}?${search}`, TicketListResponse),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTicket(id: string) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.ticket(shopId, id),
    queryFn: () => apiFetch(ticketPath('detail', { id }), TicketDetail),
  });
}

/** Timeline: first page = newest items; older pages are fetched with `olderCursor` and prepended. */
export function useTimeline(id: string, filter: TimelineFilter) {
  const shopId = useShopId();
  return useInfiniteQuery({
    queryKey: qk.timeline(shopId, id, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ filter });
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch(`${ticketPath('timeline', { id })}?${p.toString()}`, TimelineResponse);
    },
    getNextPageParam: (last) => last.olderCursor,
  });
}

export function useCheckInContext(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.checkInContext(shopId),
    queryFn: () => apiFetch(ticketPath('checkInContext'), CheckInContext),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useTicketSettings(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.ticketSettings(shopId),
    queryFn: () => apiFetch(TICKET_SETTINGS_PATH, TicketSettings),
    enabled,
  });
}

export function useDashboard(enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.dashboard(shopId),
    queryFn: () => apiFetch(DASHBOARD_PATH, DashboardSummary),
    refetchOnWindowFocus: true,
    refetchInterval: TICKET_COUNTS_REFRESH_MS,
    enabled,
  });
}

export function useCustomerList(search: string, enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.customers(shopId, search),
    queryFn: () => apiFetch(`${CUSTOMER_ACTION_PATHS.list}?${search}`, CustomerListResponse),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCustomer(id: string | null) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.customer(shopId, id ?? ''),
    queryFn: () => apiFetch(customerPath('detail', id ?? ''), CustomerDetail),
    enabled: !!id,
  });
}

export function useCustomerDevices(id: string | null, archived = false) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.customerDevices(shopId, id ?? '', archived),
    queryFn: () =>
      apiFetch(
        `${customerPath('devices', id ?? '')}?archived=${String(archived)}`,
        DeviceListResponse,
      ),
    enabled: !!id,
  });
}

export function useConsentHistory(id: string, enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.consents(shopId, id),
    queryFn: () => apiFetch(customerPath('consents', id), ConsentHistoryResponse),
    enabled,
  });
}

export function useCustomerTags() {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.customerTags(shopId),
    queryFn: () => apiFetch(CUSTOMER_ACTION_PATHS.tags, CustomerTagsResponse),
    staleTime: 60_000,
  });
}

// ---------- Check-in and device dialog searches ----------

export type ModelSuggestion = ModelSuggestionsResponse['items'][number];

/**
 * GET /api/devices/model-suggestions (R1 one-box search: `type` and `brand` optional). If the request
 * fails (not when it is aborted) the catalogue is ranked here with the contract's own `suggestModels`,
 * so the box still fills Type and Brand offline; the shop's history is the only thing missing then.
 */
export async function fetchModelSuggestions(
  query: Partial<ModelSuggestionsQuery>,
  signal?: AbortSignal,
): Promise<ModelSuggestion[]> {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  const brand = query.brand?.trim();
  if (q) params.set('q', q);
  if (query.type) params.set('type', query.type);
  if (brand) params.set('brand', brand);
  params.set('limit', String(query.limit ?? 8));
  try {
    const r = await apiFetch(
      `${DEVICE_ACTION_PATHS.modelSuggestions}?${params.toString()}`,
      ModelSuggestionsResponse,
      { signal },
    );
    return r.items;
  } catch (err) {
    if (signal?.aborted) throw err;
    return suggestModels({ q, type: query.type, brand, limit: query.limit ?? 8 });
  }
}

export const CHECK_IN_SEARCH_LIMIT = 8;

/**
 * Check-in's customer search (R5): GET GLOBAL_SEARCH_PATH with `includeArchived=true`, so an archived
 * customer is offered with "Restore and use" (`archivedAt` set). Erased customers never match.
 */
export async function searchCheckInCustomers(
  q: string,
  signal?: AbortSignal,
): Promise<SearchCustomerResult[]> {
  const query: GlobalSearchQuery = {
    q: q.trim(),
    limit: CHECK_IN_SEARCH_LIMIT,
    includeArchived: true,
  };
  const params = new URLSearchParams({
    q: query.q,
    limit: String(query.limit),
    includeArchived: String(query.includeArchived),
  });
  const r = await apiFetch(`${GLOBAL_SEARCH_PATH}?${params.toString()}`, GlobalSearchResponse, {
    signal,
  });
  return r.customers;
}
