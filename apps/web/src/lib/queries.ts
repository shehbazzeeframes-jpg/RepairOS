'use client';

import {
  AuditEventDetail,
  AuditEventListResponse,
  InvitePreview,
  ShopSettingsResponse,
  StaffListResponse,
  TaxRateListResponse,
  TimeclockStatus,
  TimesheetResponse,
  type AuditEventListQuery,
  type StaffStatus,
} from '@repairos/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';
import { useShopId } from './shop-context';

/** First segment of every shop-scoped query key: `['shop', shopId, ...]`. */
export const SHOP_SCOPE = 'shop';

/**
 * Query keys. Everything shop-scoped is `['shop', shopId, ...]`, so data cached for one shop can
 * never be read under another shop's key, and a shop change can drop it all in one call.
 */
export const qk = {
  shop: (shopId: string) => [SHOP_SCOPE, shopId] as const,
  shopSettings: (shopId: string) => [SHOP_SCOPE, shopId, 'settings'] as const,
  taxRates: (shopId: string, includeArchived: boolean) =>
    [SHOP_SCOPE, shopId, 'tax-rates', includeArchived] as const,
  taxRatesAll: (shopId: string) => [SHOP_SCOPE, shopId, 'tax-rates'] as const,
  staff: (shopId: string, statuses: readonly StaffStatus[]) =>
    [SHOP_SCOPE, shopId, 'staff', statuses.join(',')] as const,
  staffAll: (shopId: string) => [SHOP_SCOPE, shopId, 'staff'] as const,
  timeclock: (shopId: string) => [SHOP_SCOPE, shopId, 'timeclock'] as const,
  timesheets: (shopId: string, q: TimesheetParams) =>
    [SHOP_SCOPE, shopId, 'timesheets', q] as const,
  timesheetsAll: (shopId: string) => [SHOP_SCOPE, shopId, 'timesheets'] as const,
  audit: (shopId: string, q: AuditParams) => [SHOP_SCOPE, shopId, 'audit', q] as const,
  auditEvent: (shopId: string, id: string) => [SHOP_SCOPE, shopId, 'audit-event', id] as const,
  invite: (token: string) => ['invite', token] as const,
  // ---- Sprint 2. Everything ticket-derived (list, counts, detail, timeline, dashboard) sits under
  // 'tickets' so one invalidation after a write refreshes every view of it.
  ticketsAll: (shopId: string) => [SHOP_SCOPE, shopId, 'tickets'] as const,
  tickets: (shopId: string, search: string) => [SHOP_SCOPE, shopId, 'tickets', 'list', search] as const,
  ticketCounts: (shopId: string) => [SHOP_SCOPE, shopId, 'tickets', 'counts'] as const,
  ticket: (shopId: string, id: string) => [SHOP_SCOPE, shopId, 'tickets', 'detail', id] as const,
  timeline: (shopId: string, id: string, filter: string) =>
    [SHOP_SCOPE, shopId, 'tickets', 'timeline', id, filter] as const,
  dashboard: (shopId: string) => [SHOP_SCOPE, shopId, 'tickets', 'dashboard'] as const,
  customersAll: (shopId: string) => [SHOP_SCOPE, shopId, 'customers'] as const,
  customers: (shopId: string, search: string) =>
    [SHOP_SCOPE, shopId, 'customers', 'list', search] as const,
  customer: (shopId: string, id: string) => [SHOP_SCOPE, shopId, 'customers', 'detail', id] as const,
  customerDevices: (shopId: string, id: string, archived: boolean) =>
    [SHOP_SCOPE, shopId, 'customers', 'devices', id, archived] as const,
  consents: (shopId: string, id: string) => [SHOP_SCOPE, shopId, 'customers', 'consents', id] as const,
  customerTags: (shopId: string) => [SHOP_SCOPE, shopId, 'customers', 'tags'] as const,
  statuses: (shopId: string) => [SHOP_SCOPE, shopId, 'statuses'] as const,
  ticketSettings: (shopId: string) => [SHOP_SCOPE, shopId, 'ticket-settings'] as const,
  assignees: (shopId: string) => [SHOP_SCOPE, shopId, 'assignees'] as const,
  checkInContext: (shopId: string) => [SHOP_SCOPE, shopId, 'check-in-context'] as const,
  search: (shopId: string, q: string) => [SHOP_SCOPE, shopId, 'search', q] as const,
};

/**
 * True for a cached shop-scoped query that belongs to any shop other than `activeShopId`
 * (every shop-scoped query when there is no active shop).
 */
export function isOtherShopQuery(
  queryKey: readonly unknown[],
  activeShopId: string | null,
): boolean {
  return queryKey[0] === SHOP_SCOPE && queryKey[1] !== activeShopId;
}

export function useShopSettings() {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.shopSettings(shopId),
    queryFn: () => apiFetch('/api/shop', ShopSettingsResponse),
  });
}

export function useTaxRates(includeArchived: boolean) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.taxRates(shopId, includeArchived),
    queryFn: () =>
      apiFetch(
        `/api/shop/tax-rates?includeArchived=${String(includeArchived)}`,
        TaxRateListResponse,
      ),
  });
}

export function useStaff(statuses: readonly StaffStatus[], enabled = true) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.staff(shopId, statuses),
    queryFn: () => apiFetch(`/api/staff?status=${statuses.join(',')}`, StaffListResponse),
    enabled,
  });
}

export function useTimeclock(enabled: boolean) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.timeclock(shopId),
    queryFn: () => apiFetch('/api/timeclock/me', TimeclockStatus),
    enabled,
    refetchOnWindowFocus: true,
  });
}

export interface TimesheetParams {
  from: string;
  to: string;
  userId?: string;
  needsReview?: boolean;
}

export function timesheetSearch(q: TimesheetParams): string {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.userId) params.set('userId', q.userId);
  if (q.needsReview) params.set('needsReview', 'true');
  return params.toString();
}

export function useTimesheets(q: TimesheetParams, enabled: boolean) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.timesheets(shopId, q),
    queryFn: () => apiFetch(`/api/timesheets?${timesheetSearch(q)}`, TimesheetResponse),
    enabled,
  });
}

export type AuditParams = Pick<
  AuditEventListQuery,
  'from' | 'to' | 'userId' | 'action' | 'actionGroup'
>;

export function useAuditEvents(q: AuditParams, enabled: boolean) {
  const shopId = useShopId();
  return useInfiniteQuery({
    queryKey: qk.audit(shopId, q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ from: q.from, to: q.to });
      if (q.userId) params.set('userId', q.userId);
      if (q.action) params.set('action', q.action);
      if (q.actionGroup) params.set('actionGroup', q.actionGroup);
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch(`/api/audit-events?${params.toString()}`, AuditEventListResponse);
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useAuditEvent(id: string | null) {
  const shopId = useShopId();
  return useQuery({
    queryKey: qk.auditEvent(shopId, id ?? ''),
    queryFn: () => apiFetch(`/api/audit-events/${encodeURIComponent(id ?? '')}`, AuditEventDetail),
    enabled: id !== null,
  });
}

export function useInvitePreview(token: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.invite(token),
    queryFn: () => apiFetch(`/api/invites/${encodeURIComponent(token)}`, InvitePreview),
    enabled,
  });
}
