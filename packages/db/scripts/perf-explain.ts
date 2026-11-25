/**
 * EXPLAIN ANALYZE of the Sprint 2 list and search queries on the perf dataset (`pnpm db:seed:perf` first).
 * Runs as the APP role (APP_DATABASE_URL) inside a transaction with app.shop_id set, i.e. with RLS exactly as the
 * API runs. The SECURITY DEFINER search functions hide their inner plans, so their inner queries are also explained
 * as the table owner (DATABASE_URL), which is what the functions run as.
 *
 *   pnpm --filter @repairos/db perf:explain > plans.md
 *
 * Prints a markdown summary (median of 7 runs after a warm-up) and every plan.
 */
import { PrismaClient } from '@prisma/client';
import { customerSearchSql, deviceSearchSql, ticketSearchSql } from '../src/search';

const SHOP = 'perf_shop_main';
const RUNS = 7;

interface Case {
  name: string;
  sql: string;
  params?: unknown[];
  /** Run as the table owner (definer-function internals) instead of the app role. */
  owner?: boolean;
}

/** Inlines a Prisma.Sql into ($n placeholders, values) for EXPLAIN. */
function fromPrismaSql(s: { text: string; values: unknown[] }): { sql: string; params: unknown[] } {
  return { sql: s.text, params: s.values };
}

async function main() {
  const app = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const sample = await owner.$queryRawUnsafe<{ number: number; imei: string; e164: string; first: string; last: string }[]>(
      `SELECT t.number, d.imei, p.e164, c."firstName" AS first, split_part(c."lastName", ' ', 1) AS last
       FROM tickets t JOIN devices d ON d.id = t."deviceId" JOIN customers c ON c.id = t."customerId"
       JOIN customer_phones p ON p."customerId" = c.id AND p."isPrimary"
       WHERE t."shopId" = $1 AND d.imei IS NOT NULL AND c."lastName" IS NOT NULL AND t."statusCategory" = 'OPEN' LIMIT 1`,
      SHOP,
    );
    const s = sample[0];
    if (!s) throw new Error('No perf data: run `pnpm db:seed:perf` first');
    const ticketSearch = (q: string, n: number | null, e164: string | null = null) =>
      fromPrismaSql(ticketSearchSql({ shopId: SHOP, q, ticketNumber: n, phoneE164: e164 }));
    const custSearch = (q: string, e164: string | null = null, limit: number | null = null) =>
      fromPrismaSql(customerSearchSql({ q, phoneE164: e164, limit }));
    const listCols = `t.id, t.number, t."statusId", t.priority, t."dueAt", t."assigneeUserId", t."customerId", t."deviceId"`;
    const open = `('OPEN','WAITING','READY')`;

    const cs = (name: string, q: string, e164: string | null = null): Case[] => {
      const h = custSearch(q, e164);
      return [
        {
          name: `Customer list search "${name}" (page)`,
          sql: `SELECT c.id, c."displayName", c.email, c."openTicketCount" FROM customers c JOIN (${h.sql}) h ON h.id = c.id
                WHERE c."shopId" = $${h.params.length + 1} ORDER BY h.score DESC, c."displayName", c.id LIMIT 25`,
          params: [...h.params, SHOP],
        },
        {
          name: `Customer list search "${name}" (total)`,
          sql: `SELECT count(*) FROM customers c JOIN (${h.sql}) h ON h.id = c.id WHERE c."shopId" = $${h.params.length + 1}`,
          params: [...h.params, SHOP],
        },
      ];
    };

    const ts = (name: string, q: string, n: number | null, e164: string | null = null): Case => {
      const h = ticketSearch(q, n, e164);
      return {
        name: `Ticket list search "${name}" in All open`,
        sql: `SELECT ${listCols} FROM tickets t JOIN (${h.sql}) h ON h.id = t.id
              WHERE t."shopId" = $${h.params.length + 1} AND t."statusCategory" IN ${open}
              ORDER BY h.score DESC, t.priority DESC, t."dueAt", t.number LIMIT 25`,
        params: [...h.params, SHOP],
      };
    };

    const gsC = custSearch(`${s.first} ${s.last}`, null, 5);
    const gsD = fromPrismaSql(deviceSearchSql(s.imei.slice(-6), 5));
    const gsT = ticketSearch(s.imei.slice(-6), null);

    const cases: Case[] = [
      {
        name: 'Customer list, default sort (Name A-Z), page 1',
        sql: `SELECT id, "displayName", email, "openTicketCount", "lastVisitAt" FROM customers
              WHERE "shopId" = $1 AND "archivedAt" IS NULL ORDER BY "displayName", id LIMIT 25`,
        params: [SHOP],
      },
      {
        name: 'Customer list, keyset page ~1000',
        sql: `SELECT id, "displayName" FROM customers WHERE "shopId" = $1 AND "archivedAt" IS NULL
                AND ("displayName", id) > ('Maria Garcia', 'perf_c_25000') ORDER BY "displayName", id LIMIT 25`,
        params: [SHOP],
      },
      { name: 'Customer list total (no filter, exact)', sql: `SELECT count(*) FROM customers WHERE "shopId" = $1 AND "archivedAt" IS NULL`, params: [SHOP] },
      {
        name: 'Customer list total (no filter, capped at 10,000)',
        sql: `SELECT count(*) FROM (SELECT 1 FROM customers WHERE "shopId" = $1 AND "archivedAt" IS NULL LIMIT 10001) x`,
        params: [SHOP],
      },
      {
        name: 'Customer list, sort Last visit',
        sql: `SELECT id, "displayName" FROM customers WHERE "shopId" = $1 AND "archivedAt" IS NULL
              ORDER BY "lastVisitAt" DESC NULLS LAST, id LIMIT 25`,
        params: [SHOP],
      },
      ...cs('first last (any order)', `${s.last} ${s.first}`),
      ...cs('phone, full number', s.e164, s.e164),
      ...cs('phone, last 4 digits', s.e164.slice(-4)),
      ...cs('IMEI, last 6', s.imei.slice(-6)),
      ...cs('email fragment', 'maria.12'),
      ...cs('2 letters (word start)', 'ma'),
      ...cs('3 letters (contains)', 'mar'),
      {
        name: 'Duplicate check (phone exact, incl. archived)',
        sql: `SELECT DISTINCT c.id FROM customer_phones p JOIN customers c ON c.id = p."customerId"
              WHERE p."shopId" = $1 AND p.e164 = $2 AND c."erasedAt" IS NULL LIMIT 4`,
        params: [SHOP, s.e164],
      },
      {
        name: 'Tickets: All open (urgent first, due soonest)',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" IN ${open}
              ORDER BY t.priority DESC, t."dueAt", t.number LIMIT 25`,
        params: [SHOP],
      },
      { name: 'Tickets: All open total', sql: `SELECT count(*) FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" IN ${open}`, params: [SHOP] },
      {
        name: 'Tickets: Mine',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 AND t."assigneeUserId" = $2 AND t."statusCategory" IN ${open}
              ORDER BY t.priority DESC, t."dueAt", t.number LIMIT 25`,
        params: [SHOP, 'perf_user_tech1'],
      },
      {
        name: 'Tickets: Overdue',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" IN ('OPEN','WAITING') AND t."dueAt" < now()
              ORDER BY t.priority DESC, t."dueAt", t.number LIMIT 25`,
        params: [SHOP],
      },
      {
        name: 'Tickets: Ready for pickup',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" = 'READY'
              ORDER BY t.priority DESC, t."dueAt", t.number LIMIT 25`,
        params: [SHOP],
      },
      {
        name: 'Tickets: Closed (closed date newest)',
        sql: `SELECT ${listCols}, t."closedAt" FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" = 'CLOSED'
              ORDER BY t."closedAt" DESC, t.id LIMIT 25`,
        params: [SHOP],
      },
      { name: 'Tickets: Closed total (exact)', sql: `SELECT count(*) FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" = 'CLOSED'`, params: [SHOP] },
      {
        name: 'Tickets: Closed total (capped at 10,000)',
        sql: `SELECT count(*) FROM (SELECT 1 FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" = 'CLOSED' LIMIT 10001) x`,
        params: [SHOP],
      },
      {
        name: 'Tickets: All, Created (newest)',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 ORDER BY t."createdAt" DESC, t.id LIMIT 25`,
        params: [SHOP],
      },
      {
        name: 'Ticket counts (dashboard tiles, one query)',
        sql: `SELECT count(*) FILTER (WHERE t."statusCategory" IN ('OPEN','WAITING','READY')) AS open,
                     count(*) FILTER (WHERE t."assigneeUserId" = $2) AS mine,
                     count(*) FILTER (WHERE t."statusCategory" IN ('OPEN','WAITING')
                                        AND (t."assigneeUserId" IS NULL OR NOT EXISTS (
                                          SELECT 1 FROM memberships m WHERE m."shopId" = t."shopId" AND m."userId" = t."assigneeUserId" AND m.status = 'ACTIVE'))) AS unassigned,
                     count(*) FILTER (WHERE t."statusCategory" = 'READY') AS ready,
                     count(*) FILTER (WHERE t."statusCategory" IN ('OPEN','WAITING') AND t."dueAt" < now()) AS overdue,
                     count(*) FILTER (WHERE t."statusCategory" IN ('OPEN','WAITING') AND t."dueAt" >= date_trunc('day', now()) AND t."dueAt" < date_trunc('day', now()) + interval '1 day') AS due_today
              FROM tickets t WHERE t."shopId" = $1 AND t."statusCategory" IN ${open}`,
        params: [SHOP, 'perf_user_tech1'],
      },
      ts('ticket number', String(s.number), s.number),
      ts('customer name', `${s.first} ${s.last}`, null),
      ts('phone', s.e164, null, s.e164),
      ts('IMEI last 6', s.imei.slice(-6), null),
      {
        name: 'Global search: customers (limit 5)',
        sql: `SELECT c.id, c."displayName" FROM (${gsC.sql}) h JOIN customers c ON c.id = h.id WHERE c."shopId" = $${gsC.params.length + 1}`,
        params: [...gsC.params, SHOP],
      },
      { name: 'Global search: devices (limit 5)', sql: gsD.sql, params: gsD.params },
      {
        name: 'Global search: tickets (limit 5)',
        sql: `SELECT t.id FROM (${gsT.sql}) h JOIN tickets t ON t.id = h.id AND t."shopId" = $${gsT.params.length + 1}
              ORDER BY h.score DESC, t."createdAt" DESC LIMIT 5`,
        params: [...gsT.params, SHOP],
      },
      {
        name: 'Ticket timeline (50)',
        sql: `SELECT id, type, data, "createdAt" FROM ticket_events WHERE "shopId" = $1 AND "ticketId" = $2 ORDER BY "createdAt", id LIMIT 50`,
        params: [SHOP, 'perf_t_50000'],
      },
      {
        name: 'Customer tickets tab',
        sql: `SELECT ${listCols} FROM tickets t WHERE t."shopId" = $1 AND t."customerId" = $2 ORDER BY t."createdAt" DESC LIMIT 25`,
        params: [SHOP, 'perf_c_123'],
      },
      // ---- Inside the SECURITY DEFINER functions (owner role, as the function runs) ----
      {
        name: '[inside app_search_customers] name words (trigram)',
        sql: `SELECT c.id FROM customers c WHERE c."shopId" = $1 AND c."searchText" LIKE $2 AND c."searchText" LIKE ALL ($3::text[])`,
        params: [SHOP, `%${s.last.toLowerCase()}%`, [`%${s.last.toLowerCase()}%`, `%${s.first.toLowerCase()}%`]],
        owner: true,
      },
      {
        name: '[inside app_search_customers] phone digits substring (trigram)',
        sql: `SELECT p."customerId" FROM customer_phones p WHERE p."shopId" = $1 AND p.digits LIKE $2`,
        params: [SHOP, `%${s.e164.slice(-4)}%`],
        owner: true,
      },
      {
        name: '[inside app_search_devices] IMEI/serial substring (trigram)',
        sql: `SELECT d.id FROM devices d WHERE d."shopId" = $1 AND (d.imei LIKE $2 OR d.serial LIKE $2)`,
        params: [SHOP, `%${s.imei.slice(-6)}%`],
        owner: true,
      },
      {
        name: '[contrast] same name search as the APP role without the function (RLS blocks the index)',
        sql: `SELECT c.id FROM customers c WHERE c."shopId" = $1 AND c."searchText" LIKE $2 AND c."searchText" LIKE ALL ($3::text[])`,
        params: [SHOP, `%${s.last.toLowerCase()}%`, [`%${s.last.toLowerCase()}%`, `%${s.first.toLowerCase()}%`]],
      },
    ];

    const results: { name: string; median: number; max: number; plan: string }[] = [];
    for (const c of cases) {
      const client = c.owner ? owner : app;
      const times: number[] = [];
      let plan = '';
      for (let i = 0; i <= RUNS; i++) {
        const rows = await client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.shop_id', ${SHOP}, true)`;
          return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${c.sql}`, ...(c.params ?? []));
        });
        plan = rows.map((r) => r['QUERY PLAN']).join('\n');
        const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);
        if (i > 0) times.push(ms); // first run is the warm-up
      }
      times.sort((x, y) => x - y);
      results.push({ name: c.name, median: times[Math.floor(times.length / 2)]!, max: times[times.length - 1]!, plan });
    }

    const counts = await owner.$queryRawUnsafe<Record<string, number>[]>(
      `SELECT (SELECT count(*)::int FROM customers WHERE "shopId" = $1) AS customers,
              (SELECT count(*)::int FROM customer_phones WHERE "shopId" = $1) AS phones,
              (SELECT count(*)::int FROM devices WHERE "shopId" = $1) AS devices,
              (SELECT count(*)::int FROM tickets WHERE "shopId" = $1) AS tickets,
              (SELECT count(*)::int FROM tickets WHERE "shopId" = $1 AND "statusCategory" <> 'CLOSED') AS open_tickets,
              (SELECT count(*)::int FROM ticket_events WHERE "shopId" = $1) AS events,
              (SELECT version()) AS pg`,
      SHOP,
    );
    console.log(`Dataset (shop ${SHOP}): ${JSON.stringify(counts[0])}\n`);
    console.log('| Query | Median ms | Max ms | Index / access path |');
    console.log('|---|---:|---:|---|');
    for (const r of results) {
      const paths = [...new Set([...r.plan.matchAll(/(Index Only Scan|Index Scan|Bitmap Index Scan|Seq Scan|Function Scan)(?: Backward)?(?: using| on) ("?[\w]+"?)/g)].map((m) => `${m[1]} ${m[2]}`))];
      console.log(`| ${r.name} | ${r.median.toFixed(2)} | ${r.max.toFixed(2)} | ${paths.join('; ')} |`);
    }
    for (const r of results) console.log(`\n### ${r.name}\n\n\`\`\`\n${r.plan}\n\`\`\``);
  } finally {
    await app.$disconnect();
    await owner.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
