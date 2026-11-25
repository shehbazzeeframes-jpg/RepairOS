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

/** Query keys. Everything shop-scoped starts with 'shop' so a shop switch can drop it in one call. */
export const qk = {
  shopSettings: ['shop', 'settings'] as const,
  taxRates: (includeArchived: boolean) => ['shop', 'tax-rates', includeArchived] as const,
  taxRatesAll: ['shop', 'tax-rates'] as const,
  staff: (statuses: readonly StaffStatus[]) => ['shop', 'staff', statuses.join(',')] as const,
  staffAll: ['shop', 'staff'] as const,
  timeclock: ['shop', 'timeclock'] as const,
  timesheets: (q: TimesheetParams) => ['shop', 'timesheets', q] as const,
  timesheetsAll: ['shop', 'timesheets'] as const,
  audit: (q: AuditParams) => ['shop', 'audit', q] as const,
  auditEvent: (id: string) => ['shop', 'audit-event', id] as const,
  invite: (token: string) => ['invite', token] as const,
};

export function useShopSettings() {
  return useQuery({
    queryKey: qk.shopSettings,
    queryFn: () => apiFetch('/api/shop', ShopSettingsResponse),
  });
}

export function useTaxRates(includeArchived: boolean) {
  return useQuery({
    queryKey: qk.taxRates(includeArchived),
    queryFn: () =>
      apiFetch(`/api/shop/tax-rates?includeArchived=${String(includeArchived)}`, TaxRateListResponse),
  });
}

export function useStaff(statuses: readonly StaffStatus[], enabled = true) {
  return useQuery({
    queryKey: qk.staff(statuses),
    queryFn: () => apiFetch(`/api/staff?status=${statuses.join(',')}`, StaffListResponse),
    enabled,
  });
}

export function useTimeclock(enabled: boolean) {
  return useQuery({
    queryKey: qk.timeclock,
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
  return useQuery({
    queryKey: qk.timesheets(q),
    queryFn: () => apiFetch(`/api/timesheets?${timesheetSearch(q)}`, TimesheetResponse),
    enabled,
  });
}

export type AuditParams = Pick<AuditEventListQuery, 'from' | 'to' | 'userId' | 'action' | 'actionGroup'>;

export function useAuditEvents(q: AuditParams, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: qk.audit(q),
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
  return useQuery({
    queryKey: qk.auditEvent(id ?? ''),
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
