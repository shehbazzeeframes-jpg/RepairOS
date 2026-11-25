/**
 * List filters live in the URL (spec §4.1, §6: "All in the URL, back button works"). These map the
 * page's URL search params to a normalised filter object and to the API query string
 * (`TicketListQuery`, `CustomerListQuery`). The keyset cursor is never in the URL.
 */
import {
  CustomerKind,
  CustomerSort,
  ConsentChannel,
  DEFAULT_PAGE_SIZE,
  DeviceType,
  PAGE_SIZES,
  StatusCategory,
  TicketPriority,
  TicketSort,
  TicketView,
  type DeviceTypeValue,
} from '@repairos/contracts';

const list = (v: string | null): string[] =>
  v
    ? [
        ...new Set(
          v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
    : [];
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const pageSize = (v: string | null): number => {
  const n = Number(v);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
};

// ---------- Tickets ----------

export interface TicketFilters {
  view: TicketView;
  q: string;
  status: string[];
  category: StatusCategory[];
  assignee: string[];
  priority: TicketPriority | null;
  createdFrom: string | null;
  createdTo: string | null;
  dueFrom: string | null;
  dueTo: string | null;
  deviceType: DeviceTypeValue[];
  warranty: boolean;
  customerId: string | null;
  deviceId: string | null;
  sort: TicketSort;
  limit: number;
}

export function ticketFiltersFrom(sp: URLSearchParams, defaultView: TicketView): TicketFilters {
  const view = TicketView.safeParse(sp.get('view'));
  const priority = TicketPriority.safeParse(sp.get('priority'));
  const sort = TicketSort.safeParse(sp.get('sort'));
  const createdFrom = sp.get('createdFrom');
  const createdTo = sp.get('createdTo');
  const dueFrom = sp.get('dueFrom');
  const dueTo = sp.get('dueTo');
  return {
    view: view.success ? view.data : defaultView,
    q: sp.get('q') ?? '',
    status: list(sp.get('status')),
    category: list(sp.get('category')).filter(
      (c): c is StatusCategory => StatusCategory.safeParse(c).success,
    ),
    assignee: list(sp.get('assignee')),
    priority: priority.success ? priority.data : null,
    createdFrom: isDate(createdFrom) ? createdFrom : null,
    createdTo: isDate(createdTo) ? createdTo : null,
    dueFrom: isDate(dueFrom) ? dueFrom : null,
    dueTo: isDate(dueTo) ? dueTo : null,
    deviceType: list(sp.get('deviceType')).filter(
      (t): t is DeviceTypeValue => DeviceType.safeParse(t).success,
    ),
    warranty: sp.get('warranty') === 'true',
    customerId: sp.get('customerId') || null,
    deviceId: sp.get('deviceId') || null,
    sort: sort.success ? sort.data : 'default',
    limit: pageSize(sp.get('limit')),
  };
}

/** The filters that narrow a view (everything but view, sort and page size). */
export function hasTicketFilters(f: TicketFilters): boolean {
  return !!(
    f.q.trim() ||
    f.status.length ||
    f.category.length ||
    f.assignee.length ||
    f.priority ||
    f.createdFrom ||
    f.dueFrom ||
    f.deviceType.length ||
    f.warranty ||
    f.customerId ||
    f.deviceId
  );
}

function ticketParams(f: TicketFilters, forApi: boolean): URLSearchParams {
  const p = new URLSearchParams();
  p.set('view', f.view);
  const q = f.q.trim();
  // The API needs 2–100 characters; a 1-character box stays in the URL but isn't sent.
  if (q && (!forApi || q.length >= 2)) p.set('q', q);
  if (f.status.length) p.set('status', f.status.join(','));
  if (f.category.length) p.set('category', f.category.join(','));
  if (f.assignee.length) p.set('assignee', f.assignee.join(','));
  if (f.priority) p.set('priority', f.priority);
  if (f.createdFrom) p.set('createdFrom', f.createdFrom);
  if (f.createdTo) p.set('createdTo', f.createdTo);
  if (f.dueFrom) p.set('dueFrom', f.dueFrom);
  if (f.dueTo) p.set('dueTo', f.dueTo);
  if (f.deviceType.length) p.set('deviceType', f.deviceType.join(','));
  if (f.warranty) p.set('warranty', 'true');
  if (f.customerId) p.set('customerId', f.customerId);
  if (f.deviceId) p.set('deviceId', f.deviceId);
  if (f.sort !== 'default' || forApi) p.set('sort', f.sort);
  if (f.limit !== DEFAULT_PAGE_SIZE || forApi) p.set('limit', String(f.limit));
  return p;
}

/** For the page URL (defaults left out). */
export function ticketFiltersToUrl(f: TicketFilters): string {
  return ticketParams(f, false).toString();
}

/** For GET /api/tickets (with the cursor of the page being shown). */
export function ticketFiltersToApi(f: TicketFilters, cursor?: string | null): string {
  const p = ticketParams(f, true);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export function clearTicketFilters(f: TicketFilters): TicketFilters {
  return {
    ...f,
    q: '',
    status: [],
    category: [],
    assignee: [],
    priority: null,
    createdFrom: null,
    createdTo: null,
    dueFrom: null,
    dueTo: null,
    deviceType: [],
    warranty: false,
    customerId: null,
    deviceId: null,
  };
}

// ---------- Customers ----------

export interface CustomerFilters {
  q: string;
  type: CustomerKind | null;
  tags: string[];
  hasOpen: boolean;
  consent: ConsentChannel[];
  createdFrom: string | null;
  createdTo: string | null;
  archived: boolean;
  sort: CustomerSort;
  limit: number;
}

export function customerFiltersFrom(sp: URLSearchParams): CustomerFilters {
  const type = CustomerKind.safeParse(sp.get('type'));
  const sort = CustomerSort.safeParse(sp.get('sort'));
  const createdFrom = sp.get('createdFrom');
  const createdTo = sp.get('createdTo');
  return {
    q: sp.get('q') ?? '',
    type: type.success ? type.data : null,
    tags: list(sp.get('tags')),
    hasOpen: sp.get('hasOpen') === 'true',
    consent: list(sp.get('consent')).filter(
      (c): c is ConsentChannel => ConsentChannel.safeParse(c).success,
    ),
    createdFrom: isDate(createdFrom) ? createdFrom : null,
    createdTo: isDate(createdTo) ? createdTo : null,
    archived: sp.get('archived') === 'true',
    sort: sort.success ? sort.data : 'name',
    limit: pageSize(sp.get('limit')),
  };
}

export function hasCustomerFilters(f: CustomerFilters): boolean {
  return !!(
    f.q.trim() ||
    f.type ||
    f.tags.length ||
    f.hasOpen ||
    f.consent.length ||
    f.createdFrom ||
    f.archived
  );
}

function customerParams(f: CustomerFilters, forApi: boolean): URLSearchParams {
  const p = new URLSearchParams();
  const q = f.q.trim();
  if (q && (!forApi || q.length >= 2)) p.set('q', q);
  if (f.type) p.set('type', f.type);
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.hasOpen) p.set('hasOpen', 'true');
  if (f.consent.length) p.set('consent', f.consent.join(','));
  if (f.createdFrom) p.set('createdFrom', f.createdFrom);
  if (f.createdTo) p.set('createdTo', f.createdTo);
  if (f.archived) p.set('archived', 'true');
  if (f.sort !== 'name' || forApi) p.set('sort', f.sort);
  if (f.limit !== DEFAULT_PAGE_SIZE || forApi) p.set('limit', String(f.limit));
  return p;
}

export function customerFiltersToUrl(f: CustomerFilters): string {
  return customerParams(f, false).toString();
}

export function customerFiltersToApi(f: CustomerFilters, cursor?: string | null): string {
  const p = customerParams(f, true);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** "Showing 1–25 of 312" / "of 10,000+" for a keyset page. */
export function pageRangeText(
  page: number,
  pageSize: number,
  shown: number,
  total: number,
  capped: boolean,
  locale = 'en-GB',
): string {
  if (shown === 0) return 'No results';
  const nf = new Intl.NumberFormat(locale);
  const from = (page - 1) * pageSize + 1;
  const to = from + shown - 1;
  return `Showing ${nf.format(from)}–${nf.format(to)} of ${nf.format(total)}${capped ? '+' : ''}`;
}
