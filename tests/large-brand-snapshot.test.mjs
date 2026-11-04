// A national chain in the deals snapshot: its branches carried per shard, its totals measured once.
//
// Drives the built worker against a real SQLite database made from drizzle/*.sql, with a brand of
// four hundred branches in two states and a small Canadian chain beside it. A map cell's shard
// carries the branches within reach of the cell and a country's shard a sample per state
// (BRANCHES_PER_REGION), while the totals a card states are counted over every branch in D1. The
// things asserted are the ones a reader sees: how many locations a card says, which branch it names,
// how far away that is, and that a second isolate reading the colo's copy of the snapshot answers
// exactly as the first one did.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const CHUNK_DIR = new URL("../dist/server/_next/static/", import.meta.url);
const ROUTE_CHUNK_NAME = readdirSync(CHUNK_DIR).filter((name) => name.endsWith(".js"))
  .find((name) => readFileSync(new URL(name, CHUNK_DIR), "utf8").includes("__deals-snapshot"));
if (!ROUTE_CHUNK_NAME) throw new Error("could not find the deals route chunk in dist/server - run npm run build first");

const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__BRAND_TEST_ENV__?.[key] });
export const waitUntil = (promise) => { if (promise && typeof promise.then === "function") globalThis.__BRAND_TEST_WAITS__.push(promise.catch(() => {})); };
`)}`;
globalThis.__BRAND_TEST_WAITS__ = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ALIAS, shortCircuit: true };
    if (globalThis.__BRAND_ISOLATE__ && specifier.includes(ROUTE_CHUNK_NAME) && !specifier.includes("isolate=")) {
      return nextResolve(`${specifier}?isolate=${globalThis.__BRAND_ISOLATE__}`, context);
    }
    return nextResolve(specifier, context);
  },
});

// D1's API over node:sqlite, as scripts/prerender-deals.mjs does it.
function d1(db) {
  const plain = (row) => ({ ...row });
  const statement = (sql, binds) => ({
    bind: (...args) => statement(sql, args),
    first: async (column) => { const row = db.prepare(sql).get(...binds); if (row === undefined) return null; return column === undefined ? plain(row) : (row[column] ?? null); },
    all: async () => ({ results: db.prepare(sql).all(...binds).map(plain), success: true, meta: {} }),
    run: async () => { const info = db.prepare(sql).run(...binds); return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } }; },
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => Promise.all(list.map((entry) => entry.all())) };
}

const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };
const KNOXVILLE = { latitude: 35.9606, longitude: -83.9207 };
const MORRISTOWN = { latitude: 36.2140, longitude: -83.2949 };

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  const restaurant = db.prepare("INSERT INTO restaurants (id,name,cuisine,is_chain,website) VALUES (?,?,?,?,?)");
  const branch = db.prepare("INSERT INTO restaurant_locations (id,restaurant_id,address,city,region,country,postal_prefix,latitude,longitude,timezone,status) VALUES (?,?,?,?,?,?,?,?,?,?,'operating')");
  const deal = db.prepare(`INSERT INTO deals (id,slug,restaurant,restaurant_id,location_id,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url,location_scope)
    VALUES (?,?,?,?,?,?,'Food deal','American','Daily',?,?,?,?,'🍔','https://example.test/offer',?)`);

  // 250 branches around Austin and 150 around Knoxville, laid out on a grid so distances are exact
  // enough to reason about: each step is ~1.1 km of latitude.
  restaurant.run("brand-us", "Burger Brand", "American", 1, "https://burgerbrand.example");
  for (let i = 0; i < 250; i++) {
    branch.run(`b-tx-${i}`, "brand-us", `${100 + i} Congress Ave`, "Austin", "TX", "US", "787",
      AUSTIN.latitude + (i % 25) * 0.01, AUSTIN.longitude + Math.floor(i / 25) * 0.01, "America/Chicago");
  }
  for (let i = 0; i < 150; i++) {
    branch.run(`b-tn-${i}`, "brand-us", `${100 + i} Kingston Pike`, "Knoxville", "TN", "US", "379",
      KNOXVILLE.latitude + (i % 15) * 0.01, KNOXVILLE.longitude + Math.floor(i / 15) * 0.01, "America/New_York");
  }
  // One branch in Morristown, 60-odd km from Knoxville.
  branch.run("b-tn-morristown", "brand-us", "1 W Morris Blvd", "Morristown", "TN", "US", "378", MORRISTOWN.latitude, MORRISTOWN.longitude, "America/New_York");
  // Two national promotions on the same brand, both brand-wide. Two deals on one large brand is the
  // case the grouping used to handle in branches x branches time.
  deal.run("brand-value", "brand-value", "Burger Brand", "brand-us", "b-tx-0", "Value menu", "Austin", "787", "100 Congress Ave", "$5 meal", "brand");
  deal.run("brand-app", "brand-app", "Burger Brand", "brand-us", "b-tx-0", "Free fries Friday", "Austin", "787", "100 Congress Ave", "Free fries", "brand");
  // A per-branch promotion on the same large brand, confirmed at the first 20 Knoxville branches only.
  deal.run("brand-knox", "brand-knox", "Burger Brand", "brand-us", "b-tn-0", "Vols win, free sandwich", "Knoxville", "379", "100 Kingston Pike", "Free sandwich", null);
  const link = db.prepare("INSERT INTO deal_locations (deal_id,location_id,eligibility) VALUES (?,?,'confirmed')");
  for (let i = 0; i < 20; i++) link.run("brand-knox", `b-tn-${i}`);

  // A small Canadian chain, which must keep the per-deal path exactly.
  restaurant.run("small-ca", "Poutine Place", "Canadian", 1, "https://poutine.example");
  branch.run("s-1", "small-ca", "1 Bank St", "Ottawa", "ON", "CA", "K1P", 45.4215, -75.6972, "America/Toronto");
  branch.run("s-2", "small-ca", "2 Elgin St", "Ottawa", "ON", "CA", "K2P", 45.4180, -75.6900, "America/Toronto");
  deal.run("small-deal", "small-deal", "Poutine Place", "small-ca", "s-1", "Poutine Tuesday", "Ottawa", "K1P", "1 Bank St", "$6 poutine", null);

  // Three US chains Radar holds no branches for (drizzle/0050): a deal row each and no location,
  // placed by the brand row's country and footprint. Taco Chain trades in Texas and California and
  // Sub Chain in Tennessee and Texas - Kentucky counted at zero - and Pie Chain was never counted.
  const brandRow = db.prepare("INSERT INTO restaurants (id,name,cuisine,is_chain,website,country,footprint,locator_url) VALUES (?,?,?,1,?,?,?,?)");
  brandRow.run("tacos-us", "Taco Chain", "Mexican", "https://tacos.example", "US", JSON.stringify({ TX: 120, CA: 300 }), "https://tacos.example/locations");
  brandRow.run("subs-us", "Sub Chain", "Deli", "https://subs.example", "US", JSON.stringify({ TN: 40, TX: 90, KY: 0 }), "https://subs.example/find");
  brandRow.run("pie-us", "Pie Chain", "Pizza", "https://pie.example", "US", null, null);
  deal.run("tacos-tuesday", "tacos-tuesday", "Taco Chain", "tacos-us", null, "Taco Tuesday", "", "", "", "$1 tacos", "national");
  deal.run("subs-bogo", "subs-bogo", "Sub Chain", "subs-us", null, "BOGO subs", "", "", "", "Buy one, get one free", "national");
  deal.run("pie-large", "pie-large", "Pie Chain", "pie-us", null, "$10 large pizza", "", "", "", "$10 large pizza", "national");
  return db;
}

const cache = new Map();
globalThis.caches = {
  default: {
    match: async (request) => { const hit = cache.get(request.url); return hit ? new Response(hit) : undefined; },
    put: async (request, response) => { cache.set(request.url, await response.text()); },
    delete: async (request) => cache.delete(request.url),
  },
};

const db = database();
let queries = 0;
const counted = d1(db);
// R2 as the route uses it: one object per key, its metadata beside it.
const bucket = new Map();
const PHOTOS = {
  get: async (key) => {
    const entry = bucket.get(key);
    return entry ? { customMetadata: entry.customMetadata, text: async () => entry.body, body: { cancel: async () => {} } } : null;
  },
  put: async (key, body, options) => {
    bucket.set(key, { body: typeof body === "string" ? body : await new Response(body).text(), customMetadata: options?.customMetadata ?? {} });
  },
};
globalThis.__BRAND_TEST_ENV__ = { DB: { ...counted, prepare: (sql) => { queries++; return counted.prepare(sql); } }, PHOTOS, ASSETS: { fetch: async () => new Response("", { status: 404 }) } };

async function isolate(token) {
  globalThis.__BRAND_ISOLATE__ = token;
  const { default: worker } = await import(`${new URL("../dist/server/index.js", import.meta.url).href}?isolate=${token}`);
  return async (path) => {
    const response = await worker.fetch(new Request(`https://radar.cheap${path}`), globalThis.__BRAND_TEST_ENV__, { waitUntil() {}, passThroughOnException() {} });
    for (let i = 0; i < 5 && globalThis.__BRAND_TEST_WAITS__.length; i++) { const pending = globalThis.__BRAND_TEST_WAITS__; globalThis.__BRAND_TEST_WAITS__ = []; await Promise.all(pending); }
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    return response.json();
  };
}

const first = await isolate("one");
const card = (body, restaurant = "Burger Brand") => body.results.find((deal) => deal.restaurant === restaurant);
// drizzle/ seeds about fifty Canadian chain deals of its own, enough to fill the first page of a
// Canadian request, so that one names the fixture's deal. Naming deals by id also turns chain
// grouping off (it is the Saved tab's request), which is why the US requests do not. drizzle/ now
// seeds enough live US deals to fill a US page too, so the US requests that look for the brand's
// card search for it by name (q), which keeps chain grouping on.
const OURS = "id=small-deal";
const BRAND_Q = "q=Burger%20Brand";

test("an unlocated card names the deal's own branch and the brand's true totals", async () => {
  const body = await first(`/api/deals?country=US&${BRAND_Q}`);
  const brand = card(body);
  assert.ok(brand, "the brand has a card");
  assert.equal(brand.chain_location_count, 401, "every branch, not the ones this request drew");
  assert.equal(brand.participating_location_count, 401, "a brand-wide deal is confirmed at all of them");
  assert.equal(brand.address, "100 Congress Ave", "the deal's own branch leads an unlocated card");
  assert.ok(brand.chain_locations.length <= 40, "and the response carries a page of them, not 401");
});

test("a reader in Knoxville gets the nearest Knoxville branch and its distance", async () => {
  const body = await first(`/api/deals?lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&radius=10`);
  const brand = card(body);
  assert.ok(brand, "the brand is in range");
  assert.equal(brand.city, "Knoxville");
  assert.ok(brand.distance_km < 0.5, `the nearest branch is right there, got ${brand.distance_km} km`);
  assert.equal(brand.chain_location_count, 401);
  assert.ok(brand.chain_locations.every((location) => location.region === "TN"), "nothing from Texas is drawn for a Knoxville reader");
  const distances = brand.chain_locations.map((location) => Math.hypot(location.latitude - KNOXVILLE.latitude, location.longitude - KNOXVILLE.longitude));
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), "nearest first");
});

test("a reader in Morristown reaches the Morristown branch", async () => {
  const body = await first(`/api/deals?lat=${MORRISTOWN.latitude}&lng=${MORRISTOWN.longitude}&radius=10`);
  const brand = card(body);
  assert.ok(brand, "the brand is in range of Morristown");
  assert.equal(brand.address, "1 W Morris Blvd");
  assert.ok(!card(body, "Poutine Place"), "and an Ottawa chain is not");
});

test("a named state shows only that state's branches", async () => {
  // Answered from the country's shard, whose sample has branches in both states; the card shows
  // the Tennessee ones.
  const body = await first(`/api/deals?province=TN`);
  const brand = card(body);
  assert.ok(brand, "the brand has a branch in Tennessee");
  assert.ok(brand.chain_locations.length > 0 && brand.chain_locations.every((location) => location.region === "TN"));
  assert.equal(brand.chain_location_count, 401, "the total is still the brand's");
  assert.ok(!card(await first(`/api/deals?province=ON`), "Burger Brand"), "and not in Ontario");
});

test("a per-branch promotion on a large brand counts only its confirmed branches", async () => {
  const body = await first(`/api/deals?id=brand-knox&lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&radius=10`);
  const knox = body.results.find((deal) => deal.id === "brand-knox");
  assert.ok(knox, "the Knoxville promotion is in range of Knoxville");
  assert.equal(knox.participating_location_count, 20);
  assert.equal(knox.chain_location_count, 401);
  assert.ok(!("location_eligibility" in knox), "the eligibility map is internal and never leaves the route");
  const austin = await first(`/api/deals?id=brand-knox&lat=${AUSTIN.latitude}&lng=${AUSTIN.longitude}&radius=25`);
  assert.equal(austin.results.length, 0, "and it is not offered to a reader in Austin");
});

test("a small chain keeps its exact per-deal locations", async () => {
  const body = await first(`/api/deals?${OURS}&country=CA`);
  const small = card(body, "Poutine Place");
  assert.ok(small);
  assert.equal(small.chain_location_count, 2);
  assert.equal(small.chain_locations.length, 2);
  assert.equal(small.participating_location_count, 1, "confirmed only at its own address, as always");
});

const NATIONAL = ["Pie Chain", "Sub Chain", "Taco Chain"];
const names = (body) => body.results.map((deal) => deal.restaurant).sort();

test("a national deal stays out of the local feed", async () => {
  // It has no branch to name and no distance to give, and every client that plots, measures or
  // groups the local feed would have to learn it first.
  for (const path of [`/api/deals?country=US`, `/api/deals?lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&radius=10`, `/api/deals?province=TN`, `/api/deals`]) {
    const body = await first(path);
    for (const name of NATIONAL) assert.ok(!card(body, name), `${name} is not a local card (${path})`);
  }
});

test("the national list is placed by country and footprint, never by distance", async () => {
  assert.deepEqual(names(await first(`/api/deals?scope=national&country=US`)), NATIONAL);
  // Tennessee: Sub Chain trades there, Taco Chain does not, and Pie Chain was never counted - which
  // shows it rather than hides it.
  assert.deepEqual(names(await first(`/api/deals?scope=national&country=US&province=TN`)), ["Pie Chain", "Sub Chain"]);
  // A region counted at zero is not one the chain trades in.
  assert.deepEqual(names(await first(`/api/deals?scope=national&country=US&province=KY`)), ["Pie Chain"]);
  const located = await first(`/api/deals?scope=national&lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&country=US&province=TN`);
  assert.deepEqual(names(located), ["Pie Chain", "Sub Chain"]);
  assert.ok(located.results.every((deal) => deal.distance_km == null), "a chain with no branch here has no distance");
  assert.equal(located.expandRadius, null, "and no radius to widen");
  assert.equal((await first(`/api/deals?scope=national&country=CA`)).results.length, 0, "no US chain in Canada");
  assert.ok(!card(await first(`/api/deals?scope=national&country=US`)), "a brand-wide deal with branches stays a local card");
});

test("a national card says whose dollars and where to find a branch", async () => {
  const body = await first(`/api/deals?scope=national&country=US&view=compact`);
  const subs = body.results.find((deal) => deal.id === "subs-bogo");
  assert.ok(subs, "the compact shape carries national cards too");
  assert.equal(subs.country, "US", "the brand row's market, since there is no branch to take it from");
  assert.equal(subs.location_scope, "national");
  assert.equal(subs.restaurant_locator_url, "https://subs.example/find");
  assert.ok(!("latitude" in subs) && !("participating_locations" in subs), "and no pin");
});

test("a saved national deal still comes back by id, wherever the reader is", async () => {
  const body = await first(`/api/deals?id=subs-bogo&lat=${AUSTIN.latitude}&lng=${AUSTIN.longitude}&radius=10`);
  assert.deepEqual(body.results.map((deal) => deal.id), ["subs-bogo"]);
});

test("two brand-wide deals on one brand group into one card without a quadratic merge", async () => {
  const started = performance.now();
  const body = await first(`/api/deals?country=US&${BRAND_Q}`);
  const brandCards = body.results.filter((deal) => deal.restaurant === "Burger Brand" && deal.id !== "brand-knox");
  assert.equal(brandCards.length, 1, "one card for the brand's national offers");
  assert.ok(performance.now() - started < 2000, "a branches x branches merge would not finish in this");
});

test("a second isolate reads the colo's copy and answers identically", async () => {
  const before = queries;
  const second = await isolate("two");
  const path = `/api/deals?lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&radius=10`;
  const [fromFirst, fromSecond] = [await first(path), await second(path)];
  const strip = (body) => body.results.map(({ id, address, distance_km, chain_location_count, participating_location_count, chain_locations }) =>
    ({ id, address, distance_km, chain_location_count, participating_location_count, chain: chain_locations.map((location) => location.location_id) }));
  assert.deepEqual(strip(fromSecond), strip(fromFirst));
  // The revision lookup is one query; a rebuild would be seven.
  assert.ok(queries - before <= 3, `the second isolate should adopt the shared snapshot, not rebuild it (${queries - before} queries)`);
});

test("a colo that has never seen this revision takes another colo's build from R2", async () => {
  await first(`/api/deals?country=US`);
  assert.ok(bucket.size >= 1, "the first build was published to R2");
  // Another datacenter: nothing in its Cache API, not even the revision.
  cache.clear();
  const before = queries;
  const third = await isolate("three");
  const body = await third(`/api/deals?lat=${KNOXVILLE.latitude}&lng=${KNOXVILLE.longitude}&radius=10`);
  assert.equal(card(body)?.address, "100 Kingston Pike", "the same answer the building colo gives");
  assert.equal(queries - before, 1, "one query - the revision, for the whole colo - and no rebuild");
});

test("when D1 refuses every read, a cold colo still serves the last snapshot from R2", async () => {
  cache.clear();
  const working = globalThis.__BRAND_TEST_ENV__.DB;
  const refused = () => { throw new Error("D1_ERROR: exceeded the daily read limit"); };
  globalThis.__BRAND_TEST_ENV__.DB = { prepare: refused, batch: async () => refused() };
  try {
    const fourth = await isolate("four");
    const body = await fourth(`/api/deals?country=US&${BRAND_Q}`);
    assert.ok(card(body), "deals, from the copy in R2, instead of an error");
  } finally {
    globalThis.__BRAND_TEST_ENV__.DB = working;
  }
});
