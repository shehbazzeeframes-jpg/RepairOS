import { z } from 'zod';
import { TicketCounts, TicketListItem } from './tickets';

/**
 * Dashboard (Sprint 2 story §6 DB1) and the technician queue (§5.7 TQ1).
 *
 * GET /api/dashboard · permission `tickets.view` → 200 `DashboardSummary`.
 * - `counts`: identical to GET /api/tickets/counts (same query), so tiles and list views always agree.
 *   Tiles: Open tickets = `openAndWaiting` (→ `?view=open&category=OPEN,WAITING`), Ready for pickup =
 *   `ready` (→ view `ready`), Overdue = `overdue` (→ view `overdue`), Due today = `dueToday`
 *   (→ `?view=open&category=OPEN,WAITING&dueFrom=<today>&dueTo=<today>`).
 * - `myQueue`: up to 10 tickets assigned to the caller, not closed, Urgent first then due soonest ("View all" →
 *   view `mine`); `myQueueTotal` = all such tickets.
 * - `unassigned`: when `myQueue` is empty, the top 5 of view `unassigned` (same sort) with "Take"; otherwise [].
 * Refresh on focus and every `TICKET_COUNTS_REFRESH_MS`. Users without `tickets.view` keep the Sprint 0 welcome card.
 *
 * The full technician queue is GET /api/tickets?view=mine (default sort = Urgent first, then due).
 */
export const DashboardSummary = z.object({
  counts: TicketCounts,
  myQueue: z.array(TicketListItem).max(10),
  myQueueTotal: z.number().int().min(0),
  unassigned: z.array(TicketListItem).max(5),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

export const DASHBOARD_PATH = '/api/dashboard';
export const DASHBOARD_QUEUE_SIZE = 10;
export const DASHBOARD_UNASSIGNED_SIZE = 5;
