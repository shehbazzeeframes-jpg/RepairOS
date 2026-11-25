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
import { decryptField, FieldDecryptError, nextTicketNumber, passcodeAad, passcodeFromRow, type ScopedTx, type TicketEventDataByType } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { writeAudit } from '../common/audit';
import { ApiException, apiError, forbidden, notFound, validationFailed } from '../common/errors';
import { ZodValidationPipe } from '../common/zod';
import { CONFIG, type AppConfig } from '../config';
import { insertCustomer } from '../customers/customer-write';
import { insertDevice, setDevicePasscode } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { deletePasscodeOfReleasedDevice, deletePasscodeOnClose, lockDevice } from '../repair/passcode';
import { loadShopInfo, lockCustomers, refreshCustomerCounters, type ShopInfo, ticketDetail, userRefs } from '../repair/read';
import { toNoteDto } from './ticket-query.service';

/** Output of contracts `UpdateTicketInput` (the controller validates with it). */
export type UpdateTicketData = ReturnType<typeof UpdateTicketInput.parse>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function transitionError(r: Extract<TransitionResult, { ok: false }>): ApiException {
  if (r.code === 'FORBIDDEN') return forbidden(API_ERROR_MESSAGES.FORBIDDEN);
  return apiError(r.code, undefined, r.message);
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

  /** Row-locks the ticket (status/assign guards re-check the current state inside the transaction). */
  private async lockedTicket(tx: ScopedTx, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "tickets" WHERE "id" = ${id} AND "shopId" = app_current_shop_id() FOR UPDATE`;
    const t = await tx.ticket.findFirst({ where: { id } });
    if (!t) throw notFound();
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
    return this.db(actor).tx(async (tx) => {
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

      // Customer
      let customerId: string;
      if (input.newCustomer) {
        customerId = await insertCustomer(tx, actor.shopId, actor.userId, input.newCustomer);
      } else {
        customerId = input.customerId!;
        await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${customerId} AND "shopId" = app_current_shop_id() FOR UPDATE`;
        const c = await tx.customer.findFirst({ where: { id: customerId }, select: { erasedAt: true, archivedAt: true } });
        if (!c) throw notFound();
        if (c.erasedAt) throw apiError('CUSTOMER_ERASED');
        if (c.archivedAt) throw apiError('CUSTOMER_ARCHIVED');
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
      if (input.warrantyOfTicketId) {
        const original = await tx.ticket.findFirst({
          where: { id: input.warrantyOfTicketId },
          select: { id: true, warrantyOfTicketId: true, status: { select: { systemRole: true } } },
        });
        if (!original) throw notFound();
        if (original.status.systemRole !== 'COLLECTED') throw apiError('WARRANTY_NOT_ALLOWED');
        warrantyRoot = original.warrantyOfTicketId ?? original.id;
      }

      const initial = await tx.ticketStatus.findFirst({ where: { systemRole: 'INITIAL' } });
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
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const t = await this.lockedTicket(tx, id);
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
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const t = await this.lockedTicket(tx, id);
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
        await lockCustomers(tx, [t.customerId]); // lock order: ticket → customer → device
        await deletePasscodeOnClose(tx, { shopId: actor.shopId, ticketId: id, deviceId: t.deviceId, settingOn: shop.deletePasscodeOnClose });
        await refreshCustomerCounters(tx, [t.customerId]);
      }
      return ticketDetail(tx, id, shop, now);
    });
  }

  async assign(actor: Actor, id: string, input: AssignTicketInput, now = new Date()): Promise<TicketDetail> {
    return this.db(actor).tx(async (tx) => {
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
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const t = await this.lockedTicket(tx, id);
      const target = input.statusId
        ? await tx.ticketStatus.findFirst({ where: { id: input.statusId } })
        : await tx.ticketStatus.findFirst({ where: { systemRole: 'CANCELLED' } });
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
        after: { statusId: target.id, reason: input.reason, note, returnedConfirmed },
      });
      await lockCustomers(tx, [t.customerId]); // lock order: ticket → customer → device
      await deletePasscodeOnClose(tx, { shopId: actor.shopId, ticketId: id, deviceId: t.deviceId, settingOn: shop.deletePasscodeOnClose });
      await refreshCustomerCounters(tx, [t.customerId]);
      return ticketDetail(tx, id, shop, now);
    });
  }

  async reopen(actor: Actor, id: string, input: ReopenTicketInput, now = new Date()): Promise<TicketDetail> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const t = await this.lockedTicket(tx, id);
      const targetId = input.statusId ?? t.statusIdBeforeClose;
      const target = targetId
        ? await tx.ticketStatus.findFirst({ where: { id: targetId } })
        : await tx.ticketStatus.findFirst({ where: { systemRole: 'INITIAL' } });
      if (!target) throw notFound();
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
        after: { statusId: target.id, reason: input.reason },
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
      // L4: a close holds the ticket FOR UPDATE until it commits; FOR SHARE waits for it, and the read below (a new
      // statement) then sees the ticket closed. A close that starts after us waits until this reveal commits.
      await tx.$queryRaw`SELECT "id" FROM "tickets" WHERE "id" = ${ticketId} AND "shopId" = app_current_shop_id() FOR SHARE`;
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
