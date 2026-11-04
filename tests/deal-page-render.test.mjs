// The deal page, rendered by the built worker against a real SQLite database made from
// drizzle/*.sql, the way scripts/prerender-deals.mjs renders it.
//
// What a deal page is allowed to be depends on the row behind it - a draft has no page, an
// archived deal keeps one that search engines are told to drop - and what it may claim depends on
// who checked it. Neither shows up in a type check or in the source text, so these render it.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__DEAL_PAGE_TEST_ENV__?.[key] });
export const waitUntil = (promise) => { if (promise && typeof promise.catch === "function") promise.catch(() => {}); };
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ALIAS, shortCircuit: true };
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

const sqlStamp = (date) => date.toISOString().replace("T", " ").slice(0, 19);
// Checked five days ago at 02:47 UTC: the evening before, in Ottawa. The date a reader in Ottawa
// would give it, and the one the page shows before hydration, is the earlier one.
const CHECKED = new Date(Date.now() - 5 * 86_400_000);
CHECKED.setUTCHours(2, 47, 3, 0);
const dayOf = (date, timeZone) => new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone }).format(date);
const dayIn = (timeZone) => dayOf(CHECKED, timeZone);
const IMPORTED_AT = new Date(Date.now() - 9 * 86_400_000);
IMPORTED_AT.setUTCHours(2, 47, 3, 0);
const IMPORTED = sqlStamp(IMPORTED_AT);
// Checked two days ago in the afternoon, by a migration that wrote the deal and its check and left
// the branch row at its import time - drizzle/0056's shape, and Deacon Brodies' on the live site.
const RECHECKED = new Date(Date.now() - 2 * 86_400_000);
RECHECKED.setUTCHours(16, 27, 33, 0);
const US_STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC "
  + "ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split(" ");

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  const restaurant = db.prepare("INSERT INTO restaurants (id,name,cuisine,is_chain,website,photo_url,country) VALUES (?,?,?,?,?,?,'CA')");
  restaurant.run("kelseys", "Kelseys", "Pub", 1, "https://kelseys.example", "/api/photo/restaurants/kelseys/hero.jpg");
  // An independent with no website on file: its deals were found on a directory.
  restaurant.run("corner-pub", "The Corner Pub", "Pub", 0, null, null);
  const branch = db.prepare("INSERT INTO restaurant_locations (id,restaurant_id,address,city,region,country,postal_prefix,latitude,longitude,timezone) VALUES (?,?,?,?,?,'CA',?,?,?,?)");
  branch.run("k-bank", "kelseys", "2206 Bank St", "Ottawa", "ON", "K1V", 45.36, -75.65, "America/Toronto");
  branch.run("k-merivale", "kelseys", "1500 Merivale Rd", "Ottawa", "ON", "K2E", 45.35, -75.73, "America/Toronto");
  branch.run("k-windsor", "kelseys", "4115 Walker Road", "Kapuskasing", "ON", "P5N", 49.42, -82.43, "America/Toronto");
  branch.run("k-calgary", "kelseys", "1 Stephen Ave", "Calgary", "AB", "T2P", 51.04, -114.07, "America/Edmonton");
  branch.run("corner", "corner-pub", "12 Elgin St", "Ottawa", "ON", "K1P", 45.42, -75.69, "America/Toronto");

  const deal = db.prepare(`INSERT INTO deals (id,slug,restaurant,restaurant_id,location_id,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url,
      status,active,verification_status,verified_at,created_at,publish_at,deleted_at,location_scope)
    VALUES (?,?,?,?,?,?,'Happy hour','Pub',?,?,?,?,?,'🍺',?,?,?,?,?,?,?,?,?)`);
  const live = (id, restaurantId, name, location, title, schedule, city, address, price, source, verification, verifiedAt, extra = {}) =>
    deal.run(id, id, name, restaurantId, location, title, schedule, city, "K1P", address, price, source,
      extra.status ?? "live", extra.active ?? 1, verification, verifiedAt, extra.created ?? IMPORTED, extra.publishAt ?? null, extra.deletedAt ?? null, extra.scope ?? null);

  // The same happy hour at three Kelseys, two of them in Ottawa, checked by staff five days ago.
  live("kelseys-bank-happy", "kelseys", "Kelseys", "k-bank", "Happy Hour", "Daily 3-6 PM", "Ottawa", "2206 Bank St", "$5 pints", "https://kelseys.example/happy-hour", "verified", sqlStamp(CHECKED));
  live("kelseys-merivale-happy", "kelseys", "Kelseys", "k-merivale", "Happy Hour", "Daily 3-6 PM", "Ottawa", "1500 Merivale Rd", "$5 pints", "https://kelseys.example/happy-hour", "verified", sqlStamp(CHECKED));
  live("kelseys-windsor-happy", "kelseys", "Kelseys", "k-windsor", "Happy Hour", "Daily 3-6 PM", "Kapuskasing", "4115 Walker Road", "$5 off burgers", "https://kelseys.example/happy-hour", "verified", sqlStamp(CHECKED));
  // Imported from a directory and never reviewed: verified_at is the import time.
  live("corner-wings", "corner-pub", "The Corner Pub", "corner", "Wing night", "Wed", "Ottawa", "12 Elgin St", "Half price wings · about $9", "https://deal-directory.example/on/ottawa/", "needs_review", IMPORTED);
  live("corner-tacos", "corner-pub", "The Corner Pub", "corner", "Taco Tuesday", "Tue", "Ottawa", "12 Elgin St", "$3 tacos", "https://deal-directory.example/on/ottawa/", "needs_review", IMPORTED);
  // Never public.
  live("corner-draft", "corner-pub", "Test Restaurant QA", "corner", "Unpublished QA appetizer night", "Daily", "Ottawa", "12 Elgin St", "Add pricing", "https://example.test", "needs_review", IMPORTED, { status: "draft", active: 0 });
  live("corner-scheduled", "corner-pub", "The Corner Pub", "corner", "Next month's secret special", "Fri", "Ottawa", "12 Elgin St", "$9", "https://example.test", "verified", sqlStamp(CHECKED), { publishAt: sqlStamp(new Date(Date.now() + 20 * 86_400_000)) });
  live("corner-deleted", "corner-pub", "The Corner Pub", "corner", "Deleted secret special", "Fri", "Ottawa", "12 Elgin St", "$9", "https://example.test", "verified", sqlStamp(CHECKED), { deletedAt: sqlStamp(new Date()) });
  // Public once, pulled since.
  live("corner-archived", "corner-pub", "The Corner Pub", "corner", "Oyster Monday", "Mon", "Ottawa", "12 Elgin St", "$1 oysters", "https://example.test", "verified", sqlStamp(CHECKED), { status: "archived", active: 0 });

  const link = db.prepare("INSERT INTO deal_locations (deal_id,location_id,eligibility,source_url,verified_at) VALUES (?,?,'confirmed',?,?)");
  for (const [id, location] of [["kelseys-bank-happy", "k-bank"], ["kelseys-merivale-happy", "k-merivale"], ["kelseys-windsor-happy", "k-windsor"]]) {
    link.run(id, location, "https://kelseys.example/happy-hour", sqlStamp(CHECKED));
  }
  // The Bank St offer runs at the other Ottawa branch and in Calgary too, for the postal-code
  // narrowing below.
  for (const location of ["k-merivale", "k-calgary"]) link.run("kelseys-bank-happy", location, "https://kelseys.example/happy-hour", sqlStamp(CHECKED));
  // What a directory import writes: 'confirmed', by the directory.
  link.run("corner-wings", "corner", "https://deal-directory.example/on/ottawa/", IMPORTED);
  // What the admin's Verify writes: the deal, its branch and this row, at one moment.
  const check = db.prepare("INSERT INTO verification_events (deal_id,status,method,source_url,verified_at) VALUES (?,'verified','source_review',?,?)");
  for (const id of ["kelseys-bank-happy", "kelseys-merivale-happy", "kelseys-windsor-happy"]) check.run(id, "https://kelseys.example/happy-hour", sqlStamp(CHECKED));
  // The Windsor offer also lists the Calgary branch, marked 'confirmed' by an import from Calgary's
  // own store page and never checked: Windsor's check stamped Windsor alone, and never read that page.
  link.run("kelseys-windsor-happy", "k-calgary", "https://kelseys.example/locations/calgary", IMPORTED);
  // And the Merivale branch, confirmed at the import from the deal's own promotions page, the way
  // scripts/brand-wide-eligibility.sql confirms a chain's branches: Windsor's check re-read that page.
  link.run("kelseys-windsor-happy", "k-merivale", "https://kelseys.example/happy-hour", IMPORTED);

  // Deacon Brodies' shape: imported, its branch stamped 'confirmed' at the import, then checked
  // against the restaurant's own page by a migration that left the branch row alone.
  restaurant.run("taco-bar", "The Taco Bar", "Mexican", 0, "https://taco.example", null);
  branch.run("taco", "taco-bar", "187 Bank St", "Ottawa", "ON", "K2P", 45.41, -75.69, "America/Toronto");
  live("taco-bar-tue", "taco-bar", "The Taco Bar", "taco", "Taco Tuesday", "Tue", "Ottawa", "187 Bank St", "$3 tacos", "https://taco.example/specials", "verified", sqlStamp(RECHECKED));
  link.run("taco-bar-tue", "taco", "https://taco.example/specials", IMPORTED);
  check.run("taco-bar-tue", "https://taco.example/specials", sqlStamp(RECHECKED));
  // Two more Ottawa restaurants, so the city has the five a guide needs (MIN_CITY_RESTAURANTS).
  for (const [id, name, street] of [["elgin-tap", "Elgin Tap", "300 Elgin St"], ["rideau-room", "Rideau Room", "50 Rideau St"]]) {
    restaurant.run(id, name, "Pub", 0, null, null);
    branch.run(`${id}-branch`, id, street, "Ottawa", "ON", "K1P", 45.42, -75.69, "America/Toronto");
    live(`${id}-pints`, id, name, `${id}-branch`, "Pint night", "Thu", "Ottawa", street, "$6 pints", "https://example.test/pints", "needs_review", IMPORTED);
  }
  // A French translation of the Bank St happy hour, and of nothing else.
  db.prepare("INSERT INTO deal_translations (deal_id,locale,source_updated_at,title,description,schedule,price) VALUES ('kelseys-bank-happy','fr','2026-10-01 00:00:00','Happy hour','Pintes à 5 $','Tous les jours 15 h-18 h','Pintes à 5 $')").run();
  // Food deals, so the happy hours are not nearly the whole city (MAX_TOPIC_SHARE).
  db.exec("UPDATE deals SET category='Food deal' WHERE id IN ('elgin-tap-pints','rideau-room-pints')");
  // The archived deal was checked five days ago, its branch with it, and pulled since: the shape of
  // drizzle/0059's Wingstop, archived because the price it had been checked at was over.
  link.run("corner-archived", "corner", "https://example.test", sqlStamp(CHECKED));
  check.run("corner-archived", "https://example.test", sqlStamp(CHECKED));

  // A national US chain, with DC and territories in its footprint.
  const footprint = Object.fromEntries([...US_STATES, "DC", "PR", "GU"].map((code) => [code, 3]));
  db.prepare("INSERT INTO restaurants (id,name,cuisine,is_chain,national_chain,website,country,footprint) VALUES ('subway-us','Subway','Sandwiches',1,1,'https://subway.example','US',?)").run(JSON.stringify(footprint));
  deal.run("subway-national", "subway-national", "Subway", "subway-us", null, "Footlong of the day", "Daily", "", "", "", "$6.99", "https://subway.example/deals",
    "live", 1, "verified", sqlStamp(CHECKED), IMPORTED, null, null, "national");
  return db;
}

globalThis.__DEAL_PAGE_TEST_ENV__ = { DB: d1(database()), ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url).href);

// No User-Agent by default, which is how scripts/prerender-deals.mjs asks for every page it bakes.
async function render(path, userAgent) {
  const headers = { host: "radar.cheap", accept: "text/html" };
  if (userAgent) headers["user-agent"] = userAgent;
  const response = await worker.fetch(new Request(`https://radar.cheap${path}`, { headers }), globalThis.__DEAL_PAGE_TEST_ENV__, { waitUntil() {}, passThroughOnException() {} });
  return { status: response.status, html: await response.text() };
}
const head = (html) => html.slice(0, html.indexOf("</head>"));
const metaContent = (html, name) => html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1];
const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1];

test("the title, description, canonical, hreflang and og: tags are in <head> for every reader", async () => {
  for (const agent of [undefined, "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (Windows NT 10.0) Chrome/136.0 Safari/537.36", "Twitterbot/1.0"]) {
    const { status, html } = await render("/en/deals/kelseys-bank-happy", agent);
    assert.equal(status, 200, String(agent));
    const top = head(html);
    assert.match(top, /<title>[^<]+<\/title>/, `${agent || "no user agent"}: <title> in <head>`);
    assert.match(top, /<link rel="canonical" href="https:\/\/radar\.cheap\/en\/deals\/kelseys-bank-happy"\/>/, `${agent || "no user agent"}: canonical in <head>`);
    assert.match(top, /hrefLang="fr" href="https:\/\/radar\.cheap\/fr\/deals\/kelseys-bank-happy"/);
    assert.doesNotMatch(top, /hrefLang="es"/, "there is no Spanish translation, so no Spanish page to name");
    assert.match(top, /hrefLang="x-default" href="https:\/\/radar\.cheap\/en\/deals\/kelseys-bank-happy"/);
    assert.match(top, /<meta name="description"/);
    assert.match(top, /<meta property="og:url" content="https:\/\/radar\.cheap\/en\/deals\/kelseys-bank-happy"\/>/);
    assert.doesNotMatch(html, /<div hidden id="S:0">/, "nothing is streamed into a hidden div after </head>");
  }
});

// A link preview is the photo at the address the page's own <img> uses (app/photo-url.ts), carrying
// the generation, or a crawler that fetched the photo before it was rewritten in place keeps that
// copy for the year /api/photo tells it to.
test("og:image and twitter:image name the deal's own share card, photo or no photo", async () => {
  // The card scripts/deal-og.mjs draws at deploy, at an address built from the slug alone: the
  // offer in the preview, not the restaurant's photo (which is still the page's own image) and not
  // the site-wide picture. A deal the generator has no file for is answered with /og.png by the
  // Worker, so the address is the same either way.
  const { html } = await render("/en/deals/kelseys-bank-happy");
  const expected = "https://radar.cheap/og/deals/kelseys-bank-happy.png";
  assert.equal(metaContent(head(html), "og:image"), expected);
  assert.equal(metaContent(head(html), "twitter:image"), expected);
  assert.equal(metaContent(head(html), "twitter:card"), "summary_large_image");
  const plain = await render("/en/deals/corner-wings");
  assert.equal(metaContent(head(plain.html), "og:image"), "https://radar.cheap/og/deals/corner-wings.png");
});

test("a draft, a deal scheduled for later and a deleted deal have no page", async () => {
  for (const slug of ["corner-draft", "corner-scheduled", "corner-deleted"]) {
    for (const locale of ["en", "fr"]) {
      const { status, html } = await render(`/${locale}/deals/${slug}`);
      assert.equal(status, 404, `${locale}/${slug}`);
      assert.match(html, /<meta name="robots" content="noindex"\/>/);
      assert.doesNotMatch(html, /Test Restaurant QA|QA appetizer|secret special|Add pricing/, `${slug} says nothing about the deal`);
    }
  }
});

test("an archived deal keeps its page, says it is over, and asks not to be indexed", async () => {
  const { status, html } = await render("/en/deals/corner-archived");
  assert.equal(status, 200);
  assert.match(html, /class="coverage-banner"/);
  assert.match(head(html), /<meta name="robots" content="noindex, follow"\/>/);
  const description = metaContent(html, "description");
  assert.equal(description, "This offer at The Corner Pub is no longer available.");
  assert.doesNotMatch(description, /\$1/, "the old price is not advertised");
  assert.match(html, /schema\.org\/Discontinued/);
  // And no claim that the offer stands: not "Last verified" with its "still accurate" tooltip, not
  // the check's date, not "Confirmed" on its branch. Asserted against the markup, since every
  // message in the catalog is in the page payload.
  assert.doesNotMatch(html, /<b>(?:Last verified|Re-checking|Listed)<span class="info-tip"/);
  assert.doesNotMatch(html, /class="verification-inline"/);
  assert.doesNotMatch(html, /Confirmed [A-Z][a-z]{2} \d/);
  assert.match(html, /<small>Not confirmed recently<\/small>/);
});

test("the sitemap lists public deals only, the pages it used to miss, and English-only pages without translations", async () => {
  const { status, html: xml } = await render("/sitemap.xml");
  assert.equal(status, 200);
  assert.match(xml, /<loc>https:\/\/radar\.cheap\/en\/deals\/kelseys-bank-happy<\/loc>/);
  for (const slug of ["corner-archived", "corner-draft", "corner-scheduled", "corner-deleted"]) assert.ok(!xml.includes(`/deals/${slug}<`), `${slug} is not in the sitemap`);
  assert.match(xml, /<loc>https:\/\/radar\.cheap\/en\/pro<\/loc>/);
  assert.match(xml, /<loc>https:\/\/radar\.cheap\/en\/for-creators<\/loc>/);
  const ages = xml.slice(xml.indexOf("<loc>https://radar.cheap/en/age-suitability</loc>"));
  assert.doesNotMatch(ages.slice(0, ages.indexOf("</url>")), /xhtml:link/, "an English-only page declares no translations");
  // Support and the legal pages have a French translation, and only that one.
  const support = xml.slice(xml.indexOf("<loc>https://radar.cheap/en/support</loc>"));
  const supportEntry = support.slice(0, support.indexOf("</url>"));
  assert.match(supportEntry, /hreflang="fr" href="https:\/\/radar\.cheap\/fr\/support"/);
  assert.doesNotMatch(supportEntry, /hreflang="es"/);
  const home = xml.slice(xml.indexOf("<loc>https://radar.cheap/en</loc>"));
  assert.match(home.slice(0, home.indexOf("</url>")), /hreflang="x-default"/);
});

test("robots.txt lets crawlers fetch the photos a deal page previews with, and nothing else under /api/", async () => {
  const { status, html: robots } = await render("/robots.txt");
  assert.equal(status, 200);
  assert.match(robots, /^Allow: \/api\/photo\/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.doesNotMatch(robots, /^Host:/im);
});

test("a chain's title names no city, and its description the offer, the address and the day it was checked where it is", async () => {
  const bank = await render("/en/deals/kelseys-bank-happy");
  const windsor = await render("/en/deals/kelseys-windsor-happy");
  assert.equal(titleOf(bank.html), "Happy Hour at Kelseys — Radar");
  assert.equal(titleOf(windsor.html), "Happy Hour at Kelseys — Radar");
  const description = metaContent(bank.html, "description");
  assert.equal(description, `Happy hour at Kelseys: $5 pints. Daily 3-6 PM. 2206 Bank St, Ottawa. Last checked ${dayIn("America/Toronto")}.`);
  // The same day the page shows before hydration.
  assert.match(bank.html, new RegExp(`<time dateTime="${CHECKED.toISOString().replace(/\./g, "\\.")}">${dayIn("America/Toronto")}</time>`));
  if (dayIn("UTC") !== dayIn("America/Toronto")) assert.ok(!description.includes(dayIn("UTC")), "not the UTC date");
  // The heading carries the offer as well as the restaurant.
  assert.match(bank.html.replace(/<!-- -->/g, ""), /<h1>Kelseys<span class="sr-only">: <\/span><span class="deal-type">Happy Hour<\/span><\/h1>/);
});

test("a single-location restaurant's title names its city and province; a national deal's names none", async () => {
  assert.equal(titleOf((await render("/en/deals/corner-wings")).html), "Wing night at The Corner Pub in Ottawa, ON — Radar");
  assert.equal(titleOf((await render("/fr/deals/taco-bar-tue")).html), "Taco Tuesday chez The Taco Bar à Ottawa, ON — Radar");
  const national = await render("/en/deals/subway-national");
  assert.equal(titleOf(national.html), "Footlong of the day at Subway — Radar");
  assert.match(metaContent(national.html, "description"), /^Happy hour at Subway: \$6\.99\. Daily\. Last checked /, "no branch address for a national deal");
});

test("fr and es metadata is in French and Spanish", async () => {
  const fr = await render("/fr/deals/kelseys-windsor-happy");
  assert.equal(titleOf(fr.html), "Happy Hour chez Kelseys — Radar");
  assert.match(metaContent(fr.html, "description"), /Dernière vérification : /);
  const es = await render("/es/deals/corner-wings");
  assert.equal(titleOf(es.html), "Wing night en The Corner Pub, Ottawa, ON — Radar");
  assert.match(metaContent(es.html, "description"), /Añadida el /);
  const home = await render("/fr");
  assert.equal(titleOf(home.html), "Radar — Offres de restaurants et 5 à 7 près de chez vous");
  const missing = await render("/es/deals/no-such-deal");
  assert.equal(missing.status, 404);
  assert.equal(titleOf(missing.html), "Página no encontrada — Radar");
});

// Asserted against the markup, not the page's text: every message in the catalog is in the page
// payload, "Last verified" among them, whatever the page renders.
test("an unreviewed import is 'Listed', never 'Last verified' or 'Confirmed'", async () => {
  const { html } = await render("/en/deals/corner-wings");
  assert.match(html, /<b>Listed<span class="info-tip"/);
  assert.doesNotMatch(html, /<b>Last verified</);
  assert.doesNotMatch(html, /Confirmed [A-Z][a-z]{2} \d/);
  assert.match(html, /<small>Not yet confirmed for this offer<\/small>/);
  assert.match(metaContent(html, "description"), /Listed /);
  assert.doesNotMatch(metaContent(html, "description"), /Last checked/);
  const checked = await render("/en/deals/kelseys-bank-happy");
  assert.match(checked.html, /<b>Last verified<span class="info-tip"/);
  assert.match(checked.html, /Confirmed [A-Z][a-z]{2} \d/);
});

// The branch line used to print deal_locations.verified_at as "Confirmed", and for most branches
// that is the moment they were imported.
test("a branch is 'Confirmed' on the day of a check that covered it, and 'Listed' when none did", async () => {
  const taco = await render("/en/deals/taco-bar-tue");
  assert.equal(taco.status, 200);
  assert.match(taco.html, new RegExp(`<small>Confirmed ${dayOf(RECHECKED, "America/Toronto")}</small>`), "the check, not the import");
  assert.doesNotMatch(taco.html, new RegExp(`Confirmed ${dayOf(IMPORTED_AT, "America/Toronto")}`));
  const bank = await render("/en/deals/kelseys-bank-happy");
  assert.match(bank.html, new RegExp(`<small>Confirmed ${dayIn("America/Toronto")}</small>`), "the Verify button's own stamp");
  // Windsor's second branch is in the payload, not the markup (the list shows the selected one).
  // Its line is worked out on the server, and neither raw column is published.
  const windsor = await render("/en/deals/kelseys-windsor-happy");
  const payload = windsor.html.replace(/\\"/g, '"');
  assert.match(payload, /"id":"k-windsor"[^}]*"confirmation":\{"state":"confirmed","at":"[^"]+"\}/);
  assert.match(payload, new RegExp(`"id":"k-calgary"[^}]*"confirmation":\\{"state":"listed","at":"${IMPORTED}"\\}`));
  assert.match(payload, new RegExp(`"id":"k-merivale"[^}]*"confirmation":\\{"state":"confirmed","at":"${sqlStamp(CHECKED)}"\\}`), "confirmed from the page the deal's check re-read");
  assert.doesNotMatch(payload, /eligibility_verified_at|"eligibility":/);
  // In French and Spanish, the same line.
  assert.match((await render("/fr/deals/taco-bar-tue")).html, /<small>Confirmé le \d/);
  assert.match(JSON.parse(readFileSync(new URL("../messages/es.json", import.meta.url), "utf8")).offerLocations.listedOn, /^Añadido el \{date\}$/);
});

test("a restaurant with no website is never pictured from the directory its deal came from", async () => {
  const { html } = await render("/en/deals/corner-wings");
  assert.doesNotMatch(html, /restaurant-photo\?url=https%3A%2F%2Fdeal-directory\.example/);
});

test("JSON-LD gives a price only when the deal states one for the item", async () => {
  const offer = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"Offer"[^<]*)<\/script>/)[1]);
  const pints = offer((await render("/en/deals/kelseys-bank-happy")).html);
  assert.equal(pints.price, 5);
  assert.equal(pints.priceCurrency, "CAD");
  for (const slug of ["kelseys-windsor-happy", "corner-wings"]) {
    const unpriced = offer((await render(`/en/deals/${slug}`)).html);
    assert.equal(unpriced.price, undefined, `${slug}: no price`);
    assert.equal(unpriced.priceCurrency, undefined, `${slug}: and no currency`);
  }
});

const jsonLd = (html, type) => html.match(new RegExp(`<script type="application/ld\\+json">(\\{"@context":"https://schema\\.org","@type":"${type}"[^<]*)</script>`))?.[1];

test("an Ottawa deal links into its city guide and the topic pages that list it, and nothing else does", async () => {
  // Kelseys, The Corner Pub, The Taco Bar, Elgin Tap and Rideau Room: five Ottawa restaurants, so the
  // city is a guide; three have a happy hour, so that topic is a page. Two taco nights are not enough.
  const { html } = await render("/en/deals/kelseys-bank-happy");
  assert.match(html, /<section class="deal-guide">/);
  assert.match(html, /href="\/en\/cities\/ottawa-on"/);
  assert.match(html, /href="\/en\/cities\/ottawa-on\/happy-hour"/);
  assert.doesNotMatch(html, /href="\/en\/cities\/ottawa-on\/tacos"/, "a topic with too little in it is no page to link to");
  // The guide is English, so a French deal page links to the English guide, not a redirect.
  assert.match((await render("/fr/deals/kelseys-bank-happy")).html, /href="\/en\/cities\/ottawa-on\/happy-hour"/);
  for (const slug of ["kelseys-windsor-happy", "subway-national", "corner-archived"]) {
    assert.doesNotMatch((await render(`/en/deals/${slug}`)).html, /class="deal-guide"/, `${slug} is in no city guide`);
  }
});

test("the breadcrumb is the city's guide, or the guide index, and never a search", async () => {
  const crumbs = (html) => JSON.parse(jsonLd(html, "BreadcrumbList")).itemListElement;
  const ottawa = crumbs((await render("/en/deals/kelseys-bank-happy?return=%2Fen%3Fq%3Dpints")).html);
  assert.equal(ottawa[1].item, "https://radar.cheap/en/cities/ottawa-on");
  // The k-windsor branch is in Kapuskasing, which has too few restaurants for a guide. Its search canonicalizes home.
  const windsor = crumbs((await render("/en/deals/kelseys-windsor-happy?return=%2Fen%3Fq%3Dpints")).html);
  assert.deepEqual(windsor.map((step) => step.position), [1, 2, 3]);
  assert.equal(windsor[1].item, "https://radar.cheap/en/cities");
  // A national deal sits right under Home.
  const national = crumbs((await render("/en/deals/subway-national")).html);
  assert.deepEqual(national.map((step) => [step.position, step.item]), [[1, "https://radar.cheap/en"], [2, "https://radar.cheap/en/deals/subway-national"]]);
  for (const html of [(await render("/en/deals/kelseys-windsor-happy")).html, (await render("/en/deals/subway-national")).html]) {
    assert.doesNotMatch(jsonLd(html, "BreadcrumbList"), /\?city=|\?country=/);
  }
});

test("the Offer names its share card, category and seller, and the branch's pin only when it is placed", async () => {
  const offer = JSON.parse(jsonLd((await render("/en/deals/kelseys-bank-happy")).html, "Offer"));
  assert.equal(offer.image, "https://radar.cheap/og/deals/kelseys-bank-happy.png");
  assert.equal(offer.category, "Happy hour");
  assert.equal(offer.seller.url, "https://kelseys.example");
  assert.deepEqual(offer.seller.geo, { "@type": "GeoCoordinates", latitude: 45.36, longitude: -75.65 });
  const national = JSON.parse(jsonLd((await render("/en/deals/subway-national")).html, "Offer"));
  assert.deepEqual(national.eligibleRegion, { "@type": "Country", name: "US" });
  assert.equal(national.seller.geo, undefined);
  assert.equal(national.seller.telephone, undefined);
});

test("'Also at this location' links stay in the page's language", async () => {
  const { html } = await render("/fr/deals/corner-wings");
  assert.match(html, /href="\/fr\/deals\/corner-tacos"/);
  assert.doesNotMatch(html, /href="\/deals\//);
});

test("a national chain counts fifty states and names DC and the territories apart", async () => {
  const { html } = await render("/en/deals/subway-national");
  assert.match(html, /Subway has restaurants in all 50 states\. Also in Washington, DC, Guam(?:,)? and Puerto Rico\./);
  assert.doesNotMatch(html, /in 5[1-9] states/);
});

test("a Canadian postal code the cache has never seen narrows by its province, and junk says so", async () => {
  const ottawa = await render("/en/deals/kelseys-bank-happy?postal=K1K1A1");
  assert.match(ottawa.html, /2 of 3 locations — ON\./);
  assert.doesNotMatch(ottawa.html, /Stephen Ave/, "Calgary is not in an Ontario list");
  const junk = await render("/en/deals/kelseys-bank-happy?postal=ZZZ");
  assert.match(junk.html, /role="status">We couldn’t place that postal or ZIP code/);
  const none = await render("/en/deals/kelseys-bank-happy");
  assert.doesNotMatch(none.html, /role="status">We couldn’t place/);
});

// The deal page's server render reads four parameters (SERVER_READ_PARAMS in worker/index.ts):
// `return` sets the back link and the area the list is narrowed to, `postal` and `zip` narrow it to
// the reader's province or state, and `all` lifts that. A request whose query holds only other
// parameters - a click id, a campaign tag, the home page's own filters, a cache-buster - is
// answered with the baked page, which is only right while the render ignores them; and each of the
// four has to keep changing the page, or one could be dropped from the table without anything
// noticing. Compared without the navigation echo, the one place vinext writes the address itself.
test("only return, postal, zip and all change a deal page's render", async () => {
  const echo = /nav:\{"pathname":"(?:[^"\\]|\\.)*","searchParams":\[(?:\["(?:[^"\\]|\\.)*","(?:[^"\\]|\\.)*"\],?)*\]\}/g;
  const page = async (query) => {
    const { status, html } = await render(`/en/deals/kelseys-bank-happy${query}`);
    assert.equal(status, 200, query);
    return html.replace(echo, "nav:{}");
  };
  const bare = await page("");
  assert.equal(await page("?v=1&country=CA&c=x&camp=launch&utm_source=y&fbclid=abc&q=wings&city=Ottawa"), bare, "parameters the render does not read leave it as it was");
  assert.notEqual(await page("?return=%2Fen%3Fcity%3DWindsor"), bare, "return changes the back link");
  const postal = await page("?postal=K1K1A1");
  assert.notEqual(postal, bare, "postal narrows the list");
  assert.notEqual(await page("?zip=K1K1A1"), bare, "zip narrows it too");
  assert.notEqual(await page("?postal=K1K1A1&all=1"), postal, "all lifts the narrowing");
});

// GET /fr/dashboard, signed out, used to answer 307 /sign-in?redirect_url=%2Fdashboard, which with
// no locale cookie is the English sign-in page.
test("the dashboard sends a signed-out reader to sign in in their own language, and back to it", async () => {
  const locationOf = async (path) => {
    const response = await worker.fetch(new Request(`https://radar.cheap${path}`, { headers: { host: "radar.cheap", accept: "text/html" } }), globalThis.__DEAL_PAGE_TEST_ENV__, { waitUntil() {}, passThroughOnException() {} });
    await response.text();
    return [response.status, response.headers.get("location")];
  };
  assert.deepEqual(await locationOf("/fr/dashboard"), [307, "/fr/sign-in?redirect_url=%2Ffr%2Fdashboard"]);
  assert.deepEqual(await locationOf("/es/dashboard/saved"), [307, "/es/sign-in?redirect_url=%2Fes%2Fdashboard%2Fsaved"]);
  // The dashboard's own redirects keep the locale too.
  assert.deepEqual(await locationOf("/fr/dashboard/nope"), [307, "/fr/dashboard"]);
  assert.deepEqual(await locationOf("/fr/dashboard?section=settings"), [307, "/fr/dashboard/account"]);
});

// The sign-in and sign-up pages cannot be rendered here: a local build has no Clerk publishable
// key, and the pages' <SignIn/> throws without one. So their metadata is checked where it lives.
test("sign-in and sign-up are kept out of search, under their own titles", async () => {
  const { code } = await import("./source.mjs");
  for (const [segment, key] of [["sign-in", "signInPageTitle"], ["sign-up", "signUpPageTitle"]]) {
    const layout = code(readFileSync(new URL(`../app/[locale]/${segment}/layout.tsx`, import.meta.url), "utf8"));
    assert.match(layout, /export async function generateMetadata/, segment);
    assert.match(layout, new RegExp(`title: t\\("${key}"\\)`), `${segment} has its own title`);
    assert.match(layout, /robots: \{ index: false, follow: true \}/, `${segment} is noindex`);
    assert.match(layout, new RegExp(`canonical: \`/\\$\\{locale\\}/${segment}\``), `${segment} has one canonical for every sub-path`);
  }
});

test("the city guides render as real pages, and the old Ottawa addresses lead to them", async () => {
  const index = await render("/en/cities");
  assert.equal(index.status, 200);
  assert.match(index.html, /href="\/en\/cities\/ottawa-on"/);
  assert.match(head(index.html), /<link rel="canonical" href="https:\/\/radar\.cheap\/en\/cities"/);
  // The index is grouped by country and province in the server HTML, with the search box beside it;
  // the script only narrows what is already there (app/[locale]/cities/CityFinder.tsx).
  const flat = index.html.replace(/<!-- -->/g, "");
  assert.match(flat, /<h2[^>]*>Canada/);
  assert.match(flat, /<h3>Ontario<\/h3>/);
  assert.match(flat, /<input type="search"/);
  assert.match(flat, /aria-pressed="true"[^>]*>All</);
  assert.match(flat, /<h2[^>]*>Most deals<\/h2>/);
  const indexGraph = [...index.html.matchAll(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@graph"[^<]*)<\/script>/g)].flatMap((match) => JSON.parse(match[1])["@graph"]);
  const guideCount = indexGraph.find((node) => node["@type"] === "ItemList").numberOfItems;
  assert.equal((flat.match(/class="city-finder-name"/g) || []).length, guideCount, "every guide in the list is a server-rendered link");

  const hub = await render("/en/cities/ottawa-on");
  assert.equal(hub.status, 200);
  assert.equal(titleOf(hub.html), "Ottawa, ON happy hours and food deals — Radar");
  assert.match(hub.html.replace(/<!-- -->/g, ""), /<h1>Ottawa happy hours and food deals<\/h1>/);
  assert.match(hub.html, /href="\/en\/cities\/ottawa-on\/happy-hour"/);
  assert.match(hub.html, /href="\/en\/deals\/kelseys-bank-happy"/);
  assert.match(hub.html.replace(/<!-- -->/g, ""), /<h2>Nearby city guides<\/h2>/);
  assert.match(hub.html.replace(/<!-- -->/g, ""), /href="\/en\/cities">All \d+ city guides/, "the hub links the index instead of listing every other guide");
  assert.ok((hub.html.match(/href="\/en\/cities\/[a-z0-9-]+"/g) || []).length <= 13, "at most twelve other guides and itself");
  const graphs = [...hub.html.matchAll(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@graph"[^<]*)<\/script>/g)].flatMap((match) => JSON.parse(match[1])["@graph"]);
  const crumbs = graphs.find((node) => node["@type"] === "BreadcrumbList").itemListElement;
  assert.deepEqual(crumbs.map((crumb) => crumb.item), ["https://radar.cheap/en", "https://radar.cheap/en/cities", "https://radar.cheap/en/cities/ottawa-on"]);

  const topic = await render("/en/cities/ottawa-on/happy-hour");
  assert.equal(topic.status, 200);
  assert.match(topic.html.replace(/<!-- -->/g, ""), /<h1>Ottawa happy hours<\/h1>/);

  // Kapuskasing has one restaurant: no guide (real Windsor data now has one). Nor is a topic with too little in it a page.
  assert.equal((await render("/en/cities/kapuskasing-on")).status, 404);
  assert.equal((await render("/en/cities/ottawa-on/sushi")).status, 404);

  for (const [from, to] of [["/en/ottawa", "/en/cities/ottawa-on"], ["/en/ottawa/happy-hour", "/en/cities/ottawa-on/happy-hour"], ["/fr/cities/ottawa-on", "/en/cities/ottawa-on"]]) {
    const response = await worker.fetch(new Request(`https://radar.cheap${from}`, { headers: { host: "radar.cheap", accept: "text/html" } }), globalThis.__DEAL_PAGE_TEST_ENV__, { waitUntil() {}, passThroughOnException() {} });
    assert.ok([301, 308].includes(response.status), `${from} redirects permanently (${response.status})`);
    assert.equal(new URL(response.headers.get("location"), "https://radar.cheap").pathname, to);
  }
});

test("a deal page is its own page in a language only when the deal is translated into it", async () => {
  const canonical = (html) => head(html).match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  assert.equal(canonical((await render("/fr/deals/kelseys-bank-happy")).html), "https://radar.cheap/fr/deals/kelseys-bank-happy");
  const spanish = head((await render("/es/deals/kelseys-bank-happy")).html);
  assert.match(spanish, /<link rel="canonical" href="https:\/\/radar\.cheap\/en\/deals\/kelseys-bank-happy"/, "an untranslated page is a copy of the English one");
  const untranslated = head((await render("/fr/deals/corner-wings")).html);
  assert.match(untranslated, /<link rel="canonical" href="https:\/\/radar\.cheap\/en\/deals\/corner-wings"/);
  assert.doesNotMatch(untranslated, /hrefLang=/);

  const { html: xml } = await render("/sitemap.xml");
  const entry = (slug) => { const at = xml.indexOf(`<loc>https://radar.cheap/en/deals/${slug}</loc>`); return xml.slice(at, xml.indexOf("</url>", at)); };
  assert.match(entry("kelseys-bank-happy"), /hreflang="fr"/);
  assert.doesNotMatch(entry("kelseys-bank-happy"), /hreflang="es"/);
  assert.doesNotMatch(entry("corner-wings"), /xhtml:link/);
});

test("the legal pages render in French under /fr, and stay English under /es", async () => {
  for (const [page, heading] of [["privacy", "Politique de confidentialité"], ["terms", "Conditions d’utilisation"], ["support", "Aide avec Radar"]]) {
    const fr = await render(`/fr/${page}`);
    assert.equal(fr.status, 200, `/fr/${page}`);
    assert.match(fr.html, /<article lang="fr">/);
    assert.ok(fr.html.includes(heading), `/fr/${page} shows its French heading`);
    assert.match(fr.html, /Traduction automatique/);
    assert.match(fr.html, new RegExp(`<link rel="canonical" href="[^"]*/fr/${page}"`));
    const es = await render(`/es/${page}`);
    assert.match(es.html, /<article lang="en">/);
    assert.match(es.html, new RegExp(`<link rel="canonical" href="[^"]*/en/${page}"`));
  }
});
