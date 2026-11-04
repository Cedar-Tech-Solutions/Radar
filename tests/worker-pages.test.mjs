// How the Worker answers a page without rendering it, driven through the built bundle (dist/server)
// with fakes only for what Node does not have: D1, the asset binding, the colo cache, Stripe. Needs
// `npm run build` first.
//
// Each of these used to be a full page render - a trip through the framework that costs 2-9 ms of
// CPU locally and more in production, a real share of a request's CPU allowance:
// the home page and the static pages on every reload, Back and shared link that carried a query
// string; /pro and every not-found page, every time; a stale colo copy, once per request until the
// first refresh landed; a scanner's /wp-login.php; a signed-out reader's dashboard link. What is
// checked here is that each is now answered without one, and - the half that matters more - that
// nothing personal is ever answered that way: a signed-in reader, a flight, a deal page's own
// parameters, a route that is not in SERVER_READ_PARAMS.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The app reads its bindings from cloudflare:workers; a proxy onto a global lets each call hand the
// render its own.
const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__TEST_ENV__?.[key] });
export const waitUntil = (promise) => { if (promise && typeof promise.catch === "function") promise.catch(() => {}); };
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ALIAS, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// The watchdog and the background refresh log what they give up on; collected, not printed.
const logged = [];
console.error = (...args) => { logged.push(args.map(String).join(" ")); };

// Nothing a test here does may leave the process. Stripe is answered by the Pro page's test alone.
globalThis.fetch = async (input) => {
  throw new Error(`unexpected fetch of ${typeof input === "string" ? input : input.url}`);
};

// A fresh import is a fresh isolate: its own admission slots, refresh claims and Stripe price cache.
async function isolate() {
  const url = new URL("../dist/server/index.js", import.meta.url);
  url.searchParams.set("isolate", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(url.href)).default;
}

const PAGE = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ORIGIN = "https://radar.cheap";
const KEY = `${ORIGIN}/__page-cache/dev`;
const MINUTE = 60_000;

// One colo's cache, keeping bytes the way the real one does: a put reads the body, a match hands
// back a new response each time.
function colo() {
  const store = new Map();
  const puts = [];
  const deletes = [];
  return {
    store,
    puts,
    deletes,
    default: {
      async delete(request) {
        const key = typeof request === "string" ? request : request.url;
        deletes.push(key);
        return store.delete(key);
      },
      async match(request) {
        const hit = store.get(typeof request === "string" ? request : request.url);
        return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
      },
      async put(request, response) {
        const key = typeof request === "string" ? request : request.url;
        const body = await response.arrayBuffer();
        store.set(key, { body, status: response.status, headers: [...response.headers] });
        puts.push(key);
      },
    },
  };
}

function stored(entry) {
  return { status: entry.status, headers: new Headers(entry.headers), text: new TextDecoder().decode(entry.body) };
}

// A copy as the Worker stores one, `ageMs` old.
function storedCopy(body, ageMs, { status = 200, locale = "en" } = {}) {
  return {
    body: new TextEncoder().encode(body).buffer,
    status,
    headers: [
      ["content-type", "text/html; charset=utf-8"],
      ["x-radar-cached-at", String(Date.now() - ageMs)],
      ["x-radar-cached-set-cookie", `NEXT_LOCALE=${locale}; Path=/; Secure; SameSite=lax`],
    ],
  };
}

// The asset binding holding the baked pages named here, answering HEAD with headers alone. Records
// every address it is asked for.
function assets(baked = {}) {
  const asked = [];
  return {
    asked,
    async fetch(request) {
      const url = new URL(request.url);
      asked.push(`${request.method} ${url.pathname}${url.search}`);
      if (!(url.pathname in baked)) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : baked[url.pathname], {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", etag: '"baked"' },
      });
    },
  };
}

// D1 that answers every query with nothing, at once.
function emptyD1() {
  const statement = () => ({
    bind: () => statement(),
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
    raw: async () => [],
  });
  return { prepare: () => statement(), batch: async (list) => list.map(() => ({ results: [], success: true, meta: {} })) };
}

// A small catalogue in SQLite, built from drizzle/*.sql the way tests/deal-page-render.test.mjs
// builds its own: two live deals, a draft, and a listing folded into a kept one (an archived row
// with a deal_aliases entry, whose address the page redirects). `reads.deal` counts the deal page's
// own lookup (getDeal), which runs once per render of a deal page, and so counts renders; `broken`
// makes every query throw, as a D1 outage does.
function catalogueD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  const stamp = new Date(Date.now() - 3 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("INSERT INTO restaurants (id,name,cuisine,is_chain,website,country) VALUES ('corner-pub','The Corner Pub','Pub',0,'https://corner.example','CA')").run();
  db.prepare("INSERT INTO restaurant_locations (id,restaurant_id,address,city,region,country,postal_prefix,latitude,longitude,timezone) VALUES ('corner','corner-pub','12 Elgin St','Ottawa','ON','CA','K1P',45.42,-75.69,'America/Toronto')").run();
  const deal = db.prepare(`INSERT INTO deals (id,slug,restaurant,restaurant_id,location_id,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url,
      status,active,verification_status,verified_at,created_at)
    VALUES (?,?,'The Corner Pub','corner-pub','corner',?,'Happy hour','Pub',?,'Ottawa','K1P','12 Elgin St',?,'🍺','https://corner.example/specials',?,?,'verified',?,?)`);
  deal.run("corner-wings", "corner-wings", "Wing night", "Wed", "Half price wings", "live", 1, stamp, stamp);
  deal.run("corner-tacos", "corner-tacos", "Taco Tuesday", "Tue", "$3 tacos", "live", 1, stamp, stamp);
  deal.run("corner-draft", "corner-draft", "Oyster Monday", "Mon", "$1 oysters", "draft", 0, stamp, stamp);
  deal.run("corner-wings-twin", "corner-wings-twin", "Wing night", "Wed", "Half price wings", "archived", 0, stamp, stamp);
  db.prepare("INSERT INTO deal_aliases (alias_id,canonical_deal_id) VALUES ('corner-wings-twin','corner-wings')").run();
  const reads = { deal: 0 };
  const control = { broken: false };
  const plain = (row) => ({ ...row });
  const statement = (sql, binds) => {
    const guard = (run) => async (...args) => {
      if (control.broken) throw new Error("D1_ERROR: the database is unavailable");
      return run(...args);
    };
    return {
      bind: (...args) => statement(sql, args.map((value) => (typeof value === "boolean" ? Number(value) : value))),
      first: guard((column) => { const row = db.prepare(sql).get(...binds); if (row === undefined) return null; return column === undefined ? plain(row) : (row[column] ?? null); }),
      all: guard(() => ({ results: db.prepare(sql).all(...binds).map(plain), success: true, meta: {} })),
      run: guard(() => { const info = db.prepare(sql).run(...binds); return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } }; }),
      raw: guard(() => db.prepare(sql).all(...binds).map((row) => Object.values(row))),
    };
  };
  return {
    reads,
    control,
    prepare: (sql) => {
      if (sql.includes("via_alias")) reads.deal += 1;
      return statement(sql, []);
    },
    batch: async (list) => Promise.all(list.map((entry) => entry.all())),
  };
}

// D1 as a wedged isolate experiences it: every query accepted, none ever answered.
function hangingD1() {
  const statement = () => ({
    bind: () => statement(),
    first: () => new Promise(() => {}),
    all: () => new Promise(() => {}),
    run: () => new Promise(() => {}),
    raw: () => new Promise(() => {}),
  });
  return { prepare: () => statement(), batch: () => new Promise(() => {}) };
}

// An execution context that keeps what was handed to waitUntil, so a test can count it and wait
// for it.
function context() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) { pending.push(Promise.resolve(promise).catch(() => {})); },
    passThroughOnException() {},
    settle: () => Promise.all(pending),
  };
}

function call(worker, env, href, init = {}, ctx = context()) {
  globalThis.__TEST_ENV__ = env;
  return worker.fetch(new Request(href, init), env, ctx);
}

const HOME = "<!doctype html><html lang=\"en\"><body>baked home</body></html>";
const TERMS = "<!doctype html><html lang=\"fr\"><body>conditions, cuites au déploiement</body></html>";
const SIGN_IN = "<!doctype html><html lang=\"es\"><body>iniciar sesión, horneado</body></html>";
const DEAL = "<!doctype html><html lang=\"en\"><body>baked deal</body></html>";

test("a baked page is what every signed-out reader gets, whatever query its server render ignores", async () => {
  const worker = await isolate();
  globalThis.caches = colo();
  try {
    const env = { DB: hangingD1(), ASSETS: assets({ "/en": HOME, "/fr/terms": TERMS, "/es/sign-in": SIGN_IN, "/en/deals/some-deal": DEAL }), RENDER_DEADLINE_MS: "300" };
    for (const [path, body, locale] of [
      ["/en", HOME, "en"],
      // What the home page writes into its own address, the deal page's back link, a newsletter's.
      ["/en?country=CA", HOME, "en"],
      ["/en?city=Ottawa&utm_source=newsletter&fbclid=abc", HOME, "en"],
      ["/fr/terms?v=1", TERMS, "fr"],
      ["/es/sign-in?redirect_url=%2Fes%2Fdashboard", SIGN_IN, "es"],
      ["/en/deals/some-deal?fbclid=x&utm_campaign=launch", DEAL, "en"],
    ]) {
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE } });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("x-radar-served"), "baked", path);
      assert.equal(await response.text(), body, path);
      assert.equal(response.headers.get("set-cookie"), `NEXT_LOCALE=${locale}; Path=/; SameSite=lax; Secure`, path);
      assert.equal(response.headers.get("cache-control"), "private, no-cache", path);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${path}: under the security headers`);
      assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains", path);
    }
    // The file is asked for by its path alone: a query never reaches the asset binding.
    assert.ok(env.ASSETS.asked.every((entry) => !entry.includes("?")), JSON.stringify(env.ASSETS.asked));

    // A HEAD is the same answer with no body, and asks the binding for headers alone.
    env.ASSETS.asked.length = 0;
    const head = await call(worker, env, `${ORIGIN}/en?country=CA`, { method: "HEAD", headers: { accept: PAGE } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-radar-served"), "baked");
    assert.equal(head.headers.get("set-cookie"), "NEXT_LOCALE=en; Path=/; SameSite=lax; Secure");
    assert.equal(head.body, null);
    assert.deepEqual(env.ASSETS.asked, ["HEAD /en"]);
  } finally {
    delete globalThis.caches;
  }
});

test("a personal request is never answered with the baked page or a stored copy", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    // A fresh stored copy of /en/launch, which is not in SERVER_READ_PARAMS.
    cache.store.set(`${KEY}/en/launch`, storedCopy("<html><body>the colo's launch page</body></html>", MINUTE));
    const env = { DB: emptyD1(), ASSETS: assets({ "/en": HOME, "/en/deals/some-deal": DEAL }) };
    const personal = [
      // The parameters a deal page's render reads: the back link, the distances, the full list.
      ["/en/deals/some-deal?return=%2Fen%3Fcity%3DOttawa", {}],
      ["/en/deals/some-deal?postal=K1A0B1", {}],
      ["/en/deals/some-deal?zip=10001&utm_source=x", {}],
      ["/en/deals/some-deal?all=1", {}],
      // A signed-in reader, by cookie or by token, of a page that reads who they are (the deal page
      // narrows its branches by their saved postal code). The pages that read nothing of them are
      // answered from the shared copy, marked - the test below.
      ["/en/deals/some-deal", { cookie: "theme=dark; __session=eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
      ["/en/deals/some-deal", { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
      ["/en/pro", { cookie: "__session=eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
      ["/en/launch", { cookie: "__session=eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
      // A client-side navigation's flight, by header or by the framework's parameter.
      ["/en/deals/some-deal", { RSC: "1" }],
      ["/en?_rsc=1x2y3", {}],
      // Any query at all on a route that is not in the table.
      ["/en/launch?utm_source=x", {}],
    ];
    for (const [path, headers] of personal) {
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE, ...headers } });
      assert.equal(response.headers.get("x-radar-served"), null, `${path} ${JSON.stringify(headers)} was answered without a render`);
      await response.body?.cancel();
    }
    // And the stored copy is still there for the bare address.
    const bare = await call(worker, env, `${ORIGIN}/en/launch`, { headers: { accept: PAGE } });
    assert.equal(bare.headers.get("x-radar-served"), "cache");
    assert.match(await bare.text(), /the colo's launch page/);
  } finally {
    delete globalThis.caches;
  }
});

// A signed-in reader of a page that reads nothing of them - the home page, a static page, a city
// guide - is handed the page every reader gets, with the mark RootShell would have put on <html>
// added by the Worker, so the page's scripts mount Clerk and the account menu from it. Every page
// such a reader opened used to be a full render, the costliest thing the Worker does, for staff
// who are signed in on every visit.
test("a signed-in reader of a page that reads nothing of them gets the shared copy, marked", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    cache.store.set(`${KEY}/en/support`, storedCopy("<!doctype html><html lang=\"en\"><body>the colo's support page</body></html>", MINUTE));
    const env = { DB: emptyD1(), ASSETS: assets({ "/en": HOME }) };
    const session = { cookie: "theme=dark; __session=eyJhbGciOiJSUzI1NiJ9.e30.sig" };
    const token = { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig" };

    // The baked page, marked.
    for (const headers of [session, token]) {
      const baked = await call(worker, env, `${ORIGIN}/en?country=CA`, { headers: { accept: PAGE, ...headers } });
      assert.equal(baked.headers.get("x-radar-served"), "baked");
      assert.equal(baked.headers.get("cache-control"), "private, no-cache");
      const html = await baked.text();
      assert.match(html, /^<!doctype html><html data-signed-in="" lang="en">/, "the mark RootShell puts on a render that saw the cookie");
      assert.match(html, /baked home/);
    }
    // A signed-out reader's copy of the same file carries no mark.
    assert.doesNotMatch(await (await call(worker, env, `${ORIGIN}/en`, { headers: { accept: PAGE } })).text(), /data-signed-in/);

    // The colo's copy, marked, and left as it was.
    const hit = await call(worker, env, `${ORIGIN}/en/support`, { headers: { accept: PAGE, ...session } });
    assert.equal(hit.headers.get("x-radar-served"), "cache");
    assert.match(await hit.text(), /<html data-signed-in="" lang="en">.*the colo's support page/);
    assert.doesNotMatch(stored(cache.store.get(`${KEY}/en/support`)).text, /data-signed-in/);
    // A HEAD has no body to mark.
    const head = await call(worker, env, `${ORIGIN}/en/support`, { method: "HEAD", headers: { accept: PAGE, ...session } });
    assert.equal(head.headers.get("x-radar-served"), "cache");
    assert.equal(head.body, null);

    // A miss: rendered once, as a signed-out reader's, stored for everyone and handed to them marked.
    const ctx = context();
    const miss = await call(worker, env, `${ORIGIN}/en/privacy`, { headers: { accept: PAGE, ...session } }, ctx);
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get("x-radar-served"), null, "a render");
    assert.equal(miss.headers.get("cache-control"), "private, no-cache", "the shared page, sent as one");
    const rendered = await miss.text();
    assert.match(rendered, /<html[^>]* data-signed-in=""/, "marked for this reader");
    await ctx.settle();
    const copy = stored(cache.store.get(`${KEY}/en/privacy`));
    assert.equal(copy.status, 200);
    // The page's own scripts name the mark (app/clerk-react.ts reads it); the <html> tag is what carries it.
    assert.match(copy.text, /^<!DOCTYPE html><html lang="en">/, "the copy stored saw no cookie");
    assert.equal(rendered.replace('<html data-signed-in="" lang="en">', '<html lang="en">'), copy.text, "and is otherwise the page the reader was sent");
  } finally {
    delete globalThis.caches;
  }
});

// A miss with parameters its route's server render ignores is one render of the bare address, which
// answers the reader and is stored. It used to be rendered as it came, with the bare address rendered
// again beside it in the background: two renders in one invocation, against one CPU allowance.
test("only a GET of the bare address is stored; a miss with ignored parameters is answered with it", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    const env = { DB: emptyD1(), ASSETS: assets() };
    // Not baked here, so a miss: the bare address is rendered, for this reader and the next.
    const first = context();
    const noisy = await call(worker, env, `${ORIGIN}/en/privacy?utm_source=newsletter`, { headers: { accept: PAGE } }, first);
    assert.equal(noisy.status, 200);
    assert.equal(noisy.headers.get("x-radar-served"), null);
    assert.equal(noisy.headers.get("cache-control"), "private, no-cache", "an impersonal page, sent as one");
    const html = await noisy.text();
    assert.doesNotMatch(html, /utm_source|newsletter/, "the reader is handed the bare address's render, as every later reader is");
    await first.settle();
    assert.deepEqual(cache.puts, [`${KEY}/en/privacy`]);
    const copy = stored(cache.store.get(`${KEY}/en/privacy`));
    assert.equal(copy.status, 200);
    assert.equal(copy.text, html, "the copy stored is the very render the reader was sent");
    assert.match(copy.headers.get("cache-control"), /^public, max-age=0, s-maxage=\d+$/);

    // The next reader, with other parameters, gets that copy.
    const next = await call(worker, env, `${ORIGIN}/en/privacy?fbclid=abc`, { headers: { accept: PAGE } });
    assert.equal(next.headers.get("x-radar-served"), "cache");
    assert.equal(await next.text(), copy.text);

    // A HEAD that misses is answered by a render and stores nothing; one that hits is the stored
    // copy's headers, with no body and no write.
    const headMiss = context();
    const missed = await call(worker, env, `${ORIGIN}/fr/support`, { method: "HEAD", headers: { accept: PAGE } }, headMiss);
    assert.equal(missed.status, 200);
    await missed.body?.cancel();
    await headMiss.settle();
    assert.ok(!cache.store.has(`${KEY}/fr/support`));
    const get = context();
    await (await call(worker, env, `${ORIGIN}/fr/support`, { headers: { accept: PAGE } }, get)).text();
    await get.settle();
    assert.ok(cache.store.has(`${KEY}/fr/support`), "a bare GET is stored");
    const writes = cache.puts.length;
    const headHit = context();
    const hit = await call(worker, env, `${ORIGIN}/fr/support`, { method: "HEAD", headers: { accept: PAGE } }, headHit);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-radar-served"), "cache");
    assert.equal(hit.body, null);
    assert.equal(hit.headers.get("x-radar-cached-at"), null, "the bookkeeping stays in the cache");
    assert.equal(headHit.pending.length, 0);
    assert.equal(cache.puts.length, writes);
  } finally {
    delete globalThis.caches;
  }
});

test("/pro is kept once per currency bucket, and only a render that carries prices", async () => {
  const marker = 'data-radar-priced=""';
  const env = { DB: emptyD1(), ASSETS: assets(), STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_PRICE_ID: "price_monthly_placeholder" };
  const cache = colo();
  globalThis.caches = cache;
  const realNow = Date.now;
  let stripeCalls = 0;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input.url;
    assert.ok(href.startsWith("https://api.stripe.com/v1/prices/price_monthly_placeholder"), `unexpected fetch of ${href}`);
    stripeCalls += 1;
    return Response.json({ currency: "cad", unit_amount: 699, recurring: { interval: "month" }, currency_options: { usd: { unit_amount: 499 } } });
  };
  try {
    const worker = await isolate();
    const visit = async (country, locale = "en") => {
      const ctx = context();
      const response = await call(worker, env, `${ORIGIN}/${locale}/pro`, { headers: { accept: PAGE, "CF-IPCountry": country } }, ctx);
      const html = await response.text();
      await ctx.settle();
      return { response, html };
    };
    const canada = await visit("CA");
    assert.equal(canada.response.headers.get("x-radar-served"), null, "the first Canadian reader is rendered for");
    assert.ok(canada.html.includes(marker));
    assert.ok(cache.store.has(`${KEY}/en/pro?currency=cad`), JSON.stringify(cache.puts));

    const american = await visit("US");
    assert.equal(american.response.headers.get("x-radar-served"), null, "a reader quoted another currency is not handed the Canadian page");
    assert.ok(cache.store.has(`${KEY}/en/pro?currency=usd`));
    assert.notEqual(american.html, canada.html);

    const again = await visit("CA");
    assert.equal(again.response.headers.get("x-radar-served"), "cache");
    assert.equal(again.html, stored(cache.store.get(`${KEY}/en/pro?currency=cad`)).text);
    const anotherAmerican = await visit("us");
    assert.equal(anotherAmerican.response.headers.get("x-radar-served"), "cache", "the bucket is the country's, whatever its case");

    // A country with no currency of its own is quoted the price's base currency, under one key.
    await visit("ZZ");
    await visit("");
    assert.deepEqual([...cache.store.keys()].filter((key) => key.includes("/en/pro")).sort(), [`${KEY}/en/pro?currency=base`, `${KEY}/en/pro?currency=cad`, `${KEY}/en/pro?currency=usd`]);
    assert.ok(stripeCalls >= 1);

    // Stripe unreachable: the page is drawn without prices, for this reader alone. Eleven minutes on,
    // past the ten app/stripe.ts keeps prices for in the isolate (in a chunk every import of the
    // entry shares), so the render asks Stripe again and gets nothing.
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    Date.now = () => realNow() + 11 * MINUTE;
    const ctx = context();
    const unpriced = await call(worker, env, `${ORIGIN}/fr/pro`, { headers: { accept: PAGE, "CF-IPCountry": "CA" } }, ctx);
    assert.equal(unpriced.status, 200);
    assert.ok(!(await unpriced.text()).includes(marker), "drawn without prices");
    await ctx.settle();
    assert.ok(![...cache.store.keys()].some((key) => key.includes("/fr/pro")), "a page without prices is not kept for the next reader");
  } finally {
    Date.now = realNow;
    globalThis.fetch = async (input) => { throw new Error(`unexpected fetch of ${typeof input === "string" ? input : input.url}`); };
    delete globalThis.caches;
  }
});

// A deal published since the deploy has no baked file, and a shared link to it carries a click id.
// Its miss is one render of the bare address - counted by the deal page's own lookup, which a render
// makes once - and that render is what the reader gets and what is stored. The one answer the query
// still changes is an alias's redirect, which carries it on to the kept deal's page.
test("an unbaked deal page asked for with a click id is rendered once, and an alias's redirect keeps the query", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    const DB = catalogueD1();
    const env = { DB, ASSETS: assets() };
    // What one render costs in lookups, from a bare miss of another deal.
    const bare = context();
    const plain = await call(worker, env, `${ORIGIN}/en/deals/corner-tacos`, { headers: { accept: PAGE } }, bare);
    assert.equal(plain.status, 200);
    await plain.text();
    await bare.settle();
    const perRender = DB.reads.deal;
    assert.ok(perRender >= 1, "a deal page's render looks its deal up");

    DB.reads.deal = 0;
    const ctx = context();
    const clicked = await call(worker, env, `${ORIGIN}/en/deals/corner-wings?fbclid=IwAR0clickid`, { headers: { accept: PAGE } }, ctx);
    assert.equal(clicked.status, 200);
    assert.equal(clicked.headers.get("x-radar-served"), null);
    assert.equal(clicked.headers.get("cache-control"), "private, no-cache");
    const html = await clicked.text();
    await ctx.settle();
    assert.equal(DB.reads.deal, perRender, "one render in the invocation, not the reader's and then the bare page's");
    assert.match(html, /Wing night/);
    assert.doesNotMatch(html, /fbclid|IwAR0clickid/, "the render is the bare address's, so its navigation echo is empty");
    assert.deepEqual(cache.puts, [`${KEY}/en/deals/corner-tacos`, `${KEY}/en/deals/corner-wings`]);
    assert.equal(stored(cache.store.get(`${KEY}/en/deals/corner-wings`)).text, html, "and it is what is kept for the next reader");

    DB.reads.deal = 0;
    const next = await call(worker, env, `${ORIGIN}/en/deals/corner-wings?utm_source=facebook`, { headers: { accept: PAGE } });
    assert.equal(next.headers.get("x-radar-served"), "cache");
    assert.equal(await next.text(), html);
    assert.equal(DB.reads.deal, 0);

    // The folded listing's old address, from a shared link: its redirect still carries the click id
    // and the campaign, in the order they came, and nothing is kept.
    DB.reads.deal = 0;
    const aliasCtx = context();
    const alias = await call(worker, env, `${ORIGIN}/en/deals/corner-wings-twin?fbclid=IwAR0clickid&utm_source=facebook`, { headers: { accept: PAGE } }, aliasCtx);
    assert.equal(alias.status, 308);
    const target = new URL(alias.headers.get("location"), ORIGIN);
    assert.equal(`${target.pathname}${target.search}`, "/en/deals/corner-wings?fbclid=IwAR0clickid&utm_source=facebook");
    await alias.body?.cancel();
    await aliasCtx.settle();
    assert.equal(DB.reads.deal, perRender);
    assert.ok(!cache.store.has(`${KEY}/en/deals/corner-wings-twin`));
    // And without a query, the redirect is the page's own.
    const bareAlias = await call(worker, env, `${ORIGIN}/en/deals/corner-wings-twin`, { headers: { accept: PAGE } });
    assert.equal(bareAlias.status, 308);
    const bareTarget = new URL(bareAlias.headers.get("location"), ORIGIN);
    assert.equal(`${bareTarget.pathname}${bareTarget.search}`, "/en/deals/corner-wings");
    await bareAlias.body?.cancel();
  } finally {
    delete globalThis.caches;
  }
});

// While Stripe cannot be reached the Pro page is drawn without prices, which is never kept, so each
// request for it renders. The iOS app opens it with ?from=ios_app&sf=USA: that was the reader's render
// and a second, bare one beside it, every time. Counted by Stripe calls, which a render makes a fixed
// number of while nothing is cached, taken from a bare request first.
test("/pro with ignored parameters while Stripe is down is one render per request, and nothing is kept", async () => {
  const env = { DB: emptyD1(), ASSETS: assets(), STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_PRICE_ID: "price_monthly_placeholder" };
  const cache = colo();
  globalThis.caches = cache;
  const realNow = Date.now;
  // An hour on, past any price an earlier test left in the shared chunk's cache.
  Date.now = () => realNow() + 60 * MINUTE;
  let stripeCalls = 0;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input.url;
    assert.ok(href.startsWith("https://api.stripe.com/v1/prices/"), `unexpected fetch of ${href}`);
    stripeCalls += 1;
    return new Response("unavailable", { status: 503 });
  };
  try {
    const worker = await isolate();
    const visit = async (path) => {
      stripeCalls = 0;
      const ctx = context();
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE, "CF-IPCountry": "US" } }, ctx);
      const html = await response.text();
      await ctx.settle();
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("x-radar-served"), null, path);
      assert.ok(!html.includes('data-radar-priced=""'), `${path}: drawn without prices`);
      return stripeCalls;
    };
    const perRender = await visit("/en/pro");
    assert.ok(perRender >= 1, "a render asks Stripe while it has no price");
    for (let request = 0; request < 3; request += 1) {
      assert.equal(await visit("/en/pro?from=ios_app&sf=USA"), perRender, `request ${request + 1}: one render`);
    }
    assert.deepEqual(cache.puts, [], "a page without prices is never kept");
  } finally {
    Date.now = realNow;
    globalThis.fetch = async (input) => { throw new Error(`unexpected fetch of ${typeof input === "string" ? input : input.url}`); };
    delete globalThis.caches;
  }
});

// next-intl's middleware writes every page's Link alternates from X-Forwarded-Host and
// X-Forwarded-Proto when a request has them, and Cloudflare passes a client's own X-Forwarded-Host
// through. One such request on a colo miss, or on the stale hit that sets off a refresh, used to
// store a page whose Link named the client's host for every reader after it.
test("a forwarded host, port or scheme a client sends never reaches a stored page's Link header", async () => {
  const env = { DB: emptyD1(), ASSETS: assets(), STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_PRICE_ID: "price_monthly_placeholder" };
  const cache = colo();
  globalThis.caches = cache;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input.url;
    assert.ok(href.startsWith("https://api.stripe.com/v1/prices/"), `unexpected fetch of ${href}`);
    return Response.json({ currency: "cad", unit_amount: 699, recurring: { interval: "month" }, currency_options: { usd: { unit_amount: 499 } } });
  };
  const forged = { accept: PAGE, "CF-IPCountry": "CA", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", "x-forwarded-port": "8443" };
  try {
    const worker = await isolate();
    // Misses: the Pro page, a locale's not-found page, and a Pro page asked for with a campaign tag.
    for (const path of ["/en/pro", "/en/zz-not-a-page", "/fr/pro?utm_source=x"]) {
      const ctx = context();
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: forged }, ctx);
      assert.doesNotMatch(response.headers.get("link") || "", /evil\.example/, `${path}: the forged request's own answer`);
      await response.text();
      await ctx.settle();
    }
    // A stale copy, refreshed by a forged request's stale hit.
    cache.store.set(`${KEY}/es/support`, storedCopy("<html><body>viejo</body></html>", 20 * MINUTE, { locale: "es" }));
    const ctx = context();
    const stale = await call(worker, env, `${ORIGIN}/es/support`, { headers: forged }, ctx);
    assert.equal(stale.headers.get("x-radar-served"), "cache");
    await stale.text();
    await ctx.settle();

    for (const key of [`${KEY}/en/pro?currency=cad`, `${KEY}/en/zz-not-a-page`, `${KEY}/fr/pro?currency=cad`, `${KEY}/es/support`]) {
      const entry = cache.store.get(key);
      assert.ok(entry, `${key} was stored`);
      const copy = stored(entry);
      assert.doesNotMatch(copy.text, /viejo/, `${key} is a fresh render`);
      const link = copy.headers.get("link") || "";
      // No hreflang alternates in a header at all now (alternateLinks: false in i18n/routing.ts): the
      // HTML and the sitemap carry them. Whatever else a Link may hold, never the client's host.
      assert.doesNotMatch(link, /hreflang=/, `${key}: ${link}`);
      assert.doesNotMatch(link, /evil\.example|:8443|http:\/\//, `${key}: ${link}`);
    }
    // And a plain reader afterwards is handed those copies.
    for (const path of ["/en/pro", "/en/zz-not-a-page", "/fr/pro", "/es/support"]) {
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE, "CF-IPCountry": "CA" } });
      assert.equal(response.headers.get("x-radar-served"), "cache", path);
      assert.doesNotMatch(response.headers.get("link") || "", /evil\.example/, path);
      await response.text();
    }
  } finally {
    globalThis.fetch = async (input) => { throw new Error(`unexpected fetch of ${typeof input === "string" ? input : input.url}`); };
    delete globalThis.caches;
  }
});

// The checks that decide whether a request may share a page compare the path's raw segments, and
// the app routes on decoded ones: /en/pr%6F is the Pro page to the app, and was kept with no currency
// bucket. Cloudflare decodes such a segment while the zone normalizes incoming URLs, which is a
// setting; here nothing decodes it, so each must render for its reader and nothing may be kept.
test("an address with a percent-encoded locale or page segment, or a doubled slash, is rendered for its reader alone", async () => {
  const env = { DB: emptyD1(), ASSETS: assets({ "/en/terms": TERMS }), STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_PRICE_ID: "price_monthly_placeholder" };
  const cache = colo();
  globalThis.caches = cache;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input.url;
    assert.ok(href.startsWith("https://api.stripe.com/v1/prices/"), `unexpected fetch of ${href}`);
    return Response.json({ currency: "cad", unit_amount: 699, recurring: { interval: "month" }, currency_options: { usd: { unit_amount: 499 } } });
  };
  try {
    const worker = await isolate();
    for (const [path, country] of [
      ["/en/pr%6F", "CA"],
      ["/en/pr%6F", "US"],
      ["/en/%70ro?utm_source=x", "DE"],
      ["/en/de%61ls/corner-wings", "CA"],
      ["/%65n/terms", "CA"],
      ["//en/pro", "CA"],
    ]) {
      const ctx = context();
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE, "CF-IPCountry": country } }, ctx);
      assert.equal(response.headers.get("x-radar-served"), null, `${path} (${country}) was answered from the bake or a copy`);
      await response.body?.cancel();
      await ctx.settle();
    }
    assert.deepEqual(cache.puts, [], "nothing spelled that way is kept");
  } finally {
    globalThis.fetch = async (input) => { throw new Error(`unexpected fetch of ${typeof input === "string" ? input : input.url}`); };
    delete globalThis.caches;
  }
});

// A deal put back to draft, or folded into another listing, after its page was stored: the copy is
// not an old version of the page but a different answer, the offer staff took down. A refresh that
// renders the deal's 404 or its alias redirect deletes the copy, as does a miss that finds a copy too
// old to serve; the 404 is still never stored. An error says nothing about the deal and leaves the
// copy to be served stale, as before.
test("a deal withdrawn since its copy was stored loses the copy; an error leaves it", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    const DB = catalogueD1();
    const env = { DB, ASSETS: assets(), RENDER_DEADLINE_MS: "5000" };
    const old = "<html><body>the offer as it was</body></html>";
    for (const slug of ["corner-draft", "corner-wings-twin"]) {
      const key = `${KEY}/en/deals/${slug}`;
      cache.store.set(key, storedCopy(old, 20 * MINUTE));
      const ctx = context();
      const served = await call(worker, env, `${ORIGIN}/en/deals/${slug}`, { headers: { accept: PAGE } }, ctx);
      assert.equal(served.headers.get("x-radar-served"), "cache", `${slug}: the stale copy goes out while it is refreshed`);
      assert.equal(await served.text(), old);
      await ctx.settle();
      assert.ok(!cache.store.has(key), `${slug}: the refresh deleted the copy`);
    }
    // The next reader is rendered what the deal's address answers now, and that is not kept either.
    const draftCtx = context();
    const draft = await call(worker, env, `${ORIGIN}/en/deals/corner-draft`, { headers: { accept: PAGE } }, draftCtx);
    assert.equal(draft.status, 404);
    assert.equal(draft.headers.get("x-radar-served"), null);
    await draft.text();
    await draftCtx.settle();
    assert.ok(!cache.store.has(`${KEY}/en/deals/corner-draft`));
    const twin = await call(worker, env, `${ORIGIN}/en/deals/corner-wings-twin`, { headers: { accept: PAGE } });
    assert.equal(twin.status, 308);
    assert.equal(new URL(twin.headers.get("location"), ORIGIN).pathname, "/en/deals/corner-wings");
    await twin.body?.cancel();

    // A copy past a day is not served but kept as the watchdog's fallback; a render that says the deal
    // is gone takes it away too. A HEAD changes nothing.
    const aged = `${KEY}/fr/deals/corner-draft`;
    cache.store.set(aged, storedCopy(old, 25 * 60 * MINUTE, { locale: "fr" }));
    const headCtx = context();
    const head = await call(worker, env, `${ORIGIN}/fr/deals/corner-draft`, { method: "HEAD", headers: { accept: PAGE } }, headCtx);
    assert.equal(head.status, 404);
    await headCtx.settle();
    assert.ok(cache.store.has(aged), "a HEAD deletes nothing");
    const agedCtx = context();
    const gone = await call(worker, env, `${ORIGIN}/fr/deals/corner-draft`, { headers: { accept: PAGE } }, agedCtx);
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get("x-radar-served"), null);
    assert.doesNotMatch(await gone.text(), /the offer as it was/);
    await agedCtx.settle();
    assert.ok(!cache.store.has(aged), "the fallback copy of a withdrawn deal is deleted");

    // D1 failing: the refresh errors, and the copy stays, leased, to be served until one succeeds.
    const kept = `${KEY}/en/deals/corner-tacos`;
    cache.store.set(kept, storedCopy(old, 20 * MINUTE));
    DB.control.broken = true;
    const brokenCtx = context();
    const during = await call(worker, env, `${ORIGIN}/en/deals/corner-tacos`, { headers: { accept: PAGE } }, brokenCtx);
    assert.equal(during.headers.get("x-radar-served"), "cache");
    await during.text();
    await brokenCtx.settle();
    DB.control.broken = false;
    const copy = cache.store.get(kept);
    assert.ok(copy, "an error is not a withdrawal");
    assert.equal(stored(copy).text, old);
    assert.ok(Number(stored(copy).headers.get("x-radar-refresh-leased-until")) > Date.now());
    assert.ok(!cache.deletes.includes(kept));
  } finally {
    delete globalThis.caches;
  }
});

test("a locale's not-found page is kept for an hour; a deal's, never", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    const env = { DB: emptyD1(), ASSETS: assets() };
    const ctx = context();
    const missing = await call(worker, env, `${ORIGIN}/en/no-such-page`, { headers: { accept: PAGE } }, ctx);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("x-radar-served"), null);
    const html = await missing.text();
    await ctx.settle();
    const copy = stored(cache.store.get(`${KEY}/en/no-such-page`));
    assert.equal(copy.status, 404);
    assert.equal(copy.headers.get("cache-control"), "public, max-age=0, s-maxage=3600");
    assert.equal(copy.text, html);

    const again = await call(worker, env, `${ORIGIN}/en/no-such-page`, { headers: { accept: PAGE } });
    assert.equal(again.status, 404);
    assert.equal(again.headers.get("x-radar-served"), "cache");
    assert.equal(again.headers.get("cache-control"), "private, no-cache");
    assert.equal(await again.text(), html);

    // A deal that is not there may be published a minute from now.
    const dealCtx = context();
    const deal = await call(worker, env, `${ORIGIN}/en/deals/not-published-yet`, { headers: { accept: PAGE } }, dealCtx);
    assert.equal(deal.status, 404);
    await deal.text();
    await dealCtx.settle();
    assert.ok(!cache.store.has(`${KEY}/en/deals/not-published-yet`));

    // An hour on, a stored not-found page is rendered again rather than served.
    cache.store.set(`${KEY}/fr/ancienne-page`, storedCopy("<html><body>an old 404</body></html>", 61 * MINUTE, { status: 404, locale: "fr" }));
    const old = await call(worker, env, `${ORIGIN}/fr/ancienne-page`, { headers: { accept: PAGE } });
    assert.equal(old.status, 404);
    assert.equal(old.headers.get("x-radar-served"), null);
    assert.doesNotMatch(await old.text(), /an old 404/);
  } finally {
    delete globalThis.caches;
  }
});

// An internal cache key asked for as an address is the site's not-found page - never the entry
// stored under it, and never itself stored, though it is a 404 under a locale once rewritten.
test("an internal cache path is never looked up, and its 404 never stored", async () => {
  const worker = await isolate();
  const cache = colo();
  globalThis.caches = cache;
  try {
    cache.store.set(`${KEY}/en`, storedCopy("<html><body>a stored page</body></html>", MINUTE));
    const env = { DB: emptyD1(), ASSETS: assets({ "/en": HOME }) };
    for (const path of ["/__page-cache/dev/en", "/__page-cache/dev/en/no-such-page"]) {
      const ctx = context();
      const response = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE } }, ctx);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("x-radar-served"), null, path);
      assert.doesNotMatch(await response.text(), /a stored page|baked home/, path);
      await ctx.settle();
    }
    assert.deepEqual(cache.puts, []);
  } finally {
    delete globalThis.caches;
  }
});

test("a stale copy is refreshed once per colo per minute, not once per request", async () => {
  const realNow = Date.now;
  const cache = colo();
  globalThis.caches = cache;
  try {
    // A deal page whose render never finishes, so every refresh fails and leaves its lease behind.
    const env = { DB: hangingD1(), ASSETS: assets(), RENDER_DEADLINE_MS: "100" };
    cache.store.set(`${KEY}/en/deals/stale-deal`, storedCopy("<html><body>twenty minutes old</body></html>", 20 * MINUTE));
    const first = await isolate();
    const a = context();
    const served = await call(first, env, `${ORIGIN}/en/deals/stale-deal`, { headers: { accept: PAGE } }, a);
    assert.equal(served.headers.get("x-radar-served"), "cache");
    assert.match(await served.text(), /twenty minutes old/);
    assert.equal(a.pending.length, 1, "the first stale hit starts a refresh");

    const b = context();
    await (await call(first, env, `${ORIGIN}/en/deals/stale-deal`, { headers: { accept: PAGE } }, b)).text();
    assert.equal(b.pending.length, 0, "the isolate already refreshing it starts no second one");

    await a.settle();
    const leased = stored(cache.store.get(`${KEY}/en/deals/stale-deal`));
    const until = Number(leased.headers.get("x-radar-refresh-leased-until"));
    assert.ok(until > realNow() + 50_000 && until <= realNow() + 60_000, `leased until ${until}`);
    assert.match(leased.text, /twenty minutes old/, "the stale copy is what is re-stored, with the lease on it");
    assert.ok(logged.some((line) => line.includes("background refresh of /en/deals/stale-deal")), "the failed refresh is logged");

    // Another isolate in the same colo sees the lease.
    const second = await isolate();
    const c = context();
    const fromOther = await call(second, env, `${ORIGIN}/en/deals/stale-deal`, { headers: { accept: PAGE } }, c);
    assert.equal(fromOther.headers.get("x-radar-served"), "cache");
    assert.equal(fromOther.headers.get("x-radar-refresh-leased-until"), null, "the lease stays in the cache");
    assert.equal(fromOther.headers.get("x-radar-cached-at"), null);
    await fromOther.text();
    assert.equal(c.pending.length, 0, "a refresh leased elsewhere is not repeated");

    // Once the lease has run out, the next stale hit tries again - a GET, not a HEAD.
    Date.now = () => realNow() + 61_000;
    const head = context();
    const headed = await call(second, env, `${ORIGIN}/en/deals/stale-deal`, { method: "HEAD", headers: { accept: PAGE } }, head);
    assert.equal(headed.headers.get("x-radar-served"), "cache");
    assert.equal(head.pending.length, 0, "a HEAD never refreshes");
    const d = context();
    await (await call(second, env, `${ORIGIN}/en/deals/stale-deal`, { headers: { accept: PAGE } }, d)).text();
    assert.equal(d.pending.length, 1, "a lease that has run out is taken again");
    await d.settle();
  } finally {
    Date.now = realNow;
    delete globalThis.caches;
  }
});

test("a refresh that renders replaces the stale copy with a fresh one", async () => {
  const cache = colo();
  globalThis.caches = cache;
  try {
    const env = { DB: emptyD1(), ASSETS: assets() };
    cache.store.set(`${KEY}/es/terms`, storedCopy("<html><body>viejo</body></html>", 30 * MINUTE, { locale: "es" }));
    const worker = await isolate();
    const ctx = context();
    const served = await call(worker, env, `${ORIGIN}/es/terms?utm_source=x`, { headers: { accept: PAGE } }, ctx);
    assert.equal(served.headers.get("x-radar-served"), "cache");
    assert.match(await served.text(), /viejo/);
    await ctx.settle();
    const fresh = stored(cache.store.get(`${KEY}/es/terms`));
    assert.doesNotMatch(fresh.text, /viejo/);
    assert.doesNotMatch(fresh.text, /utm_source/, "refreshed from the bare address");
    assert.equal(fresh.headers.get("x-radar-refresh-leased-until"), null);
    assert.ok(Date.now() - Number(fresh.headers.get("x-radar-cached-at")) < MINUTE);
  } finally {
    delete globalThis.caches;
  }
});

// The cheap answers are ahead of the admission gate: a full isolate still answers a scanner, a
// signed-out reader's dashboard link and a baked page, and refuses only what would render.
test("probes, signed-out dashboard links and baked pages are answered while the isolate is full", async () => {
  const worker = await isolate();
  const env = { DB: hangingD1(), ASSETS: assets({ "/en": HOME }), RENDER_DEADLINE_MS: "2000" };
  const holders = [];
  for (let slot = 0; slot < 12; slot += 1) {
    holders.push(call(worker, env, `${ORIGIN}/en/deals/stuck-${slot}`, { headers: { accept: "application/json" } }));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const full = async (when) => {
    const refused = await call(worker, env, `${ORIGIN}/en/for-restaurants`, { headers: { accept: PAGE } });
    assert.equal(refused.status, 503, `the isolate is full ${when}`);
    await refused.body?.cancel();
  };
  try {
    await full("to begin with");

    for (const [path, lang] of [["/wp-login.php", "en"], ["/fr/.env", "fr"], ["/es/wp-admin/install.php", "es"]]) {
      const probe = await call(worker, env, `${ORIGIN}${path}`, { headers: { accept: PAGE } });
      assert.equal(probe.status, 404, path);
      assert.ok((await probe.text()).includes(`<html lang="${lang}">`), path);
      assert.equal(probe.headers.get("x-content-type-options"), "nosniff");
    }
    const dashboard = await call(worker, env, `${ORIGIN}/en/dashboard/alerts`, { headers: { accept: PAGE } });
    assert.equal(dashboard.status, 307);
    assert.equal(dashboard.headers.get("location"), "/en/sign-in?redirect_url=%2Fen%2Fdashboard%2Falerts");
    const home = await call(worker, env, `${ORIGIN}/en`, { headers: { accept: PAGE } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("x-radar-served"), "baked");
    await home.text();
    await full("still, so none of the answers above can have been a render");
  } finally {
    for (const held of await Promise.all(holders)) assert.equal(held.status, 503);
  }
});

// The redirect a signed-out reader's dashboard link gets is answered by the Worker itself, so it has
// to be the app's own response, header for header. The Worker answers a GET; a HEAD of the same
// address still goes to the app, which is how the two are compared here. The GETs are made while the
// isolate is full, which is what shows they were never rendered: the app's answer would be a 503.
test("a signed-out reader's dashboard link gets the app's own redirect, without a render", async () => {
  const sections = [...readFileSync(new URL("../app/[locale]/dashboard/sections.ts", import.meta.url), "utf8").match(/dashboardSections = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, ["saved", "areas", "preferences", "alerts", "history", "contributions", "account", "billing", "privacy"]);
  const locales = ["en", "fr", "es"];
  const variants = (locale) => {
    const other = locale === "en" ? "fr" : "en";
    return [
      { label: "no cookie, no language", origin: ORIGIN, headers: {} },
      { label: "its own locale's cookie", origin: ORIGIN, headers: { cookie: `NEXT_LOCALE=${locale}`, "accept-language": "de-DE,de;q=0.9" } },
      { label: "another locale's cookie", origin: ORIGIN, headers: { cookie: `theme=dark; NEXT_LOCALE=${other}`, "accept-language": `${locale}` } },
      { label: "the later of two cookies", origin: ORIGIN, headers: { cookie: `NEXT_LOCALE=${locale}; NEXT_LOCALE=${other}` } },
      { label: "a cookie that does not decode", origin: ORIGIN, headers: { cookie: "NEXT_LOCALE=%E0%A4%A" } },
      { label: "a document request", origin: ORIGIN, headers: { "sec-fetch-dest": "document", cookie: `NEXT_LOCALE=${other}` } },
      { label: "not a document", origin: ORIGIN, headers: { "sec-fetch-dest": "empty", "accept-language": "fr-CA" } },
      { label: "forwarded host and scheme", origin: ORIGIN, headers: { "x-forwarded-host": "preview.radar.test", "x-forwarded-proto": "http" } },
      { label: "a host with a port", origin: "http://localhost:8787", headers: { host: "localhost:8787" } },
    ];
  };
  const addresses = (locale) => [`/${locale}/dashboard`, ...sections.map((section) => `/${locale}/dashboard/${section}`), `/${locale}/dashboard?utm_source=digest`];
  const headerList = (response) => {
    const list = [...response.headers].filter(([name]) => name !== "set-cookie");
    for (const cookie of response.headers.getSetCookie()) list.push(["set-cookie", cookie]);
    return list.sort(([a, x], [b, y]) => (a + x < b + y ? -1 : 1));
  };

  // Every GET, made while twelve hung renders fill the isolate.
  const full = await isolate();
  const hung = { DB: hangingD1(), ASSETS: assets(), RENDER_DEADLINE_MS: "5000" };
  const holders = [];
  for (let slot = 0; slot < 12; slot += 1) holders.push(call(full, hung, `${ORIGIN}/en/deals/stuck-${slot}`, { headers: { accept: "application/json" } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const answered = [];
  try {
    for (const locale of locales) {
      for (const variant of variants(locale)) {
        for (const address of addresses(locale)) {
          const response = await call(full, hung, `${variant.origin}${address}`, { headers: { accept: PAGE, ...variant.headers } });
          assert.equal(response.status, 307, `${address} (${variant.label}) should be answered by the Worker`);
          answered.push({ locale, variant, address, headers: headerList(response), body: response.body });
        }
      }
      // What the Worker leaves to the app, which here is a refusal at the full gate.
      for (const [address, headers] of [
        [`/${locale}/dashboard`, { "accept-language": "fr-CA,fr;q=0.9" }],
        [`/${locale}/dashboard?section=alerts`, {}],
        [`/${locale}/dashboard/locations`, {}],
        [`/${locale}/dashboard/nowhere`, {}],
        [`/${locale}/dashboard/`, {}],
        [`/${locale}/dashboard/alerts`, { cookie: "__session=eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
        [`/${locale}/dashboard/alerts`, { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig" }],
        [`/${locale}/dashboard`, { RSC: "1" }],
      ]) {
        const response = await call(full, hung, `${ORIGIN}${address}`, { headers: { accept: PAGE, ...headers } });
        assert.equal(response.status, 503, `${address} ${JSON.stringify(headers)} is the app's to answer`);
        await response.body?.cancel();
      }
    }
    const post = await call(full, hung, `${ORIGIN}/en/dashboard`, { method: "POST", headers: { accept: PAGE }, body: "" });
    assert.equal(post.status, 503, "only a GET");
    await post.body?.cancel();
    // Still full at the end, so every 307 above came from the Worker and not from a render.
    const still = await call(full, hung, `${ORIGIN}/en/for-restaurants`, { headers: { accept: PAGE } });
    assert.equal(still.status, 503, "the isolate emptied before the checks above finished; they prove nothing");
    await still.body?.cancel();
  } finally {
    for (const held of await Promise.all(holders)) assert.equal(held.status, 503);
  }

  // The app's own answer to each, on an isolate with room.
  const app = await isolate();
  const env = { DB: emptyD1(), ASSETS: assets() };
  for (const { variant, address, headers, body } of answered) {
    const response = await call(app, env, `${variant.origin}${address}`, { method: "HEAD", headers: { accept: PAGE, ...variant.headers } });
    assert.equal(response.status, 307, `${address} (${variant.label}): the app's answer`);
    assert.deepEqual(headers, headerList(response), `${address} (${variant.label}): the Worker's redirect differs from the app's`);
    assert.equal(body, null);
  }
  // Neither the app nor the Worker sends hreflang alternates in a Link header (alternateLinks: false
  // in i18n/routing.ts), so a forwarded host has nothing to leak into.
  for (const { variant, address, headers } of answered) {
    assert.ok(!headers.some(([name]) => name === "link"), `${address} (${variant.label}): no Link header`);
  }
  // And what the shortcut produced, for the record: the sign-in page, with the path to come back to.
  const sample = answered.find((entry) => entry.address === "/fr/dashboard/saved" && entry.variant.label === "no cookie, no language");
  assert.ok(sample.headers.some(([name, value]) => name === "location" && value === "/fr/sign-in?redirect_url=%2Ffr%2Fdashboard%2Fsaved"));
  assert.ok(sample.headers.some(([name, value]) => name === "set-cookie" && value.startsWith("NEXT_LOCALE=fr;")));
});


// RFC 9116: Contact and Expires are required, and Expires must be in the future and under a year out.
test("security.txt names a contact and an expiry that is always ahead and under a year away", async () => {
  const worker = await isolate();
  const env = { DB: emptyD1(), ASSETS: assets() };
  const response = await call(worker, env, `${ORIGIN}/.well-known/security.txt`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  const body = await response.text();
  assert.match(body, /^Contact: mailto:\S+@\S+$/m);
  assert.match(body, /^Canonical: https:\/\/radar\.cheap\/\.well-known\/security\.txt$/m);
  const expires = new Date(body.match(/^Expires: (\S+)$/m)[1]);
  const days = (expires.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 90 && days < 365, `${days} days`);
});
