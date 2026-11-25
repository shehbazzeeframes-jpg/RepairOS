import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  API_ERROR_MESSAGES,
  type AssignTicketInput,
  type CancelTicketInput,
  canEditNote,
  canTransition,
  type ChangeTicketStatusInput,
  CHECKLIST_ITEMS_BY_DEVICE_TYPE,
  checklistKeyProblems,
  completeChecklist,
  computeDefaultDueAt,
  createTicketSchema,
  type CreateTicketNoteInput,
  deviceLabel,
  dueAtFor,
  dueInputProblem,
  hasPermission,
  IDEMPOTENCY_WINDOW_MINUTES,
  type PasscodeReveal,
  PASSCODE_REVEALS_PER_HOUR,
  parsePattern,
  type ReopenTicketInput,
  STALE_TICKET_MESSAGE,
  type StatusCategory,
  type TicketDetail,
  type TicketNote,
  toTicketIssues,
  type TransitionResult,
  UpdateTicketInput,
  type UpdateTicketNoteInput,
  type ChecklistItemKey,
  type ChecklistResult,
  type DeviceType,
  type TicketIssueInput,
} from '@repairos/contracts';
import {
  decryptField,
  FieldDecryptError,
  nextTicketNumber,
  passcodeAad,
  passcodeFromRow,
  type ScopedTx,
  type Ticket,
  type TicketEventDataByType,
  TxRetryError,
} from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { isCheckViolation, isForeignKeyViolation, writeAudit } from '../common/audit';
import { ApiException, apiError, forbidden, notFound, validationFailed } from '../common/errors';
import { ZodValidationPipe } from '../common/zod';
import { CONFIG, type AppConfig } from '../config';
import { insertCustomer } from '../customers/customer-write';
import { insertDevice, setDevicePasscode } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { lockCustomers, lockDevices, lockStatuses, lockTickets } from '../repair/locks';
import { deletePasscodeOfReleasedDevice, deletePasscodeOnClose, lockDevice } from '../repair/passcode';
import { loadShopInfo, refreshCustomerCounters, type ShopInfo, ticketDetail, userRefs } from '../repair/read';
import { toNoteDto } from './ticket-query.service';

/** Output of contracts `UpdateTicketInput` (the controller validates with it). */
export type UpdateTicketData = ReturnType<typeof UpdateTicketInput.parse>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function transitionError(r: Extract<TransitionResult, { ok: false }>): ApiException {
  if (r.code === 'FORBIDDEN') return forbidden(API_ERROR_MESSAGES.FORBIDDEN);
  return apiError(r.code, undefined, r.message);
}

/** Constraints a ticket write can still hit if a status it references is changed at the same time (backstop). */
const STATUS_RACE_FKS = ['tickets_shopId_statusId_statusCategory_fkey', 'tickets_shopId_statusIdBeforeClose_fkey'] as const;
const STATUS_RACE_CHECKS = ['tickets_closed_at_check', 'tickets_status_before_close_check'] as const;
export const STATUS_CHANGED_MESSAGE = 'This status was changed at the same time. Refresh and try again.';

/** Maps a leftover status race (the status row lock makes it unreachable in practice) to 409 instead of a 500. */
export function mapStatusRace(err: unknown): never {
  if (isForeignKeyViolation(err, STATUS_RACE_FKS) || isCheckViolation(err, STATUS_RACE_CHECKS)) {
    throw apiError('CONFLICT', undefined, STATUS_CHANGED_MESSAGE);
  }
  throw err;
}

/** Every id in `needed` is among `held` (nulls ignored). */
const allHeld = (needed: readonly (string | null | undefined)[] = [], held: readonly (string | null | undefined)[] = []) =>
  needed.every((x) => !x || held.includes(x));

/** What a ticket write will reference, derived from the ticket row (see `lockTicketWrite`). */
interface TicketLockPlan {
  /** Statuses the write points the ticket at (statusId, statusIdBeforeClose): locked FOR SHARE. */
  statuses?: (string | null | undefined)[];
  /** Customers other than the ticket's own (customer change). */
  customers?: (string | null | undefined)[];
}

type Event<K extends keyof TicketEventDataByType> = { type: K; data: TicketEventDataByType[K]; noteId?: string | null; actorUserId?: string | null };

/** Ticket writes (story §5): check-in, edit, status, assign, cancel, reopen, notes and the passcode reveal. */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger('TicketsService');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  private ctx(actor: Actor) {
    return { shopId: actor.shopId, userId: actor.userId, keyring: this.config.fieldEncryption };
  }

  private async event<K extends keyof TicketEventDataByType>(tx: ScopedTx, actor: Actor, ticketId: string, e: Event<K>) {
    await tx.ticketEvent.create({
      data: {
        shopId: actor.shopId,
        ticketId,
        actorUserId: e.actorUserId === undefined ? actor.userId : e.actorUserId,
        type: e.type,
        data: e.data as object,
        noteId: e.noteId ?? null,
      },
    });
  }

  /** Shop transaction for a ticket write: retried on deadlock (PrismaService.forShop), leftover status races → 409. */
  private write<T>(actor: Actor, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
    return this.db(actor).tx(fn).catch(mapStatusRace);
  }

  /** Row-locks the ticket (FOR NO KEY UPDATE) and reads it: guards re-check the current state under the lock. */
  private async lockedTicket(tx: ScopedTx, id: string) {
    await lockTickets(tx, [id], 'update');
    const t = await tx.ticket.findFirst({ where: { id } });
    if (!t) throw notFound();
    return t;
  }

  /**
   * Takes a ticket write's locks in the lock order (../repair/locks): the statuses it will reference (FOR SHARE), its
   * customer(s), then the ticket. `plan` is worked out from an unlocked read of the ticket and again from the locked
   * row; if the locked row needs a lock that was not taken (it moved to another customer or status meanwhile), the
   * transaction is rerun (TxRetryError). Holding one lock too many is harmless.
   */
  private async lockTicketWrite(tx: ScopedTx, id: string, plan: (t: Ticket) => TicketLockPlan = () => ({})): Promise<Ticket> {
    const pre = await tx.ticket.findFirst({ where: { id } });
    if (!pre) throw notFound();
    const want = plan(pre);
    await lockStatuses(tx, want.statuses ?? [], 'share');
    await lockCustomers(tx, [pre.customerId, ...(want.customers ?? [])]);
    const t = await this.lockedTicket(tx, id);
    const got = plan(t);
    const customersHeld = [pre.customerId, ...(want.customers ?? [])];
    if (!allHeld([t.customerId, ...(got.customers ?? [])], customersHeld) || !allHeld(got.statuses, want.statuses)) {
      throw new TxRetryError(`ticket ${id} changed before it was locked`);
    }
    return t;
  }

  private dueFor(shop: ShopInfo, date: string, time: string | null, now: Date) {
    const problem = dueInputProblem(date, time, now, shop.timezone);
    if (problem) throw validationFailed([{ path: [problem.startsWith('Due date') ? 'dueDate' : 'dueTime'], message: problem }]);
    return dueAtFor(date, time, shop.hours, shop.timezone);
  }

  private async activeAssignee(tx: ScopedTx, userId: string) {
    const m = await tx.membership.findFirst({ where: { userId }, select: { status: true, user: { select: { name: true } } } });
    if (!m) throw notFound();
    if (m.status !== 'ACTIVE') throw apiError('ASSIGNEE_NOT_ACTIVE', { name: m.user.name });
  }

  async detail(actor: Actor, id: string): Promise<TicketDetail> {
    return this.db(actor).tx(async (tx) => ticketDetail(tx, id, await loadShopInfo(tx)));
  }

  // ---------- Check-in ----------

  /**
   * POST /api/tickets: one transaction (new customer → new device → passcode → number → ticket → events → customer
   * counters). With an Idempotency-Key, a repeat within the window returns the first ticket (`created: false`).
   */
  async create(actor: Actor, body: unknown, idempotencyKey: string | undefined, now = new Date()): Promise<{ ticket: TicketDetail; created: boolean }> {
    if (idempotencyKey !== undefined && !UUID.test(idempotencyKey)) {
      throw validationFailed([{ path: ['Idempotency-Key'], message: 'Use a UUID' }]);
    }
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      // A repeat is answered before the body is looked at (contracts: "the body is not compared").
      if (idempotencyKey) {
        const windowStart = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MINUTES * 60_000);
        await tx.ticketIdempotencyKey.deleteMany({ where: { userId: actor.userId, key: idempotencyKey, createdAt: { lt: windowStart } } });
        // Waits for a concurrent request with the same key; then sees its committed row.
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "ticket_idempotency_keys" ("id", "shopId", "userId", "key")
          VALUES (gen_random_uuid()::text, ${actor.shopId}, ${actor.userId}, ${idempotencyKey})
          ON CONFLICT ("shopId", "userId", "key") DO NOTHING RETURNING "id"`;
        if (inserted.length === 0) {
          const prior = await tx.ticketIdempotencyKey.findFirst({ where: { userId: actor.userId, key: idempotencyKey } });
          if (!prior?.ticketId) throw apiError('CONFLICT', undefined, 'This check-in is already being created.');
          return { ticket: await ticketDetail(tx, prior.ticketId, shop, now), created: false };
        }
      }

      const input = new ZodValidationPipe(createTicketSchema(shop.country)).transform(body ?? {});
      if ((input.newCustomer || input.newDevice || input.devicePasscode) && !hasPermission(actor.role, 'customers.manage')) {
        throw forbidden(API_ERROR_MESSAGES.FORBIDDEN);
      }

      // Locks in the lock order (../repair/locks): INITIAL status → customer → warranty ticket(s) → device → number.
      const initialRef = await tx.ticketStatus.findFirst({ where: { systemRole: 'INITIAL' }, select: { id: true } });
      if (!initialRef) throw new Error('Shop has no INITIAL status');
      await lockStatuses(tx, [initialRef.id], 'share');

      // Customer
      let customerId: string;
      if (input.newCustomer) {
        customerId = await insertCustomer(tx, actor.shopId, actor.userId, input.newCustomer);
      } else {
        customerId = input.customerId!;
        await lockCustomers(tx, [customerId]);
        const c = await tx.customer.findFirst({ where: { id: customerId }, select: { erasedAt: true, archivedAt: true } });
        if (!c) throw notFound();
        if (c.erasedAt) throw apiError('CUSTOMER_ERASED');
        if (c.archivedAt) throw apiError('CUSTOMER_ARCHIVED');
      }

      // Warranty (M2): the original (and the warranty root) FOR SHARE, so a concurrent reopen of the original waits.
      const warrantySelect = { id: true, deviceId: true, warrantyOfTicketId: true, status: { select: { systemRole: true } } } as const;
      let original: { id: string; deviceId: string; warrantyOfTicketId: string | null; status: { systemRole: string | null } } | null = null;
      if (input.warrantyOfTicketId) {
        const pre = await tx.ticket.findFirst({ where: { id: input.warrantyOfTicketId }, select: warrantySelect });
        if (!pre) throw notFound();
        await lockTickets(tx, [pre.id, pre.warrantyOfTicketId], 'share');
        original = await tx.ticket.findFirst({ where: { id: input.warrantyOfTicketId }, select: warrantySelect });
        if (!original) throw notFound();
        if (original.warrantyOfTicketId !== pre.warrantyOfTicketId) throw new TxRetryError('warranty ticket changed before it was locked');
      }

      // Device
      let deviceId: string;
      let deviceType: DeviceType;
      if (input.newDevice) {
        deviceId = await insertDevice(tx, this.ctx(actor), customerId, input.newDevice);
        deviceType = input.newDevice.type;
      } else {
        // H1: same lock as a close of another ticket of this device, so that close sees this new ticket.
        await lockDevice(tx, input.deviceId!);
        const d = await tx.device.findFirst({ where: { id: input.deviceId! }, select: { id: true, customerId: true, type: true, lockType: true, passcodeKeyVersion: true } });
        if (!d) throw notFound();
        if (d.customerId !== customerId) throw validationFailed([{ path: ['deviceId'], message: 'This device belongs to another customer' }]);
        deviceId = d.id;
        deviceType = d.type;
        const problems = checklistKeyProblems(d.type, input.checklist);
        if (problems.length) throw validationFailed(problems.map((k) => ({ path: ['checklist', k], message: 'Not on this device’s checklist' })));
        if (input.devicePasscode) {
          await setDevicePasscode(tx, this.ctx(actor), d.id, { lockType: d.lockType, passcodeOnFile: d.passcodeKeyVersion !== null }, input.devicePasscode);
        }
      }

      if (input.estimate && input.estimate.currency !== shop.currency) {
        throw validationFailed([{ path: ['estimate', 'currency'], message: `Use ${shop.currency}` }]);
      }
      const due = input.dueDate
        ? this.dueFor(shop, input.dueDate, input.dueTime, now)
        : computeDefaultDueAt(now, shop.turnaroundDays, shop.hours, shop.timezone);
      if (input.assigneeUserId) await this.activeAssignee(tx, input.assigneeUserId);

      let warrantyRoot: string | null = null;
      if (original) {
        // M2 (tech lead): a Collected ticket for the SAME device.
        if (original.status.systemRole !== 'COLLECTED' || original.deviceId !== deviceId) throw apiError('WARRANTY_NOT_ALLOWED');
        warrantyRoot = original.warrantyOfTicketId ?? original.id;
      }

      // Read under the status lock: the category is the committed one.
      const initial = await tx.ticketStatus.findFirst({ where: { id: initialRef.id } });
      if (!initial) throw new Error('Shop has no INITIAL status');
      const number = await nextTicketNumber(tx, actor.shopId);
      const ticket = await tx.ticket.create({
        data: {
          shopId: actor.shopId,
          number,
          statusId: initial.id,
          statusCategory: initial.category,
          statusChangedAt: now,
          priority: input.priority,
          customerId,
          deviceId,
          assigneeUserId: input.assigneeUserId,
          description: input.description,
          conditionNotes: input.conditionNotes,
          accessoriesOther: input.accessories.includes('OTHER') ? input.accessoriesOther : null,
          estimateMinor: input.estimate?.amountMinor ?? null,
          currency: shop.currency,
          dueAt: new Date(due.dueAt),
          dueHasTime: due.dueHasTime,
          warrantyOfTicketId: warrantyRoot,
          createdByUserId: actor.userId,
          createdAt: now,
        },
      });
      await this.writeIssues(tx, actor.shopId, ticket.id, input.issues);
      await this.writeChecklist(tx, actor.shopId, ticket.id, deviceType, completeChecklist(deviceType, input.checklist));
      if (input.accessories.length) {
        await tx.ticketAccessory.createMany({ data: input.accessories.map((code) => ({ shopId: actor.shopId, ticketId: ticket.id, code })) });
      }
      await this.event(tx, actor, ticket.id, { type: 'created', data: { statusId: initial.id, warrantyOfTicketId: warrantyRoot } });
      if (warrantyRoot) {
        await this.event(tx, actor, warrantyRoot, { type: 'warranty_linked', data: { ticketId: ticket.id, role: 'warranty' } });
      }
      await refreshCustomerCounters(tx, [customerId]);
      if (idempotencyKey) {
        await tx.ticketIdempotencyKey.updateMany({ where: { userId: actor.userId, key: idempotencyKey }, data: { ticketId: ticket.id } });
      }
      return { ticket: await ticketDetail(tx, ticket.id, shop, now), created: true };
    });
  }

  private async writeIssues(tx: ScopedTx, shopId: string, ticketId: string, issues: readonly TicketIssueInput[]) {
    const list = toTicketIssues(issues);
    if (list.length) {
      await tx.ticketIssue.createMany({ data: list.map((i, position) => ({ shopId, ticketId, code: i.code, label: i.label, position })) });
    }
  }

  private async writeChecklist(tx: ScopedTx, shopId: string, ticketId: string, type: DeviceType, results: Partial<Record<ChecklistItemKey, ChecklistResult>>) {
    const items = CHECKLIST_ITEMS_BY_DEVICE_TYPE[type];
    await tx.ticketChecklistItem.createMany({
      data: items.map((item, position) => ({ shopId, ticketId, itemKey: item.key, result: results[item.key] ?? 'UNTESTED', position })),
    });
  }

  // ---------- Edit ----------

  async update(actor: Actor, id: string, parsed: UpdateTicketData, now = new Date()): Promise<TicketDetail> {
    if ((parsed.customerId || parsed.deviceId) && !hasPermission(actor.role, 'customers.manage')) throw forbidden(API_ERROR_MESSAGES.FORBIDDEN);
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      // L1 + lock order: both customers (sorted) before the ticket, so a concurrent erase either commits first (and is
      // seen below) or waits for this move (and then counts the ticket as open).
      const t = await this.lockTicketWrite(tx, id, (row) => ({
        customers: parsed.customerId && parsed.customerId !== row.customerId ? [parsed.customerId] : [],
      }));
      if (t.statusCategory === 'CLOSED') throw apiError('TICKET_CLOSED');
      if (t.version !== parsed.version) throw new ApiException(409, 'STALE_RECORD', STALE_TICKET_MESSAGE);

      const [issues, checklistRows, accessories, device] = await Promise.all([
        tx.ticketIssue.findMany({ where: { ticketId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
        tx.ticketChecklistItem.findMany({ where: { ticketId: id } }),
        tx.ticketAccessory.findMany({ where: { ticketId: id } }),
        tx.device.findFirstOrThrow({ where: { id: t.deviceId }, select: { id: true, type: true, brand: true, model: true } }),
      ]);
      const changes: { field: string; before: unknown; after: unknown }[] = [];
      const data: Record<string, unknown> = {};
      const events: Event<'device_changed' | 'customer_changed'>[] = [];

      // Device / customer (mistakes at the counter).
      let deviceType = device.type as DeviceType;
      let customerId = t.customerId;
      if (parsed.customerId && parsed.customerId !== t.customerId) {
        const c = await tx.customer.findFirst({ where: { id: parsed.customerId }, select: { erasedAt: true, archivedAt: true } });
        if (!c) throw notFound();
        if (c.erasedAt) throw apiError('CUSTOMER_ERASED');
        if (c.archivedAt) throw apiError('CUSTOMER_ARCHIVED');
        customerId = parsed.customerId;
        data.customerId = customerId;
        events.push({ type: 'customer_changed', data: { fromCustomerId: t.customerId, toCustomerId: customerId } });
      }
      if (parsed.deviceId && (parsed.deviceId !== t.deviceId || customerId !== t.customerId)) {
        // Old and new device, sorted, before the ticket points at the new one (its FK) and the old one's passcode check.
        await lockDevices(tx, [t.deviceId, parsed.deviceId]);
        const d = await tx.device.findFirst({ where: { id: parsed.deviceId }, select: { id: true, customerId: true, type: true, brand: true, model: true } });
        if (!d) throw notFound();
        if (d.customerId !== customerId) throw validationFailed([{ path: ['deviceId'], message: 'Choose a device of this customer' }]);
        if (d.id !== t.deviceId) {
          data.deviceId = d.id;
          deviceType = d.type;
          events.push({ type: 'device_changed', data: { from: { deviceId: device.id, label: deviceLabel(device) }, to: { deviceId: d.id, label: deviceLabel(d) } } });
        }
      }

      const issueLabels = issues.map((i) => i.label);
      let newIssues: ReturnType<typeof toTicketIssues> | null = null;
      if (parsed.issues) {
        newIssues = toTicketIssues(parsed.issues);
        const labels = newIssues.map((i) => i.label);
        if (JSON.stringify(labels) !== JSON.stringify(issueLabels) || JSON.stringify(newIssues.map((i) => i.code)) !== JSON.stringify(issues.map((i) => i.code))) {
          changes.push({ field: 'issues', before: issueLabels, after: labels });
        } else newIssues = null;
      }
      const description = parsed.description === undefined ? t.description : parsed.description;
      if (description !== t.description) {
        changes.push({ field: 'description', before: t.description, after: description });
        data.description = description;
      }
      if ((newIssues ? newIssues.length : issues.length) === 0 && !description) {
        throw validationFailed([{ path: ['issues'], message: 'Choose an issue or describe the problem' }]);
      }

      // Checklist, merged per item against the (possibly new) device type.
      const current = completeChecklist(device.type as DeviceType, Object.fromEntries(checklistRows.map((c) => [c.itemKey, c.result])) as Partial<Record<ChecklistItemKey, ChecklistResult>>);
      let nextChecklist: Partial<Record<ChecklistItemKey, ChecklistResult>> | null = null;
      if (parsed.checklist || deviceType !== device.type) {
        const patch = parsed.checklist ?? {};
        const problems = checklistKeyProblems(deviceType, patch);
        if (problems.length) throw validationFailed(problems.map((k) => ({ path: ['checklist', k], message: 'Not on this device’s checklist' })));
        nextChecklist = completeChecklist(deviceType, { ...current, ...patch });
        const keys = new Set([...Object.keys(current), ...Object.keys(nextChecklist)]) as Set<ChecklistItemKey>;
        let changed = false;
        for (const k of keys) {
          if (current[k] !== nextChecklist[k]) {
            changes.push({ field: `checklist.${k}`, before: current[k] ?? null, after: nextChecklist[k] ?? null });
            changed = true;
          }
        }
        if (!changed) nextChecklist = null;
      }

      if (parsed.conditionNotes !== undefined && parsed.conditionNotes !== t.conditionNotes) {
        changes.push({ field: 'conditionNotes', before: t.conditionNotes, after: parsed.conditionNotes });
        data.conditionNotes = parsed.conditionNotes;
      }
      const ACC_ORDER = ['SIM_CARD', 'SIM_TRAY', 'MEMORY_CARD', 'CASE', 'CHARGER', 'CABLE', 'STYLUS', 'BOX', 'OTHER'];
      const sortAcc = (a: string[]) => [...a].sort((x, y) => ACC_ORDER.indexOf(x) - ACC_ORDER.indexOf(y));
      const accBefore = sortAcc(accessories.map((a) => a.code));
      let newAcc: string[] | null = null;
      if (parsed.accessories) {
        const after = sortAcc(parsed.accessories);
        if (after.join() !== accBefore.join()) {
          changes.push({ field: 'accessories', before: accBefore, after });
          newAcc = after;
        }
      }
      const finalAcc = newAcc ?? accBefore;
      const other = parsed.accessoriesOther === undefined ? t.accessoriesOther : parsed.accessoriesOther;
      const otherFinal = finalAcc.includes('OTHER') ? other : null;
      if (finalAcc.includes('OTHER') && !otherFinal) throw validationFailed([{ path: ['accessoriesOther'], message: 'Say what else was left' }]);
      if (otherFinal !== t.accessoriesOther) {
        changes.push({ field: 'accessoriesOther', before: t.accessoriesOther, after: otherFinal });
        data.accessoriesOther = otherFinal;
      }
      if (parsed.estimate !== undefined) {
        if (parsed.estimate && parsed.estimate.currency !== t.currency) {
          throw validationFailed([{ path: ['estimate', 'currency'], message: `Use ${t.currency}` }]);
        }
        const amount = parsed.estimate?.amountMinor ?? null;
        if (amount !== t.estimateMinor) {
          const money = (m: number | null) => (m === null ? null : { amountMinor: m, currency: t.currency });
          changes.push({ field: 'estimate', before: money(t.estimateMinor), after: money(amount) });
          data.estimateMinor = amount;
        }
      }
      if (parsed.dueDate) {
        const due = this.dueFor(shop, parsed.dueDate, parsed.dueTime ?? null, now);
        if (due.dueAt !== t.dueAt.toISOString() || due.dueHasTime !== t.dueHasTime) {
          changes.push({ field: 'due', before: { dueAt: t.dueAt.toISOString(), dueHasTime: t.dueHasTime }, after: { dueAt: due.dueAt, dueHasTime: due.dueHasTime } });
          data.dueAt = new Date(due.dueAt);
          data.dueHasTime = due.dueHasTime;
        }
      }
      if (parsed.priority && parsed.priority !== t.priority) {
        changes.push({ field: 'priority', before: t.priority, after: parsed.priority });
        data.priority = parsed.priority;
      }

      if (changes.length === 0 && events.length === 0) return ticketDetail(tx, id, shop, now);

      const updated = await tx.ticket.updateMany({ where: { id, version: parsed.version }, data: { ...data, version: { increment: 1 } } });
      if (updated.count !== 1) throw new ApiException(409, 'STALE_RECORD', STALE_TICKET_MESSAGE);
      if (newIssues) {
        await tx.ticketIssue.deleteMany({ where: { ticketId: id } });
        await this.writeIssues(tx, actor.shopId, id, parsed.issues!);
      }
      if (nextChecklist) {
        await tx.ticketChecklistItem.deleteMany({ where: { ticketId: id } });
        await this.writeChecklist(tx, actor.shopId, id, deviceType, nextChecklist);
      }
      if (newAcc) {
        await tx.ticketAccessory.deleteMany({ where: { ticketId: id } });
        if (newAcc.length) await tx.ticketAccessory.createMany({ data: newAcc.map((code) => ({ shopId: actor.shopId, ticketId: id, code })) });
      }
      for (const e of events) await this.event(tx, actor, id, e);
      if (changes.length) await this.event(tx, actor, id, { type: 'fields_changed', data: { changes } });
      if (customerId !== t.customerId) await refreshCustomerCounters(tx, [t.customerId, customerId]);
      // H1: the old device may have no non-closed ticket left.
      if (data.deviceId) await deletePasscodeOfReleasedDevice(tx, { deviceId: t.deviceId, settingOn: shop.deletePasscodeOnClose });
      return ticketDetail(tx, id, shop, now);
    });
  }

  // ---------- Status, assign, cancel, reopen ----------

  async changeStatus(actor: Actor, id: string, input: ChangeTicketStatusInput, now = new Date()): Promise<TicketDetail> {
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      // Target status FOR SHARE (and the current one, which a close stores as statusIdBeforeClose): a concurrent
      // re-categorisation waits for this change, or commits first and the read below sees the new category.
      const t = await this.lockTicketWrite(tx, id, (row) => ({ statuses: [input.statusId, row.statusId] }));
      const target = await tx.ticketStatus.findFirst({ where: { id: input.statusId } });
      if (!target) throw notFound();
      const r = canTransition({ category: t.statusCategory as StatusCategory, id: t.statusId }, { ...target, category: target.category as StatusCategory }, {
        role: actor.role,
        via: 'status',
        now,
      });
      if (!r.ok) throw transitionError(r);
      if (r.requiresNote && !input.note) throw validationFailed([{ path: ['note'], message: "Why can't it be repaired?" }]);

      let noteId: string | null = null;
      if (input.note) {
        const note = await tx.ticketNote.create({
          data: { shopId: actor.shopId, ticketId: id, authorUserId: actor.userId, body: input.note.body, visibility: input.note.visibility, createdAt: now },
        });
        noteId = note.id;
        await this.event(tx, actor, id, { type: 'note_added', data: {}, noteId });
      }
      await tx.ticket.update({
        where: { id },
        data: {
          statusId: target.id,
          statusCategory: target.category,
          statusChangedAt: now,
          version: { increment: 1 },
          ...(r.closes ? { closedAt: now, statusIdBeforeClose: t.statusId } : {}),
        },
      });
      await this.event(tx, actor, id, {
        type: 'status_changed',
        data: { fromStatusId: t.statusId, toStatusId: target.id, notifyPending: target.notifyCustomer },
        noteId,
      });
      if (r.closes) {
        await deletePasscodeOnClose(tx, { shopId: actor.shopId, ticketId: id, deviceId: t.deviceId, settingOn: shop.deletePasscodeOnClose });
        await refreshCustomerCounters(tx, [t.customerId]);
      }
      return ticketDetail(tx, id, shop, now);
    });
  }

  async assign(actor: Actor, id: string, input: AssignTicketInput, now = new Date()): Promise<TicketDetail> {
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      const t = await this.lockedTicket(tx, id);
      if (t.statusCategory === 'CLOSED') throw apiError('TICKET_CLOSED');
      if (input.userId === t.assigneeUserId) return ticketDetail(tx, id, shop, now);
      if (input.userId) await this.activeAssignee(tx, input.userId);
      await tx.ticket.update({ where: { id }, data: { assigneeUserId: input.userId, version: { increment: 1 } } });
      await this.event(tx, actor, id, { type: 'assigned', data: { fromUserId: t.assigneeUserId, toUserId: input.userId } });
      return ticketDetail(tx, id, shop, now);
    });
  }

  async cancel(actor: Actor, id: string, input: CancelTicketInput, now = new Date()): Promise<TicketDetail> {
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      const targetId = input.statusId ?? (await tx.ticketStatus.findFirst({ where: { systemRole: 'CANCELLED' }, select: { id: true } }))?.id;
      if (!targetId) throw notFound();
      const t = await this.lockTicketWrite(tx, id, (row) => ({ statuses: [targetId, row.statusId] }));
      const target = await tx.ticketStatus.findFirst({ where: { id: targetId } });
      if (!target) throw notFound();
      const r = canTransition({ category: t.statusCategory as StatusCategory, id: t.statusId }, { ...target, category: target.category as StatusCategory }, {
        role: actor.role,
        via: 'cancel',
        now,
      });
      if (!r.ok) throw transitionError(r);
      const note = input.note ?? null;
      const returnedConfirmed = input.returnedConfirmed ?? false;
      await tx.ticket.update({
        where: { id },
        data: {
          statusId: target.id,
          statusCategory: target.category,
          statusChangedAt: now,
          closedAt: now,
          statusIdBeforeClose: t.statusId,
          cancelReason: input.reason,
          cancelNote: note,
          returnedConfirmed,
          version: { increment: 1 },
        },
      });
      await this.event(tx, actor, id, { type: 'cancelled', data: { statusId: target.id, reason: input.reason, note, returnedConfirmed } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'ticket.cancelled',
        entityId: id,
        // A11-b: reason code and ids only; the free-text note stays on the ticket and its timeline (redacted on erase).
        after: { statusId: target.id, reason: input.reason, returnedConfirmed },
      });
      await deletePasscodeOnClose(tx, { shopId: actor.shopId, ticketId: id, deviceId: t.deviceId, settingOn: shop.deletePasscodeOnClose });
      await refreshCustomerCounters(tx, [t.customerId]);
      return ticketDetail(tx, id, shop, now);
    });
  }

  async reopen(actor: Actor, id: string, input: ReopenTicketInput, now = new Date()): Promise<TicketDetail> {
    return this.write(actor, async (tx) => {
      const shop = await loadShopInfo(tx);
      const initialId = input.statusId ? null : (await tx.ticketStatus.findFirst({ where: { systemRole: 'INITIAL' }, select: { id: true } }))?.id;
      const targetOf = (row: Ticket) => input.statusId ?? row.statusIdBeforeClose ?? initialId;
      // Lock order: target status → customer → ticket. Erase holds the customer while it rewrites the customer's
      // tickets, so taking the customer before the ticket is what keeps reopen and erase from deadlocking.
      const t = await this.lockTicketWrite(tx, id, (row) => ({ statuses: [targetOf(row)] }));
      const targetId = targetOf(t);
      const target = targetId ? await tx.ticketStatus.findFirst({ where: { id: targetId } }) : null;
      if (!target) throw notFound();
      // An erase that committed first: an erased customer cannot get an open ticket back.
      const owner = await tx.customer.findFirst({ where: { id: t.customerId }, select: { erasedAt: true } });
      if (owner?.erasedAt) throw apiError('CUSTOMER_ERASED');
      const r = canTransition({ category: t.statusCategory as StatusCategory, id: t.statusId }, { ...target, category: target.category as StatusCategory }, {
        role: actor.role,
        via: 'reopen',
        closedAt: t.closedAt,
        now,
      });
      if (!r.ok) throw transitionError(r);
      const deleted = await tx.ticketEvent.count({ where: { ticketId: id, type: 'passcode_deleted', createdAt: { gte: t.closedAt ?? now } } });
      await tx.ticket.update({
        where: { id },
        data: {
          statusId: target.id,
          statusCategory: target.category,
          statusChangedAt: now,
          closedAt: null,
          statusIdBeforeClose: null,
          cancelReason: null,
          cancelNote: null,
          returnedConfirmed: false,
          reopenCount: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await this.event(tx, actor, id, {
        type: 'reopened',
        data: { fromStatusId: t.statusId, toStatusId: target.id, reason: input.reason, passcodeWasDeleted: deleted > 0 },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'ticket.reopened',
        entityId: id,
        before: { statusId: t.statusId },
        // A11-b: no free text in audit payloads; the reopen reason is on the timeline.
        after: { statusId: target.id },
      });
      await refreshCustomerCounters(tx, [t.customerId]);
      return ticketDetail(tx, id, shop, now);
    });
  }

  // ---------- Notes ----------

  async addNote(actor: Actor, id: string, input: CreateTicketNoteInput, now = new Date()): Promise<TicketNote> {
    return this.db(actor).tx(async (tx) => {
      const t = await tx.ticket.findFirst({ where: { id }, select: { id: true } });
      if (!t) throw notFound();
      const note = await tx.ticketNote.create({
        data: { shopId: actor.shopId, ticketId: id, authorUserId: actor.userId, body: input.body, visibility: input.visibility ?? 'INTERNAL', createdAt: now },
      });
      await this.event(tx, actor, id, { type: 'note_added', data: {}, noteId: note.id });
      const users = await userRefs(tx, [actor.userId]);
      return toNoteDto(note, users.get(actor.userId)!, actor.userId, now);
    });
  }

  async editNote(actor: Actor, id: string, noteId: string, input: UpdateTicketNoteInput, now = new Date()): Promise<TicketNote> {
    return this.db(actor).tx(async (tx) => {
      const note = await tx.ticketNote.findFirst({ where: { id: noteId, ticketId: id } });
      if (!note) throw notFound();
      if (note.authorUserId !== actor.userId) throw forbidden('You can edit only your own notes');
      if (!canEditNote(note, actor.userId, now)) throw apiError('NOTE_EDIT_WINDOW_PASSED');
      const updated = await tx.ticketNote.update({ where: { id: noteId }, data: { body: input.body, editedAt: now } });
      await this.event(tx, actor, id, { type: 'note_edited', data: {}, noteId });
      const users = await userRefs(tx, [actor.userId]);
      return toNoteDto(updated, users.get(actor.userId)!, actor.userId, now);
    });
  }

  // ---------- Passcode reveal (DV4, A15) ----------

  /**
   * Decrypts the passcode of the ticket's device. Open tickets only; 30 reveals per user per hour, counted from the
   * audit log (so the limit survives restarts) under a per-user advisory lock; audited; never logged.
   */
  async revealPasscode(actor: Actor, ticketId: string, now = new Date()): Promise<PasscodeReveal> {
    const result = await this.db(actor).tx(async (tx) => {
      // L4: a close holds the ticket FOR NO KEY UPDATE until it commits; FOR SHARE waits for it, and the read below (a new
      // statement) then sees the ticket closed. A close that starts after us waits until this reveal commits.
      // Lock order: ticket (FOR SHARE) → device (the view counter update).
      await lockTickets(tx, [ticketId], 'share');
      const t = await tx.ticket.findFirst({ where: { id: ticketId }, select: { id: true, statusCategory: true, deviceId: true } });
      if (!t) throw notFound();
      if (t.statusCategory === 'CLOSED') throw apiError('PASSCODE_NOT_AVAILABLE');
      const d = await tx.device.findFirst({
        where: { id: t.deviceId },
        select: { id: true, lockType: true, passcodeCiphertext: true, passcodeIv: true, passcodeTag: true, passcodeKeyVersion: true, passcodeViewCount: true },
      });
      const encrypted = d ? passcodeFromRow(d) : null;
      if (!d || !encrypted || !['PIN', 'PASSWORD', 'PATTERN'].includes(d.lockType)) throw notFound('No passcode on file');

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`passcode-reveal:${actor.shopId}:${actor.userId}`}, 0))`;
      const recent = await tx.auditLog.count({
        where: { actorUserId: actor.userId, action: 'device.passcode_viewed', createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
      });
      if (recent >= PASSCODE_REVEALS_PER_HOUR) throw new ApiException(429, 'RATE_LIMITED', 'Too many passcode views. Try again later.');

      let plain: string;
      try {
        if (!this.config.fieldEncryption) throw new FieldDecryptError('No FIELD_ENCRYPTION_KEY');
        plain = decryptField(this.config.fieldEncryption, encrypted, passcodeAad(actor.shopId, d.id));
      } catch (err) {
        if (err instanceof FieldDecryptError) return { unreadable: true as const, deviceId: d.id };
        throw err;
      }
      const pattern = d.lockType === 'PATTERN' ? parsePattern(plain) : null;
      if (d.lockType === 'PATTERN' && !pattern) return { unreadable: true as const, deviceId: d.id };
      const updated = await tx.device.update({
        where: { id: d.id },
        data: { passcodeViewCount: { increment: 1 }, passcodeLastViewedAt: now, passcodeLastViewedByUserId: actor.userId },
        select: { passcodeViewCount: true },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'device.passcode_viewed',
        entityId: d.id,
        after: { deviceId: d.id, ticketId },
      });
      const common = { viewCount: updated.passcodeViewCount, revealedAt: now.toISOString() };
      if (pattern) return { reveal: { lockType: 'PATTERN' as const, pattern, ...common } };
      return { reveal: { lockType: d.lockType as 'PIN' | 'PASSWORD', value: plain, ...common } };
    });
    if ('unreadable' in result) {
      this.logger.error(`Passcode for device ${result.deviceId} could not be decrypted (wrong key or tampered value)`);
      throw apiError('PASSCODE_UNREADABLE');
    }
    return result.reveal;
  }
}
