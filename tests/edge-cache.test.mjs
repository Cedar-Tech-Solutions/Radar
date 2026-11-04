import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { code } from "./source.mjs";

// Comments stripped, so an assertion can never be satisfied by prose explaining the thing rather
// than the thing itself — worker/index.ts describes its own cache rules at length, and every word
// these tests look for appears in that description too. This file read the raw text until
// tests/source.mjs was fixed: its block-comment stripper used to treat the "//*" inside
// "https://*.clerk.accounts.dev" as a comment opener and delete two thirds of the file.
const worker = () => code(readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8"));
const routing = () => code(readFileSync(new URL("../i18n/routing.ts", import.meta.url), "utf8"));

// Pulls the string literals out of the first array that follows `marker`.
function localesAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected to find ${marker}`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  assert.ok(open !== -1 && close > open, `expected an array literal after ${marker}`);
  return source
    .slice(open + 1, close)
    .split(",")
    .map((entry) => entry.trim().replace(/["']/g, ""))
    .filter(Boolean)
    .sort();
}

function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected to find ${signature}`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `expected a closing brace for ${signature}`);
  return source.slice(start, end);
}

// worker/index.ts decides which paths may be served from the colo cache by allowlisting the
// locale prefix, and hardcodes that list rather than importing routing, to keep next-intl's
// routing module out of the worker entry. This is what stops the two drifting apart. A locale
// added to routing but not to the worker would quietly re-render on every single request
// forever — the exact CPU problem the cache exists to fix, reintroduced for one language and
// invisible in English. One removed from routing but left in the worker would keep serving a
// locale the app no longer routes.
test("the worker's cacheable locales match the app's routing locales", () => {
  assert.deepEqual(
    localesAfter(worker(), "const CACHEABLE_LOCALES = new Set("),
    localesAfter(routing(), "locales:"),
  );
});

// The allowlist is only half the guarantee. These are the pages that DO sit under a locale but
// show one person their own state, so serving a stored copy of one to the next visitor would
// hand them someone else's page. Named explicitly so that dropping an entry has to be a decision
// someone makes here, rather than a line that quietly disappears in an unrelated edit.
//
// The one exception is the bare sign-in and sign-up pages, whose server render is the same for
// every signed-out reader (the page reads redirect_url in the browser). Only those two, only with
// nothing below them: Clerk's own steps under /sign-in/ stay personal.
test("personalized locale pages are excluded from the cache, bar the bare sign-in shells", () => {
  const excluded = localesAfter(worker(), "const UNCACHEABLE_SEGMENTS = new Set(");
  for (const segment of ["dashboard", "sign-in", "sign-up", "confirm-email", "unsubscribe"]) {
    assert.ok(excluded.includes(segment), `${segment} must stay uncacheable`);
  }
  assert.deepEqual(localesAfter(worker(), "const AUTH_SHELLS = new Set("), ["sign-in", "sign-up"]);
  assert.match(
    bodyOf(worker(), "function pageLookup"),
    /UNCACHEABLE_SEGMENTS\.has\(segments\[1\]\) && !\(segments\.length === 2 && AUTH_SHELLS\.has\(segments\[1\]\)\)\) return null;/,
    "the exception is the bare path alone",
  );
});

// The cache key is origin + pathname, so nothing that varies per reader may ride along inside a
// stored body. These guards are what make that key honest: the RSC headers, `_rsc` and `.rsc`
// select a flight payload instead of a document under the very same URL, a session cookie or a
// bearer token means the render saw a signed-in reader, and a query parameter the route's server
// render reads (`?return=` changes the back link and every distance shown) personalizes the page.
//
// It used to be any query string at all. That is now a table of the parameters each route's server
// render reads (SERVER_READ_PARAMS, held to the pages by tests/route-params.test.mjs); what is not
// in it is ignored for the lookup, and a route that is not in it refuses every query, so a page
// added later fails closed.
test("page lookup refuses flights, signed-in readers of personal pages and the parameters a route's server render reads", () => {
  const source = worker();
  const flight = bodyOf(source, "function isFlightRequest");
  assert.match(flight, /headers\.has\("RSC"\)/);
  assert.match(flight, /headers\.has\("Next-Router-State-Tree"\)/);
  assert.match(flight, /searchParams\.has\("_rsc"\)/);
  assert.match(flight, /pathname\.endsWith\("\.rsc"\)/);
  const signedIn = bodyOf(source, "function isSignedIn");
  assert.match(signedIn, /includes\("__session="\)/);
  assert.match(signedIn, /headers\.has\("authorization"\)/, "getAppUser reads a bearer token before the cookie");
  const lookup = bodyOf(source, "function pageLookup");
  assert.match(lookup, /request\.method !== "GET" && request\.method !== "HEAD"/);
  assert.match(lookup, /if \(isFlightRequest\(request, url\)\) return null;/);
  assert.match(lookup, /if \(signedIn && \(route === null \|\| !USER_BLIND_ROUTES\.has\(route\)\)\) return null;/,
    "a signed-in reader is shared only the pages that read nothing of them (held to the pages by tests/route-params.test.mjs)");
  assert.match(lookup, /if \(!url\.search\) return \{ url, bare: true, signedIn \};/);
  assert.match(lookup, /if \(!read\) return null;/, "a route missing from the table refuses any query");
  assert.match(lookup, /if \(read\.includes\(key\)\) return null;/, "a parameter the render reads makes the request personal");
  assert.match(lookup, /return \{ url: new URL\(url\.pathname, url\.origin\), bare: false, signedIn \};/, "everything else is looked up as the bare address");
});

function serverReadParams() {
  const source = worker();
  const start = source.indexOf("const SERVER_READ_PARAMS = new Map<string, readonly string[]>([");
  assert.notEqual(start, -1, "expected SERVER_READ_PARAMS in worker/index.ts");
  const table = source.slice(start, source.indexOf("]);", start));
  return new Map([...table.matchAll(/\["([^"]*)", \[([^\]]*)\]\]/g)].map((match) => [match[1], [...match[2].matchAll(/"([^"]+)"/g)].map((key) => key[1])]));
}

// A shared link carries click ids and campaign tags on every click, the home page writes ?country=
// into its own address, sign-in links carry ?redirect_url=, and a load test's ?v= cache-buster rides
// on everything. None of those is read by a server render, so none of them may be in the table - and
// the four a deal page's render does read must stay there, or a reader's back link and distances
// would be served to everyone.
test("only a deal page's return, postal, zip and all make a request personal", () => {
  const table = serverReadParams();
  assert.deepEqual(table.get("deals/[slug]"), ["return", "postal", "zip", "all"]);
  for (const [route, read] of table) {
    if (route !== "deals/[slug]") assert.deepEqual(read, [], `${route || "home"} reads no parameter on the server`);
  }
  assert.deepEqual(
    [...table.keys()].sort(),
    ["", "age-suitability", "cities", "cities/[city]", "cities/[city]/[topic]", "deals/[slug]", "for-creators", "for-restaurants", "ottawa", "ottawa/[topic]", "privacy", "pro", "sign-in", "sign-up", "support", "terms"],
  );
  for (const ignored of ["utm_source", "fbclid", "gclid", "c", "camp", "country", "q", "city", "v", "redirect_url", "suggest"]) {
    for (const [route, read] of table) assert.ok(!read.includes(ignored), `${ignored} is not read by ${route || "home"}'s server render`);
  }
  // The old per-deal-page list of tracking parameters is folded into the table.
  assert.doesNotMatch(worker(), /withoutInertParams|INERT_DEAL_PAGE_PARAMS/);
});

// Rendered, stored and refreshed from the bare address only, so a stored page's navigation echo is
// always empty, whatever query the request that filled it carried. A miss whose parameters are all
// ones the route ignores is that one render of the bare address, answering its reader too: it used
// to be rendered as it came, with the bare page rendered again beside it for the next reader, which
// was two renders in one invocation. A HEAD stores nothing either: it is answered from what is there.
test("only a GET of the bare address is stored, and a miss renders it once", () => {
  const source = worker();
  const handler = source.slice(source.indexOf("async fetch(request: Request, env: Env, ctx: ExecutionContext)"));
  const standIn = handler.indexOf("if (lookup && !lookup.bare) request = new Request(lookup.url.toString(), request);");
  assert.notEqual(standIn, -1, "a miss with ignored parameters renders the bare address in its place");
  assert.ok(standIn < handler.indexOf("withinDeadline(renderPage(request, env, ctx)"), "before the render, not beside it");
  assert.match(handler, /if \(lookup && !lookup\.bare\) outcome = withQueryCarried\(outcome, url\.search\);/, "a redirect keeps the query it would have carried");
  const missPath = source.slice(source.indexOf("const response = outcome;"));
  assert.match(missPath, /storable && request\.method === "GET"\) \{\s*ctx\.waitUntil\(storePage\(cache, cacheKey, response\.clone\(\), lookup\.url\)/);
  assert.doesNotMatch(source, /populateInBackground/, "nothing renders the bare page a second time in the background");
  const refresh = bodyOf(source, "async function refreshPage");
  assert.match(refresh, /new Request\(`\$\{url\.origin\}\$\{url\.pathname\}`, \{ method: "GET"/, "a refresh renders the bare address");
  assert.match(bodyOf(source, "function refreshInBackground"), /request\.method !== "GET"/, "a HEAD never refreshes");
});

// A response carrying a Set-Cookie is per-reader, with exactly one documented exception:
// next-intl writes NEXT_LOCALE on every response, and its value is the locale segment of the URL
// being requested — which is part of the cache key. The first version of this cache rejected
// every cookie and therefore stored nothing at all, which is why the exception exists. What must
// not regress is the check that the cookie's value actually matches the path it is stored under;
// without it a /fr page could hand its French locale cookie to a reader of the English one.
test("only the locale cookie is storable, and only when it matches the path", () => {
  const decide = bodyOf(worker(), "function isStorable");
  assert.match(decide, /cookies\.length > 1/, "more than one cookie must not be stored");
  assert.match(decide, /NEXT_LOCALE=\$\{/, "the stored cookie must be checked against the URL's locale");
  const build = bodyOf(worker(), "function storableResponse");
  assert.match(build, /headers\.delete\("Set-Cookie"\)/, "Set-Cookie must be stripped before storing");
});

// The decision has to come first, and it has to be readable from headers alone. The two branches
// of a tee share a buffer, so a clone nobody reads fills up and then applies backpressure to the
// branch the visitor is still being served — "this response was not cacheable" becomes a request
// that hangs until it times out. Cloning first and deciding after shipped exactly that.
test("nothing is cloned until it is known to be storable", () => {
  const source = worker();
  // The render now goes through the watchdog, so the miss path starts where its result is taken.
  const start = source.indexOf("const response = outcome;");
  assert.notEqual(start, -1);
  const missPath = source.slice(start, start + 600);
  const guard = missPath.indexOf("isStorable(response, url)");
  const clone = missPath.indexOf("response.clone()");
  assert.notEqual(guard, -1, "the miss path must test isStorable before storing");
  assert.notEqual(clone, -1, "the miss path must store from a clone");
  assert.ok(guard < clone, "isStorable must be checked before the clone is taken");
});

// The stored copy carries `public, s-maxage=...` so this cache will hold it, and bookkeeping
// headers so the hit path can date it. None of that is addressed to the visitor's browser: a hit
// has to come back looking exactly like a fresh render, or the cache changes behavior for
// everyone downstream rather than just saving a render.
//
// "Like a fresh render" of an impersonal page means `private, no-cache`: the
// framework's no-store kept every page, even ones identical for everyone, out of the back/forward
// cache. The same header goes on the fresh render of such a page and on the prerendered file.
test("a cache hit is restored to look like a fresh render", () => {
  const source = worker();
  const body = bodyOf(source, "function fromCache");
  assert.match(body, /headers\.delete\(CACHED_COOKIE_HEADER\)/);
  assert.match(body, /headers\.delete\(CACHED_AT_HEADER\)/);
  assert.match(body, /headers\.delete\(REFRESH_LEASE_HEADER\)/);
  assert.match(body, /headers\.set\("Cache-Control", IMPERSONAL_PAGE_CACHE_CONTROL\)/);
  assert.match(source, /const IMPERSONAL_PAGE_CACHE_CONTROL = "private, no-cache";/);
  assert.match(bodyOf(source, "async function prerenderedPage"), /headers\.set\("Cache-Control", IMPERSONAL_PAGE_CACHE_CONTROL\)/);
  // And only an impersonal, storable render gets it; anything personal keeps the framework's no-store.
  const missPath = source.slice(source.indexOf("const response = outcome;"));
  assert.match(missPath, /const storable = impersonal && isStorable\(response, url\);/);
  assert.match(missPath, /storable \? impersonalPage\(response\) : response/);
});

// NEXT_LOCALE is Secure in production, both where next-intl writes it and where the Worker
// writes it by hand for a prerendered page. The attribute goes after the value, so the prefix
// isStorable checks before caching a page — "NEXT_LOCALE=<locale>;" — still matches.
test("the locale cookie is Secure over https, and still storable", () => {
  const source = worker();
  const prerendered = bodyOf(source, "async function prerenderedPage");
  assert.match(prerendered, /const locale = url\.pathname\.split\("\/"\)\[1\];/);
  assert.match(prerendered, /url\.protocol === "https:" \? "; Secure" : ""/);
  assert.match(prerendered, /`NEXT_LOCALE=\$\{locale\}; Path=\/; SameSite=lax\$\{secure\}`/);
  assert.match(routing(), /localeCookie: \{ secure: import\.meta\.env\.PROD \}/);
  // The signed-out dashboard redirect writes it the way next-intl does, Secure in a production build
  // (tests/worker-pages.test.mjs compares it with the app's own response).
  assert.match(bodyOf(source, "function localeCookieFor"), /`NEXT_LOCALE=\$\{locale\}; Path=\/\$\{import\.meta\.env\.PROD \? "; Secure" : ""\}; SameSite=lax`/);
});

// Cache entries outlive a deploy. Without the deployment id in the key, HTML stored before one
// keeps being served after it, still referencing the hashed CSS and JS filenames of the build
// that produced it — which the new build's asset manifest no longer serves. That failure looks
// like an unstyled page for everyone in a colo holding a stale entry, and it heals only when the
// entry ages out, so the guard belongs in the key rather than in a purge step someone has to
// remember to run.
test("the cache key is namespaced by the deployment id", () => {
  const body = bodyOf(worker(), "function cacheKeyFor");
  assert.match(body, /CF_VERSION/, "the deployment id must be part of the cache key");
});

// /pro quotes a currency chosen from CF-IPCountry, so its key carries the reader's currency bucket -
// and no other page's does, or every page would be stored once per currency for nothing. As a query
// string on the key, which no request path can produce.
test("only the Pro page's key carries the currency bucket", () => {
  const source = worker();
  const key = bodyOf(source, "function cacheKeyFor");
  assert.match(key, /if \(!isPricedPage\(url\.pathname\)\) return new Request\(key, \{ method: "GET" \}\);/);
  assert.match(key, /\?currency=\$\{currencyBucket\(request\.headers\.get\("CF-IPCountry"\)\)\}/);
  assert.match(bodyOf(source, "function isPricedPage"), /segments\.length === 2 && CACHEABLE_LOCALES\.has\(segments\[0\]\) && segments\[1\] === "pro"/);
  assert.match(source, /import \{ PRICED_PAGE_MARKER, currencyBucket \} from "\.\.\/app\/pricing";/, "the bucket is app/pricing.ts's own");
  // And a Pro render is kept only when it carries prices: one drawn while Stripe was unreachable is
  // right for its reader and wrong for everyone after them.
  assert.match(bodyOf(source, "async function storePage"), /if \(!html\.includes\(PRICED_PAGE_MARKER\)\) return;/);
});

// A locale path's 404 is the same page until the next deploy, so it is kept, for an hour, and never
// refreshed - except under /deals/, where a deal published between deploys has to appear at once.
test("a not-found page is stored for an hour, never under /deals/", () => {
  const source = worker();
  assert.match(source, /const NOT_FOUND_KEEP_MS = 60 \* 60_000;/);
  assert.match(bodyOf(source, "function isStorable"), /response\.status === 404 && notFoundIsStorable\(url\)/);
  assert.match(bodyOf(source, "function notFoundIsStorable"), /CACHEABLE_LOCALES\.has\(segments\[0\]\) && segments\[1\] !== "deals"/);
  assert.match(bodyOf(source, "function storableResponse"), /response\.status === 404 \? NOT_FOUND_KEEP_MS : EDGE_CACHE_KEEP_MS/);
  const handler = source.slice(source.indexOf("async fetch(request: Request, env: Env, ctx: ExecutionContext)"));
  assert.match(handler, /if \(hit\.status === 404\) \{\s*if \(age < NOT_FOUND_KEEP_MS\) return withSecurityHeaders\(await shared\(fromCache\(hit, request\)\), url\);/);
});
