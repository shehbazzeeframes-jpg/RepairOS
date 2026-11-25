import { Inject, Injectable } from '@nestjs/common';
import {
  type AppendConsentsInput,
  type ConsentChange,
  ConsentChangeInput,
  type ConsentHistoryResponse,
  createCustomerSchema,
  type CustomerDetail,
  type CustomerExport,
  customerExportFilename,
  type CustomerListQuery,
  type CustomerListResponse,
  customerRecordIssues,
  type CustomerTagsResponse,
  currentConsent,
  type DuplicateCheckQuery,
  type DuplicateCheckResponse,
  EmailAddress,
  type EraseCustomerResponse,
  effectiveConsentChanges,
  formatTicketNumber,
  LIST_TOTAL_CAP,
  NOTE_VISIBILITY_LABELS,
  normalizePhone,
  STALE_CUSTOMER_MESSAGE,
  updateCustomerSchema,
  customerDisplayName,
  type CustomerKind,
} from '@repairos/contracts';
import { eraseCustomer, EraseCustomerError, Prisma, type ScopedTx, customerSearchSql } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { writeAudit } from '../common/audit';
import { decodeKeyset, encodeKeyset } from '../common/cursor';
import { ApiException, apiError, notFound, validationFailed } from '../common/errors';
import { localDateOf, localRange } from '../common/time';
import { ZodValidationPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { customerDetail, loadShopInfo, nameRef, primaryPhones, userRefs } from '../repair/read';
import { appendConsentEvents, consentColumns, insertCustomer, insertPhones } from './customer-write';

interface ListRow {
  id: string;
  kind: CustomerKind;
  displayName: string;
  businessContactName: string | null;
  email: string | null;
  tags: string[];
  openTicketCount: number;
  lastVisitAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Customers (story §1). Erased customers are 404 on every route and never listed. */
@Injectable()
export class CustomersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  // ---------- Reads ----------

  async list(actor: Actor, q: CustomerListQuery): Promise<CustomerListResponse> {
    const kinds =
      q.sort === 'name' ? (['string', 'string'] as const) : q.sort === 'last_visit' ? (['date?', 'string'] as const) : (['date', 'string'] as const);
    const cursor = decodeKeyset(q.cursor, kinds);
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const where: Prisma.Sql[] = [Prisma.sql`c."shopId" = ${actor.shopId}`, Prisma.sql`c."erasedAt" IS NULL`];
      if (!q.archived) where.push(Prisma.sql`c."archivedAt" IS NULL`);
      if (q.type) where.push(Prisma.sql`c."kind" = ${q.type}::"CustomerKind"`);
      if (q.tags?.length) {
        const tags = q.tags.map((t) => t.toLowerCase());
        where.push(Prisma.sql`EXISTS (SELECT 1 FROM unnest(c."tags") AS tag WHERE lower(tag) = ANY(${tags}::text[]))`);
      }
      if (q.hasOpen === true) where.push(Prisma.sql`c."openTicketCount" > 0`);
      if (q.hasOpen === false) where.push(Prisma.sql`c."openTicketCount" = 0`);
      for (const ch of q.consent ?? []) {
        if (ch === 'SMS') where.push(Prisma.sql`c."marketingSmsAt" IS NOT NULL`);
        if (ch === 'EMAIL') where.push(Prisma.sql`c."marketingEmailAt" IS NOT NULL`);
        if (ch === 'WHATSAPP') where.push(Prisma.sql`c."marketingWhatsappAt" IS NOT NULL`);
      }
      if (q.createdFrom || q.createdTo) {
        const { start, end } = localRange(q.createdFrom ?? '2000-01-01', q.createdTo ?? '2999-12-31', shop.timezone);
        where.push(Prisma.sql`c."createdAt" >= ${start} AND c."createdAt" < ${end}`);
      }
      const join = q.q
        ? Prisma.sql`JOIN (${customerSearchSql({ q: q.q, phoneE164: normalizePhone(q.q, shop.country), includeArchived: q.archived })}) h ON h."id" = c."id"`
        : Prisma.empty;
      const filter = Prisma.join(where, ' AND ');

      let order: Prisma.Sql;
      let after: Prisma.Sql = Prisma.empty;
      if (q.sort === 'name') {
        order = Prisma.sql`c."displayName", c."id"`;
        if (cursor) after = Prisma.sql`AND (c."displayName", c."id") > (${cursor[0] as string}, ${cursor[1] as string})`;
      } else if (q.sort === 'last_visit') {
        order = Prisma.sql`c."lastVisitAt" DESC NULLS LAST, c."id"`;
        if (cursor) {
          const [at, id] = cursor as [Date | null, string];
          after = at
            ? Prisma.sql`AND (c."lastVisitAt" < ${at} OR (c."lastVisitAt" = ${at} AND c."id" > ${id}) OR c."lastVisitAt" IS NULL)`
            : Prisma.sql`AND c."lastVisitAt" IS NULL AND c."id" > ${id}`;
        }
      } else {
        order = Prisma.sql`c."createdAt" DESC, c."id"`;
        if (cursor) {
          const [at, id] = cursor as [Date, string];
          after = Prisma.sql`AND (c."createdAt" < ${at} OR (c."createdAt" = ${at} AND c."id" > ${id}))`;
        }
      }

      const rows = await tx.$queryRaw<ListRow[]>`
        SELECT c."id", c."kind", c."displayName", c."businessContactName", c."email", c."tags", c."openTicketCount",
               c."lastVisitAt", c."createdAt", c."archivedAt"
        FROM "customers" c ${join}
        WHERE ${filter} ${after}
        ORDER BY ${order}
        LIMIT ${q.limit + 1}`;
      const [count] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (SELECT 1 FROM "customers" c ${join} WHERE ${filter} LIMIT ${LIST_TOTAL_CAP + 1}) x`;
      const page = rows.slice(0, q.limit);
      const phones = await primaryPhones(
        tx,
        page.map((r) => r.id),
      );
      const last = page[page.length - 1];
      const total = count?.n ?? 0;
      return {
        items: page.map((r) => ({
          id: r.id,
          kind: r.kind,
          displayName: r.displayName,
          businessContactName: r.businessContactName,
          primaryPhone: phones.get(r.id) ?? null,
          email: r.email,
          tags: r.tags,
          openTicketCount: r.openTicketCount,
          lastVisitAt: iso(r.lastVisitAt),
          createdAt: r.createdAt.toISOString(),
          archivedAt: iso(r.archivedAt),
        })),
        nextCursor:
          rows.length > q.limit && last
            ? encodeKeyset(
                q.sort === 'name'
                  ? [last.displayName, last.id]
                  : q.sort === 'last_visit'
                    ? [iso(last.lastVisitAt), last.id]
                    : [last.createdAt.toISOString(), last.id],
              )
            : null,
        total: Math.min(total, LIST_TOTAL_CAP),
        totalCapped: total > LIST_TOTAL_CAP,
      };
    });
  }

  async detail(actor: Actor, id: string): Promise<CustomerDetail> {
    return this.db(actor).tx((tx) => customerDetail(tx, id));
  }

  async duplicates(actor: Actor, q: DuplicateCheckQuery): Promise<DuplicateCheckResponse> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const e164 = q.phone ? normalizePhone(q.phone, shop.country) : null;
      const emailParsed = q.email ? EmailAddress.safeParse(q.email) : null;
      const email = emailParsed?.success ? emailParsed.data : null;
      if (!e164 && !email) return { items: [], more: 0 };
      const or: Prisma.CustomerWhereInput[] = [];
      if (e164) or.push({ phones: { some: { e164 } } });
      if (email) or.push({ email });
      const where: Prisma.CustomerWhereInput = { erasedAt: null, OR: or, ...(q.excludeId ? { id: { not: q.excludeId } } : {}) };
      const [rows, total] = await Promise.all([
        tx.customer.findMany({
          where,
          orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }],
          take: 3,
          include: { phones: { select: { e164: true, isPrimary: true } } },
        }),
        tx.customer.count({ where }),
      ]);
      return {
        items: rows.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          primaryPhone: c.phones.find((p) => p.isPrimary)?.e164 ?? null,
          email: c.email,
          lastVisitAt: iso(c.lastVisitAt),
          openTicketCount: c.openTicketCount,
          archived: c.archivedAt !== null,
          matchedOn: [
            ...(e164 && c.phones.some((p) => p.e164 === e164) ? (['phone'] as const) : []),
            ...(email && c.email === email ? (['email'] as const) : []),
          ],
        })),
        more: Math.max(0, total - rows.length),
      };
    });
  }

  async tags(actor: Actor, q: string | undefined): Promise<CustomerTagsResponse> {
    return this.db(actor).tx(async (tx) => {
      const filter = q ? Prisma.sql`AND lower(tag) LIKE '%' || app_like_escape(lower(${q})) || '%'` : Prisma.empty;
      const rows = await tx.$queryRaw<{ tag: string }[]>`
        SELECT min(tag) AS tag FROM "customers" c, unnest(c."tags") AS tag
        WHERE c."shopId" = ${actor.shopId} AND c."erasedAt" IS NULL ${filter}
        GROUP BY lower(tag) ORDER BY count(*) DESC, lower(tag) LIMIT 50`;
      return { tags: rows.map((r) => r.tag) };
    });
  }

  async consentHistory(actor: Actor, id: string): Promise<ConsentHistoryResponse> {
    return this.db(actor).tx(async (tx) => {
      await this.liveCustomer(tx, id);
      const events = await tx.customerConsentEvent.findMany({ where: { customerId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const users = await userRefs(
        tx,
        events.map((e) => e.recordedByUserId),
      );
      return {
        items: events.map((e) => ({
          id: e.id,
          channel: e.channel,
          purpose: e.purpose,
          state: e.state,
          source: e.source,
          note: e.note,
          recordedBy: nameRef(users.get(e.recordedByUserId ?? '')),
          createdAt: e.createdAt.toISOString(),
        })),
      };
    });
  }

  // ---------- Writes ----------

  async create(actor: Actor, body: unknown): Promise<CustomerDetail> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const data = new ZodValidationPipe(createCustomerSchema(shop.country)).transform(body ?? {});
      const id = await insertCustomer(tx, actor.shopId, actor.userId, data);
      return customerDetail(tx, id);
    });
  }

  async update(actor: Actor, id: string, body: unknown): Promise<CustomerDetail> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const input = new ZodValidationPipe(updateCustomerSchema(shop.country)).transform(body ?? {});
      const c = await this.liveCustomer(tx, id, true);
      if (c.version !== input.version) throw new ApiException(409, 'STALE_RECORD', STALE_CUSTOMER_MESSAGE);
      const existingPhones = await tx.customerPhone.findMany({ where: { customerId: id } });

      const pick = <K extends keyof typeof c>(k: K, v: (typeof c)[K] | undefined) => (v === undefined ? c[k] : v);
      const kind = input.kind ?? c.kind;
      const merged = {
        kind,
        firstName: kind === 'PERSON' ? pick('firstName', input.firstName) : null,
        lastName: kind === 'PERSON' ? pick('lastName', input.lastName) : null,
        businessName: kind === 'BUSINESS' ? pick('businessName', input.businessName) : null,
        businessContactName: kind === 'BUSINESS' ? pick('businessContactName', input.businessContactName) : null,
        email: pick('email', input.email),
        addressLine1: pick('addressLine1', input.addressLine1),
        addressLine2: pick('addressLine2', input.addressLine2),
        city: pick('city', input.city),
        region: pick('region', input.region),
        postcode: pick('postcode', input.postcode),
        notes: pick('notes', input.notes),
        tags: input.tags ?? c.tags,
        preferredChannel: input.preferredChannel ?? c.preferredChannel ?? 'SMS',
        serviceOptOutSms: input.serviceOptOutSms ?? c.serviceOptOutSms,
        serviceOptOutEmail: input.serviceOptOutEmail ?? c.serviceOptOutEmail,
        serviceOptOutWhatsapp: input.serviceOptOutWhatsapp ?? c.serviceOptOutWhatsapp,
      };
      const phones = input.phones ?? existingPhones;
      const issues = customerRecordIssues({ ...merged, phones });
      if (issues.length) throw validationFailed(issues);

      if (input.phones) {
        const known = new Set(existingPhones.map((p) => p.id));
        const unknown = input.phones.findIndex((p) => p.id && !known.has(p.id));
        if (unknown >= 0) throw validationFailed([{ path: ['phones', unknown, 'id'], message: 'Unknown phone' }]);
        // Replace the list in one go (rows with an id keep it), so the unique/partial-unique indexes never see
        // an intermediate state (two primaries, a number moving between rows).
        await tx.customerPhone.deleteMany({ where: { customerId: id } });
        await insertPhones(tx, actor.shopId, id, input.phones);
      }

      let consentData = {};
      if (input.consents?.length) {
        const changes = await this.effectiveChanges(tx, id, input.consents as ConsentChange[]);
        const at = new Date();
        await appendConsentEvents(tx, actor.shopId, id, actor.userId, changes, at);
        consentData = consentColumns(changes, at);
      }

      const updated = await tx.customer.updateMany({
        where: { id, version: input.version },
        data: { ...merged, displayName: customerDisplayName(merged), version: { increment: 1 }, ...consentData },
      });
      if (updated.count !== 1) throw new ApiException(409, 'STALE_RECORD', STALE_CUSTOMER_MESSAGE);
      return customerDetail(tx, id);
    });
  }

  async appendConsents(actor: Actor, id: string, input: AppendConsentsInput): Promise<CustomerDetail> {
    return this.db(actor).tx(async (tx) => {
      await this.liveCustomer(tx, id, true);
      const parsed = input.changes.map((c) => ConsentChangeInput.parse(c));
      const changes = await this.effectiveChanges(tx, id, parsed);
      if (changes.length) {
        const at = new Date();
        await appendConsentEvents(tx, actor.shopId, id, actor.userId, changes, at);
        await tx.customer.update({ where: { id }, data: consentColumns(changes, at) });
      }
      return customerDetail(tx, id);
    });
  }

  async archive(actor: Actor, id: string): Promise<CustomerDetail> {
    return this.db(actor).tx(async (tx) => {
      const c = await this.liveCustomer(tx, id, true);
      if (c.archivedAt) return customerDetail(tx, id);
      const open = await tx.ticket.count({ where: { customerId: id, statusCategory: { not: 'CLOSED' } } });
      if (open > 0) throw apiError('CUSTOMER_HAS_OPEN_TICKETS', { n: String(open) });
      const archivedAt = new Date();
      await tx.customer.update({ where: { id }, data: { archivedAt } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'customer.archived',
        entityId: id,
        before: { archivedAt: null },
        after: { archivedAt: archivedAt.toISOString() },
      });
      return customerDetail(tx, id);
    });
  }

  async restore(actor: Actor, id: string): Promise<CustomerDetail> {
    return this.db(actor).tx(async (tx) => {
      const c = await this.liveCustomer(tx, id, true);
      if (!c.archivedAt) return customerDetail(tx, id);
      await tx.customer.update({ where: { id }, data: { archivedAt: null } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'customer.restored',
        entityId: id,
        before: { archivedAt: c.archivedAt.toISOString() },
        after: { archivedAt: null },
      });
      return customerDetail(tx, id);
    });
  }

  /** GDPR export (CU8): no passcodes, only CUSTOMER-visible notes. Audits counts only. */
  async export(actor: Actor, id: string): Promise<{ filename: string; body: CustomerExport }> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const detail = await customerDetail(tx, id);
      const [events, devices, tickets] = await Promise.all([
        tx.customerConsentEvent.findMany({ where: { customerId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        tx.device.findMany({
          where: { customerId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, type: true, brand: true, model: true, colour: true, imei: true, serial: true, notes: true, passcodeKeyVersion: true, createdAt: true },
        }),
        tx.ticket.findMany({
          where: { customerId: id },
          orderBy: [{ number: 'asc' }],
          include: {
            issues: { orderBy: { position: 'asc' } },
            checklistItems: true,
            accessories: true,
            notes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, // A11-c: every note, labelled below
            events: { where: { type: { in: ['created', 'status_changed', 'cancelled', 'reopened'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          },
        }),
      ]);
      const statuses = new Map((await tx.ticketStatus.findMany()).map((s) => [s.id, s.name]));
      const users = await userRefs(
        tx,
        events.map((e) => e.recordedByUserId),
      );
      const { version: _v, consent: _c, ...customer } = detail;
      const statusOfEvent = (data: unknown): string | undefined => {
        const d = (data ?? {}) as Record<string, unknown>;
        const sid = (d.toStatusId ?? d.statusId) as string | undefined;
        return sid ? statuses.get(sid) : undefined;
      };
      const body: CustomerExport = {
        exportedAt: new Date().toISOString(),
        shop: { name: shop.name },
        customer,
        consentHistory: events.map((e) => ({
          id: e.id,
          channel: e.channel,
          purpose: e.purpose,
          state: e.state,
          source: e.source,
          note: e.note,
          recordedBy: nameRef(users.get(e.recordedByUserId ?? '')),
          createdAt: e.createdAt.toISOString(),
        })),
        devices: devices.map((d) => ({
          id: d.id,
          type: d.type,
          brand: d.brand,
          model: d.model,
          colour: d.colour,
          imei: d.imei,
          serial: d.serial,
          notes: d.notes,
          passcodeOnFile: d.passcodeKeyVersion !== null,
          createdAt: d.createdAt.toISOString(),
        })),
        tickets: tickets.map((t) => ({
          number: formatTicketNumber(shop.prefix, t.number),
          deviceId: t.deviceId,
          createdAt: t.createdAt.toISOString(),
          closedAt: iso(t.closedAt),
          status: statuses.get(t.statusId) ?? '',
          statusHistory: t.events
            .map((e) => ({ status: statusOfEvent(e.data), at: e.createdAt.toISOString() }))
            .filter((s): s is { status: string; at: string } => !!s.status),
          issues: t.issues.map((i) => i.label),
          description: t.description,
          checklist: Object.fromEntries(t.checklistItems.map((c) => [c.itemKey, c.result])),
          accessories: t.accessories.map((a) => a.code),
          estimate: t.estimateMinor === null ? null : { amountMinor: t.estimateMinor, currency: t.currency },
          customerVisibleNotes: t.notes.filter((n) => n.visibility === 'CUSTOMER').map((n) => ({ body: n.body, createdAt: n.createdAt.toISOString() })),
          notes: t.notes.map((n) => ({
            body: n.body,
            visibility: n.visibility,
            visibilityLabel: NOTE_VISIBILITY_LABELS[n.visibility],
            createdAt: n.createdAt.toISOString(),
            editedAt: iso(n.editedAt),
          })),
          conditionNotes: t.conditionNotes,
          accessoriesOther: t.accessoriesOther,
          cancelReason: t.cancelReason,
          cancelNote: t.cancelNote,
        })),
      };
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'customer.exported',
        entityId: id,
        after: { phones: detail.phones.length, devices: devices.length, tickets: tickets.length, consentEvents: events.length },
      });
      return { filename: customerExportFilename(id, localDateOf(new Date(), shop.timezone)), body };
    });
  }

  /** CU9 erase, through the data layer's app_erase_customer. Audits counts only. */
  async erase(actor: Actor, id: string): Promise<EraseCustomerResponse> {
    return this.db(actor).tx(async (tx) => {
      await this.liveCustomer(tx, id);
      let counts;
      try {
        counts = await eraseCustomer(tx, id);
      } catch (err) {
        if (err instanceof EraseCustomerError) {
          if (err.code === 'CUSTOMER_HAS_OPEN_TICKETS') throw apiError('CUSTOMER_HAS_OPEN_TICKETS', { n: String(err.openTickets ?? '') });
          throw notFound();
        }
        throw err;
      }
      const notesKept = await tx.ticketNote.count({ where: { ticket: { customerId: id } } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'customer.erased',
        entityId: id,
        after: { phones: counts.phones, devices: counts.devices, tickets: counts.tickets, consentEvents: counts.consentEvents, notesKept },
      });
      const c = await tx.customer.findFirstOrThrow({ where: { id }, select: { erasedAt: true } });
      return {
        id,
        erasedAt: c.erasedAt!.toISOString(),
        counts: { phones: counts.phones, devices: counts.devices, tickets: counts.tickets, consentEvents: counts.consentEvents },
      };
    });
  }

  // ---------- Helpers ----------

  /** The customer, unless missing or erased (404). `lock` takes the row lock (archive/erase/check-in race). */
  private async liveCustomer(tx: ScopedTx, id: string, lock = false) {
    if (lock) await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "id" = ${id} AND "shopId" = app_current_shop_id() FOR UPDATE`;
    const c = await tx.customer.findFirst({ where: { id } });
    if (!c || c.erasedAt) throw notFound();
    return c;
  }

  private async effectiveChanges(tx: ScopedTx, id: string, changes: ConsentChange[]): Promise<ConsentChange[]> {
    const events = await tx.customerConsentEvent.findMany({ where: { customerId: id } });
    const current = currentConsent(
      events.map((e) => ({ channel: e.channel, state: e.state, source: e.source, createdAt: e.createdAt.toISOString(), recordedBy: null })),
    );
    return effectiveConsentChanges(current, changes);
  }
}
