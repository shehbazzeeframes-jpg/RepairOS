/**
 * Performance dataset (story §9): one shop with 50,000 customers (+ ~60,000 phones), 70,000 devices,
 * 100,000 tickets (~3% not closed) and 400,000 timeline events, plus a small second shop so `shopId` is selective.
 * NOT part of `pnpm db:seed`. Run against a scratch/dev database only:
 *
 *   pnpm db:seed:perf            # creates or replaces the perf shops (about a minute)
 *   pnpm --filter @repairos/db perf:explain > /tmp/plans.md
 *
 * Generated in SQL (INSERT ... SELECT generate_series) as the table owner, so it is fast and bypasses RLS.
 */
import { PrismaClient } from '@prisma/client';

export const PERF_SHOP_ID = 'perf_shop_main';
const NOISE_SHOP_ID = 'perf_shop_noise';
const PERF_USERS = ['perf_user_owner', 'perf_user_tech1', 'perf_user_tech2', 'perf_user_tech3', 'perf_user_desk'];

const CUSTOMERS = 50_000;
const DEVICES = 70_000;
const TICKETS = 100_000;
const EVENTS_PER_TICKET = 4;

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create perf data with NODE_ENV=production');
  const url = process.env.DATABASE_URL ?? '';
  if (/prod/i.test(new URL(url).pathname)) throw new Error('Refusing to create perf data in a database whose name contains "prod"');
  const prisma = new PrismaClient({ datasourceUrl: url });
  const t0 = Date.now();
  const step = async (label: string, sql: string) => {
    const t = Date.now();
    const n = await prisma.$executeRawUnsafe(sql);
    console.log(`[seed:perf] ${label}: ${n} rows (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  };
  try {
    for (const shopId of [PERF_SHOP_ID, NOISE_SHOP_ID]) {
      // Children first (RESTRICT FKs), then the shop's Sprint 2 data, memberships and the shop itself.
      await prisma.$executeRawUnsafe(`DELETE FROM ticket_events WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM ticket_notes WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM ticket_issues WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM devices WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM customers WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM memberships WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM ticket_statuses WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM shop_ticket_settings WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE "shopId" = $1`, shopId);
      await prisma.$executeRawUnsafe(`DELETE FROM shops WHERE id = $1`, shopId);
    }
    await step(
      'shops',
      `INSERT INTO shops (id, name, country, currency, locale, timezone, "pricesIncludeTax", "updatedAt") VALUES
         ('${PERF_SHOP_ID}', 'Perf Repair Co', 'US', 'USD', 'en-US', 'America/New_York', false, now()),
         ('${NOISE_SHOP_ID}', 'Perf Noise Shop', 'PK', 'PKR', 'en-GB', 'Asia/Karachi', true, now())`,
    );
    await step(
      'users',
      `INSERT INTO users (id, name, email, "emailVerified", "updatedAt")
       SELECT u, initcap(replace(u, '_', ' ')), u || '@perf.test', true, now() FROM unnest(ARRAY['${PERF_USERS.join("','")}']) u
       ON CONFLICT (id) DO NOTHING`,
    );
    await step(
      'memberships',
      `INSERT INTO memberships (id, "userId", "shopId", role, "updatedAt")
       SELECT 'perf_m_' || u || '_' || s, u, s, CASE WHEN u LIKE '%owner' THEN 'OWNER'::"Role" ELSE 'TECHNICIAN'::"Role" END, now()
       FROM unnest(ARRAY['${PERF_USERS.join("','")}']) u, unnest(ARRAY['${PERF_SHOP_ID}', '${NOISE_SHOP_ID}']) s`,
    );
    await prisma.$executeRawUnsafe(`SELECT app_ensure_ticket_defaults($1), app_ensure_ticket_defaults($2)`, PERF_SHOP_ID, NOISE_SHOP_ID);

    // Generator: shop = main for g ≤ N, noise shop for the extra 5%.
    const shopOf = (n: number) => `CASE WHEN g <= ${n} THEN '${PERF_SHOP_ID}' ELSE '${NOISE_SHOP_ID}' END`;
    const names = {
      first: `(ARRAY['James','Maria','Robert','Jennifer','Michael','Linda','David','Sofia','Daniel','Aisha','Kevin','Emily','Carlos','Grace','Tyler','Nicole','Ali','Ayesha','Usman','Fatima','Hamza','Zainab','José','Chloé','Wei','Priya','Olu','Mateo','Hannah','Marcus'])[1 + (g * 7) % 30]`,
      last: `(ARRAY['Smith','Johnson','Williams','Brown','Garcia','Miller','Davis','Rodriguez','Martinez','Lee','Walker','Nguyen','Patel','Thompson','White','Harris','Clark','Lewis','Khan','Ahmed','Malik','Butt','Qureshi','Peña','Müller','O''Brien','Kowalski','Haddad','Okafor','Silva','Rossi','Yamamoto','Novak','Ivanova','Dubois','Larsen','Costa','Fischer','Kim','Singh'])[1 + (g * 13) % 40]`,
    };
    const custN = Math.round(CUSTOMERS * 1.05);
    await step(
      'customers',
      `INSERT INTO customers (id, "shopId", kind, "firstName", "lastName", "businessName", "displayName", email, tags,
                              "preferredChannel", "marketingSmsAt", "lastVisitAt", "archivedAt", "createdAt", "updatedAt")
       SELECT 'perf_c_' || g, ${shopOf(CUSTOMERS)},
              CASE WHEN g % 20 = 0 THEN 'BUSINESS'::"CustomerKind" ELSE 'PERSON' END,
              CASE WHEN g % 20 = 0 THEN NULL ELSE ${names.first} END,
              CASE WHEN g % 20 = 0 OR g % 9 = 0 THEN NULL ELSE ${names.last} || CASE WHEN g % 3 = 0 THEN '' ELSE ' ' || (g % 97) END END,
              CASE WHEN g % 20 = 0 THEN ${names.last} || ' Holdings ' || g ELSE NULL END,
              CASE WHEN g % 20 = 0 THEN ${names.last} || ' Holdings ' || g
                   WHEN g % 9 = 0 THEN ${names.first}
                   ELSE ${names.first} || ' ' || ${names.last} || CASE WHEN g % 3 = 0 THEN '' ELSE ' ' || (g % 97) END END,
              CASE WHEN g % 5 < 3 THEN lower(${names.first}) || '.' || g || '@example.com' ELSE NULL END,
              CASE WHEN g % 10 = 0 THEN ARRAY['VIP'] ELSE '{}'::text[] END,
              'SMS', CASE WHEN g % 4 = 0 THEN now() - (g % 700) * interval '1 day' END,
              now() - (g % 900) * interval '1 day',
              CASE WHEN g % 50 = 0 THEN now() - interval '30 days' END,
              now() - (g % 1100) * interval '1 day', now()
       FROM generate_series(1, ${custN}) g`,
    );
    await step(
      'customer phones',
      `INSERT INTO customer_phones (id, "shopId", "customerId", e164, digits, "isPrimary", "isWhatsapp", position, "updatedAt")
       SELECT 'perf_p_' || g || '_' || k, ${shopOf(CUSTOMERS)}, 'perf_c_' || g,
              '+1' || (ARRAY['212','646','718','917','347','929'])[1 + (g + k) % 6] || lpad(((g * 7919 + k * 104729) % 10000000)::text, 7, '0'),
              '1' || (ARRAY['212','646','718','917','347','929'])[1 + (g + k) % 6] || lpad(((g * 7919 + k * 104729) % 10000000)::text, 7, '0'),
              k = 0, k = 0, k, now()
       FROM generate_series(1, ${custN}) g, generate_series(0, 1) k
       WHERE k = 0 OR g % 5 = 0`,
    );
    const devN = Math.round(DEVICES * 1.05);
    await step(
      'devices',
      `INSERT INTO devices (id, "shopId", "customerId", type, brand, model, imei, serial, "lockType", "createdAt", "updatedAt")
       SELECT 'perf_d_' || g, ${shopOf(DEVICES)},
              'perf_c_' || CASE WHEN g <= ${DEVICES} THEN 1 + (g - 1) % ${CUSTOMERS} ELSE ${CUSTOMERS} + 1 + (g - ${DEVICES} - 1) % ${custN - CUSTOMERS} END,
              CASE WHEN g % 10 < 8 THEN 'PHONE'::"DeviceType" WHEN g % 10 = 8 THEN 'LAPTOP' ELSE 'TABLET' END,
              (ARRAY['Apple','Samsung','Google','Motorola','Xiaomi'])[1 + g % 5],
              (ARRAY['iPhone 13','Galaxy S23','Pixel 8','moto g','Redmi Note 12','iPhone 15 Pro','Galaxy A54'])[1 + g % 7],
              CASE WHEN g % 10 <> 8 AND g % 6 <> 0 THEN '35' || lpad(((g::bigint * 982451653) % 10000000000000)::text, 13, '0') END,
              CASE WHEN g % 10 = 8 OR g % 4 = 0 THEN 'SN' || upper(substr(md5(g::text), 1, 10)) END,
              'NONE', now() - (g % 1100) * interval '1 day', now()
       FROM generate_series(1, ${devN}) g`,
    );
    // Tickets: ~3% not closed (spread over OPEN/WAITING/READY), the rest Collected/Cancelled.
    const tickN = Math.round(TICKETS * 1.05);
    await step(
      'tickets',
      `WITH st AS (
         SELECT "shopId", max(id) FILTER (WHERE name = 'Received') AS received, max(id) FILTER (WHERE name = 'Awaiting parts') AS waiting,
                max(id) FILTER (WHERE name = 'Ready for pickup') AS ready, max(id) FILTER (WHERE name = 'Collected') AS collected,
                max(id) FILTER (WHERE name = 'Cancelled') AS cancelled
         FROM ticket_statuses GROUP BY "shopId"),
       src AS (
         SELECT g, ${shopOf(TICKETS)} AS shop,
                CASE WHEN g <= ${TICKETS} THEN 1 + (g - 1) % ${DEVICES} ELSE ${DEVICES} + 1 + (g - ${TICKETS} - 1) % ${devN - DEVICES} END AS dev,
                CASE WHEN g % 100 < 2 THEN 'OPEN' WHEN g % 100 = 2 THEN (CASE WHEN g % 200 < 100 THEN 'WAITING' ELSE 'READY' END)
                     ELSE 'CLOSED' END AS cat,
                now() - ((${tickN} - g) * interval '15 minutes') AS created
         FROM generate_series(1, ${tickN}) g)
       INSERT INTO tickets (id, "shopId", number, "statusId", "statusCategory", priority, "customerId", "deviceId", "assigneeUserId",
                            currency, "estimateMinor", "dueAt", "closedAt", "createdAt", "updatedAt")
       SELECT 'perf_t_' || s.g, s.shop, 1000 + s.g,
              CASE s.cat WHEN 'OPEN' THEN st.received WHEN 'WAITING' THEN st.waiting WHEN 'READY' THEN st.ready
                         ELSE CASE WHEN s.g % 10 = 0 THEN st.cancelled ELSE st.collected END END,
              s.cat, CASE WHEN s.g % 13 = 0 THEN 'URGENT'::"TicketPriority" ELSE 'NORMAL' END,
              d."customerId", d.id,
              CASE WHEN s.g % 7 = 0 THEN NULL ELSE (ARRAY['${PERF_USERS.slice(1).join("','")}'])[1 + s.g % 4] END,
              'USD', 4900 + (s.g % 300) * 100,
              s.created + interval '2 days',
              CASE WHEN s.cat = 'CLOSED' THEN s.created + interval '3 days' END,
              s.created, s.created
       FROM src s JOIN st ON st."shopId" = s.shop JOIN devices d ON d.id = 'perf_d_' || s.dev`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE shop_ticket_settings s SET "nextNumber" = (SELECT max(number) + 1 FROM tickets t WHERE t."shopId" = s."shopId")
       WHERE s."shopId" IN ($1, $2)`,
      PERF_SHOP_ID,
      NOISE_SHOP_ID,
    );
    await step(
      'ticket issues',
      `INSERT INTO ticket_issues (id, "shopId", "ticketId", code, label)
       SELECT 'perf_i_' || t.id, t."shopId", t.id, 'SCREEN_CRACKED', 'Screen cracked' FROM tickets t WHERE t."shopId" IN ('${PERF_SHOP_ID}', '${NOISE_SHOP_ID}')`,
    );
    // Event data follows TicketEventDataByType (code review L3): created → Received, assigned → the assignee,
    // then Received → Ready for pickup → the ticket's current status.
    await step(
      'ticket events',
      `WITH st AS (
         SELECT "shopId", max(id) FILTER (WHERE "systemRole" = 'INITIAL') AS received,
                max(id) FILTER (WHERE name = 'Ready for pickup') AS ready
         FROM ticket_statuses GROUP BY "shopId")
       INSERT INTO ticket_events (id, "shopId", "ticketId", "actorUserId", type, data, "createdAt")
       SELECT 'perf_e_' || t.id || '_' || k, t."shopId", t.id, 'perf_user_desk',
              (ARRAY['created','assigned','status_changed','status_changed'])[k]::"TicketEventType",
              CASE k
                WHEN 1 THEN jsonb_build_object('statusId', st.received, 'warrantyOfTicketId', NULL)
                WHEN 2 THEN jsonb_build_object('fromUserId', NULL, 'toUserId', t."assigneeUserId")
                WHEN 3 THEN jsonb_build_object('fromStatusId', st.received, 'toStatusId', st.ready, 'notifyPending', false)
                ELSE jsonb_build_object('fromStatusId', st.ready, 'toStatusId', t."statusId", 'notifyPending', false)
              END,
              t."createdAt" + k * interval '1 hour'
       FROM tickets t JOIN st ON st."shopId" = t."shopId", generate_series(1, ${EVENTS_PER_TICKET}) k
       WHERE t."shopId" IN ('${PERF_SHOP_ID}', '${NOISE_SHOP_ID}')`,
    );
    await step(
      'open ticket counts',
      `UPDATE customers c SET "openTicketCount" = x.n FROM (
         SELECT "customerId", count(*) AS n FROM tickets WHERE "statusCategory" <> 'CLOSED' AND "shopId" IN ('${PERF_SHOP_ID}', '${NOISE_SHOP_ID}')
         GROUP BY 1) x WHERE c.id = x."customerId"`,
    );
    await prisma.$executeRawUnsafe('VACUUM ANALYZE customers, customer_phones, devices, tickets, ticket_events, ticket_issues');
    console.log(`[seed:perf] done in ${((Date.now() - t0) / 1000).toFixed(0)} s (shop ${PERF_SHOP_ID})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
