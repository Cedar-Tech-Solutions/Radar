// The requests the Worker's entry answers without the app, and the other places this site was made
// cheaper to run on 2026-10-03: stored photos (worker/stored-photo.ts), deals answers the colo
// already holds (app/deals-answer.ts, sharedDealsAnswer in worker/index.ts), a baked page a reader
// already has (304), the icons' lifetime (public/_headers), the deal lookup the app makes
// (app/api/deals/[slug]) and the geocode job's retries.
//
// Each fast path stands in for a route that still exists and still answers whatever the fast path
// does not, so most of this file holds the two to the same answer. Needs `npm run build` first.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness } from "./route-harness.mjs";
import { code } from "./source.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const { storedPhoto } = await import("../worker/stored-photo.ts");
const { GET: photoRoute } = await import("../app/api/photo/[...key]/route.ts");
const { ANONYMOUS_ANSWER_CACHE_CONTROL, answerFromShared, answerToShare, sharedAnswerKey, sharedAnswerSeconds } = await import("../app/deals-answer.ts");
const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url).href);

const KEY = "restaurants/union613-ottawa-restaurant/1789690910554-871a7548.png";

// R2 as the binding hands an object back: `size` is what R2 recorded, `read` what a read yields.
function bucket({ size = 60_000, read: readable = size, fail = false, missing = false } = {}) {
  const asked = [];
  const bytes = new Uint8Array(readable).map((_, i) => i % 251);
  return {
    asked,
    async get(key) {
      asked.push(key);
      if (missing) return null;
      return {
        size,
        httpEtag: '"f023a1486239965233de7682e4091c0c"',
        writeHttpMetadata(headers) { headers.set("content-type", "image/png"); },
        async arrayBuffer() {
          if (fail) throw new Error("Network connection lost.");
          return bytes.buffer.slice(0);
        },
      };
    },
  };
}

// The colo cache, keyed by URL like the real one.
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      const hit = store.get(typeof request === "string" ? request : request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      store.set(typeof request === "string" ? request : request.url, response);
    },
  };
}

const photoRequest = (key = KEY, init) => new Request(`https://radar.cheap/api/photo/${key}`, init);
const fast = (photos, { key = KEY, cache = null, init, pending = [] } = {}) => {
  const request = photoRequest(key, init);
  return storedPhoto(request, new URL(request.url), photos, cache, (promise) => pending.push(promise));
};

const COMPARED = ["content-type", "content-length", "cache-control", "etag", "retry-after"];

for (const [name, shape] of [
  ["a whole photo", {}],
  ["a photo that is not there", { missing: true }],
  ["a read that comes up short", { read: 20_000 }],
  ["a read that fails", { fail: true }],
]) {
  test(`the entry answers ${name} exactly as the route does`, async () => {
    harness.env.PHOTOS = bucket(shape);
    const fromRoute = await photoRoute(photoRequest(), { params: Promise.resolve({ key: KEY.split("/") }) });
    const fromEntry = await fast(bucket(shape));
    assert.ok(fromEntry, "the entry answers it");
    assert.equal(fromEntry.status, fromRoute.status);
    for (const header of COMPARED) assert.equal(fromEntry.headers.get(header), fromRoute.headers.get(header), header);
    assert.equal((await fromEntry.arrayBuffer()).byteLength, (await fromRoute.arrayBuffer()).byteLength);
  });
}

test("the entry leaves to the route whatever it does not recognise", async () => {
  const photos = bucket();
  assert.equal(await fast(photos, { init: { method: "HEAD" } }), null, "a HEAD");
  assert.equal(await fast(photos, { init: { method: "POST" } }), null, "a POST");
  assert.equal(await fast(photos, { key: "restaurants/x.gif" }), null, "a key the route refuses");
  assert.equal(await fast(photos, { key: "restaurants//x.png" }), null, "a doubled slash");
  assert.equal(await fast(undefined), null, "no bucket bound");
  assert.equal(photos.asked.length, 0, "and asks R2 nothing for any of them");
});

test("a photo the colo holds is not read from R2 again, whatever its query string", async () => {
  const photos = bucket();
  const cache = fakeCache();
  const pending = [];
  const first = await fast(photos, { cache, pending });
  assert.equal(first.status, 200);
  await Promise.all(pending);
  assert.deepEqual([...cache.store.keys()], [`https://radar.cheap/__photo-cache/stored/${KEY}`]);

  const second = await fast(photos, { key: `${KEY}?v=2`, cache });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("content-length"), "60000");
  assert.match(second.headers.get("cache-control"), /max-age=31536000, immutable/);
  assert.equal((await second.arrayBuffer()).byteLength, 60_000);
  assert.equal(photos.asked.length, 1, "R2 was read once");
});

test("a short read is never kept by the colo", async () => {
  const cache = fakeCache();
  const pending = [];
  const response = await fast(bucket({ read: 20_000 }), { cache, pending });
  await Promise.all(pending);
  assert.equal(response.status, 503);
  assert.equal(cache.store.size, 0);
});

// ── Shared deals answers ─────────────────────────────────────────────────────────────────────────

test("a shared answer lasts until the next five-minute mark", () => {
  const at = (clock) => Date.parse(`2026-10-03T${clock}Z`);
  assert.equal(sharedAnswerSeconds(at("12:03:10")), 110);
  assert.equal(sharedAnswerSeconds(at("12:05:00")), 300);
  assert.equal(sharedAnswerSeconds(at("12:04:59.500")), 1);
});

test("the colo's copy carries its own lifetime and the reader's copy never does", async () => {
  const answer = Response.json({ results: [] }, { headers: { "cache-control": ANONYMOUS_ANSWER_CACHE_CONTROL } });
  const shared = answerToShare(answer, '{"market":"CA","properties":"{}"}', Date.parse("2026-10-03T12:03:10Z"));
  assert.equal(shared.headers.get("cache-control"), "public, max-age=110");
  assert.equal(shared.headers.get("x-radar-search-event"), '{"market":"CA","properties":"{}"}');
  assert.equal(answer.headers.get("cache-control"), ANONYMOUS_ANSWER_CACHE_CONTROL, "the reader's own copy is untouched");

  const { answer: sent, searchEvent } = answerFromShared(shared);
  assert.equal(sent.headers.get("cache-control"), ANONYMOUS_ANSWER_CACHE_CONTROL);
  assert.equal(sent.headers.get("x-radar-search-event"), null);
  assert.equal(searchEvent, '{"market":"CA","properties":"{}"}');
  assert.deepEqual(await sent.json(), { results: [] });
});

test("a signed-in request has no shared answer", () => {
  const url = new URL("https://radar.cheap/api/deals?limit=5&city=Ottawa");
  assert.equal(sharedAnswerKey(new Request(url), url).url, "https://radar.cheap/__deals-answer/v1/?city=Ottawa&limit=5");
  assert.equal(sharedAnswerKey(new Request(url, { headers: { authorization: "Bearer x" } }), url), null);
  assert.equal(sharedAnswerKey(new Request(url, { headers: { cookie: "theme=dark; __session=x" } }), url), null);
});

// A browse that names no place and no country - the site's first paint for a reader who has not
// shared a location, a keyword search - is placed in the network's country, so two networks are
// never handed one answer; a request that names any of those is keyed on what it names alone.
test("an unplaced browse is keyed on the network's country; a placed one is not", () => {
  const unplaced = new URL("https://radar.cheap/api/deals?limit=5&q=wings");
  const from = (country) => new Request(unplaced, { headers: country ? { "cf-ipcountry": country } : {} });
  assert.equal(sharedAnswerKey(from("CA"), unplaced).url, "https://radar.cheap/__deals-answer/v1/?limit=5&q=wings&%7Enetwork-country=CA");
  assert.equal(sharedAnswerKey(from("US"), unplaced).url, "https://radar.cheap/__deals-answer/v1/?limit=5&q=wings&%7Enetwork-country=US");
  assert.equal(sharedAnswerKey(from(null), unplaced).url, "https://radar.cheap/__deals-answer/v1/?limit=5&q=wings&%7Enetwork-country=");
  for (const placed of ["country=US", "province=ON", "city=Ottawa", "postal=K1A", "lat=45.4&lng=-75.7&country=CA&tz=America%2FToronto"]) {
    const url = new URL(`https://radar.cheap/api/deals?limit=5&${placed}`);
    assert.doesNotMatch(sharedAnswerKey(new Request(url, { headers: { "cf-ipcountry": "CA" } }), url).url, /network-country/, placed);
  }
});

const CTX = (pending = []) => ({ waitUntil(promise) { pending.push(Promise.resolve(promise).catch(() => {})); }, passThroughOnException() {} });

// D1 that records what it is asked and answers nothing.
function recordingD1() {
  const asked = [];
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { asked.push({ sql, args }); return null; },
    all: async () => { asked.push({ sql, args }); return { results: [], success: true, meta: {} }; },
    run: async () => { asked.push({ sql, args }); return { results: [], success: true, meta: { changes: 1 } }; },
  });
  return { asked, prepare: (sql) => statement(sql) };
}

test("the Worker hands an anonymous reader the colo's answer without the app, and still counts the search", async () => {
  const cache = fakeCache();
  globalThis.caches = { default: cache };
  try {
    const event = JSON.stringify({ market: "CA", properties: JSON.stringify({ term: "wings", matches: 3 }) });
    cache.store.set(
      // A keyword search names no place, so it is placed in the network's country (browseCountry in
      // the route), which is part of its key; a request from no known country is its own answer.
      "https://radar.cheap/__deals-answer/v1/?limit=5&q=wings&%7Enetwork-country=",
      new Response(JSON.stringify({ results: [], marker: "shared" }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=110", "x-radar-search-event": event },
      }),
    );
    const env = { DB: recordingD1() };
    harness.env = env;
    const pending = [];
    const response = await worker.fetch(new Request("https://radar.cheap/api/deals?q=wings&limit=5", { headers: { "user-agent": "Mozilla/5.0 (test)" } }), env, CTX(pending));
    await Promise.all(pending);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).marker, "shared");
    assert.equal(response.headers.get("cache-control"), ANONYMOUS_ANSWER_CACHE_CONTROL);
    assert.equal(response.headers.get("x-radar-search-event"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", "still under the security headers");
    assert.equal(env.DB.asked.length, 1, "one write, and no read");
    assert.match(env.DB.asked[0].sql, /INSERT INTO product_events\(id,type,market,properties\)/);
    assert.deepEqual(env.DB.asked[0].args.slice(1), ["search", "CA", JSON.stringify({ term: "wings", matches: 3 })]);
  } finally {
    delete globalThis.caches;
    harness.env = {};
  }
});

test("a stored photo reaches a reader through the Worker with its length and the security headers", async () => {
  const env = { PHOTOS: bucket() };
  harness.env = env;
  try {
    const response = await worker.fetch(photoRequest(`${KEY}?v=2`, { headers: { "user-agent": "Mozilla/5.0 (test)" } }), env, CTX());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "60000");
    assert.match(response.headers.get("cache-control"), /max-age=31536000, immutable/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await response.arrayBuffer()).byteLength, 60_000);
  } finally {
    harness.env = {};
  }
});

// ── A baked page the reader already has ──────────────────────────────────────────────────────────

test("a reader whose copy of a baked page is current is told so, and sent nothing", async () => {
  const asked = [];
  const env = {
    ASSETS: {
      async fetch(request) {
        asked.push(request);
        if (new URL(request.url).pathname !== "/en/terms") return new Response("Not found", { status: 404 });
        const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", etag: '"baked"' };
        if (request.headers.get("if-none-match") === '"baked"') return new Response(null, { status: 304, headers });
        return new Response("<html>terms</html>", { status: 200, headers });
      },
    },
  };
  harness.env = env;
  try {
    const ask = (headers = {}) => worker.fetch(new Request("https://radar.cheap/en/terms", { headers: { "user-agent": "Mozilla/5.0 (test)", ...headers } }), env, CTX());
    const first = await ask();
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "<html>terms</html>");
    assert.equal(first.headers.get("etag"), '"baked"');

    const again = await ask({ "if-none-match": '"baked"' });
    assert.equal(again.status, 304);
    assert.equal(again.body, null);
    assert.equal(again.headers.get("x-radar-served"), "baked");
    assert.equal(again.headers.get("cache-control"), "private, no-cache");
    assert.match(again.headers.get("set-cookie"), /^NEXT_LOCALE=en;/);

    const other = await ask({ "if-none-match": '"an-older-deploy"' });
    assert.equal(other.status, 200, "a copy from another deploy is replaced");
    assert.equal(await other.text(), "<html>terms</html>");
  } finally {
    harness.env = {};
  }
});

// ── Files and queries ────────────────────────────────────────────────────────────────────────────

test("the icons and share images are kept for a day; the files that must be current are not", () => {
  const rules = new Map();
  let current = null;
  for (const line of read("public/_headers").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.set(current = line.trim(), []);
    else rules.get(current).push(line.trim());
  }
  for (const path of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/og.png", "/og/deals/*"]) {
    assert.deepEqual(rules.get(path), ["Cache-Control: public, max-age=86400"], path);
  }
  for (const path of ["/sw.js", "/robots.txt", "/sitemap.xml", "/vinext-client-entry-manifest.json"]) {
    assert.equal(rules.has(path), false, `${path} must stay revalidated on every use`);
  }
});

test("the app's deal lookup finds its row by index, not by walking every live deal", () => {
  const route = code(read("app/api/deals/[slug]/route.ts"));
  assert.match(route, /FROM \(SELECT id FROM deals WHERE slug=\?\s+UNION ALL SELECT \?\s+UNION ALL SELECT canonical_deal_id FROM deal_aliases WHERE alias_id=\?\) c\s+CROSS JOIN deals d ON d\.id=c\.id/);
  assert.doesNotMatch(route, /d\.slug=\? OR d\.id=\?/);
});

test("the geocode job does not ask again, every hour, about an address it could not place", () => {
  const job = code(read("app/api/jobs/geocode/route.ts"));
  assert.match(job, /AND \(geocoded_at IS NULL OR geocoded_at < datetime\('now','-\$\{RETRY_AFTER_DAYS\} days'\)\)/);
  assert.match(job, /const RETRY_AFTER_DAYS = 7;/);
});
