/* global process, console, fetch, performance */
// Small HTTP load check (packages/db/PERF.md, "API"): 400 requests per scenario at 20 concurrent, after 40
// warm-up requests; prints p50/p95/p99 latency per scenario.
//   node apps/api/scripts/load-check.mjs http://localhost:4500 "<Cookie header>" apps/api/scripts/load-check.scenarios.json
import { readFileSync } from 'node:fs';

const [base, cookie, file] = process.argv.slice(2);
const scenarios = JSON.parse(readFileSync(file, 'utf8'));
const CONCURRENCY = 20;
const REQUESTS = 400;
const WARMUP = 40;

async function hit(path) {
  const t0 = performance.now();
  const res = await fetch(base + path, { headers: { cookie } });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`${path} → ${res.status}`);
  return performance.now() - t0;
}

async function run(paths, n) {
  const times = [];
  let i = 0;
  const worker = async () => {
    while (i < n) {
      const path = paths[i++ % paths.length];
      times.push(await hit(path));
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { times: times.sort((a, b) => a - b), wall: performance.now() - t0 };
}

const pct = (s, p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
console.log(`| Scenario | Requests | p50 ms | p95 ms | p99 ms | max ms | req/s |`);
console.log(`|---|---:|---:|---:|---:|---:|---:|`);
for (const [name, paths] of Object.entries(scenarios)) {
  await run(paths, WARMUP);
  const { times, wall } = await run(paths, REQUESTS);
  const f = (x) => x.toFixed(1);
  console.log(`| ${name} | ${REQUESTS} | ${f(pct(times, 50))} | ${f(pct(times, 95))} | ${f(pct(times, 99))} | ${f(times.at(-1))} | ${Math.round((REQUESTS / wall) * 1000)} |`);
}
