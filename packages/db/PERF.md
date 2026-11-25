# Sprint 2 performance: list and search queries (story §9, A14)

Target: list and search queries use indexes and run in **< 50 ms** in the database on a shop with 50,000 customers,
70,000 devices, 100,000 tickets and 400,000 timeline events (API p95 targets are 300 ms for lists and 200 ms for
global search; this leaves the database a small share of that).

**Result: every list, count and search query below has a median under 50 ms and uses an index (except the
uncapped counts of non-selective filters, which are sequential scans by design; see finding 2).** Apart from those
exact counts (12-26 ms) and the 2-3 letter name searches that match thousands of customers (~28-35 ms median, max
50 ms), every query has a median under 7 ms, most under 2 ms.

## How to reproduce

```sh
pnpm db:migrate                               # scratch / dev database
pnpm db:seed:perf                             # ~25 s: shops perf_shop_main (the dataset) + perf_shop_noise (5% extra rows)
pnpm --filter @repairos/db perf:explain > plans.md
```

`seed:perf` (packages/db/scripts/seed-perf.ts) is **not** part of `pnpm db:seed`. `perf:explain`
(packages/db/scripts/perf-explain.ts) runs every query as the **app role with RLS** (`APP_DATABASE_URL`, `app.shop_id`
set in the transaction, exactly like the API), 1 warm-up + 7 runs of `EXPLAIN (ANALYZE, BUFFERS)`, and prints the
median and max execution time. Measured on a dev container: PostgreSQL 16.15, default settings, data fully cached.
Search queries are built with the helpers in `src/search.ts`, so what is measured is what the API will run.

## Findings that shaped the schema

1. **RLS blocks index use for non-LEAKPROOF operators.** For a role subject to RLS, Postgres only uses a `WHERE`
   condition as an index condition if its operator is `LEAKPROOF` (otherwise it could leak rows of other shops through
   errors before the policy is checked). `text =`, `<`, `>`, integer and timestamp comparisons are leakproof; **enum
   `=`, `LIKE`/`ILIKE` (so every trigram search) and array operators (`@>`, `&&`) are not.** Consequences:
   - `tickets."statusCategory"` and `ticket_statuses.category` are `text` + `CHECK`, not a Postgres enum. With an enum,
     every ticket view scanned all 100k index entries of the shop and filtered (measured 4x slower even on a toy table).
   - Trigram search runs inside `SECURITY DEFINER` functions (`app_search_customers`, `app_search_devices`), which run
     as the table owner (no RLS) and filter by `app_current_shop_id()` themselves; they return only ids and scores.
     The last row of the table shows the same name search as the app role directly: a sequential scan of the shop.
   - The tag filter (`tags && $1`) and the `kind` filter cannot use an index under RLS either; they are applied after
     the `shopId`/sort index (customers are bounded per shop, so this is fine). No GIN index on `tags` was added.
2. **Counts on non-selective filters are sequential scans** ("all customers": 50k rows, "Closed": 97k rows):
   12-26 ms exact. The contract's `LIST_TOTAL_CAP` (10,000) brings them to ~3 ms with
   `SELECT count(*) FROM (SELECT 1 ... LIMIT 10001) x`; use that form for `total` / `totalCapped`.
3. **1-2 character name words match at a word start**, 3+ characters anywhere. A 2-letter "contains" (`%ma%`) has no
   trigram, so it was a sequential scan, matched a fifth of all customers (Thomas, Emma, ...) and took 80 ms; word-start
   (`% ma%`, made possible by a leading space in `searchText`) uses the trigram index and is what people mean when they
   type two letters. Trigram similarity is only computed for 3+ character queries.
4. **Open-ticket views stay small**: the views filter on `statusCategory` first, so their cost grows with open tickets
   (3,000 here), not with history. The dashboard counts are one index-only scan of `tickets_status_due_idx`.

## Index → query map

| Index | Serves |
|---|---|
| `customers_active_name_idx` (shopId, displayName, id) WHERE archivedAt IS NULL | Customer list default sort + keyset pages |
| `customers_active_last_visit_idx` (shopId, lastVisitAt DESC NULLS LAST, id) WHERE archivedAt IS NULL | "Last visit" sort |
| `customers_shopId_createdAt_id_idx` | "Created" sort, created-date filter |
| `customers_shopId_email_idx` | Duplicate check by email (email stored lower-cased) |
| `customers_search_trgm_idx` GIN (searchText gin_trgm_ops) | Name / business / contact / email words (in app_search_customers) |
| `customer_phones_shopId_e164_idx` | Exact phone (search with a full number, duplicate check) |
| `customer_phones_digits_trgm_idx` GIN | Phone substring, 4+ digits |
| `devices_imei_idx`, `devices_serial_idx` (partial, NOT NULL) | Exact IMEI / serial lookup (DV2.5 warning, scanner jump) |
| `devices_imei_trgm_idx`, `devices_serial_trgm_idx` GIN (partial) | IMEI last 4+ / serial contains (in app_search_devices) |
| `devices_shopId_brand_model_idx` | "Models used before" suggestions |
| `tickets_shopId_number_key` (unique) | Ticket number search / jump; gapless uniqueness |
| `tickets_status_due_idx` (shopId, statusCategory, dueAt, id, assigneeUserId, priority) | Open / Ready / Overdue / Due today views and the counts query (index-only) |
| `tickets_closed_idx` (shopId, statusCategory, closedAt DESC, id) | Closed view sorted by closed date (also picked for other single-category views) |
| `tickets_assignee_idx` (shopId, assigneeUserId, statusCategory, dueAt) | Mine / My queue |
| `tickets_created_idx` (shopId, createdAt DESC, id) | All tickets by created date, created-date filter |
| `tickets_customer_idx`, `tickets_device_idx` | Customer Tickets tab, device history, ticket search through customer/device hits |
| `tickets_status_idx` (shopId, statusId) | Ticket count per status (settings) and the category-change FK cascade |
| `tickets_warranty_idx` (partial) | Warranty links, "Warranty only" filter |
| `ticket_events_shopId_ticketId_createdAt_id_idx` | Timeline, cursor-paginated |

## Results


Dataset (shop perf_shop_main): {"customers":50000,"phones":60000,"devices":70000,"tickets":100000,"open_tickets":3000,"events":400000,"pg":"PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit"}

| Query | Median ms | Max ms | Index / access path |
|---|---:|---:|---|
| Customer list, default sort (Name A-Z), page 1 | 0.05 | 0.07 | Index Scan customers_active_name_idx |
| Customer list, keyset page ~1000 | 0.04 | 0.06 | Index Only Scan customers_active_name_idx |
| Customer list total (no filter, exact) | 11.71 | 15.09 | Seq Scan customers |
| Customer list total (no filter, capped at 10,000) | 2.92 | 7.60 | Seq Scan customers |
| Customer list, sort Last visit | 0.06 | 0.09 | Index Scan customers_active_last_visit_idx |
| Customer list search "first last (any order)" (page) | 5.30 | 14.24 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "first last (any order)" (total) | 5.48 | 6.85 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "phone, full number" (page) | 1.26 | 1.70 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "phone, full number" (total) | 1.17 | 1.31 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "phone, last 4 digits" (page) | 1.41 | 2.39 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "phone, last 4 digits" (total) | 1.46 | 1.55 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "IMEI, last 6" (page) | 1.04 | 1.22 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "IMEI, last 6" (total) | 1.03 | 1.24 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "email fragment" (page) | 1.40 | 4.04 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "email fragment" (total) | 0.73 | 1.49 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "2 letters (word start)" (page) | 34.68 | 49.98 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "2 letters (word start)" (total) | 32.33 | 36.08 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Customer list search "3 letters (contains)" (page) | 27.49 | 39.18 | Function Scan app_search_customers; Index Scan customers_pkey |
| Customer list search "3 letters (contains)" (total) | 28.21 | 33.70 | Function Scan app_search_customers; Index Only Scan "customers_shopId_id_key" |
| Duplicate check (phone exact, incl. archived) | 0.06 | 0.10 | Index Scan "customer_phones_shopId_e164_idx"; Index Scan "customers_shopId_id_key" |
| Tickets: All open (urgent first, due soonest) | 3.89 | 7.83 | Bitmap Index Scan tickets_closed_idx |
| Tickets: All open total | 0.68 | 1.90 | Index Only Scan tickets_closed_idx |
| Tickets: Mine | 1.09 | 1.41 | Index Scan tickets_assignee_idx |
| Tickets: Overdue | 2.74 | 6.51 | Bitmap Index Scan tickets_closed_idx |
| Tickets: Ready for pickup | 0.64 | 0.66 | Index Scan tickets_closed_idx |
| Tickets: Closed (closed date newest) | 0.05 | 0.10 | Index Scan tickets_closed_idx |
| Tickets: Closed total (exact) | 25.65 | 38.70 | Seq Scan tickets |
| Tickets: Closed total (capped at 10,000) | 3.31 | 3.52 | Seq Scan tickets |
| Tickets: All, Created (newest) | 0.04 | 0.11 | Index Scan tickets_created_idx |
| Ticket counts (dashboard tiles, one query) | 4.05 | 16.46 | Index Only Scan tickets_status_due_idx; Index Scan "memberships_userId_shopId_key" |
| Ticket list search "ticket number" in All open | 2.53 | 6.41 | Index Scan "tickets_shopId_number_key"; Function Scan app_search_customers; Index Scan tickets_customer_idx; Function Scan app_search_devices; Index Scan tickets_device_idx; Index Scan tickets_pkey |
| Ticket list search "customer name" in All open | 9.80 | 12.48 | Function Scan app_search_customers; Index Scan tickets_customer_idx; Function Scan app_search_devices; Index Scan tickets_device_idx; Index Scan tickets_pkey |
| Ticket list search "phone" in All open | 1.23 | 2.39 | Function Scan app_search_customers; Index Scan tickets_customer_idx; Function Scan app_search_devices; Index Scan tickets_device_idx; Index Scan tickets_pkey |
| Ticket list search "IMEI last 6" in All open | 0.89 | 1.17 | Function Scan app_search_customers; Index Scan tickets_customer_idx; Function Scan app_search_devices; Index Scan tickets_device_idx; Index Scan tickets_pkey |
| Global search: customers (limit 5) | 6.02 | 8.15 | Function Scan app_search_customers; Index Scan customers_pkey |
| Global search: devices (limit 5) | 0.36 | 0.45 | Function Scan app_search_devices |
| Global search: tickets (limit 5) | 1.01 | 2.63 | Function Scan app_search_customers; Index Scan tickets_customer_idx; Function Scan app_search_devices; Index Scan tickets_device_idx; Index Scan tickets_pkey |
| Ticket timeline (50) | 0.03 | 0.04 | Index Scan "ticket_events_shopId_ticketId_createdAt_id_idx" |
| Customer tickets tab | 0.04 | 0.05 | Index Scan tickets_customer_idx |

## API

End-to-end latency through the HTTP API (Sprint 2 API branch), measured on the same perf dataset: everything a real
request does (Better Auth session lookup, membership check, `X-Shop-Id` guard, `SET LOCAL` + RLS, the list/search SQL,
the capped total, hydrating the page into contract DTOs, JSON).

**Target: p95 < 300 ms for lists and search. Result: met; every scenario's p95 is 145–262 ms at 20 concurrent
requests** (run 3 below; an earlier run after the same fixes was within ±65 ms, all p95 < 300 ms). Single requests (no contention) take 10–35 ms
(`/api/me` 12 ms, counts 10 ms, dashboard 21 ms, Closed view 25 ms, All open 27 ms, global search 34 ms).

How: a scratch database `repairos_s2perf` (`pnpm db:migrate` + `pnpm db:seed:perf`), the built API
(`node apps/api/dist/main.js`, `NODE_ENV=development`, `LOG_LEVEL=warn`, default Prisma pool = 9 connections) on port
4500, signed in as a Manager of `perf_shop_main`, then
`node apps/api/scripts/load-check.mjs http://localhost:4500 "<cookie>" apps/api/scripts/load-check.scenarios.json`:
per scenario 40 warm-up requests, then 400 requests at **20 concurrent**, cycling through the scenario's URLs. Same dev
container as above (4 vCPUs shared by Postgres, the API and the load generator), so at 20 concurrent the latency is
mostly queueing: one Node process serves ~110–180 requests/s.

| Scenario (run 3) | Requests | p50 ms | p95 ms | p99 ms | max ms | req/s |
|---|---:|---:|---:|---:|---:|---:|
| Ticket list: All open (default sort), page 1 + capped total | 400 | 131.8 | 181.2 | 217.9 | 259.5 | 145 |
| Ticket list: Overdue / Ready / Unassigned | 400 | 124.9 | 161.8 | 179.0 | 188.0 | 156 |
| Ticket list: Closed (97k rows, total capped) | 400 | 121.3 | 164.4 | 178.5 | 189.5 | 159 |
| Ticket list: All, Created (newest) | 400 | 115.5 | 144.5 | 154.6 | 163.3 | 170 |
| Ticket list: search (name / phone / IMEI last 6 / number) | 400 | 175.1 | 224.8 | 264.3 | 356.1 | 113 |
| Customer list: default + search (name / phone digits) | 400 | 140.3 | 255.0 | 303.5 | 416.2 | 130 |
| Global search (name / phone / IMEI / number) | 400 | 127.6 | 173.7 | 189.0 | 205.2 | 153 |
| Dashboard (counts + My queue + Unassigned) | 400 | 154.4 | 262.0 | 280.7 | 319.4 | 119 |
| Ticket counts | 400 | 105.3 | 154.9 | 168.7 | 176.2 | 180 |

Findings while measuring:

1. **The Closed view sorted the whole history** (p95 466 ms in the first run): its `ORDER BY "closedAt" DESC NULLS LAST,
   id DESC` did not match `tickets_closed_idx (closedAt DESC, id)`. The API now uses exactly the index order for the
   Closed view (and `createdAt DESC, id` for "Created"), which made it an index scan (p95 165 ms).
2. **Round trips dominate**: every Sprint 2 request needs the shop's country/timezone/hours/prefix; reading them in one
   query instead of three took ~10 % off every endpoint.
3. A bigger Prisma pool (`connection_limit=20`) made things worse on this 4-vCPU box (p95 up to 393 ms): the limit is
   CPU, not connections. Leave the default; scale with more API processes.
4. The global-search story target (p95 < 200 ms, §7) is met at 20 concurrent (174 ms) on this box.

## Plans

App-role plans include the RLS policy condition (`NULLIF(current_setting(...))`); `[inside ...]` plans are the
queries the SECURITY DEFINER functions run, explained as the table owner.
| [inside app_search_customers] name words (trigram) | 1.66 | 2.96 | Bitmap Index Scan customers_search_trgm_idx |
| [inside app_search_customers] phone digits substring (trigram) | 0.11 | 0.59 | Bitmap Index Scan customer_phones_digits_trgm_idx |
| [inside app_search_devices] IMEI/serial substring (trigram) | 0.12 | 0.22 | Bitmap Index Scan devices_imei_trgm_idx; Bitmap Index Scan devices_serial_trgm_idx |
| [contrast] same name search as the APP role without the function (RLS blocks the index) | 9.86 | 10.43 | Seq Scan customers |

#### Customer list, default sort (Name A-Z), page 1

```
Limit (actual time=0.014..0.034 rows=25 loops=1)
  Buffers: shared hit=28
  ->  Result (actual time=0.014..0.032 rows=25 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=28
        ->  Index Scan using customers_active_name_idx on customers (actual time=0.011..0.026 rows=25 loops=1)
              Index Cond: ("shopId" = 'perf_shop_main'::text)
              Buffers: shared hit=28
Planning Time: 0.095 ms
Execution Time: 0.047 ms
```

#### Customer list, keyset page ~1000

```
Limit (actual time=0.019..0.025 rows=25 loops=1)
  Buffers: shared hit=4
  ->  Result (actual time=0.018..0.022 rows=25 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=4
        ->  Index Only Scan using customers_active_name_idx on customers (actual time=0.016..0.018 rows=25 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND (ROW("displayName", id) > ROW('Maria Garcia'::text, 'perf_c_25000'::text)))
              Heap Fetches: 0
              Buffers: shared hit=4
Planning Time: 0.151 ms
Execution Time: 0.040 ms
```

#### Customer list total (no filter, exact)

```
Aggregate (actual time=11.376..11.377 rows=1 loops=1)
  Buffers: shared hit=1411
  ->  Result (actual time=0.013..9.547 rows=49000 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=1411
        ->  Seq Scan on customers (actual time=0.011..6.550 rows=49000 loops=1)
              Filter: (("archivedAt" IS NULL) AND ("shopId" = 'perf_shop_main'::text))
              Rows Removed by Filter: 3544
              Buffers: shared hit=1411
Planning Time: 0.093 ms
Execution Time: 11.392 ms
```

#### Customer list total (no filter, capped at 10,000)

```
Aggregate (actual time=2.750..2.750 rows=1 loops=1)
  Buffers: shared hit=271
  ->  Limit (actual time=0.013..2.385 rows=10001 loops=1)
        Buffers: shared hit=271
        ->  Result (actual time=0.012..1.840 rows=10001 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=271
              ->  Seq Scan on customers (actual time=0.010..1.237 rows=10001 loops=1)
                    Filter: (("archivedAt" IS NULL) AND ("shopId" = 'perf_shop_main'::text))
                    Rows Removed by Filter: 148
                    Buffers: shared hit=271
Planning Time: 0.097 ms
Execution Time: 2.765 ms
```

#### Customer list, sort Last visit

```
Limit (actual time=0.017..0.039 rows=25 loops=1)
  Buffers: shared hit=27
  ->  Result (actual time=0.017..0.036 rows=25 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=27
        ->  Index Scan using customers_active_last_visit_idx on customers (actual time=0.014..0.029 rows=25 loops=1)
              Index Cond: ("shopId" = 'perf_shop_main'::text)
              Buffers: shared hit=27
Planning Time: 0.108 ms
Execution Time: 0.053 ms
```

#### Customer list search "first last (any order)" (page)

```
Limit (actual time=5.090..5.094 rows=25 loops=1)
  Buffers: shared hit=2714
  ->  Sort (actual time=5.089..5.091 rows=25 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=2714
        ->  Result (actual time=3.712..4.954 rows=417 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=2714
              ->  Nested Loop (actual time=3.709..4.913 rows=417 loops=1)
                    Buffers: shared hit=2714
                    ->  Function Scan on app_search_customers (actual time=3.695..3.718 rows=417 loops=1)
                          Buffers: shared hit=1046
                    ->  Index Scan using customers_pkey on customers c (actual time=0.002..0.002 rows=1 loops=417)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=1668
Planning Time: 0.160 ms
Execution Time: 5.120 ms
```

#### Customer list search "first last (any order)" (total)

```
Aggregate (actual time=4.683..4.683 rows=1 loops=1)
  Buffers: shared hit=2298
  ->  Result (actual time=3.557..4.640 rows=417 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=2298
        ->  Nested Loop (actual time=3.554..4.604 rows=417 loops=1)
              Buffers: shared hit=2298
              ->  Function Scan on app_search_customers (actual time=3.541..3.562 rows=417 loops=1)
                    Buffers: shared hit=1046
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.002..0.002 rows=1 loops=417)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=1252
Planning Time: 0.177 ms
Execution Time: 4.707 ms
```

#### Customer list search "phone, full number" (page)

```
Limit (actual time=1.169..1.170 rows=1 loops=1)
  Buffers: shared hit=113
  ->  Sort (actual time=1.168..1.169 rows=1 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=113
        ->  Result (actual time=1.164..1.165 rows=1 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=113
              ->  Nested Loop (actual time=1.161..1.162 rows=1 loops=1)
                    Buffers: shared hit=113
                    ->  Function Scan on app_search_customers (actual time=1.151..1.152 rows=1 loops=1)
                          Buffers: shared hit=109
                    ->  Index Scan using customers_pkey on customers c (actual time=0.007..0.007 rows=1 loops=1)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=4
Planning Time: 0.156 ms
Execution Time: 1.190 ms
```

#### Customer list search "phone, full number" (total)

```
Aggregate (actual time=1.090..1.090 rows=1 loops=1)
  Buffers: shared hit=113
  ->  Result (actual time=1.087..1.088 rows=1 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=113
        ->  Nested Loop (actual time=1.083..1.085 rows=1 loops=1)
              Buffers: shared hit=113
              ->  Function Scan on app_search_customers (actual time=1.075..1.076 rows=1 loops=1)
                    Buffers: shared hit=109
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.006..0.006 rows=1 loops=1)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=4
Planning Time: 0.142 ms
Execution Time: 1.111 ms
```

#### Customer list search "phone, last 4 digits" (page)

```
Limit (actual time=2.356..2.361 rows=25 loops=1)
  Buffers: shared hit=952
  ->  Sort (actual time=2.355..2.358 rows=25 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=952
        ->  Result (actual time=1.864..2.279 rows=99 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=952
              ->  Nested Loop (actual time=1.861..2.262 rows=99 loops=1)
                    Buffers: shared hit=952
                    ->  Function Scan on app_search_customers (actual time=1.848..1.857 rows=99 loops=1)
                          Buffers: shared hit=556
                    ->  Index Scan using customers_pkey on customers c (actual time=0.003..0.003 rows=1 loops=99)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=396
Planning Time: 0.189 ms
Execution Time: 2.392 ms
```

#### Customer list search "phone, last 4 digits" (total)

```
Aggregate (actual time=1.377..1.378 rows=1 loops=1)
  Buffers: shared hit=854
  ->  Result (actual time=1.183..1.370 rows=99 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=854
        ->  Nested Loop (actual time=1.180..1.359 rows=99 loops=1)
              Buffers: shared hit=854
              ->  Function Scan on app_search_customers (actual time=1.173..1.178 rows=99 loops=1)
                    Buffers: shared hit=556
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.002..0.002 rows=1 loops=99)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=298
Planning Time: 0.164 ms
Execution Time: 1.398 ms
```

#### Customer list search "IMEI, last 6" (page)

```
Limit (actual time=1.156..1.158 rows=2 loops=1)
  Buffers: shared hit=72
  ->  Sort (actual time=1.155..1.156 rows=2 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=72
        ->  Result (actual time=1.146..1.151 rows=2 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=72
              ->  Nested Loop (actual time=1.143..1.147 rows=2 loops=1)
                    Buffers: shared hit=72
                    ->  Function Scan on app_search_customers (actual time=1.134..1.135 rows=2 loops=1)
                          Buffers: shared hit=64
                    ->  Index Scan using customers_pkey on customers c (actual time=0.004..0.004 rows=1 loops=2)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=8
Planning Time: 0.184 ms
Execution Time: 1.183 ms
```

#### Customer list search "IMEI, last 6" (total)

```
Aggregate (actual time=0.848..0.849 rows=1 loops=1)
  Buffers: shared hit=71
  ->  Result (actual time=0.843..0.847 rows=2 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=71
        ->  Nested Loop (actual time=0.840..0.843 rows=2 loops=1)
              Buffers: shared hit=71
              ->  Function Scan on app_search_customers (actual time=0.834..0.834 rows=2 loops=1)
                    Buffers: shared hit=64
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.003..0.003 rows=1 loops=2)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=7
Planning Time: 0.158 ms
Execution Time: 0.869 ms
```

#### Customer list search "email fragment" (page)

```
Limit (actual time=0.832..0.833 rows=0 loops=1)
  Buffers: shared hit=67
  ->  Sort (actual time=0.832..0.833 rows=0 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=67
        ->  Result (actual time=0.829..0.830 rows=0 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=67
              ->  Nested Loop (actual time=0.827..0.827 rows=0 loops=1)
                    Buffers: shared hit=67
                    ->  Function Scan on app_search_customers (actual time=0.826..0.826 rows=0 loops=1)
                          Buffers: shared hit=67
                    ->  Index Scan using customers_pkey on customers c (never executed)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
Planning Time: 0.137 ms
Execution Time: 0.851 ms
```

#### Customer list search "email fragment" (total)

```
Aggregate (actual time=1.256..1.257 rows=1 loops=1)
  Buffers: shared hit=67
  ->  Result (actual time=1.254..1.254 rows=0 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=67
        ->  Nested Loop (actual time=1.250..1.250 rows=0 loops=1)
              Buffers: shared hit=67
              ->  Function Scan on app_search_customers (actual time=1.249..1.249 rows=0 loops=1)
                    Buffers: shared hit=67
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (never executed)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
Planning Time: 0.240 ms
Execution Time: 1.286 ms
```

#### Customer list search "2 letters (word start)" (page)

```
Limit (actual time=31.091..31.096 rows=25 loops=1)
  Buffers: shared hit=29867
  ->  Sort (actual time=31.090..31.092 rows=25 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=29867
        ->  Result (actual time=15.755..29.525 rows=7111 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=29867
              ->  Nested Loop (actual time=15.751..28.879 rows=7111 loops=1)
                    Buffers: shared hit=29867
                    ->  Function Scan on app_search_customers (actual time=15.729..16.112 rows=7111 loops=1)
                          Buffers: shared hit=1423
                    ->  Index Scan using customers_pkey on customers c (actual time=0.001..0.001 rows=1 loops=7111)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=28444
Planning Time: 0.234 ms
Execution Time: 31.268 ms
```

#### Customer list search "2 letters (word start)" (total)

```
Aggregate (actual time=30.806..30.807 rows=1 loops=1)
  Buffers: shared hit=22757
  ->  Result (actual time=16.794..30.440 rows=7111 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=22757
        ->  Nested Loop (actual time=16.790..29.885 rows=7111 loops=1)
              Buffers: shared hit=22757
              ->  Function Scan on app_search_customers (actual time=16.765..17.101 rows=7111 loops=1)
                    Buffers: shared hit=1423
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.002..0.002 rows=1 loops=7111)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=21334
Planning Time: 0.228 ms
Execution Time: 30.872 ms
```

#### Customer list search "3 letters (contains)" (page)

```
Limit (actual time=26.438..26.442 rows=25 loops=1)
  Buffers: shared hit=19147
  ->  Sort (actual time=26.437..26.439 rows=25 loops=1)
        Sort Key: app_search_customers.score DESC, c."displayName", c.id
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=19147
        ->  Result (actual time=16.571..25.473 rows=4445 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=19147
              ->  Nested Loop (actual time=16.568..25.051 rows=4445 loops=1)
                    Buffers: shared hit=19147
                    ->  Function Scan on app_search_customers (actual time=16.548..16.786 rows=4445 loops=1)
                          Buffers: shared hit=1367
                    ->  Index Scan using customers_pkey on customers c (actual time=0.001..0.001 rows=1 loops=4445)
                          Index Cond: (id = app_search_customers.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=17780
Planning Time: 0.187 ms
Execution Time: 26.515 ms
```

#### Customer list search "3 letters (contains)" (total)

```
Aggregate (actual time=27.861..27.862 rows=1 loops=1)
  Buffers: shared hit=14703
  ->  Result (actual time=18.409..27.626 rows=4445 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=14703
        ->  Nested Loop (actual time=18.406..27.262 rows=4445 loops=1)
              Buffers: shared hit=14703
              ->  Function Scan on app_search_customers (actual time=18.385..18.603 rows=4445 loops=1)
                    Buffers: shared hit=1367
              ->  Index Only Scan using "customers_shopId_id_key" on customers c (actual time=0.002..0.002 rows=1 loops=4445)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = app_search_customers.id))
                    Heap Fetches: 0
                    Buffers: shared hit=13336
Planning Time: 0.235 ms
Execution Time: 27.907 ms
```

#### Duplicate check (phone exact, incl. archived)

```
Limit (actual time=0.023..0.024 rows=1 loops=1)
  Buffers: shared hit=8
  ->  Unique (actual time=0.022..0.023 rows=1 loops=1)
        Buffers: shared hit=8
        ->  Sort (actual time=0.021..0.022 rows=1 loops=1)
              Sort Key: c.id
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=8
              ->  Result (actual time=0.017..0.018 rows=1 loops=1)
                    One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                    Buffers: shared hit=8
                    ->  Nested Loop (actual time=0.015..0.016 rows=1 loops=1)
                          Buffers: shared hit=8
                          ->  Index Scan using "customer_phones_shopId_e164_idx" on customer_phones p (actual time=0.008..0.009 rows=1 loops=1)
                                Index Cond: (("shopId" = 'perf_shop_main'::text) AND (e164 = '+16460007919'::text))
                                Buffers: shared hit=4
                          ->  Index Scan using "customers_shopId_id_key" on customers c (actual time=0.005..0.005 rows=1 loops=1)
                                Index Cond: (("shopId" = 'perf_shop_main'::text) AND (id = p."customerId"))
                                Filter: ("erasedAt" IS NULL)
                                Buffers: shared hit=4
Planning:
  Buffers: shared hit=16
Planning Time: 0.212 ms
Execution Time: 0.042 ms
```

#### Tickets: All open (urgent first, due soonest)

```
Limit (actual time=2.123..2.126 rows=25 loops=1)
  Buffers: shared hit=1083
  ->  Sort (actual time=2.122..2.124 rows=25 loops=1)
        Sort Key: priority DESC, "dueAt", number
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=1083
        ->  Result (actual time=0.353..1.420 rows=3000 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=1083
              ->  Bitmap Heap Scan on tickets t (actual time=0.350..1.023 rows=3000 loops=1)
                    Recheck Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                    Heap Blocks: exact=1035
                    Buffers: shared hit=1083
                    ->  Bitmap Index Scan on tickets_closed_idx (actual time=0.240..0.241 rows=3000 loops=1)
                          Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                          Buffers: shared hit=48
Planning Time: 0.106 ms
Execution Time: 2.145 ms
```

#### Tickets: All open total

```
Aggregate (actual time=0.880..0.881 rows=1 loops=1)
  Buffers: shared hit=49
  ->  Result (actual time=0.020..0.620 rows=3000 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=49
        ->  Index Only Scan using tickets_closed_idx on tickets t (actual time=0.017..0.395 rows=3000 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
              Heap Fetches: 0
              Buffers: shared hit=49
Planning Time: 0.226 ms
Execution Time: 0.898 ms
```

#### Tickets: Mine

```
Limit (actual time=0.951..0.954 rows=25 loops=1)
  Buffers: shared hit=879
  ->  Sort (actual time=0.950..0.951 rows=25 loops=1)
        Sort Key: priority DESC, "dueAt", number
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: shared hit=879
        ->  Result (actual time=0.022..0.637 rows=858 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=879
              ->  Index Scan using tickets_assignee_idx on tickets t (actual time=0.018..0.510 rows=858 loops=1)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("assigneeUserId" = 'perf_user_tech1'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                    Buffers: shared hit=879
Planning Time: 0.140 ms
Execution Time: 0.972 ms
```

#### Tickets: Overdue

```
Limit (actual time=3.030..3.035 rows=25 loops=1)
  Buffers: shared hit=1057
  ->  Sort (actual time=3.029..3.031 rows=25 loops=1)
        Sort Key: priority DESC, "dueAt", number
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=1057
        ->  Result (actual time=0.339..1.932 rows=2500 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=1057
              ->  Bitmap Heap Scan on tickets t (actual time=0.337..1.703 rows=2500 loops=1)
                    Recheck Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING}'::text[])))
                    Filter: ("dueAt" < now())
                    Heap Blocks: exact=1018
                    Buffers: shared hit=1057
                    ->  Bitmap Index Scan on tickets_closed_idx (actual time=0.222..0.223 rows=2500 loops=1)
                          Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING}'::text[])))
                          Buffers: shared hit=39
Planning Time: 0.138 ms
Execution Time: 3.058 ms
```

#### Tickets: Ready for pickup

```
Limit (actual time=0.637..0.640 rows=25 loops=1)
  Buffers: shared hit=509
  ->  Sort (actual time=0.636..0.637 rows=25 loops=1)
        Sort Key: priority DESC, "dueAt", number
        Sort Method: top-N heapsort  Memory: 31kB
        Buffers: shared hit=509
        ->  Result (actual time=0.019..0.430 rows=500 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=509
              ->  Index Scan using tickets_closed_idx on tickets t (actual time=0.016..0.339 rows=500 loops=1)
                    Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = 'READY'::text))
                    Buffers: shared hit=509
Planning Time: 0.127 ms
Execution Time: 0.657 ms
```

#### Tickets: Closed (closed date newest)

```
Limit (actual time=0.019..0.027 rows=25 loops=1)
  Buffers: shared hit=4
  ->  Result (actual time=0.018..0.024 rows=25 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=4
        ->  Index Scan using tickets_closed_idx on tickets t (actual time=0.015..0.017 rows=25 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = 'CLOSED'::text))
              Buffers: shared hit=4
Planning Time: 0.158 ms
Execution Time: 0.044 ms
```

#### Tickets: Closed total (exact)

```
Aggregate (actual time=25.477..25.478 rows=1 loops=1)
  Buffers: shared hit=2919
  ->  Result (actual time=0.032..20.644 rows=97000 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=2919
        ->  Seq Scan on tickets t (actual time=0.017..13.027 rows=97000 loops=1)
              Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = 'CLOSED'::text))
              Rows Removed by Filter: 8053
              Buffers: shared hit=2919
Planning Time: 0.192 ms
Execution Time: 25.514 ms
```

#### Tickets: Closed total (capped at 10,000)

```
Aggregate (actual time=3.471..3.472 rows=1 loops=1)
  Buffers: shared hit=289
  ->  Limit (actual time=0.013..2.959 rows=10001 loops=1)
        Buffers: shared hit=289
        ->  Result (actual time=0.012..2.259 rows=10001 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=289
              ->  Seq Scan on tickets t (actual time=0.009..1.321 rows=10001 loops=1)
                    Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = 'CLOSED'::text))
                    Rows Removed by Filter: 364
                    Buffers: shared hit=289
Planning Time: 0.117 ms
Execution Time: 3.489 ms
```

#### Tickets: All, Created (newest)

```
Limit (actual time=0.017..0.024 rows=25 loops=1)
  Buffers: shared hit=4
  ->  Result (actual time=0.016..0.022 rows=25 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=4
        ->  Index Scan using tickets_created_idx on tickets t (actual time=0.013..0.015 rows=25 loops=1)
              Index Cond: ("shopId" = 'perf_shop_main'::text)
              Buffers: shared hit=4
Planning Time: 0.133 ms
Execution Time: 0.040 ms
```

#### Ticket counts (dashboard tiles, one query)

```
Aggregate (actual time=4.024..4.025 rows=1 loops=1)
  Buffers: shared hit=4356
  ->  Result (actual time=0.017..0.729 rows=3000 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=68
        ->  Index Only Scan using tickets_status_due_idx on tickets t (actual time=0.015..0.440 rows=3000 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
              Heap Fetches: 0
              Buffers: shared hit=68
  SubPlan 1
    ->  Index Scan using "memberships_userId_shopId_key" on memberships m (actual time=0.001..0.001 rows=1 loops=2144)
          Index Cond: (("userId" = t."assigneeUserId") AND ("shopId" = t."shopId"))
          Filter: ((("shopId" = NULLIF(current_setting('app.shop_id'::text, true), ''::text)) OR ("userId" = NULLIF(current_setting('app.user_id'::text, true), ''::text))) AND (status = 'ACTIVE'::"MembershipStatus"))
          Buffers: shared hit=4288
Planning Time: 0.246 ms
Execution Time: 4.055 ms
```

#### Ticket list search "ticket number" in All open

```
Limit (actual time=2.112..2.118 rows=17 loops=1)
  Buffers: shared hit=1342
  ->  Sort (actual time=2.111..2.115 rows=17 loops=1)
        Sort Key: (max(('10'::real))) DESC, t.priority DESC, t."dueAt", t.number
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=1342
        ->  Result (actual time=1.627..2.100 rows=17 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=1342
              ->  Nested Loop (actual time=1.625..2.095 rows=17 loops=1)
                    Buffers: shared hit=1342
                    ->  GroupAggregate (actual time=1.619..1.683 rows=164 loops=1)
                          Group Key: t_1.id
                          Buffers: shared hit=686
                          ->  Sort (actual time=1.616..1.626 rows=164 loops=1)
                                Sort Key: t_1.id
                                Sort Method: quicksort  Memory: 32kB
                                Buffers: shared hit=686
                                ->  Append (actual time=0.012..1.557 rows=164 loops=1)
                                      Buffers: shared hit=686
                                      ->  Result (actual time=0.012..0.013 rows=1 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=4
                                            ->  Index Scan using "tickets_shopId_number_key" on tickets t_1 (actual time=0.011..0.012 rows=1 loops=1)
                                                  Index Cond: (("shopId" = 'perf_shop_main'::text) AND (number = 1001))
                                                  Buffers: shared hit=4
                                      ->  Result (actual time=0.796..1.015 rows=84 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=356
                                            ->  Nested Loop (actual time=0.795..1.006 rows=84 loops=1)
                                                  Buffers: shared hit=356
                                                  ->  Function Scan on app_search_customers (actual time=0.788..0.790 rows=38 loops=1)
                                                        Buffers: shared hit=158
                                                  ->  Index Scan using tickets_customer_idx on tickets t_2 (actual time=0.004..0.005 rows=2 loops=38)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = app_search_customers.id))
                                                        Buffers: shared hit=198
                                      ->  Result (actual time=0.303..0.515 rows=79 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=326
                                            ->  Nested Loop (actual time=0.301..0.505 rows=79 loops=1)
                                                  Buffers: shared hit=326
                                                  ->  Function Scan on app_search_devices (actual time=0.293..0.296 rows=56 loops=1)
                                                        Buffers: shared hit=79
                                                  ->  Index Scan using tickets_device_idx on tickets t_3 (actual time=0.003..0.003 rows=1 loops=56)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("deviceId" = app_search_devices.id))
                                                        Buffers: shared hit=247
                    ->  Index Scan using tickets_pkey on tickets t (actual time=0.002..0.002 rows=0 loops=164)
                          Index Cond: (id = t_1.id)
                          Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                          Rows Removed by Filter: 1
                          Buffers: shared hit=656
Planning Time: 0.469 ms
Execution Time: 2.166 ms
```

#### Ticket list search "customer name" in All open

```
Limit (actual time=8.747..8.755 rows=25 loops=1)
  Buffers: shared hit=6467
  ->  Sort (actual time=8.746..8.752 rows=25 loops=1)
        Sort Key: (max(app_search_customers.score)) DESC, t.priority DESC, t."dueAt", t.number
        Sort Method: top-N heapsort  Memory: 32kB
        Buffers: shared hit=6467
        ->  Result (actual time=5.939..8.649 rows=168 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=6467
              ->  Nested Loop (actual time=5.936..8.626 rows=168 loops=1)
                    Buffers: shared hit=6467
                    ->  GroupAggregate (actual time=5.927..6.251 rows=834 loops=1)
                          Group Key: t_1.id
                          Buffers: shared hit=3131
                          ->  Sort (actual time=5.922..6.017 rows=834 loops=1)
                                Sort Key: t_1.id
                                Sort Method: quicksort  Memory: 63kB
                                Buffers: shared hit=3131
                                ->  Append (actual time=3.470..5.571 rows=834 loops=1)
                                      Buffers: shared hit=3131
                                      ->  Result (actual time=3.469..5.252 rows=834 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=3083
                                            ->  Nested Loop (actual time=3.468..5.161 rows=834 loops=1)
                                                  Buffers: shared hit=3083
                                                  ->  Function Scan on app_search_customers (actual time=3.456..3.479 rows=417 loops=1)
                                                        Buffers: shared hit=998
                                                  ->  Index Scan using tickets_customer_idx on tickets t_1 (actual time=0.003..0.004 rows=2 loops=417)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = app_search_customers.id))
                                                        Buffers: shared hit=2085
                                      ->  Result (actual time=0.255..0.256 rows=0 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=48
                                            ->  Nested Loop (actual time=0.251..0.252 rows=0 loops=1)
                                                  Buffers: shared hit=48
                                                  ->  Function Scan on app_search_devices (actual time=0.251..0.251 rows=0 loops=1)
                                                        Buffers: shared hit=48
                                                  ->  Index Scan using tickets_device_idx on tickets t_2 (never executed)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("deviceId" = app_search_devices.id))
                    ->  Index Scan using tickets_pkey on tickets t (actual time=0.003..0.003 rows=0 loops=834)
                          Index Cond: (id = t_1.id)
                          Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                          Rows Removed by Filter: 1
                          Buffers: shared hit=3336
Planning Time: 0.493 ms
Execution Time: 8.805 ms
```

#### Ticket list search "phone" in All open

```
Limit (actual time=1.154..1.157 rows=3 loops=1)
  Buffers: shared hit=127
  ->  Sort (actual time=1.153..1.156 rows=3 loops=1)
        Sort Key: (max(app_search_customers.score)) DESC, t.priority DESC, t."dueAt", t.number
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=127
        ->  Result (actual time=1.135..1.148 rows=3 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=127
              ->  Nested Loop (actual time=1.132..1.145 rows=3 loops=1)
                    Buffers: shared hit=127
                    ->  GroupAggregate (actual time=1.124..1.127 rows=3 loops=1)
                          Group Key: t_1.id
                          Buffers: shared hit=115
                          ->  Sort (actual time=1.119..1.121 rows=3 loops=1)
                                Sort Key: t_1.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=115
                                ->  Append (actual time=0.775..1.118 rows=3 loops=1)
                                      Buffers: shared hit=115
                                      ->  Result (actual time=0.775..0.779 rows=3 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=75
                                            ->  Nested Loop (actual time=0.774..0.777 rows=3 loops=1)
                                                  Buffers: shared hit=75
                                                  ->  Function Scan on app_search_customers (actual time=0.767..0.767 rows=1 loops=1)
                                                        Buffers: shared hit=69
                                                  ->  Index Scan using tickets_customer_idx on tickets t_1 (actual time=0.005..0.007 rows=3 loops=1)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = app_search_customers.id))
                                                        Buffers: shared hit=6
                                      ->  Result (actual time=0.337..0.338 rows=0 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=40
                                            ->  Nested Loop (actual time=0.336..0.336 rows=0 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Function Scan on app_search_devices (actual time=0.335..0.335 rows=0 loops=1)
                                                        Buffers: shared hit=40
                                                  ->  Index Scan using tickets_device_idx on tickets t_2 (never executed)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("deviceId" = app_search_devices.id))
                    ->  Index Scan using tickets_pkey on tickets t (actual time=0.005..0.005 rows=1 loops=3)
                          Index Cond: (id = t_1.id)
                          Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                          Buffers: shared hit=12
Planning Time: 0.442 ms
Execution Time: 1.197 ms
```

#### Ticket list search "IMEI last 6" in All open

```
Limit (actual time=0.619..0.622 rows=8 loops=1)
  Buffers: shared hit=109
  ->  Sort (actual time=0.619..0.621 rows=8 loops=1)
        Sort Key: (max(app_search_customers.score)) DESC, t.priority DESC, t."dueAt", t.number
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=109
        ->  Result (actual time=0.594..0.615 rows=8 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=109
              ->  Nested Loop (actual time=0.592..0.612 rows=8 loops=1)
                    Buffers: shared hit=109
                    ->  GroupAggregate (actual time=0.587..0.591 rows=10 loops=1)
                          Group Key: t_1.id
                          Buffers: shared hit=69
                          ->  Sort (actual time=0.584..0.586 rows=10 loops=1)
                                Sort Key: t_1.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=69
                                ->  Append (actual time=0.566..0.581 rows=10 loops=1)
                                      Buffers: shared hit=69
                                      ->  Result (actual time=0.386..0.386 rows=0 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=20
                                            ->  Nested Loop (actual time=0.385..0.386 rows=0 loops=1)
                                                  Buffers: shared hit=20
                                                  ->  Function Scan on app_search_customers (actual time=0.385..0.385 rows=0 loops=1)
                                                        Buffers: shared hit=20
                                                  ->  Index Scan using tickets_customer_idx on tickets t_1 (never executed)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = app_search_customers.id))
                                      ->  Result (actual time=0.180..0.193 rows=10 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=49
                                            ->  Nested Loop (actual time=0.178..0.191 rows=10 loops=1)
                                                  Buffers: shared hit=49
                                                  ->  Function Scan on app_search_devices (actual time=0.168..0.169 rows=5 loops=1)
                                                        Buffers: shared hit=24
                                                  ->  Index Scan using tickets_device_idx on tickets t_2 (actual time=0.003..0.004 rows=2 loops=5)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("deviceId" = app_search_devices.id))
                                                        Buffers: shared hit=25
                    ->  Index Scan using tickets_pkey on tickets t (actual time=0.002..0.002 rows=1 loops=10)
                          Index Cond: (id = t_1.id)
                          Filter: (("shopId" = 'perf_shop_main'::text) AND ("statusCategory" = ANY ('{OPEN,WAITING,READY}'::text[])))
                          Rows Removed by Filter: 0
                          Buffers: shared hit=40
Planning Time: 0.273 ms
Execution Time: 0.652 ms
```

#### Global search: customers (limit 5)

```
Result (actual time=6.066..6.085 rows=5 loops=1)
  One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
  Buffers: shared hit=1066
  ->  Nested Loop (actual time=6.063..6.081 rows=5 loops=1)
        Buffers: shared hit=1066
        ->  Function Scan on app_search_customers (actual time=6.048..6.049 rows=5 loops=1)
              Buffers: shared hit=1046
        ->  Index Scan using customers_pkey on customers c (actual time=0.005..0.005 rows=1 loops=5)
              Index Cond: (id = app_search_customers.id)
              Filter: ("shopId" = 'perf_shop_main'::text)
              Buffers: shared hit=20
Planning Time: 0.187 ms
Execution Time: 6.108 ms
```

#### Global search: devices (limit 5)

```
Function Scan on app_search_devices (actual time=0.283..0.284 rows=5 loops=1)
  Buffers: shared hit=24
Planning Time: 0.024 ms
Execution Time: 0.292 ms
```

#### Global search: tickets (limit 5)

```
Limit (actual time=1.100..1.103 rows=5 loops=1)
  Buffers: shared hit=109
  ->  Sort (actual time=1.099..1.101 rows=5 loops=1)
        Sort Key: (max(app_search_customers.score)) DESC, t."createdAt" DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=109
        ->  Result (actual time=1.068..1.095 rows=10 loops=1)
              One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
              Buffers: shared hit=109
              ->  Nested Loop (actual time=1.065..1.091 rows=10 loops=1)
                    Buffers: shared hit=109
                    ->  GroupAggregate (actual time=1.059..1.064 rows=10 loops=1)
                          Group Key: t_1.id
                          Buffers: shared hit=69
                          ->  Sort (actual time=1.055..1.057 rows=10 loops=1)
                                Sort Key: t_1.id
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=69
                                ->  Append (actual time=1.032..1.052 rows=10 loops=1)
                                      Buffers: shared hit=69
                                      ->  Result (actual time=0.589..0.590 rows=0 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=20
                                            ->  Nested Loop (actual time=0.588..0.589 rows=0 loops=1)
                                                  Buffers: shared hit=20
                                                  ->  Function Scan on app_search_customers (actual time=0.588..0.588 rows=0 loops=1)
                                                        Buffers: shared hit=20
                                                  ->  Index Scan using tickets_customer_idx on tickets t_1 (never executed)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = app_search_customers.id))
                                      ->  Result (actual time=0.442..0.460 rows=10 loops=1)
                                            One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
                                            Buffers: shared hit=49
                                            ->  Nested Loop (actual time=0.440..0.456 rows=10 loops=1)
                                                  Buffers: shared hit=49
                                                  ->  Function Scan on app_search_devices (actual time=0.427..0.428 rows=5 loops=1)
                                                        Buffers: shared hit=24
                                                  ->  Index Scan using tickets_device_idx on tickets t_2 (actual time=0.004..0.005 rows=2 loops=5)
                                                        Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("deviceId" = app_search_devices.id))
                                                        Buffers: shared hit=25
                    ->  Index Scan using tickets_pkey on tickets t (actual time=0.002..0.002 rows=1 loops=10)
                          Index Cond: (id = t_1.id)
                          Filter: ("shopId" = 'perf_shop_main'::text)
                          Buffers: shared hit=40
Planning Time: 0.361 ms
Execution Time: 1.141 ms
```

#### Ticket timeline (50)

```
Limit (actual time=0.016..0.020 rows=4 loops=1)
  Buffers: shared hit=7
  ->  Result (actual time=0.015..0.019 rows=4 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=7
        ->  Index Scan using "ticket_events_shopId_ticketId_createdAt_id_idx" on ticket_events (actual time=0.012..0.015 rows=4 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("ticketId" = 'perf_t_50000'::text))
              Buffers: shared hit=7
Planning Time: 0.085 ms
Execution Time: 0.032 ms
```

#### Customer tickets tab

```
Limit (actual time=0.017..0.020 rows=3 loops=1)
  Buffers: shared hit=6
  ->  Result (actual time=0.016..0.019 rows=3 loops=1)
        One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
        Buffers: shared hit=6
        ->  Index Scan using tickets_customer_idx on tickets t (actual time=0.013..0.015 rows=3 loops=1)
              Index Cond: (("shopId" = 'perf_shop_main'::text) AND ("customerId" = 'perf_c_123'::text))
              Buffers: shared hit=6
Planning Time: 0.180 ms
Execution Time: 0.047 ms
```

#### [inside app_search_customers] name words (trigram)

```
Bitmap Heap Scan on customers c (actual time=0.388..1.335 rows=417 loops=1)
  Recheck Cond: ("searchText" ~~ '%thompson%'::text)
  Filter: (("searchText" ~~ ALL ('{%thompson%,%sofia%}'::text[])) AND ("shopId" = 'perf_shop_main'::text))
  Rows Removed by Filter: 752
  Heap Blocks: exact=983
  Buffers: shared hit=997
  ->  Bitmap Index Scan on customers_search_trgm_idx (actual time=0.267..0.267 rows=1169 loops=1)
        Index Cond: ("searchText" ~~ '%thompson%'::text)
        Buffers: shared hit=14
Planning:
  Buffers: shared hit=1
Planning Time: 0.142 ms
Execution Time: 1.368 ms
```

#### [inside app_search_customers] phone digits substring (trigram)

```
Bitmap Heap Scan on customer_phones p (actual time=0.530..0.571 rows=49 loops=1)
  Recheck Cond: (digits ~~ '%7919%'::text)
  Rows Removed by Index Recheck: 5
  Filter: ("shopId" = 'perf_shop_main'::text)
  Rows Removed by Filter: 2
  Heap Blocks: exact=54
  Buffers: shared hit=59
  ->  Bitmap Index Scan on customer_phones_digits_trgm_idx (actual time=0.517..0.517 rows=56 loops=1)
        Index Cond: (digits ~~ '%7919%'::text)
        Buffers: shared hit=5
Planning:
  Buffers: shared hit=1
Planning Time: 0.073 ms
Execution Time: 0.586 ms
```

#### [inside app_search_devices] IMEI/serial substring (trigram)

```
Bitmap Heap Scan on devices d (actual time=0.088..0.092 rows=5 loops=1)
  Recheck Cond: ((imei ~~ '%451653%'::text) OR (serial ~~ '%451653%'::text))
  Filter: ("shopId" = 'perf_shop_main'::text)
  Heap Blocks: exact=4
  Buffers: shared hit=22
  ->  BitmapOr (actual time=0.082..0.082 rows=0 loops=1)
        Buffers: shared hit=18
        ->  Bitmap Index Scan on devices_imei_trgm_idx (actual time=0.071..0.071 rows=5 loops=1)
              Index Cond: (imei ~~ '%451653%'::text)
              Buffers: shared hit=9
        ->  Bitmap Index Scan on devices_serial_trgm_idx (actual time=0.010..0.010 rows=0 loops=1)
              Index Cond: (serial ~~ '%451653%'::text)
              Buffers: shared hit=9
Planning:
  Buffers: shared hit=2
Planning Time: 0.099 ms
Execution Time: 0.105 ms
```

#### [contrast] same name search as the APP role without the function (RLS blocks the index)

```
Result (actual time=0.018..10.227 rows=417 loops=1)
  One-Time Filter: (NULLIF(current_setting('app.shop_id'::text, true), ''::text) = 'perf_shop_main'::text)
  Buffers: shared hit=1411
  ->  Seq Scan on customers c (actual time=0.016..10.183 rows=417 loops=1)
        Filter: (("shopId" = 'perf_shop_main'::text) AND ("searchText" ~~ '%thompson%'::text) AND ("searchText" ~~ ALL ('{%thompson%,%sofia%}'::text[])))
        Rows Removed by Filter: 52127
        Buffers: shared hit=1411
Planning Time: 0.104 ms
Execution Time: 10.260 ms
```
