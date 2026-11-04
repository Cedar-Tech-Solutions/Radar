// The deals snapshot is shared between the isolates of a colo through the Cache API, so that a
// deploy costs one build per colo rather than one per isolate — and so a cold isolate can still
// serve when D1 will not answer.
//
// This drives the built worker, twice, from two separate module instances. That is what makes the
// test meaningful: a fresh import of dist/server/index.js has its own module-level state, which is
// exactly what a new isolate is. The two share one fake Cache and each gets its own D1 that counts
// what it was asked. The question the whole feature turns on — does the second isolate touch D1 —
// is then a number, not an inference.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

// The bundle takes `env` and `waitUntil` from cloudflare:workers, not from its fetch arguments, so
// the module has to be supplied. `env` is a proxy rather than a snapshot because every isolate here
// is a fresh import while this alias module is instantiated once — reading through to the global on
// each access is what lets each isolate see its own database.
// The route chunk carries a build hash in its name, so it is located by content.
const CHUNK_DIR = new URL("../dist/server/_next/static/", import.meta.url);
const ROUTE_CHUNK_NAME = (() => {
  const named = readdirSync(CHUNK_DIR).filter((name) => name.endsWith(".js"));
  const match = named.find((name) => readFileSync(new URL(name, CHUNK_DIR), "utf8").includes("__deals-snapshot"));
  if (!match) throw new Error("could not find the deals route chunk in dist/server — run npm run build first");
  return match;
})();

const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__TEST_ENV__?.[key] });
export const waitUntil = (promise) => {
  if (promise && typeof promise.then === "function") globalThis.__TEST_WAITS__.push(promise.catch(() => {}));
};
`)}`;
globalThis.__TEST_ENV__ = {};
globalThis.__TEST_WAITS__ = [];
// Two jobs. Supply cloudflare:workers, and give each isolate its own copy of the deals route.
//
// The second is the one that makes this test mean anything. dist/server/index.js reaches the route
// through a dynamic import of a fixed path, so re-importing index.js under a new query string
// produces a fresh wrapper around the same route module — and the route module is where
// cachedSnapshot lives. Written that way, the second "isolate" served from the first one's
// in-memory snapshot and the test passed with the Cache API doing nothing at all. Rewriting the
// chunk specifier here is what actually gives a new isolate the empty memory it really has.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ALIAS, shortCircuit: true };
    if (globalThis.__ISOLATE_TOKEN__ && specifier.includes(ROUTE_CHUNK_NAME) && !specifier.includes("isolate=")) {
      return nextResolve(`${specifier}?isolate=${globalThis.__ISOLATE_TOKEN__}`, context);
    }
    return nextResolve(specifier, context);
  },
});

// Background work the worker handed to waitUntil — the shared-snapshot write among it. Awaiting it
// explicitly beats sleeping and hoping.
async function settleBackgroundWork() {
  for (let i = 0; i < 5 && globalThis.__TEST_WAITS__.length; i += 1) {
    const pending = globalThis.__TEST_WAITS__;
    globalThis.__TEST_WAITS__ = [];
    await Promise.all(pending);
  }
}

// The fixed `updated_at` the fake database reports for all three tables, which the route hashes
// into the cache key. Changing it is how a test simulates a staff edit.
const REVISION = "2026-09-19 00:00:00";

const DEAL = {
  id: "deal-1",
  slug: "half-price-wings",
  restaurant: "The Test Tavern",
  canonical_restaurant: "The Test Tavern",
  canonical_restaurant_id: "restaurant-1",
  title: "Half-price wings",
  description: "",
  category: "food",
  cuisine: "pub",
  city: "Ottawa",
  region: "ON",
  country: "CA",
  address: "1 Test St",
  postal_prefix: "K1A",
  price: "$9",
  price_tier: 2,
  schedule: "Mon-Fri 3-6pm",
  terms: "",
  restrictions: "",
  emoji: "🍗",
  status: "live",
  active: 1,
  sponsored: 0,
  deleted_at: null,
  source_url: "https://tavern.test/",
  restaurant_website: "https://tavern.test/",
  restaurant_photo_url: null,
  restaurant_phone: null,
  amenities: "[]",
  dietary_options: "[]",
  accessibility: "[]",
  is_chain: 0,
  vertical: "restaurant",
  latitude: 45.42,
  longitude: -75.7,
  timezone: "America/Toronto",
  eligible_location_id: "location-1",
  neighborhood: null,
  location_website: null,
  schedule_days: "1,2,3,4,5",
  start_time: "15:00",
  end_time: "18:00",
  recurring: 1,
  save_count: 0,
  verification_status: "verified",
  effective_verification_status: "verified",
  verified_at: new Date().toISOString(),
  expires_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Answers the queries a shard build makes, and counts them. Anything it does not recognize comes
// back empty rather than throwing, so an unrelated query added later fails loudly in the assertion
// about counts rather than silently here. It filters nothing: every shard - a map cell, a country,
// the nationwide list - is answered with every deal, and the route's own per-request filters sort
// them out, as they would a real shard that happened to hold the same rows.
function fakeD1(revision = REVISION, data = { deals: [DEAL], branches: [] }) {
  const asked = [];
  const rowsFor = (sql) => {
    if (sql.includes("FROM deals d LEFT JOIN restaurants")) return data.deals;
    if (sql.includes("FROM restaurant_locations l WHERE")) return data.branches;
    // Not merely "FROM deal_aliases": the revision query reads that table's rowid too.
    if (sql.startsWith("SELECT alias_id,canonical_deal_id FROM deal_aliases")) return data.aliases || [];
    if (sql.startsWith("SELECT * FROM market_coverage")) return data.markets || [];
    // The revision the route hashes into the cache key. Fixed, so every isolate in a test agrees
    // on the key; a test that wants to simulate an edit changes it through `revision`.
    if (sql.includes("MAX(updated_at)")) return [{ d: revision, r: revision, l: revision }];
    return [];
  };
  const prepare = (sql) => {
    asked.push(sql);
    const statement = {
      sql,
      bind: () => statement,
      all: async () => ({ results: rowsFor(sql), success: true, meta: {} }),
      first: async () => rowsFor(sql)[0] ?? null,
      run: async () => ({ success: true }),
    };
    return statement;
  };
  return {
    asked,
    // The reads that build a shard: its deals (every shard starts with that one query), and the
    // markets the meta shard reads. A read of deals by id is left out - the Saved tab's request is
    // answered straight from D1 on purpose, held by nobody, so it says nothing about the snapshot.
    get snapshotQueries() {
      return asked.filter((sql) =>
        (sql.includes("FROM deals d LEFT JOIN restaurants") && !sql.includes("d.id IN (SELECT value FROM json_each")) || sql.startsWith("SELECT * FROM market_coverage"),
      ).length;
    },
    prepare,
    // The secondary reads of a build travel as one batch, which is one subrequest - see batched().
    batch: async (statements) => Promise.all(statements.map((statement) => statement.all())),
  };
}

// A Cache standing in for the colo's. Keyed by URL, like the real one.
//
// Whole answers (sharedAnswerKey in the route) are only kept when a test asks for them. Every call
// in this file is the same anonymous URL, and the answers layer would hand the second isolate the
// first one's response before the snapshot this file is about was ever reached.
function fakeCache({ answers = false } = {}) {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const hit = store.get(typeof request === "string" ? request : request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        const key = typeof request === "string" ? request : request.url;
        if (!answers && key.includes("/__deals-answer/")) return;
        store.set(key, response);
      },
    },
  };
}

// The route's own chunk, not dist/server/index.js.
//
// This distinction is the test. index.js reaches the route through a dynamic import of a fixed
// path, so re-importing index.js under a new query string produces a fresh wrapper around the same
// route module — and the route module is where cachedSnapshot lives. Written that way, a second
// "isolate" served from the first one's in-memory snapshot and the test passed without the Cache
// API doing anything at all. Importing the chunk itself, under a unique query, is what actually
// yields the fresh module state a new isolate has.
//
// Located by content rather than by name, because the filename carries a build hash.
// A fresh module instance: its own module-level cachedSnapshot, exactly like a new isolate. The
// route still runs through the worker, which is what gives it the request context `headers()` and
// the rest of the handler need.
async function isolate(revision = REVISION, data = undefined) {
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  globalThis.__ISOLATE_TOKEN__ = token;
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("isolate", token);
  const { default: worker } = await import(workerUrl.href);
  const db = fakeD1(revision, data);
  const env = { DB: db, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const call = (path = "/api/deals?limit=5", headers = {}) => {
    globalThis.__ISOLATE_TOKEN__ = token;
    globalThis.__TEST_ENV__ = env;
    return worker.fetch(
      new Request(`https://radar.cheap${path}`, { headers: { accept: "application/json", ...headers } }),
      env,
      { waitUntil(promise) { globalThis.__TEST_WAITS__.push(Promise.resolve(promise).catch(() => {})); }, passThroughOnException() {} },
    );
  };
  return { call, db, env };
}

// Read out of the route rather than written down here. Pinning the version in the test meant that
// bumping SNAPSHOT_CACHE_VERSION - which is how a snapshot is published early - failed two tests
// that had no opinion about the version, only about the key's shape.
const SNAPSHOT_VERSION = Number(
  readFileSync(new URL("../app/api/deals/route.ts", import.meta.url), "utf8")
    .match(/^const SNAPSHOT_CACHE_VERSION = (\d+)/m)?.[1],
);
assert.ok(Number.isInteger(SNAPSHOT_VERSION), "could not read SNAPSHOT_CACHE_VERSION from the route");
// The key carries a hash of the data revision as its last segment, so the exact URL depends on
// what the fake database reports. Tests assert on the prefix and read the whole key back out of
// the cache, rather than recomputing the hash here — a second implementation of it would only be
// something else that can disagree.
const SNAPSHOT_PREFIX = `/__deals-snapshot/v${SNAPSHOT_VERSION}/`;
// Only ever handed to the guard tests, which care that the path is refused and not what is under
// it. Everything that needs the real key discovers it with seedKey below.
const SNAPSHOT_PATH = `${SNAPSHOT_PREFIX}anyrevisiontag`;
// The colo's record of the data revision, which isolates read instead of asking D1 themselves; D1
// is asked again only once it is five minutes old (REVISION_SHARED_MS in the route).
const REVISION_RECORD = `https://radar.cheap${SNAPSHOT_PREFIX}current-revision`;

/** The shard an unplaced request for the fixture reads: the deals of its one country. */
const COUNTRY_SHARD = "country:CA";

/**
 * Lets one isolate publish, and returns the key the country shard was published under.
 *
 * The key ends in a hash of the data revision, so a test that wants to plant an entry the route
 * will actually read has to learn the key rather than assemble it. Recomputing the hash here would
 * only add a second implementation that can disagree with the first.
 */
async function seedKey(cache) {
  const first = await isolate();
  assert.equal((await first.call()).status, 200);
  await settleBackgroundWork();
  return revisionKeys(cache)[COUNTRY_SHARD];
}

/**
 * The revision-named keys the cache is holding, by shard.
 *
 * A build publishes two entries per shard: one named for the data revision, which a healthy read
 * asks for, and one under a fixed name that a cold isolate can construct without asking D1 — the
 * copy that keeps the site up when D1 is refusing reads. An unplaced request builds two shards: the
 * meta shard every request reads, and the country's deals.
 */
function revisionKeys(cache) {
  const keys = [...cache.store.keys()].filter((key) => key.startsWith(`https://radar.cheap${SNAPSHOT_PREFIX}`) && key !== REVISION_RECORD);
  const byShard = {};
  for (const key of keys.filter((key) => key.includes("/latest/"))) {
    const shard = key.slice(key.indexOf("/latest/") + "/latest/".length);
    const named = keys.filter((other) => other.startsWith(`https://radar.cheap${SNAPSHOT_PREFIX}r`) && other.endsWith(`/${shard}`));
    assert.equal(named.length, 1, `expected one revision-named copy of ${shard}, got ${named.join(", ")}`);
    byShard[shard] = named[0];
  }
  assert.deepEqual(Object.keys(byShard).sort(), [COUNTRY_SHARD, "meta"], `expected the meta and country shards, got ${keys.join(", ")}`);
  return byShard;
}

async function withCache(cache, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "caches");
  const previous = globalThis.caches;
  globalThis.caches = cache;
  try {
    return await run();
  } finally {
    if (had) globalThis.caches = previous;
    else delete globalThis.caches;
  }
}

test("the first isolate builds from D1 and leaves the snapshot for the colo", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate();
    const response = await first.call();
    assert.equal(response.status, 200);
    assert.ok(first.db.snapshotQueries > 0, "a cold isolate with an empty cache must build from D1");
    await settleBackgroundWork();
    revisionKeys(cache);
  });
});

// The whole point. Before this, every isolate a deploy created rebuilt the snapshot out of D1.
test("a second isolate serves from the colo's copy without touching D1", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate();
    assert.equal((await first.call()).status, 200);
    await settleBackgroundWork();

    const second = await isolate();
    const response = await second.call();
    assert.equal(response.status, 200);
    assert.equal(second.db.snapshotQueries, 0, "the second isolate must not rebuild the snapshot");
    const body = await response.json();
    const deals = body.deals || body.results || body.items || [];
    assert.equal(deals.length, 1, "and it must serve the same catalog, not an empty one");
  });
});

// The colo's copy is packed: deals as positional rows under one list of field names, and the two
// location lists derived from chain_locations left out and rebuilt on the way back. Whatever that
// does, a reader served from the copy must get exactly what a reader served from a fresh build
// gets - a chain with a branch that carries the offer and one that does not, and a national deal
// with the fields only national deals have. Four requests, four kinds of shard: the country's
// deals, the nationwide list, the Saved tab's deals by id (read from D1 as asked, so it is left out
// of the count), and the map cells around a point.
test("a deal served from the colo's copy is the deal a fresh build serves", async () => {
  const chain = {
    ...DEAL, id: "deal-2", slug: "chain-wings", restaurant_id: "restaurant-2", canonical_restaurant_id: "restaurant-2",
    restaurant: "Chain Wings", canonical_restaurant: "Chain Wings", is_chain: 1, address: "2 Chain St", eligible_location_id: "location-2",
  };
  const national = {
    ...DEAL, id: "deal-3", slug: "national-coffee", restaurant_id: "restaurant-3", canonical_restaurant_id: "restaurant-3",
    restaurant: "Coffee Co", canonical_restaurant: "Coffee Co", is_chain: 1, location_scope: "national",
    restaurant_country: "US", restaurant_footprint: '{"TN":3,"NY":0}', city: "", address: "", postal_prefix: "",
    country: null, region: null, latitude: null, longitude: null, timezone: null, eligible_location_id: null,
  };
  const branches = [
    { location_id: "location-2", restaurant_id: "restaurant-2", address: "2 Chain St", city: "Ottawa", region: "ON", country: "CA", postal_prefix: "K1A", latitude: 45.42, longitude: -75.7, official_url: null, approximate: 0 },
    // A branch whose coordinate is only the city's centre (geo_precision 'city'): the flag has to
    // reach the answer, and survive the colo's copy, for a map to draw it as an area.
    { location_id: "location-4", restaurant_id: "restaurant-2", address: "9 Other Ave", city: "Ottawa", region: "ON", country: "CA", postal_prefix: "K2P", latitude: 45.41, longitude: -75.69, official_url: null, approximate: 1 },
  ];
  // A duplicate folded into the first deal: a Saved list asking for its old id is answered through
  // the alias map, which has to survive the trip through the colo's copy like everything else.
  const aliases = [{ alias_id: "deal-1-old-copy", canonical_deal_id: "deal-1" }];
  // And a market a bare point finds by where it is, from the centres the snapshot carries: a copy
  // that lost them would place the same point in no market at all, and call Ottawa thin; one that
  // pinned a centre to the wrong row would call it Toronto's, which says it is not covered.
  const markets = [
    { id: "m-toronto", market: "Toronto", region: "ON", country: "CA", status: "no_coverage", minimum_offers: 1 },
    { id: "m-ottawa", market: "Ottawa", region: "ON", country: "CA", status: "covered", minimum_offers: 1 },
  ];
  const data = { deals: [DEAL, chain, national], branches, aliases, markets };
  const local = "/api/deals?limit=10";
  const nationwide = "/api/deals?scope=national&country=US&province=TN&limit=10";
  const saved = "/api/deals?id=deal-1-old-copy";
  const point = "/api/deals?lat=45.4215&lng=-75.6972&radius=25&tz=America/Toronto&limit=10";
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate(REVISION, data);
    const builtLocal = await (await first.call(local)).json();
    const builtNational = await (await first.call(nationwide)).json();
    const builtSaved = await (await first.call(saved)).json();
    const builtPoint = await (await first.call(point)).json();
    await settleBackgroundWork();

    const second = await isolate(REVISION, data);
    const cachedLocal = await (await second.call(local)).json();
    const cachedNational = await (await second.call(nationwide)).json();
    const cachedSaved = await (await second.call(saved)).json();
    const cachedPoint = await (await second.call(point)).json();
    assert.equal(second.db.snapshotQueries, 0, "the second isolate must serve from the colo's copy");
    assert.deepEqual(builtSaved.results.map((deal) => deal.id), ["deal-1"], "an old id finds the deal it was folded into");
    assert.deepEqual(cachedSaved.results.map((deal) => deal.id), ["deal-1"], "and still does from the colo's copy");
    assert.equal(builtPoint.coverage, "covered", "a point in Ottawa is Ottawa");
    assert.equal(cachedPoint.coverage, "covered", "and still is from the colo's copy");

    const chainCard = builtLocal.results.find((deal) => deal.id === "deal-2");
    assert.ok(chainCard, "the chain deal is in the local list");
    assert.match(JSON.stringify(chainCard), /9 Other Ave/, "with its branch that does not carry the offer");
    const located = chainCard.chain_locations || [...(chainCard.participating_locations || []), ...(chainCard.other_brand_locations || [])];
    const centroid = located.find((location) => location.address === "9 Other Ave");
    const placed = located.find((location) => location.address === "2 Chain St");
    assert.equal(centroid?.approximate, true, "a city-centre branch is marked approximate");
    assert.ok(placed && !("approximate" in placed), "a placed branch carries no approximate key");
    assert.equal(builtNational.results.length, 1, "and the national deal is in the nationwide list");
    assert.deepEqual(cachedLocal.results, builtLocal.results);
    assert.deepEqual(cachedNational.results, builtNational.results);
  });
});

// The reason a cold isolate returned 500 while its warm neighbors were fine. With a shared copy
// available it can answer without D1 at all.
test("a cold isolate serves even when D1 refuses", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate();
    assert.equal((await first.call()).status, 200);
    await settleBackgroundWork();

    const stricken = await isolate();
    stricken.env.DB = { prepare: () => { throw new Error("D1 row read limit exceeded"); } };
    const response = await stricken.call();
    assert.equal(response.status, 200, "a cold isolate must not 500 while the colo holds a snapshot");
  });
});

// If the serialised shape ever changes without the version being bumped, the validation is the net:
// an entry it does not recognize costs one rebuild rather than serving fields the reader no longer
// understands.
test("an entry from another version is ignored", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    // Written at the key the route really publishes under, not one assembled here. Put anywhere
    // else it would simply be a miss, and the test would pass without exercising the validation.
    cache.store.set(
      await seedKey(cache),
      new Response(JSON.stringify({ v: 999, key: COUNTRY_SHARD, expiresAt: Date.now() + 60_000, revision: "", sites: [], bases: [DEAL], translations: [] })),
    );
    const fresh = await isolate();
    assert.equal((await fresh.call()).status, 200);
    assert.ok(fresh.db.snapshotQueries > 0, "a foreign version must be rebuilt, not adopted");
  });
});

test("a truncated entry is ignored rather than thrown", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    cache.store.set(await seedKey(cache), new Response('{"v":1,"bases":[{"id":'));
    const fresh = await isolate();
    const response = await fresh.call();
    assert.equal(response.status, 200, "a torn entry is a miss, never an error the visitor sees");
    assert.ok(fresh.db.snapshotQueries > 0);
  });
});

// An empty shard is a real answer now that the catalogue is in shards: a map cell with no deal in
// it, a country with none, and the fixture's one country once its deals are gone. The whole
// catalogue used to be one snapshot, and an empty one was refused as more likely a failed write
// than the truth; refusing an empty cell would rebuild it on every request from the empty quarter
// of the map. A failed write is caught instead by the shape check (the two tests above).
test("an empty shard is adopted", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    // At the current version and in the current shape, named for the shard it is planted as.
    cache.store.set(
      await seedKey(cache),
      new Response(JSON.stringify({ v: SNAPSHOT_VERSION, key: COUNTRY_SHARD, expiresAt: Date.now() + 60_000, revision: "", sites: [], bases: [], translations: [] })),
    );
    const fresh = await isolate();
    const response = await fresh.call();
    assert.equal(response.status, 200);
    assert.equal(fresh.db.snapshotQueries, 0, "an empty shard is not rebuilt");
    assert.deepEqual((await response.json()).results, [], "and it is the answer");
  });
});

// A copy planted under one shard's key that says it is another is a miss: a copy under the wrong
// name would answer a Vancouver reader with Ottawa's deals.
test("a copy that names another shard is ignored", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    cache.store.set(
      await seedKey(cache),
      new Response(JSON.stringify({ v: SNAPSHOT_VERSION, key: "country:US", expiresAt: Date.now() + 60_000, revision: "", sites: [], bases: [], translations: [] })),
    );
    const fresh = await isolate();
    assert.equal((await fresh.call()).status, 200);
    assert.ok(fresh.db.snapshotQueries > 0, "a copy of another shard must be rebuilt, not adopted");
  });
});

// The render tests load this same bundle in plain Node, where `caches` does not exist. Reaching for
// it must degrade to building every time, not throw.
test("no Cache API at all still serves", async () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "caches");
  const previous = globalThis.caches;
  delete globalThis.caches;
  try {
    const fresh = await isolate();
    const response = await fresh.call();
    assert.equal(response.status, 200);
    assert.ok(fresh.db.snapshotQueries > 0);
  } finally {
    if (had) globalThis.caches = previous;
  }
});

// The snapshot key is a URL because the Cache API keys entries by URL, not because anything should
// answer it. Workers run ahead of Cloudflare's cache, so a stored entry cannot reach a visitor
// without passing through worker/index.ts first — and that path matched no route, so it already
// 404ed. This pins it down: refused by name, above the routing, with an entry actually sitting in
// the cache at the time, which is the only state in which the question has teeth.
test("the snapshot key is not reachable as a request", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate();
    assert.equal((await first.call()).status, 200);
    await settleBackgroundWork();
    revisionKeys(cache);

    const response = await first.call(SNAPSHOT_PATH);
    assert.equal(response.status, 404, "the cache key must not answer as an endpoint");
    const body = await response.text();
    assert.ok(!body.includes("half-price-wings"), "and must never hand back the catalog");
    assert.ok(!body.includes("The Test Tavern"), "and must never hand back the catalog");
  });
});

// The other internal caches name themselves the same way, so the guard covers the prefix rather
// than the one key that prompted it. A version bump moves the snapshot to /__deals-snapshot/v2, so
// the refusal has to survive that too.
test("every internal cache path is refused, whatever the suffix", async () => {
  const worker = await isolate();
  for (const path of [
    SNAPSHOT_PATH,
    "/__deals-snapshot/v2",
    "/__deals-snapshot",
    "/__deals-answer/v1/?limit=5",
    "/__page-cache/dev/en",
    "/__photo-cache/dev/api/restaurant-photo",
  ]) {
    const response = await worker.call(path);
    assert.equal(response.status, 404, `${path} must not be served`);
  }
});

// What the refusal gives back is the site's own not-found response, not a bespoke one that would
// describe what it is protecting.
//
// It is not indistinguishable, and deliberately so. A bare path the app does not know gets a 307
// into a locale first and only 404s on the second hop, so refusing at the top of the handler is
// visible as a refusal to anyone who looks. Mirroring the redirect instead would mean duplicating
// locale negotiation — cookie, then Accept-Language — inside the worker entry, which is exactly
// what it keeps out (see tests/edge-cache.test.mjs on why the locale list is hardcoded here). That
// is a lot of drift-prone machinery to hide one bit about a document whose contents are the public
// deal catalog. So: the prefix is known to be refused, and nothing behind it is disclosed.
//
// The not-found page names the path it was asked for (the router state carries it), so the two
// bodies are compared with that one differing segment set aside; everything else must match.
test("refusing one gives back the site's ordinary not-found, and nothing about itself", async () => {
  const worker = await isolate();
  const guarded = await worker.call(SNAPSHOT_PATH);
  const unknown = await worker.call(`/en/__nothing-is-here/v${SNAPSHOT_VERSION}/anyrevisiontag`);
  assert.equal(guarded.status, 404);
  assert.equal(guarded.status, unknown.status, "the same status as any missing page under a locale");
  assert.equal(guarded.headers.get("content-type"), unknown.headers.get("content-type"));
  const guardedBody = (await guarded.text()).replaceAll("__deals-snapshot", "<segment>");
  const unknownBody = (await unknown.text()).replaceAll("__nothing-is-here", "<segment>");
  assert.match(guardedBody, /This page wandered off\./, "the site's own not-found page");
  assert.equal(guardedBody, unknownBody, "and the same body — it describes nothing");
});

// The reason any of the above exists in this shape.
//
// The snapshot used to be cached under one fixed key with a TTL, which answers "is this copy old?"
// and never asks "is this copy wrong?". A chain merge on 2026-09-19 was correct in D1 immediately
// and still absent from the site 48 minutes later, across 15 consecutive requests: every isolate
// kept adopting the same superseded copy, because nothing addressed it differently after the data
// changed. Keying on the data revision is what makes a superseded copy unreachable rather than
// merely undesirable.
test("a data change is served without waiting for any TTL", async () => {
  const cache = fakeCache();
  await withCache(cache, async () => {
    const before = await isolate();
    assert.equal((await before.call()).status, 200);
    await settleBackgroundWork();
    const firstKey = revisionKeys(cache)[COUNTRY_SHARD];

    // A staff edit: every write path touches updated_at, so the revision moves. The colo notices
    // once its shared record of the revision is old enough to ask D1 again - aged out here rather
    // than waited for. Until then its isolates keep serving the copy they have: that window, five
    // minutes, is the price of asking D1 once per colo instead of once per isolate.
    assert.ok(cache.store.has(REVISION_RECORD), "the colo keeps its record of the revision");
    cache.store.delete(REVISION_RECORD);
    const after = await isolate("2026-09-20 12:00:00");
    assert.equal((await after.call()).status, 200);
    assert.ok(after.db.snapshotQueries > 0, "a changed revision must rebuild rather than adopt");
    await settleBackgroundWork();

    // The superseded entry is deliberately left where it is. Nothing can address it any more — no
    // revision produces that key again — and it falls out on its own when its max-age expires.
    // Deleting it would only work in this one colo anyway, which is the limitation that made
    // purging unusable as an invalidation strategy in the first place.
    const keys = [...cache.store.keys()].filter((key) => key.endsWith(`/${COUNTRY_SHARD}`) && !key.includes("/latest/"));
    assert.ok(keys.includes(firstKey), "the superseded copy may remain; it is simply unreachable");
    assert.equal(keys.length, 2, `expected the old and new keys, got ${keys.join(", ")}`);
    assert.notEqual(keys[1], firstKey, "a changed revision must publish under a different key");
  });
});

test("an unchanged revision is still adopted rather than rebuilt", async () => {
  // The other half: if every request rebuilt, the cost this whole mechanism exists to avoid would
  // be back, and a deploy would again read a million rows.
  const cache = fakeCache();
  await withCache(cache, async () => {
    const first = await isolate();
    assert.equal((await first.call()).status, 200);
    await settleBackgroundWork();

    const second = await isolate();
    assert.equal((await second.call()).status, 200);
    assert.equal(second.db.snapshotQueries, 0, "an unchanged revision must be adopted, not rebuilt");
  });
});

test("a cold isolate serves from the fallback copy when D1 cannot give a revision", async () => {
  // The fallback exists for exactly one moment: D1 refusing reads, when the revision that names
  // the current key cannot be learned at all. Serving a knowingly stale catalog beats a 500.
  const cache = fakeCache();
  await withCache(cache, async () => {
    const healthy = await isolate();
    assert.equal((await healthy.call()).status, 200);
    await settleBackgroundWork();

    const stricken = await isolate();
    stricken.env.DB = { prepare: () => { throw new Error("D1 row read limit exceeded"); } };
    const response = await stricken.call();
    assert.equal(response.status, 200, "an outage must be served from the fixed-name copy");
    const body = await response.json();
    const deals = body.deals || body.results || body.items || [];
    assert.equal(deals.length, 1, "and it must be the real catalog, not an empty one");
  });
});

// Above the snapshot sits a cache of whole answers: the colo's anonymous readers share one response
// per URL for the minute its own max-age already allows, so most of them never touch the snapshot.
// See sharedAnswerKey in the route.
test("an anonymous answer is shared across the colo without touching D1 or the snapshot", async () => {
  const cache = fakeCache({ answers: true });
  await withCache(cache, async () => {
    const first = await isolate();
    const built = await (await first.call()).json();
    await settleBackgroundWork();
    assert.ok([...cache.store.keys()].some((key) => key.includes("/__deals-answer/")), "the answer is shared");

    const second = await isolate();
    const shared = await (await second.call()).json();
    assert.equal(second.db.asked.length, 0, "a shared answer asks D1 nothing, not even the revision");
    assert.deepEqual(shared.results, built.results);
  });
});

// A signed-in reader's hidden restaurants shape their answer, so it can be neither handed one built
// for somebody else nor leave its own for the next reader. getAppUser reads exactly two places for
// a session, and each is checked.
test("a signed-in reader is never handed, nor hands out, a shared answer", async () => {
  const cache = fakeCache({ answers: true });
  await withCache(cache, async () => {
    const first = await isolate();
    assert.equal((await first.call()).status, 200);
    await settleBackgroundWork();
    const answerKeys = [...cache.store.keys()].filter((key) => key.includes("/__deals-answer/"));
    assert.equal(answerKeys.length, 1);
    // Marked, so the body says which path answered.
    const marked = () => new Response(JSON.stringify({ results: [], marker: "shared" }), { headers: { "content-type": "application/json" } });
    cache.store.set(answerKeys[0], marked());

    const anonymous = await isolate();
    assert.equal((await (await anonymous.call()).json()).marker, "shared", "an anonymous reader is handed the shared answer");

    for (const headers of [{ authorization: "Bearer not-a-real-token" }, { cookie: "theme=dark; __session=not-a-real-token" }]) {
      const reader = await isolate();
      const body = await (await reader.call("/api/deals?limit=5", headers)).json();
      const via = Object.keys(headers)[0];
      assert.equal(body.marker, undefined, `${via}: must not be handed the shared answer`);
      assert.equal(body.results.length, 1, `${via}: and must be answered from the catalog instead`);
    }
    await settleBackgroundWork();
    assert.equal((await cache.store.get(answerKeys[0]).clone().json()).marker, "shared", "nor may either replace it");
  });
});

// The search log is the one side effect of a deals request. A search answered from the shared copy
// never reaches the code that counts it, so the copy carries its event with it.
test("a search answered from the shared copy is still counted", async () => {
  const cache = fakeCache({ answers: true });
  await withCache(cache, async () => {
    const counted = (db) => db.asked.filter((sql) => sql.includes("INSERT INTO product_events")).length;
    const first = await isolate();
    assert.equal((await first.call("/api/deals?limit=5&q=wings")).status, 200);
    await settleBackgroundWork();
    assert.equal(counted(first.db), 1);

    const second = await isolate();
    const response = await second.call("/api/deals?limit=5&q=wings");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-radar-search-event"), null, "the event rides in the cache, not out to the reader");
    await settleBackgroundWork();
    assert.equal(second.db.snapshotQueries, 0, "answered from the shared copy");
    assert.equal(counted(second.db), 1, "and counted all the same");
  });
});
