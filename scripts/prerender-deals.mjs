#!/usr/bin/env node
// Prerenders every public deal page to a static file under dist/client, so the Worker can hand it
// back from the asset binding without rendering anything. The home page, the six static pages and
// the two sign-in shells are baked the same way for every locale (STATIC_PAGES), and sitemap.xml and
// robots.txt too (see bakeCrawlerFiles).
//
// Why this exists
// ---------------
// One deal page render costs several D1 queries and a full React SSR pass, which does not reliably
// fit in the platform's per-request CPU limit. The colo cache in worker/index.ts fixes every
// request after the first, but it cannot fix the first — the cache has to be populated by a render
// that might itself be killed. Baking the HTML at build time removes the render from the request
// path entirely. Assets that match a path are served without invoking the Worker at all, so they
// keep answering even when rendered routes cannot.
//
// Why the pages are rendered here rather than by `vinext build`
// -------------------------------------------------------------
// vinext does have a prerender phase, but it drives the built bundle in plain Node and passes
// `process.env` as the Worker env (see node_modules/vinext/dist/server/prod-server.js). There is
// no D1 there, so a deal page cannot render — which is also why tests/rendered-html.test.mjs only
// covers pages that never touch the database. This script supplies the missing half: a real
// SQLite database holding a copy of production, exposed through a D1-shaped facade, reached by
// aliasing the `cloudflare:workers` module the app imports `env` from.
//
// The copy is local and thrown away. That matters beyond speed: rendering a sponsored deal page
// runs an `UPDATE sponsorships SET clicks=clicks+1`, so pointing this at the live database would
// silently inflate every sponsor's click count by one per locale per deploy.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { renderDealImage } from "./deal-og.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = path.join(ROOT, "dist", "client");
const SERVER_ENTRY = path.join(ROOT, "dist", "server", "index.js");
const ORIGIN = "https://radar.cheap";
// Every locale the app routes, not just the one the sitemap lists. The sitemap names the English
// URL for each deal and points at the other two through hreflang alternates, so reading it alone
// would leave /fr and /es rendering on the Worker for every request — the languages least likely
// to have a warm colo cache. Kept in step with i18n/routing.ts by tests/prerender.test.mjs.
const LOCALES = ["en", "fr", "es"];

// A slug becomes a filename, so anything outside this set is left to render dynamically rather
// than guessed at — a slug with a slash or an encoded character in it would otherwise write
// outside the directory it belongs in.
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;

// The pages baked for every locale besides the deal pages, as the path under the locale: the home
// page, the six static pages, and the bare sign-in and sign-up shells - 27 files. None reads anything
// about its reader, and only the home page reads D1 (its list of recently checked deals and the city
// guides, app/home-listings.ts), which is the same for everyone and which this bakes from the copy
// of production below - so the file is the page every signed-out reader of that address gets,
// and it was being rendered once per colo per deploy, then again every fifteen minutes, to produce
// the same bytes. The Worker serves each ahead of its colo cache (BAKED_PAGES in worker/index.ts),
// and wrangler.jsonc routes each to the Worker first; tests/prerender.test.mjs keeps the three lists
// in step.
//
// The sign-in shells render only in a build that carries Clerk's publishable key
// (VITE_CLERK_PUBLISHABLE_KEY, which the deploy's build step has): without it <SignIn/> has no
// provider and the page is a 500, which fails this script - as it should, since the deployed page
// would be broken too.
const STATIC_PAGES = ["", "/terms", "/privacy", "/support", "/age-suitability", "/for-restaurants", "/for-creators", "/sign-in", "/sign-up"];

// The pages whose forms carry the Turnstile widget, rendered with the site key the Worker passes
// every render (x-turnstile-site-key). A bake made without it would ship a form whose challenge
// never loads, to everyone, until the next deploy.
const TURNSTILE_PAGES = new Set(["", "/for-creators", "/for-restaurants"]);

// Why a rendered page must not be baked, or null when it can be. A status other than 200 and a page
// cut off before </html> are the plain cases. The third is a page that rendered an error inside a
// 200: when something under a Suspense boundary throws on the server - one of vinext's own, around
// the streamed metadata, or a library's - React does not fail the response. It answers 200, ends
// the document properly, and leaves that boundary for the browser to render again, marked one of
// two ways: "<!--$!-->" in place of the boundary when it failed before it was written, or a
// `$RX("B:0", ...)` script after it when it failed while the response was streaming (both from
// react-dom/server; tests/prerender.test.mjs renders each and holds this to them). Served live,
// that is one reader's bad render. Baked, it is what everyone gets until the next deploy, and the
// deploy's own check cannot see it: it compares the served bytes with this very file, and a bad
// file matches itself.
function bakeProblem(status, html) {
  if (status !== 200) return String(status);
  if (!html.includes("</html>")) return "cut off before </html>";
  if (html.includes("<!--$!-->") || html.includes('$RX("')) return "part of the page failed to render (React left it to the browser)";
  return null;
}

function log(message) {
  process.stdout.write(`  ${message}\n`);
}

// D1's API is a thin wrapper over SQLite, so this is a straight translation rather than any kind
// of emulation. Only the shapes the app actually uses are implemented; anything else should throw
// loudly here rather than silently return nothing and bake a page with a section missing.
//
// One difference does need translating: node:sqlite builds each row with a null prototype, and D1
// hands back ordinary objects. React refuses a null-prototype object as a prop crossing from a
// server component to a client one, so a page that passed query rows straight to a client
// component rendered fine on the Worker and failed here - 510 pages at once, the day the deal
// page's week list became a client component. Copying each row makes it the object D1 would have
// returned.
const plain = (row) => ({ ...row });

function d1(db) {
  const statement = (sql, binds) => ({
    bind: (...args) => statement(sql, args.map((value) => (typeof value === "boolean" ? Number(value) : value))),
    first: async (column) => {
      const row = db.prepare(sql).get(...binds);
      if (row === undefined) return null;
      return column === undefined ? plain(row) : (row[column] ?? null);
    },
    all: async () => {
      const results = db.prepare(sql).all(...binds).map(plain);
      return { results, success: true, meta: { rows_read: results.length, changes: 0, duration: 0 } };
    },
    run: async () => {
      const info = db.prepare(sql).run(...binds);
      return {
        results: [],
        success: true,
        meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0), duration: 0 },
      };
    },
    raw: async () => db.prepare(sql).all(...binds).map((row) => Object.values(row)),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => Promise.all(statements.map((entry) => entry.all())),
    exec: async (sql) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

// The app reaches its bindings through `import { env } from "cloudflare:workers"`, a specifier
// Node has never heard of. The built bundle imports it dynamically (a template-literal import, so
// it is not hoisted), which is what makes intercepting it possible at all: this maps the
// specifier onto a data: module that hands back whatever env is installed on globalThis.
function aliasCloudflareWorkers() {
  const source =
    "export const env = globalThis.__PRERENDER_ENV__;\n" +
    // Real waitUntil keeps the isolate alive for background work. Here the process simply must not
    // die on a rejection from work nobody is waiting for.
    "export const waitUntil = (promise) => { if (promise && typeof promise.catch === 'function') promise.catch(() => {}); };\n";
  const url = `data:text/javascript,${encodeURIComponent(source)}`;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

function exportProductionDatabase(workDir) {
  // A local run can reuse an export it already has: each one reads the whole database, a real
  // share of the day's D1 read allowance, and a second run an hour later needs nothing newer. CI
  // never sets this, so every deploy still renders from production as it is.
  if (process.env.RADAR_PRERENDER_SQL) {
    log(`using the export at ${process.env.RADAR_PRERENDER_SQL}`);
    return process.env.RADAR_PRERENDER_SQL;
  }
  const sqlPath = path.join(workDir, "production.sql");
  log("exporting production D1...");
  // Through a shell, because npx on Windows is a .cmd and execFile cannot start one directly
  // (EINVAL). The output path is quoted for the same reason: it comes from mkdtemp, and on Windows
  // that sits under a user profile path that frequently contains a space.
  execSync(`npx wrangler d1 export radar --remote --output="${sqlPath}"`, {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  return sqlPath;
}

function openDatabase(sqlPath) {
  const db = new DatabaseSync(":memory:");
  // The dump wraps its inserts in a transaction and may set pragmas; exec runs the whole script.
  db.exec(readFileSync(sqlPath, "utf8"));
  applyPendingMigrations(db);
  return db;
}

// In CI the migrations are applied to production before this runs, so the export already has them
// and this finds nothing to do. Run locally ahead of a push that adds one, the export is the schema
// production has now, and a page that reads a new column 500s here while it would render in CI.
// Applying what d1_migrations does not record makes the local run render what CI will render.
function applyPendingMigrations(db) {
  const applied = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name));
  const pending = readdirSync(path.join(ROOT, "drizzle")).filter((name) => name.endsWith(".sql") && !applied.has(name)).sort();
  for (const name of pending) {
    log(`applying ${name} to the local copy (not yet in production)`);
    db.exec(readFileSync(path.join(ROOT, "drizzle", name), "utf8"));
  }
}

// sitemap.xml and robots.txt, rendered once here and written into dist/client beside the deal
// pages, so the Worker never renders either for a visitor.
//
// Both used to be rendered on every request. The sitemap is 342 KB — every public deal, three
// hreflang links each — rebuilt from a D1 query, and serializing it alone costs more than a
// request's CPU allowance on a cold isolate; under load the runtime killed it, and the killed
// requests kept their admission slots, so robots.txt then got the Worker's OVERLOADED 503. A
// crawler that gets a 5xx for robots.txt stops crawling the site. As files neither
// can fail that way. Both are listed in run_worker_first, but only so the Worker can send plain
// http to https (the asset layer would serve them over either): it hands the baked file straight
// back from the asset binding, ahead of its admission gate and without rendering anything
// (topLevelFile in worker/index.ts).
//
// app/sitemap.ts and app/robots.ts stay the source: this fetches them through the built Worker,
// exactly as a crawler would, so `vinext dev` (which has no dist/client) and any deploy that skips
// this script keep serving the dynamic versions. That is also why the stand-in asset binding below
// answers 404: finding no baked file, the Worker renders the route. The price is freshness: a deal
// published after a deploy is in the sitemap from the next one. Deploys run at least daily
// (.github/workflows/deploy.yml), and the deal page itself is live the moment it is published.
//
// Files in dist/client are served for every hostname the Worker is bound to, so
// affiliate.radar.cheap/robots.txt is now radar.cheap's, naming radar.cheap's sitemap. The dynamic
// affiliate copy listed hundreds of affiliate.radar.cheap/en/... URLs that answer 404, so that is
// no loss. (www.radar.cheap/robots.txt is a redirect to radar.cheap's, like everything on www.)
const CRAWLER_FILES = [
  { name: "sitemap.xml", looksRight: (body) => body.includes("<urlset") && body.includes("</urlset>") },
  { name: "robots.txt", looksRight: (body) => /^user-agent:/im.test(body) },
];

async function bakeCrawlerFiles(worker, env) {
  const bodies = {};
  for (const { name, looksRight } of CRAWLER_FILES) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/${name}`, { headers: { host: "radar.cheap" } }),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    );
    const body = await response.text();
    // Fatal, like a deal page that fails to render: a deploy that shipped an error page as its
    // sitemap would tell every search engine the site had no pages.
    if (!response.ok || !looksRight(body)) throw new Error(`${name} render failed with ${response.status}`);
    writeFileSync(path.join(CLIENT_DIR, name), body, "utf8");
    bodies[name] = body;
  }
  return bodies;
}

// The set of pages to bake is taken from the site's own sitemap rather than re-implementing
// `publicDealPredicate` here. That predicate decides what counts as a public deal — live, active,
// published, not expired past its grace period, not soft-deleted — and a second copy of it in
// this script would drift from the real one without anything failing. Reading the sitemap means
// the prerendered set is exactly the set of URLs the site tells search engines about.
//
// A deal whose slug was rewritten by scripts/backfill-deal-slugs.mjs is also reachable at its old
// /deals/deal-<uuid> path, and this used to bake that path as a second full copy of the page. The
// Worker now answers it with a 301 to the slug (canonicalDealRedirect in worker/index.ts) before
// it would ever look for a file, so only the slug is baked.
function dealSlugsFromSitemap(xml) {
  const slugs = new Set();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const segments = new URL(match[1]).pathname.split("/").filter(Boolean);
    const dealsAt = segments.indexOf("deals");
    // Only a ".../deals/<slug>" path, and only its final segment. Everything else in the sitemap
    // is the home page or a static page, baked from STATIC_PAGES instead; /pro, which reads the
    // reader's country and is kept in the Worker's colo cache once per currency; or /launch, once
    // it exists, which the colo cache holds like any other page.
    if (dealsAt !== -1 && segments.length === dealsAt + 2) slugs.add(segments[dealsAt + 1]);
  }
  return [...slugs];
}

// The home page, the static pages and the sign-in shells, for every locale, through the same
// worker.fetch as the deal pages below. A page bakeProblem refuses is a failure - one that does not
// render, renders without its closing tag, or renders an error inside a 200 - and so is a Turnstile
// page without the site key: each would be served to everyone, in place of a render, until the
// next deploy.
async function bakeStaticPages(worker, env, failures) {
  let baked = 0;
  for (const locale of LOCALES) {
    for (const page of STATIC_PAGES) {
      const pathname = `/${locale}${page}`;
      const response = await worker.fetch(
        new Request(`${ORIGIN}${pathname}`, { headers: { host: "radar.cheap", accept: "text/html" } }),
        env,
        { waitUntil() {}, passThroughOnException() {} },
      );
      const html = await response.text();
      const problem = bakeProblem(response.status, html);
      if (problem) {
        failures.push(`${problem} ${pathname}`);
        continue;
      }
      // The home page renders without its server list when the read fails, which is right for one
      // reader and wrong for a file everyone gets until the next deploy: the list is the home page's
      // only links to deals a crawler can see (app/home-listings.ts).
      if (page === "" && !html.includes('class="recent-checks"')) {
        failures.push(`${pathname} has no list of recently checked deals`);
        continue;
      }
      if (TURNSTILE_PAGES.has(page) && env.TURNSTILE_SITE_KEY && !html.includes(env.TURNSTILE_SITE_KEY)) {
        failures.push(`${pathname} has no Turnstile site key`);
        continue;
      }
      // "en.html" beside the "en" directory and "en/terms.html", never ".../index.html", for the
      // reason the deal pages below give: a sibling file is served at the page's own address.
      const outPath = path.join(CLIENT_DIR, `${locale}${page}.html`);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, html, "utf8");
      baked += 1;
    }
  }
  return baked;
}

// The city guides' pages (app/city-pages.ts): /en/cities, each city's hub and the topics the
// catalogue can fill, as the sitemap lists them. English only - /fr/cities/... and /es/cities/...
// redirect to these - and baked
// the way the home and static pages are, so a crawler's first request is a file. Which topics exist
// is the data's decision, so the list comes from the sitemap rather than from this script, the way
// the deal pages' does.
function cityPathsFromSitemap(xml) {
  const paths = new Set();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const pathname = new URL(match[1]).pathname;
    if (/^\/en\/cities(\/[a-z0-9-]+){0,2}$/.test(pathname)) paths.add(pathname);
  }
  return [...paths];
}

async function bakeCityPages(worker, env, failures, paths) {
  let baked = 0;
  for (const pathname of paths) {
    const response = await worker.fetch(
      new Request(`${ORIGIN}${pathname}`, { headers: { host: "radar.cheap", accept: "text/html" } }),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    );
    const html = await response.text();
    const problem = bakeProblem(response.status, html);
    if (problem) {
      failures.push(`${problem} ${pathname}`);
      continue;
    }
    const outPath = path.join(CLIENT_DIR, `${pathname}.html`);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
    baked += 1;
  }
  return baked;
}

// The not-found page, once per locale, at dist/client/__baked/404/<locale>.html.
//
// Every address under a locale that no route claims was a render of this page - header, footer
// and flight data, 13-30 ms of CPU locally against the platform's ten - and a scanner or a broken
// link asks for a different one each time. The Worker answers those from this file instead
// (unknownAddress and missingPage in worker/index.ts), with the 404 status and the locale cookie the
// render would have given them. Rendered here at an address no page can have, so the Worker, which
// finds no baked file on this pass, lets the render through.
const NOT_FOUND_DIR = path.join(CLIENT_DIR, "__baked", "404");

async function bakeNotFoundPages(worker, env, failures) {
  let baked = 0;
  for (const locale of LOCALES) {
    const pathname = `/${locale}/__not-a-page__/${Date.now()}`;
    const response = await worker.fetch(
      new Request(`${ORIGIN}${pathname}`, { headers: { host: "radar.cheap", accept: "text/html" } }),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    );
    const html = await response.text();
    if (response.status !== 404 || !html.includes("</html>") || !html.includes("<html")) {
      failures.push(`not-found page for ${locale}: ${response.status}, ${html.length} bytes`);
      continue;
    }
    mkdirSync(NOT_FOUND_DIR, { recursive: true });
    writeFileSync(path.join(NOT_FOUND_DIR, `${locale}.html`), html, "utf8");
    baked += 1;
  }
  return baked;
}

// Every shard of the deals snapshot, at dist/client/__baked/deals-snapshot/v<N>/<key>.json.
//
// A colo that holds no copy of a shard built it from D1 inside the first request that needed it:
// fifty to two hundred milliseconds of CPU, on every cell, after every deploy that changed the
// snapshot's format and in every colo traffic reached for the first time. The route now reads
// these files last, after the colo's and R2's copies, and serves one while it rebuilds the current
// revision behind the request (readBakedSnapshot and catchUp in app/api/deals/route.ts).
//
// Built the way a request builds them, through the Worker, with the Cache API stood in for by a
// map: a request placed in each cell that holds a branch makes the route build that cell (and the
// meta shard), one per country its country and nationwide shards, and what the route publishes
// under the fixed "latest" name is what is written. The keys and the format are the route's own;
// this script knows neither, which is the point.
const SNAPSHOT_DIR = path.join(CLIENT_DIR, "__baked", "deals-snapshot");

async function bakeSnapshotShards(worker, env, db, failures) {
  const captured = new Map();
  const pending = [];
  let cells = [];
  const countries = new Set();
  const key = (request) => (typeof request === "string" ? request : request.url);
  globalThis.caches = {
    default: {
      match: async () => undefined,
      delete: async () => false,
      put: async (request, response) => {
        const url = key(request);
        const match = /\/__deals-snapshot\/(v\d+)\/latest\/([^/]+)$/.exec(url);
        if (!match) return;
        const read = response.text().then((body) => { captured.set(`${match[1]}/${match[2]}`, body); });
        pending.push(read);
        await read;
      },
    },
  };
  try {
    cells = db.prepare(
      "SELECT DISTINCT CAST(floor(latitude) AS INTEGER) lat, CAST(floor(longitude) AS INTEGER) lng FROM restaurant_locations WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
    ).all();
    for (const row of db.prepare("SELECT DISTINCT UPPER(country) country FROM restaurants WHERE country IS NOT NULL UNION SELECT DISTINCT UPPER(country) FROM restaurant_locations WHERE country IS NOT NULL").all()) {
      if (/^[A-Z]{2}$/.test(row.country || "")) countries.add(row.country);
    }
    const requests = [
      ...cells.map((cell) => `/api/deals?lat=${cell.lat + 0.5}&lng=${cell.lng + 0.5}&radius=1&limit=1&tz=UTC`),
      ...[...countries].flatMap((country) => [`/api/deals?country=${country}&limit=1`, `/api/deals?scope=national&country=${country}&limit=1`]),
    ];
    for (const pathname of requests) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}${pathname}`, { headers: { host: "radar.cheap", accept: "application/json" } }),
        env,
        { waitUntil(promise) { pending.push(Promise.resolve(promise).catch(() => {})); }, passThroughOnException() {} },
      );
      await response.body?.cancel();
      if (response.status !== 200) failures.push(`snapshot shard request ${pathname}: ${response.status}`);
    }
    // Whatever the route scheduled behind those requests, including the publishes themselves.
    for (let round = 0; round < 5 && pending.length; round++) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  } finally {
    delete globalThis.caches;
  }
  if (!captured.has([...captured.keys()].find((name) => name.endsWith("/meta")) || "")) failures.push("the snapshot's meta shard was not built");
  for (const [name, body] of captured) {
    // "cell:43:-80" is written as cell_43_-80.json: a colon cannot be in a file name on Windows,
    // where this script also runs. The route asks for the same spelling (bakedSnapshotPath).
    const outPath = path.join(SNAPSHOT_DIR, `${name.replace(/:/g, "_")}.json`);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
  }
  return { shards: captured.size, cells: cells.length, countries: countries.size };
}

// One share card per deal in the sitemap, at dist/client/og/deals/<slug>.png (scripts/deal-og.mjs).
// The deal page's og:image names that address, and a deal without a file there gets /og.png from the
// Worker, so a card that cannot be drawn costs one preview its picture, not the deploy - up to a
// point: a handful failing is a font or a title, but a tenth failing is the generator being broken,
// and that fails the deploy so it is seen.
const CARD_FAILURE_LIMIT = 0.1;

async function bakeShareCards(db, slugs, failures) {
  const rows = new Map(
    db.prepare(
      `SELECT COALESCE(d.slug, d.id) AS key, d.restaurant, d.title, d.price, d.schedule, d.category, d.location_scope, COALESCE(l.city, d.city) AS city, l.region
         FROM deals d LEFT JOIN restaurant_locations l ON l.id = d.location_id
        WHERE d.status = 'live'`,
    ).all().map((row) => [row.key, row]),
  );
  mkdirSync(path.join(CLIENT_DIR, "og", "deals"), { recursive: true });
  let drawn = 0;
  let broken = 0;
  let wanted = 0;
  for (const slug of slugs) {
    const row = rows.get(slug);
    if (!row || !SAFE_SLUG.test(slug)) continue;
    wanted += 1;
    // A chain's offer runs at many branches; naming the one the row happens to carry would be wrong
    // for most of them.
    const chainWide = row.location_scope === "brand" || row.location_scope === "national";
    const where = chainWide ? "" : [row.city, row.region].filter(Boolean).join(", ");
    try {
      const png = await renderDealImage({ ...row, city: where });
      writeFileSync(path.join(CLIENT_DIR, "og", "deals", `${slug}.png`), png);
      drawn += 1;
    } catch (error) {
      broken += 1;
      log(`no share card for ${slug}: ${error?.message || error}`);
    }
  }
  if (wanted && broken / wanted > CARD_FAILURE_LIMIT) failures.push(`${broken} of ${wanted} share cards failed to draw`);
  return drawn;
}

async function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), "radar-prerender-"));
  let db = null;
  let rendered = 0;
  let staticPages = 0;
  let skipped = 0;
  let imageCount = 0;
  const failures = [];
  try {
    db = openDatabase(exportProductionDatabase(workDir));

    const vars = JSON.parse(readFileSync(path.join(ROOT, "dist", "server", "wrangler.json"), "utf8")).vars || {};
    const env = {
      ...vars,
      // Tells a page its reads are free. The deal page counts a national brand's branches only
      // here - against production D1 that count reads every one of them (see locationCount).
      RADAR_PRERENDER: "1",
      // The Worker gives up on a page render after eight seconds and answers without it (the render
      // watchdog in worker/index.ts), which is right for a visitor and wrong here: a national chain's
      // page read from an in-memory copy of production can be slow in plain Node, and a page cut
      // short would fail the deploy. Nothing here is waiting on a person.
      RENDER_DEADLINE_MS: String(10 * 60_000),
      DB: d1(db),
      // Returning 404 is what makes the Worker fall through to rendering. The prerendered files do
      // not exist yet on this pass, and a stub that pretended otherwise would bake empty pages.
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    };
    globalThis.__PRERENDER_ENV__ = env;
    aliasCloudflareWorkers();

    const { default: worker } = await import(`${new URL("../dist/server/index.js", import.meta.url).href}?prerender=${Date.now()}`);
    void SERVER_ENTRY;

    const crawlerFiles = await bakeCrawlerFiles(worker, env);
    log(`wrote ${CRAWLER_FILES.map(({ name }) => name).join(" and ")} to dist/client`);
    staticPages = await bakeStaticPages(worker, env, failures);
    log(`prerendered ${staticPages} of ${STATIC_PAGES.length * LOCALES.length} home, static and sign-in pages`);
    const cityPaths = cityPathsFromSitemap(crawlerFiles["sitemap.xml"]);
    const cityPages = await bakeCityPages(worker, env, failures, cityPaths);
    log(`prerendered ${cityPages} of ${cityPaths.length} city guide pages`);
    const notFoundPages = await bakeNotFoundPages(worker, env, failures);
    log(`prerendered ${notFoundPages} of ${LOCALES.length} not-found pages`);
    const shards = await bakeSnapshotShards(worker, env, db, failures);
    log(`baked ${shards.shards} snapshot shards (${shards.cells} cells, ${shards.countries} countries)`);
    const slugs = dealSlugsFromSitemap(crawlerFiles["sitemap.xml"]);
    log(`${slugs.length} deals x ${LOCALES.length} locales to prerender`);

    const targets = [];
    for (const slug of slugs) {
      if (!SAFE_SLUG.test(slug)) {
        skipped += LOCALES.length;
        continue;
      }
      for (const locale of LOCALES) targets.push({ locale, slug });
    }

    for (const { locale, slug } of targets) {
      const pathname = `/${locale}/deals/${slug}`;
      const response = await worker.fetch(
        new Request(`${ORIGIN}${pathname}`, { headers: { host: "radar.cheap", accept: "text/html" } }),
        env,
        { waitUntil() {}, passThroughOnException() {} },
      );
      const html = await response.text();
      const problem = bakeProblem(response.status, html);
      if (problem) {
        failures.push(`${problem} ${pathname}`);
        continue;
      }
      // Written as "<slug>.html", not "<slug>/index.html". With Cloudflare's default
      // auto-trailing-slash handling a directory index is served by redirecting /x to /x/, which
      // would change every canonical URL on the site; a sibling .html file is served at /x
      // directly, leaving the URLs exactly as they are today.
      const outPath = path.join(CLIENT_DIR, locale, "deals", `${slug}.html`);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, html, "utf8");
      rendered += 1;
    }

    imageCount = await bakeShareCards(db, slugs, failures);
  } finally {
    if (db) db.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  log(`prerendered ${rendered} deal pages across ${LOCALES.length} locales (${skipped} skipped)`);
  log(`drew ${imageCount} share cards`);
  if (failures.length) {
    // Loud, and fatal. A page that failed to prerender silently would fall back to rendering on
    // the Worker, which is the exact cost this script exists to remove — and it would look fine in
    // every test, because the page still works.
    log(`FAILED to prerender ${failures.length}:`);
    for (const failure of failures) log(`  ${failure}`);
    process.exitCode = 1;
  }
}

await main();
