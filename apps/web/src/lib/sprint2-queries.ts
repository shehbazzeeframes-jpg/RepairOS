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
  DashboardSummary,
  DeviceListResponse,
  TICKET_COUNTS_REFRESH_MS,
  TICKET_SETTINGS_PATH,
  TICKET_STATUS_PATHS,
  TicketCounts,
  TicketDetail,
  TicketListResponse,
  TicketSettings,
  TicketStatusListResponse,
  TimelineResponse,
  ticketPath,
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
