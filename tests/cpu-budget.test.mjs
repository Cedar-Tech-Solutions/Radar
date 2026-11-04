// What the public routes cost in CPU, held to a budget.
//
// A Worker on the Cloudflare free plan has ten milliseconds of CPU per request, and past it the
// visitor gets error 1102. Twice now the site has grown into that limit without anything failing
// here: the deals search measured, grouped and filtered the whole catalogue for every request, and
// a page for a signed-in reader was a full render. Nothing in the suite noticed, because nothing
// in the suite measured. This does: it drives the built worker against a SQLite copy of the
// migrated catalogue - 2,500-odd deals, every branch given a coordinate - and takes each request's
// CPU time, with SQLite's own time (D1's, in production) taken out.
//
// The figures are this machine's, under Node, with the cost of a request's reads excluded: a
// relative measure, not the Worker's clock. Each ceiling is a few times what the request costs
// after the work in docs/CPU-BUDGET.md, so a change that doubles one fails here and a noisy minute
// does not: the least of several runs is what is compared, after a warm-up, since the first run of
// anything pays for its compilation. A ceiling that has become too tight for an honest change is
// raised here with the reason; one that trips without a change is a regression to find.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__BUDGET_ENV__?.[key] });
export const waitUntil = (promise) => { if (promise && typeof promise.then === "function") globalThis.__BUDGET_WAITS__.push(promise.catch(() => {})); };
`)}`;
globalThis.__BUDGET_WAITS__ = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ALIAS, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// SQLite's time, kept out of the figures: a D1 query runs on D1's clock, not the Worker's.
let sqlMs = 0;
const timed = (run) => { const before = process.cpuUsage(); try { return run(); } finally { const used = process.cpuUsage(before); sqlMs += (used.user + used.system) / 1000; } };

function d1(db) {
  const plain = (row) => ({ ...row });
  const statement = (sql, binds) => ({
    bind: (...args) => statement(sql, args.map((value) => (typeof value === "boolean" ? Number(value) : value))),
    first: async (column) => { const row = timed(() => db.prepare(sql).get(...binds)); if (row === undefined) return null; return column === undefined ? plain(row) : (row[column] ?? null); },
    all: async () => ({ results: timed(() => db.prepare(sql).all(...binds).map(plain)), success: true, meta: {} }),
    run: async () => { const info = timed(() => db.prepare(sql).run(...binds)); return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } }; },
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => Promise.all(list.map((entry) => entry.all())) };
}

// The migrated catalogue, with a coordinate for every branch: the ones the geocode job has not
// placed get their city's centre and up to eight kilometres of deterministic scatter, so a located
// search finds a city's worth of deals in its cell, as one does in production.
function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  const hash = (text) => { let h = 2166136261; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
  const centres = new Map();
  for (const row of db.prepare("SELECT city,country,AVG(latitude) lat,AVG(longitude) lng,SUM(latitude IS NOT NULL) n FROM restaurant_locations GROUP BY city,country").all()) {
    const key = `${row.city}|${row.country}`;
    if (row.n > 0) centres.set(key, { lat: row.lat, lng: row.lng });
    else { const h = hash(key); centres.set(key, { lat: 30 + (h % 2000) / 100, lng: -125 + ((h >>> 11) % 5500) / 100 }); }
  }
  const place = db.prepare("UPDATE restaurant_locations SET latitude=?,longitude=?,geo_precision='exact' WHERE id=?");
  for (const row of db.prepare("SELECT id,city,country FROM restaurant_locations WHERE latitude IS NULL").all()) {
    const centre = centres.get(`${row.city}|${row.country}`);
    const h = hash(row.id);
    place.run(centre.lat + ((h % 1600) - 800) / 10000, centre.lng + (((h >>> 11) % 1600) - 800) / 10000, row.id);
  }
  return db;
}

const db = database();
const cache = new Map();
globalThis.caches = {
  default: {
    match: async (request) => { const hit = cache.get(request.url); return hit ? new Response(hit.body, { headers: hit.headers }) : undefined; },
    put: async (request, response) => { cache.set(request.url, { body: await response.arrayBuffer(), headers: [...response.headers] }); },
    delete: async (request) => cache.delete(request.url),
  },
};
const bucket = new Map();
globalThis.__BUDGET_ENV__ = {
  DB: d1(db),
  PHOTOS: {
    get: async (key) => { const entry = bucket.get(key); return entry ? { customMetadata: entry.customMetadata, text: async () => entry.body, body: { cancel: async () => {} } } : null; },
    put: async (key, body, options) => { bucket.set(key, { body: typeof body === "string" ? body : await new Response(body).text(), customMetadata: options?.customMetadata ?? {} }); },
  },
  ASSETS: { fetch: async (request) => (new URL(request.url).pathname === "/en" ? new Response(BAKED_HOME, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("", { status: 404 })) },
  CF_VERSION: { id: "budget" },
};
// A baked page the size of the real one, so marking it for a signed-in reader is measured honestly.
const BAKED_HOME = `<!doctype html><html lang="en"><head><title>Radar</title></head><body>${"<p>deals near you</p>".repeat(8000)}</body></html>`;
const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url).href);

// A city the catalogue holds many deals in, found rather than named, so the fixture stays honest
// as the migrations change.
const busiest = db.prepare(`SELECT l.city,AVG(l.latitude) lat,AVG(l.longitude) lng,COUNT(DISTINCT d.id) deals
  FROM deals d JOIN restaurant_locations l ON l.id=d.location_id
  WHERE d.status='live' AND d.active=1 AND d.deleted_at IS NULL AND d.location_scope IS NOT 'national'
  GROUP BY l.city,l.country ORDER BY deals DESC LIMIT 1`).get();
assert.ok(busiest && busiest.deals >= 30, `expected a city with a few dozen live deals, got ${JSON.stringify(busiest)}`);
const slug = db.prepare("SELECT slug FROM deals WHERE status='live' AND active=1 AND deleted_at IS NULL AND slug IS NOT NULL LIMIT 1").get().slug;

async function settle() {
  for (let i = 0; i < 5 && globalThis.__BUDGET_WAITS__.length; i++) { const pending = globalThis.__BUDGET_WAITS__; globalThis.__BUDGET_WAITS__ = []; await Promise.all(pending); }
}

/** One request's CPU in milliseconds, SQLite's time taken out, and its response. */
async function cost(path, headers = {}) {
  const request = new Request(`https://radar.cheap${path}`, { headers: { host: "radar.cheap", accept: path.startsWith("/api/") ? "application/json" : "text/html", ...headers } });
  // The answer a search stored is forgotten before the next, so each run is the search itself over
  // the held snapshot - what a request pays on every URL the colo has not seen - and not the
  // cache hit a repeat of the same URL gets (sharedDealsAnswer in worker/index.ts).
  for (const key of [...cache.keys()]) if (key.includes("/__deals-answer/")) cache.delete(key);
  sqlMs = 0;
  const before = process.cpuUsage();
  const response = await worker.fetch(request, globalThis.__BUDGET_ENV__, { waitUntil(promise) { globalThis.__BUDGET_WAITS__.push(Promise.resolve(promise).catch(() => {})); }, passThroughOnException() {} });
  const body = await response.text();
  const used = process.cpuUsage(before);
  await settle();
  return { ms: (used.user + used.system) / 1000 - sqlMs, status: response.status, body };
}

/** The least CPU of `runs` requests after `warm` unmeasured ones, and the last response. */
async function least(path, headers, { warm = 5, runs = 10 } = {}) {
  const seen = [];
  let last;
  for (let i = 0; i < warm + runs; i++) {
    last = await cost(path, headers);
    assert.equal(last.status, 200, `${path} answered ${last.status}: ${last.body.slice(0, 200)}`);
    if (i >= warm) seen.push(last.ms);
  }
  return { ...last, ms: Math.min(...seen), runs: seen };
}

// CPU_BUDGET_LOG=1 prints each figure, for setting a ceiling.
const within = (name, measured, ceiling) => {
  if (process.env.CPU_BUDGET_LOG) console.error(`${name}: ${measured.ms.toFixed(1)} ms (ceiling ${ceiling}; runs ${measured.runs.map((ms) => ms.toFixed(1)).join(" ")})`);
  assert.ok(measured.ms <= ceiling, `${name}: ${measured.ms.toFixed(1)} ms of CPU, over the ${ceiling} ms ceiling (see tests/cpu-budget.test.mjs)`);
};

test("a located search reads its own cells, not the catalogue", async () => {
  const path = `/api/deals?lat=${busiest.lat}&lng=${busiest.lng}&radius=10&tz=America/Toronto&limit=24`;
  const search = await least(path, {});
  const body = JSON.parse(search.body);
  assert.ok(body.results.length >= 10, `a search in ${busiest.city} finds deals, got ${body.results.length}`);
  // Measured at 3-8 ms after the sharded snapshot; 12-35 ms before it.
  within(`a located search in ${busiest.city}`, search, 20);
  const typed = await least(`${path}&q=wings`, {});
  // 33 ms before the search text was normalised once per shard; 3 ms after.
  within("a keyword search", typed, 20);
});

test("the nationwide list and a deal by slug are cheap", async () => {
  within("the nationwide chain list", await least("/api/deals?scope=national&country=CA&view=compact&limit=200", {}), 15);
  within("a deal by slug", await least(`/api/deals/${slug}`, {}), 10);
});

test("the whole-country list stays within its budget", async () => {
  // The one request that still reads a country's every deal: a search with no place and no
  // country, which the website's first paint no longer makes. 46 ms here on 2,500 deals when the
  // ceiling was set, against ~1,200 live in production.
  within("the unplaced list", await least("/api/deals?limit=24", {}), 90);
});

test("a baked page costs next to nothing, for a signed-in reader too", async () => {
  within("the baked home page", await least("/en", {}), 4);
  // Marked for a signed-in reader by one pass over the body (signedInCopy in worker/index.ts): a
  // page such a reader used to get as a full render, at 25-57 ms.
  const marked = await least("/en", { cookie: "__session=eyJhbGciOiJSUzI1NiJ9.e30.sig" });
  assert.match(marked.body, /^<!doctype html><html data-signed-in="" lang="en">/);
  within("the baked home page, marked for a signed-in reader", marked, 6);
});

// A fresh isolate's first request paid 7-9 ms before any work of its own - the framework's router
// and request machinery compiled and run for the first time - and the platform starts a fresh
// isolate for a burst of traffic, after a deploy and whenever it moves the Worker. The bundle now
// makes one request through the framework at startup (`warmed` in worker/index.ts), under the
// startup allowance rather than a visitor's. Each isolate here is a fresh import of the bundle,
// its warm-up awaited the way the runtime would have it settle before the first request arrives,
// and the first request's CPU is what is measured: 1.5 ms after the warm-up, 8.8 without it.
test("a fresh isolate's first request is not the one that pays for the framework", async () => {
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const url = new URL("../dist/server/index.js", import.meta.url);
    url.searchParams.set("isolate", `${process.pid}-${Date.now()}-${i}`);
    const fresh = await import(url.href);
    await fresh.warmed;
    await settle();
    for (const key of [...cache.keys()]) if (key.includes("/__deals-answer/")) cache.delete(key);
    sqlMs = 0;
    const before = process.cpuUsage();
    const response = await fresh.default.fetch(new Request(`https://radar.cheap/api/deals/${slug}`, { headers: { host: "radar.cheap", accept: "application/json" } }), globalThis.__BUDGET_ENV__, { waitUntil(promise) { globalThis.__BUDGET_WAITS__.push(Promise.resolve(promise).catch(() => {})); }, passThroughOnException() {} });
    const body = await response.text();
    const used = process.cpuUsage(before);
    assert.equal(response.status, 200, body.slice(0, 200));
    runs.push((used.user + used.system) / 1000 - sqlMs);
    await settle();
  }
  // 3-6 ms here when the ceiling was set (the route's own chunk is still compiled on its first
  // request); 8-9 without the warm-up.
  within("a fresh isolate's first request, a deal by slug", { ms: Math.min(...runs), runs }, 7);
});
