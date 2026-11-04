/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { expireDealsStatement } from "../app/deal-lifecycle";
import { MATURE_COMMISSIONS_SQL, holdCutoffModifier } from "../app/affiliate-program";
import { sweepStaffReminders } from "../app/staff-reminders";
import { isRetentionHour, sweepRetention } from "../app/retention";
import { CHANGED_DEAL_PAGES_SQL, type ChangedDealRow, dealPageUrls, indexNowEnabled, submitToIndexNow } from "../app/indexnow";
import {
  RENDER_DEADLINE_MS,
  RENDER_TIMED_OUT,
  noteRenderTimeout,
  renderDeadlineMs,
  unavailableResponse,
  withinDeadline,
  isDocumentRequest,
} from "./render-watchdog";
import { HEARTBEAT_MS, createAdmissionGate } from "./admission";
import { isProbePath, probeNotFoundResponse } from "./probe-paths";
import { storedPhoto } from "./stored-photo";
// One function of app/search.ts and nothing else of the app: see the module for why it is shared.
import { answerFromShared, sharedAnswerKey } from "../app/deals-answer";
// Both import-free, so neither brings anything of the app into the entry beyond its own few lines:
// the Pro page's currency table and its priced-page marker, and the dashboard's section names.
import { PRICED_PAGE_MARKER, currencyBucket } from "../app/pricing";
import { dashboardSections } from "../app/[locale]/dashboard/sections";

/** 12:00 UTC, the hour the GitHub Actions deploy used to run on its own schedule. */
const DAILY_REBUILD_HOUR_UTC = 12;
export function isDailyRebuildHour(at: Date): boolean {
  return at.getUTCHours() === DAILY_REBUILD_HOUR_UTC;
}

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTOS: R2Bucket;
  EMAIL_JOB_SECRET?: string;
  BILLING_JOB_SECRET?: string;
  TRANSLATE_JOB_SECRET?: string;
  GEOCODE_JOB_SECRET?: string;
  /** Secret. The Workers Builds deploy hook URL; the daily rebuild below POSTs to it. */
  DEPLOY_HOOK_URL?: string;
  PUBLIC_APP_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  // Never set in production. See renderDeadlineMs in worker/render-watchdog.ts for who sets it.
  RENDER_DEADLINE_MS?: string;
  CF_VERSION?: { id: string };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// `caches.default` is a Cloudflare extension the DOM lib's CacheStorage doesn't describe.
// Declared here rather than adding @cloudflare/workers-types to tsconfig's `types`, which would
// redefine Request/Response/fetch globally and collide with the "dom" lib the rest of the app is
// checked against — the same reason Env and ExecutionContext above are hand-written.
declare const caches: CacheStorage & { default: Cache };

// The two names the site is served under. wrangler.jsonc binds a third, www.radar.cheap, which
// serves nothing but a redirect to the first of these (wwwRedirectFor) and so never reaches any code
// that asks this question. Anything else reaching the Worker is a local run (localhost,
// affiliate.localhost), a workers.dev preview, or a test.
const PRODUCTION_HOSTS = new Set(["radar.cheap", "affiliate.radar.cheap"]);

// The one HSTS policy, on every https response the Worker sends and, through public/_headers, on
// every file the asset layer sends.
const HSTS = "max-age=31536000; includeSubDomains";

// A photo's length, kept on the wire. app/api/photo reads the whole R2 object and sends it as bytes
// so that the reply declares Content-Length and a copy cut off in transit reads as a failed download
// rather than a finished picture. It never got there: the framework passes every route handler's
// body through a TransformStream to see when it closes (vinext's closeAfterResponseWithBody), and
// withSecurityHeaders builds another Response around that stream. A stream of unknown length goes
// out chunked, and the runtime drops a Content-Length header written onto one - so on production
// every photo GET was chunked with no length, and only HEAD, which has no body, showed it.
//
// FixedLengthStream is how the runtime is told a stream's length: what comes out of it is sent with
// that Content-Length, and it errors if the bytes through it add up to anything else. Images only -
// pages are streamed on purpose and stay chunked - and only when the declared length describes the
// bytes as they will be read: an encoded body declares its encoded length and is read decoded.
// Absent outside workerd (the Node tests and the prerender), where the body passes through as is.
declare const FixedLengthStream: (new (length: number) => TransformStream<Uint8Array, Uint8Array>) | undefined;

function bodyKeepingLength(response: Response): ReadableStream<Uint8Array> | null {
  const body = response.body;
  if (!body || typeof FixedLengthStream === "undefined") return body;
  if (!/^image\//i.test(response.headers.get("content-type") || "")) return body;
  if ((response.headers.get("content-encoding") || "identity").trim().toLowerCase() !== "identity") return body;
  const declared = response.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared)) return body;
  return body.pipeThrough(new FixedLengthStream(Number(declared)));
}

function withSecurityHeaders(response: Response, requestUrl: URL) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  // Clerk's production instance serves its frontend API and Account Portal from
  // clerk.radar.cheap and accounts.radar.cheap (CNAMEd to Clerk), not from whichever host a
  // visitor happens to be on — the publishable key is baked into the client bundle at build
  // time and always points at that one domain. So these stay hardcoded rather than built from
  // requestUrl.hostname, which would have CSP block clerk-js on any other host and silently
  // break sign-in and sign-up there.
  //
  // Clerk's shared test-mode domain, *.clerk.accounts.dev, is allowed only off the production
  // hosts: a local or preview build whose publishable key is a development one loads clerk-js from
  // there, and production's live key never does. On radar.cheap that wildcard was an allowance for
  // every Clerk development instance anyone has ever created to serve script to the site, in
  // exchange for nothing.
  //
  // 'unsafe-inline' stays in script-src. The framework puts each page's flight data in inline
  // scripts (65 of the 69 on a deal page), so the only alternative is a per-request nonce on every
  // one of them — and the pages that matter most are the ones that have no request: a prerendered
  // deal page is one file served to everyone, and a colo-cached page is one body replayed to
  // everyone, so a nonce baked into either is the same nonce for every reader, which is no nonce.
  const clerkHosts = PRODUCTION_HOSTS.has(requestUrl.hostname)
    ? "https://clerk.radar.cheap https://accounts.radar.cheap"
    : "https://clerk.radar.cheap https://accounts.radar.cheap https://*.clerk.accounts.dev";
  // Cloudflare auto-injects its Web Analytics beacon into every HTML response for zones that
  // have it enabled (a dashboard setting, not something this code turns on) — script-src and
  // connect-src both need the host or the beacon 404s into a blocked-by-CSP console error on
  // every page load without actually disabling the injection itself.
  headers.set("Content-Security-Policy", `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' ${clerkHosts} https://challenges.cloudflare.com https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${clerkHosts} https://clerk-telemetry.com https://api.clerk.com https://api.mapbox.com https://challenges.cloudflare.com https://cloudflareinsights.com; frame-src 'self' ${clerkHosts} https://accounts.google.com https://discord.com https://challenges.cloudflare.com https://www.openstreetmap.org; upgrade-insecure-requests`);
  // An image gets a policy of its own instead, under which nothing runs. The page policy above
  // allows inline script, so an image that a browser ends up treating as a document - an SVG, or a
  // type it reads as markup - would run its scripts on radar.cheap when someone opens its URL.
  // app/api/photo and app/api/restaurant-photo only ever send JPEG, PNG or WebP; this is the
  // backstop for the day one of them, or the image optimizer, does not.
  if (/^image\//i.test(response.headers.get("content-type") || "")) {
    headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox");
  }
  // includeSubDomains holds for every name under radar.cheap that answers at all: affiliate. and www.
  // are this Worker's custom domains, served over https on Cloudflare's certificate (www only ever
  // with a redirect), and clerk. and accounts. are Clerk's and HTTPS-only. No preload: that is a
  // list browsers ship, slow to leave, and a decision for the zone rather than this file.
  // public/_headers sends the same header on every file the asset layer sends, whether it answers
  // the request itself or this Worker asks it through env.ASSETS.
  if (requestUrl.protocol === "https:") headers.set("Strict-Transport-Security", HSTS);
  // Anything not on a production name - a workers.dev or preview URL, should one ever be switched on
  // again (wrangler.jsonc turns both off) - is a full copy of the site whose pages canonicalize to
  // themselves. Kept out of every index rather than left to compete with radar.cheap. Local runs and
  // tests get it too, which costs nothing.
  if (!PRODUCTION_HOSTS.has(requestUrl.hostname)) headers.set("X-Robots-Tag", "noindex, nofollow");
  // An API answer that says nothing about caching is kept by nobody. The ones meant to be shared -
  // the deal listings, photos - say so themselves; the rest are a reader's own account, saved deals
  // or staff data, and must not be stored by a browser, a shared machine or anything in between.
  if (requestUrl.pathname.startsWith("/api/") && !headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return new Response(bodyKeepingLength(response),{status:response.status,statusText:response.statusText,headers});
}

// Plain http reached this Worker and was answered: every page, sign-in and /api served over an
// unencrypted connection with a 200, and HSTS cannot help a first visit or a crawler, since it is
// only ever sent over https. Cloudflare's "Always Use HTTPS" is the zone-wide fix, and it is a
// dashboard setting outside this repository; this covers everything that reaches the Worker. That
// is every file in dist/client too, bar the content-hashed build under /_next/: the asset layer
// answers a request that matches a file before the Worker runs, whatever its scheme, so the files
// at the top of dist/client are routed here first (TOP_LEVEL_FILES, which says why /_next/ is not).
//
// Production hosts only, so localhost, affiliate.localhost and the tests that drive the built
// Worker over http keep working as they are. Path and query are kept. The port is not: Cloudflare
// also proxies plain http on ports such as 8080, and https on that port would be TLS on a port
// Cloudflare only serves plain http on.
export function httpsRedirectFor(url: URL): string | null {
  if (url.protocol !== "http:" || !PRODUCTION_HOSTS.has(url.hostname)) return null;
  const secure = new URL(url.toString());
  secure.protocol = "https:";
  secure.port = "";
  return secure.toString();
}

// www.radar.cheap is a custom domain of this Worker (wrangler.jsonc) only so that the name people
// type out of habit resolves, over either scheme, and arrives at the site. It serves nothing of its
// own: every request on it - a page, /api, a file - is sent in one hop to the same path and query on
// https://radar.cheap, ahead of everything else in fetch, so no cache key, admission slot, render or
// API handler ever sees the name. One name rather than two copies of the site: one set of canonical
// URLs, one cookie jar, one origin for Clerk and Stripe to send people back to.
//
// Straight to https on the apex from plain http too, rather than to https on www first: two hops
// buy nothing, since HSTS on the apex, with includeSubDomains, already covers www for any browser
// that has been to the site.
const WWW_HOST = "www.radar.cheap";
const CANONICAL_HOST = "radar.cheap";

export function wwwRedirectFor(url: URL): string | null {
  if (url.hostname !== WWW_HOST) return null;
  const apex = new URL(url.toString());
  apex.protocol = "https:";
  apex.hostname = CANONICAL_HOST;
  apex.port = "";
  return apex.toString();
}

// The files at the top of dist/client: public/'s icons, og.png and sw.js, the entry manifest vinext
// writes beside them, and the sitemap.xml and robots.txt scripts/prerender-deals.mjs bakes there.
// The asset layer answers a request that matches a file before this Worker runs, and it never looks
// at the scheme, so over plain http every one of these was served with a 200 - robots.txt and the
// sitemap included, the two files a crawler reads first. wrangler.jsonc lists each of them under
// run_worker_first, which sends them here instead: plain http gets the same redirect as a page, www
// the same redirect as everything on www, and https the file exactly as the asset layer would have
// served it (topLevelFile).
//
// The content-hashed build under /_next/ is deliberately not routed here. Only a page loads those
// files, every page is https now, and a browser will not load script into an https page over http
// anyway. What the asset layer still answers over plain http, and on www.radar.cheap, is the same
// public, immutable file the apex serves over https, at a URL nothing links to - no page renders on
// www. Left to the asset layer they also cost no Worker invocation, where every request that runs
// this code is metered by the platform, and a page's bundles are most of what a first visit asks
// for.
//
// Kept in step with wrangler.jsonc, and with what a build and the prerender actually write, by
// tests/https-www.test.mjs. A top-level file missing from both is served over plain http again; one
// listed there and not here would reach the app as an unknown path and be rendered as its 404 page.
const TOP_LEVEL_FILES = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/sw.js",
  "/favicon.ico",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/og.png",
  "/BingSiteAuth.xml",
  // The IndexNow key file (app/indexnow.ts).
  "/602d8d4ce8bbaf576a0b258628794d49.txt",
  "/vinext-client-entry-manifest.json",
]);

// Asked of the asset binding the way the asset layer itself would have been asked: with the
// visitor's method and headers, so a HEAD, a conditional request answered 304 and a POST answered
// 405 all come back as they did before, with the asset layer's own headers - content-type, ETag, its
// `public, max-age=0, must-revalidate` - and with public/_headers, which the binding applies to what
// it returns exactly as the asset layer applies it to what it serves (nosniff, and HSTS). The body
// is left behind: no file reads one, and a request that falls through below still needs its own.
//
// Not passed through withSecurityHeaders. That policy is written for pages, and a service worker
// runs under the Content-Security-Policy of the response that delivered its script: /sw.js would
// start making its fetches under a page's connect-src. Nothing about these files changes except the
// scheme and the name they can be fetched under.
//
// A 404 means this build has no such file: sitemap.xml and robots.txt under `vinext dev`, in the
// prerender's own render of them, or in a deploy that skipped the prerender. The app's routes
// (app/sitemap.ts, app/robots.ts) answer those instead, as they did before either was baked.
/** The body of /.well-known/security.txt: required Contact and Expires, and the canonical address. */
export function securityTxt(url: URL, now = new Date()): string {
  const expires = new Date(now.getTime() + 182 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    "Contact: mailto:support@cedartechsolutions.ca",
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en, fr",
    `Canonical: https://${PRODUCTION_HOSTS.has(url.hostname) ? url.hostname : "radar.cheap"}/.well-known/security.txt`,
    "",
  ].join("\n");
}

async function topLevelFile(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!env.ASSETS || !TOP_LEVEL_FILES.has(url.pathname)) return null;
  const asset = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: request.headers }));
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  return null;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

// Hard ceiling on requests this isolate will actively work on at once. Too many concurrent
// requests on one isolate exhaust the platform's per-request resource limits, and cold isolates
// (each doing cold-start SSR and a cold snapshot build for every admitted request) cost more per
// request than warm ones, so there is no single safe number to chase. Instead this
// admission-control gate refuses excess requests immediately, before any real work starts, with a
// small controlled response instead of letting the isolate be driven into a crash. It's a
// per-isolate limit, not a site-wide one — the platform runs many isolates in parallel for real
// traffic, so this only engages when a single isolate is asked for more than it can safely
// process. The limit is MAX_CONCURRENT_REQUESTS in worker/admission.ts.
//
// A request the Workers runtime hard-kills for exceeding ITS OWN resource limit can be torn
// down without ever running a normal `finally` block, so a plain counter incremented here would
// have no way back down for those killed requests and the isolate would keep refusing requests
// with nothing else in flight. So a slot is held only while its request shows signs of life: each
// admitted request touches its slot from a timer of its own (HEARTBEAT_MS), a killed request's
// timers die with it, and a slot that has gone quiet is dropped at the next admission check. A
// killed request is followed by at most STALE_AFTER_MS of OVERLOADED answers rather than a full
// MAX_REQUEST_AGE_MS. worker/admission.ts has the details.
//
// A live request still holds its slot however long it runs, up to MAX_REQUEST_AGE_MS. Every page
// render answers within RENDER_DEADLINE_MS (the watchdog below), so a slot older than that plus a
// margin is not a render at all. An /api request that genuinely runs longer loses its slot early,
// which admits one request more than the cap for the rest of it: a far smaller cost than refusing
// everyone for thirty seconds, which is what the limit was before the watchdog.
const MAX_REQUEST_AGE_MS = RENDER_DEADLINE_MS + 2_000;
const admission = createAdmissionGate(MAX_REQUEST_AGE_MS);

// The heartbeat for one admitted request. Cleared the moment the request answers (the `finally`
// below), and it stops itself once the slot is gone - given back, let go, or past
// MAX_REQUEST_AGE_MS - so a request that never answers is not kept alive by it, and the runtime can
// still see that it has hung. unref'd where timers have that method (Node, where the tests drive
// requests that never answer and must still be able to exit).
function keepAlive(id: number): ReturnType<typeof setInterval> {
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!admission.beat(id, Date.now())) clearInterval(timer);
  }, HEARTBEAT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

// Colo-level cache for anonymous public pages.
//
// A deal page costs several D1 queries and a full React SSR pass, which is more CPU than a request
// can reliably spend on the platform's per-request limit, even with no other load. That is the
// render being too expensive, not load — the admission gate above does not help with it.
//
// Nothing on those pages is per-second. The only time-dependent copy is day-granular ("Ends
// today"), and LocalTime re-renders in the reader's own timezone on the client regardless. The
// only per-request variance is the handful of query parameters a page's server render reads
// (SERVER_READ_PARAMS below: on a deal page `?return=`, `?postal=`, `?zip=` and `?all=`, which
// change the back link and the per-location distances) and a signed-in reader, whose saved postal
// feeds those same distances. So an anonymous document request whose query carries none of those
// is answered with the page every signed-out visitor of that address gets, and serving it from the
// colo's cache turns a full render into a cache lookup. The Worker still runs on a hit, but it does
// almost no CPU work — which is the limit that was being hit.
//
// Freshness uses the same stale-while-revalidate shape as loadSnapshot() in the deals API: a hit
// inside FRESH_MS is served as-is, a hit past it is served immediately and kicks off a background
// re-render (one per colo at a time; see REFRESH_LEASE_MS). So a staff edit in admin reaches the
// public page within FRESH_MS of the next request for it, and no visitor ever waits on the
// re-render. MAX_STALE_MS is the outer bound — how long a cached copy may keep being served if
// those background refreshes keep failing.
const EDGE_CACHE_FRESH_MS = 15 * 60_000;
const EDGE_CACHE_MAX_STALE_MS = 24 * 60 * 60_000;
// How long the Cache API itself keeps an entry, which is longer than it is normally served. Past
// MAX_STALE_MS a copy is not handed out while a render can replace it, but it is still the best
// answer when the render cannot finish at all (see answerWithoutRender): a week-old page with its
// own "last checked" date on it beats a 503. Stored with MAX_STALE_MS as its lifetime, the cache
// would have dropped it at exactly the moment it became the fallback.
const EDGE_CACHE_KEEP_MS = 7 * 24 * 60 * 60_000;
// How long a stored not-found page is kept and served: an hour, and never refreshed. See isStorable
// for which ones are stored at all.
const NOT_FOUND_KEEP_MS = 60 * 60_000;
// One background re-render of a page per colo at a time, for at most this long. A stale hit used to
// start its own full render every time, so a busy page past FRESH_MS was re-rendered once per
// request until the first refresh landed - each one a render's worth of CPU billed to a request
// that had been answered from the cache, if waitUntil work counts against the invocation that
// started it, as it appears to. The first stale hit now re-stores the stale copy marked as leased
// until a minute from now (REFRESH_LEASE_HEADER), so every other request in the colo sees a refresh
// already under way; an isolate also remembers which keys it is re-rendering itself, since the
// Cache API answers a put a moment after it is made.
//
// A refresh that fails - a 5xx, a render the watchdog gave up on, a throw - is taken to be
// transient: it leaves the lease to run out, and the next stale hit after that tries again, a
// minute's delay at worst, with the page still served stale in the meantime. A refresh of a deal
// page that renders a 404, a 410 or a redirect has not failed. It is the deal's answer now - the
// deal was withdrawn, or folded into another - and the copy is deleted rather than served on, so
// the next reader is rendered that answer (isWithdrawnDealPage).
const REFRESH_LEASE_MS = 60_000;
const CACHED_AT_HEADER = "x-radar-cached-at";
const REFRESH_LEASE_HEADER = "x-radar-refresh-leased-until";
// Cloudflare's Cache API refuses to store a response carrying Set-Cookie, so the one cookie that
// is safe to replay is parked here instead and re-emitted on the way out of a hit. See
// storableResponse for which cookie qualifies and why.
const CACHED_COOKIE_HEADER = "x-radar-cached-set-cookie";
// Where a page answered without a render came from: "baked" for the prerendered file, "cache" for
// the colo's copy. A page that was rendered carries none. Diagnostic only - nothing reads it but
// people and the deploy's own check (.github/workflows/deploy.yml), which fails a deploy whose
// home, static or sign-in pages are no longer the baked ones: a bake that silently stopped being
// served looks exactly like a working site, only slower and dearer.
const SERVED_HEADER = "x-radar-served";

// An allowlist on the locale prefix rather than a denylist of privileged areas. Admin, /api, the
// operator portal and /creator all deliberately live outside the locale routing tree (see
// i18n/routing.ts), so none of them can reach this cache by construction, and a route added
// outside that tree later cannot silently become cacheable by not being on a list. Kept in step
// with routing.locales by tests/edge-cache.test.mjs rather than imported, to keep next-intl's
// routing module out of the worker entry.
const CACHEABLE_LOCALES = new Set(["en","fr","es"]);
// Pages that do sit under a locale but exist to show one person their own state. Everything under
// them renders, every time - with one exception, AUTH_SHELLS below.
//
// /pro used to be on this list, because it shows one person their own *currency*: the page reads
// CF-IPCountry to pick which of the currencies the Stripe price carries to quote, and a key with no
// country in it would hand a Canadian render to the next American visitor at that colo. It is
// cached once per currency bucket instead (cacheKeyFor, currencyBucket in app/pricing.ts), which is
// the only thing about the page that varies for a signed-out reader - it reads no D1 row for one.
const UNCACHEABLE_SEGMENTS = new Set(["dashboard","sign-in","sign-up","confirm-email","unsubscribe"]);
// The bare sign-in and sign-up pages, /{locale}/sign-in and /{locale}/sign-up and nothing below
// them, are the one exception. Their server render is the same for every signed-out reader: the page
// is a client component that reads where to go afterwards (`redirect_url`) from the address bar in
// the browser, and a reader who is signed in carries __session and is never answered from here. So
// they are baked at deploy like the home page. Clerk's own steps under them (/sign-in/factor-one,
// /sign-up/verify-email-address, /sign-in/sso-callback) stay personal and always render.
const AUTH_SHELLS = new Set(["sign-in","sign-up"]);

// The query parameters each route's server render reads, which is what decides whether a request
// with a query string can be answered with the page everyone else gets.
//
// It used to be "any query string at all, and the request renders": the only way to be sure a new
// parameter could never serve one reader's page to another. But it meant nearly nothing a real
// visitor asked for was ever answered without a render. The home page rewrites its own address to
// /en?country=CA on a first visit, so every reload, Back and shared link of it rendered; the deal
// page's back link is /en?city=Ottawa; sign-in links all carry ?redirect_url=; campaign tags, click
// ids and load-test cache-busters ride on everything. Their server renders read none of those -
// the home page applies its filters in the browser, sign-in reads redirect_url from the address bar
// - and only vinext's echo of the address in the page's bootstrap script differed.
//
// So a request whose parameters are all ones its route's server render does not read is answered as
// the bare address: the baked page, then the colo's copy, and on a miss the bare address's own
// render, which is stored for the next reader. The browser's address bar keeps the parameters, and
// the page's own script reads them from there (HomeClient's filters, CreatorLink's ?c= and ?camp=,
// sign-in's redirect_url), exactly as it does when they arrive on a client-side navigation. A
// parameter in the route's list - a deal page's `return`, `postal`, `zip` and `all`, which change
// the back link, the distances and the list of locations - makes the request personal, as before.
// So does any query at all on a route that is not in this table: a page added later fails closed
// rather than silently sharing one reader's render.
//
// Only the bare address is ever rendered for such a request, stored or refreshed (storePage,
// refreshPage), so a stored copy's echo is always empty and a miss costs one render. A miss with
// parameters used to be rendered as it came, with the bare page rendered beside it in the
// background for the next reader: two full renders inside one invocation, and so against one CPU
// allowance, for every click id that met a page with no baked file - and for every request for /pro
// while Stripe could not be reached, since a page drawn without prices is never stored. The reader
// is now handed the bare render itself, the same bytes the bake or the colo gives every later
// reader with any query. The one thing in a server's answer that the query still decides is where
// a redirect goes - an alias deal's, or the framework's trailing-slash one, each of which carries
// the query along - so the Worker carries it onto the bare render's Location (withQueryCarried).
//
// tests/route-params.test.mjs holds this table to the pages: it reads every route's server
// component, layout and generateMetadata and fails when the searchParams they read differ from the
// entry here, when anything a page uses reads useSearchParams, or when a page reads a request header
// or cookie this file does not account for.
//
// Keyed by route: "" is the home page, "deals/[slug]" a deal page, and every other key the one
// segment under the locale. A Map rather than an object literal, so that a path segment such as
// "constructor" can never find something on Object.prototype.
const SERVER_READ_PARAMS = new Map<string, readonly string[]>([
  ["", []],
  ["terms", []],
  ["privacy", []],
  ["support", []],
  ["age-suitability", []],
  ["for-restaurants", []],
  ["for-creators", []],
  ["pro", []],
  ["sign-in", []],
  ["sign-up", []],
  ["deals/[slug]", ["return", "postal", "zip", "all"]],
  // The city guides (app/city-pages.ts), and the old Ottawa addresses that redirect to them.
  ["cities", []],
  ["cities/[city]", []],
  ["cities/[city]/[topic]", []],
  ["ottawa", []],
  ["ottawa/[topic]", []],
]);

// The route a locale path belongs to, in SERVER_READ_PARAMS's terms, or null for a shape no entry
// describes (a path two levels below a page, say), which then refuses any query.
function routeOf(segments: string[]): string | null {
  if (segments.length === 1) return "";
  if (segments.length === 2) return segments[1];
  if (segments.length === 3 && segments[1] === "deals") return "deals/[slug]";
  if (segments.length === 3 && segments[1] === "ottawa") return "ottawa/[topic]";
  if (segments.length === 3 && segments[1] === "cities") return "cities/[city]";
  if (segments.length === 4 && segments[1] === "cities") return "cities/[city]/[topic]";
  return null;
}

// The pages scripts/prerender-deals.mjs bakes at deploy besides the deal pages, as the path under
// the locale: the home page, the six static pages and the two sign-in shells, 27 files across the
// three locales. Each is answered ahead of the colo cache (prerenderedPage) and is listed, exactly,
// in wrangler.jsonc's run_worker_first, so the Worker - not the asset layer, which would ignore the
// query string and leave off the locale cookie - is what serves it. tests/prerender.test.mjs keeps
// this list, the script's and wrangler's in step.
//
// Their HTML depends on nothing but the build and the locale: no D1 read, no header beyond the host
// and the Turnstile site key the Worker itself supplies, no cookie for a signed-out reader. Rendered
// on demand, each still cost one render per colo per deploy, and a stale-while-revalidate render
// every fifteen minutes after that, to produce the same bytes again.
const BAKED_PAGES = new Set(["", "/terms", "/privacy", "/support", "/age-suitability", "/for-restaurants", "/for-creators", "/sign-in", "/sign-up"]);

function isBakedPath(pathname: string): boolean {
  const locale = pathname.split("/")[1];
  if (!CACHEABLE_LOCALES.has(locale)) return false;
  const page = pathname.slice(locale.length + 1);
  // The city guides (app/city-pages.ts) are baked in English only; /fr/cities redirects to them.
  return BAKED_PAGES.has(page) || /^\/deals\/[^/]+$/.test(page) || (locale === "en" && /^\/cities(\/[^/]+){0,2}$/.test(page));
}

// The one page whose server render reads the visitor's country (CF-IPCountry), and so is kept once
// per currency bucket rather than once per address (cacheKeyFor).
function isPricedPage(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2 && CACHEABLE_LOCALES.has(segments[0]) && segments[1] === "pro";
}

// The affiliate portal is the same Worker, the same app and the same database served under its
// own name. `affiliate.radar.cheap/earnings` renders what `radar.cheap/affiliate/earnings` renders.
//
// A rewrite rather than a second Worker, because the alternative is two deployments sharing one
// D1 binding, one Stripe key and one session — which is two of everything to keep in step for a
// difference nobody outside can see. What the subdomain buys is real, though: an affiliate lands
// somewhere that is plainly the affiliate portal and not a page of the consumer site, and the
// portal's cookies and CSP can be reasoned about on their own hostname.
//
// Three things deliberately pass through unrewritten. `/api/*` so the portal's own fetches reach
// the same endpoints under either name; `/_vinext/*` and anything with a file extension so the
// build's assets resolve; and a path that already starts with `/affiliate` so a link written the
// long way is not turned into `/affiliate/affiliate`.
const AFFILIATE_HOSTS = new Set(["affiliate.radar.cheap", "affiliate.localhost"]);

export function affiliatePathFor(url: URL): string | null {
  if (!AFFILIATE_HOSTS.has(url.hostname)) return null;
  const path = url.pathname;
  if (path.startsWith("/api/") || path.startsWith("/_vinext/") || path === "/api") return null;
  if (path === "/affiliate" || path.startsWith("/affiliate/")) return null;
  // A dot in the last segment means a file — favicon.ico, a hashed bundle, robots.txt — and those
  // are served from the asset manifest at the path they were built at.
  if (/\.[a-z0-9]+$/i.test(path.split("/").pop() || "")) return null;
  return path === "/" ? "/affiliate" : `/affiliate${path.replace(/\/+$/, "")}`;
}

// The same URL serves either an HTML document or an RSC flight payload for a client-side
// navigation, distinguished by these request headers, the framework's `_rsc` cache-busting
// parameter or a `.rsc` suffix. Neither the baked files nor the colo cache ever hold a flight, so a
// flight is never answered from either, and a document is never stored from a flight.
function isFlightRequest(request: Request, url: URL): boolean {
  if (request.headers.has("RSC") || request.headers.has("Next-Router-State-Tree")) return true;
  return url.searchParams.has("_rsc") || url.pathname.endsWith(".rsc");
}

// A reader the render would recognise: Clerk's session cookie, or a bearer token, which getAppUser
// in app/auth.ts reads ahead of the cookie. The token was not checked here before, so a page request
// carrying one could have been rendered signed in and stored for everyone; any Authorization header
// at all now keeps a request's render out of the cache.
function isSignedIn(request: Request): boolean {
  return (request.headers.get("cookie") || "").includes("__session=") || request.headers.has("authorization");
}

// The Clerk cookies and the bearer token, left out of a request rendered for the colo's cache
// (refreshPage): the render then sees a signed-out reader, whatever reader's stale hit set it off.
const SESSION_COOKIE = /^(__session|__client_uat|__clerk)/;

function signedOutHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("authorization");
  const cookie = (headers.get("cookie") || "").split(/; */).filter((pair) => pair && !SESSION_COOKIE.test(pair));
  if (cookie.length) out.set("cookie", cookie.join("; "));
  else out.delete("cookie");
  return out;
}

// The pages whose server render reads nothing of the reader: the home page, the static pages and
// the city guides. Their render reads the session cookie in one place only, RootShell, which marks
// <html data-signed-in> and mounts Clerk by it - and the Worker can add that mark itself
// (signedInCopy). So a signed-in reader of one of these is answered as a signed-out one is, from
// the baked file or the colo's copy with the mark added, and the client picks the rest up from the
// mark (app/has-session.tsx, app/ClerkClientProvider.tsx).
//
// Every page a signed-in reader opened used to render, because RootShell reads the cookie. For the
// staff who are signed in on every visit, that was a full render of the home page - 25 to 57 ms of
// CPU locally, past the free plan's limit several times over - on every page load, including the
// ones a signed-out reader gets for nothing. tests/route-params.test.mjs holds this list to the
// pages: a route here may read no header or cookie but the ones every reader shares.
//
// Not the deal page, which narrows its branches by the reader's saved postal code; not /pro, which
// reads who is signed in; not the sign-in shells, which mount Clerk themselves.
const USER_BLIND_ROUTES = new Set(["", "terms", "privacy", "support", "age-suitability", "for-restaurants", "for-creators", "cities", "cities/[city]", "cities/[city]/[topic]", "ottawa", "ottawa/[topic]"]);

type PageLookup = {
  // The address the baked file and the colo's copy are found under: the request's own path, with
  // no query string. On a miss, this is also the address that is rendered.
  url: URL;
  // Whether the request itself had no query string. One that had one is rendered as `url` on a
  // miss, in its place (see the fetch handler).
  bare: boolean;
  // A signed-in reader of a page that reads nothing of them (USER_BLIND_ROUTES): answered from the
  // shared page with the signed-in mark added, and never the one whose render is stored.
  signedIn: boolean;
};

// Whether a page request may be answered with the page every signed-out reader of its address
// gets, and the address to look that page up under; null when the request is personal and has to
// be rendered for this reader alone. GET and HEAD only - a HEAD is answered with the same headers
// and no body - and never a flight. A signed-in reader is answered that way only on the pages that
// read nothing of them (USER_BLIND_ROUTES). A query string is allowed when none of its parameters
// is one its route's server render reads (SERVER_READ_PARAMS).
//
// Nor an address spelled in a way these checks cannot vouch for. They compare the path's raw
// segments, and the app routes on decoded ones: /en/pr%6F is the Pro page to the app and an
// unknown page here, so it was kept under that spelling with no currency bucket, and the first
// reader's price was handed to every country after them; /en/de%61ls/<slug> was a deal page whose
// 404 was kept for an hour. Cloudflare decodes such a segment before the Worker sees it while the
// zone normalizes incoming URLs, which is its default, and that is a setting rather than a
// guarantee. So a percent sign in the locale or the page segment sends the request to be rendered
// for its reader alone, as does a doubled slash, which the app does not route as the page either
// and which `new URL(path, origin)` below would read as another host (//en/pro is https://en/pro).
// A deal's slug, the third segment, may be encoded: it names the deal however it is spelled.
function pageLookup(request: Request, url: URL): PageLookup | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (isFlightRequest(request, url)) return null;
  if (url.pathname.includes("//")) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.slice(0, 2).some((segment) => segment.includes("%"))) return null;
  if (!CACHEABLE_LOCALES.has(segments[0])) return null;
  if (segments[1] && UNCACHEABLE_SEGMENTS.has(segments[1]) && !(segments.length === 2 && AUTH_SHELLS.has(segments[1]))) return null;
  const route = routeOf(segments);
  const signedIn = isSignedIn(request);
  if (signedIn && (route === null || !USER_BLIND_ROUTES.has(route))) return null;
  if (!url.search) return { url, bare: true, signedIn };
  const read = route === null ? undefined : SERVER_READ_PARAMS.get(route);
  if (!read) return null;
  for (const key of url.searchParams.keys()) if (read.includes(key)) return null;
  return { url: new URL(url.pathname, url.origin), bare: false, signedIn };
}

// The shared page, for a signed-in reader of one of USER_BLIND_ROUTES: the mark RootShell puts on
// <html> for a render that saw the session cookie, added to the copy every reader gets. The mark is
// what the page's own scripts read to fetch Clerk ahead of hydration (app/clerk-react.ts), give the
// header its signed-in row from the first paint (site-chrome.css) and mount Clerk and the
// client-side links once hydrated. Nothing else in the page differs for them.
//
// By a string replacement over the whole body rather than a streaming rewrite: a baked page is a
// few hundred kilobytes, which is a fraction of a millisecond to decode and search, and the one
// code path runs the same under the test harness, which has no HTMLRewriter. A 304 and a HEAD carry
// no body to mark, and a page with no <html> is sent as it is.
async function signedInCopy(response: Response): Promise<Response> {
  if (!response.body || response.status === 304) return response;
  const text = await response.text();
  const marked = text.replace(/<html(?=[\s>])/i, '<html data-signed-in=""');
  const headers = new Headers(response.headers);
  // The body is a different length now; the runtime measures the new one.
  headers.delete("content-length");
  return new Response(marked, { status: response.status, statusText: response.statusText, headers });
}

// Origin + pathname, since a stored page is the bare address's and dropping everything else keeps
// one entry per page rather than one per visitor — under a namespace named for the current
// deployment. Cache entries outlive a deploy, so without that prefix, HTML stored before one
// would keep being served after it, still referencing the hashed CSS and JS filenames of the
// build that produced it — names the new build's asset manifest no longer serves, which is a
// page that loads with no styles at all. Entries under an older deployment's prefix are simply
// never looked up again and age out on their own.
//
// The Pro page alone also carries its reader's currency bucket, so a colo keeps one copy per
// currency it is asked to quote (currencyBucket in app/pricing.ts says why a bucket is exactly
// enough). As a query string on the key, which no request's path can produce, so no other page can
// ever be stored under one of those keys or find one.
function cacheKeyFor(url: URL, env: Env, request: Request): Request {
  const key = `${url.origin}/__page-cache/${env.CF_VERSION?.id || "dev"}${url.pathname}`;
  if (!isPricedPage(url.pathname)) return new Request(key, { method: "GET" });
  return new Request(`${key}?currency=${currencyBucket(request.headers.get("CF-IPCountry"))}`, { method: "GET" });
}

// The Cache API keys entries by URL, so three internal caches — rendered pages here, restaurant
// photos in app/api/restaurant-photo, and the shared deals snapshot in app/api/deals — each name
// themselves with a path on this origin. Those paths are identifiers, not endpoints: no visitor is
// ever meant to be handed one.
//
// Nothing was serving them. Workers run ahead of Cloudflare's cache, so a stored entry cannot reach
// a visitor without coming through this handler first, and these paths match no route, so they
// already 404. But that is a fact about the routes that exist today rather than a rule: a catch-all
// added later, or a change to how unknown paths are rewritten, could quietly start answering one.
// The snapshot is the whole public catalog in a single document, an answer is a whole deals response
// (sharedAnswerKey in app/api/deals/route.ts) and the page cache is rendered HTML, so the prefix is
// refused here, ahead of everything, instead of being left to what happens to be routed.
//
// The reply is the site's own not-found page, describing nothing about what it refused. It is not
// indistinguishable — an unknown bare path is redirected into a locale before it 404s, so answering
// in place is visibly a refusal — and that is the accepted trade: mirroring the redirect would mean
// duplicating locale negotiation in this file, which is the thing it deliberately keeps out, to
// conceal one bit about a document that holds the public deal catalog.
const INTERNAL_CACHE_PATH = /^\/__(page-cache|photo-cache|deals-snapshot|deals-answer)(\/|$)/;

// A deal page answered 200 at three URLs besides its own: with a trailing slash, with ".html" on
// the end (both handed the prerendered file back through the asset binding), and, for
// the ten deals whose slug was rewritten by scripts/backfill-deal-slugs.mjs, at the old
// /deals/deal-<uuid> path it was first shared and indexed under — which the page's lookup
// (`WHERE d.slug=? OR d.id=?`) still finds, and which the prerender used to bake as a second full
// copy. Each carried a canonical pointing at the real URL, but a canonical is a hint; a redirect is
// the answer. So each is sent to /<locale>/deals/<slug> here, ahead of the prerendered lookup, so
// that no variant is ever served as a page again.
//
// An old id is recognized by its shape, `deal-` and a UUID, which is what admin gives every deal it
// creates (app/api/admin/route.ts) and which no readable slug has. Only that shape costs a D1
// lookup — one row by primary key — so the ordinary deal page pays nothing for this. A deal whose
// id is its slug (nearly all of them) is found by the same query and simply not redirected.
//
// Not for a flight request or anything but GET and HEAD. A client-side navigation follows the
// framework's own redirect protocol rather than a bare 301, and nothing links to these variants
// from inside the app anyway; a POST keeps whatever the framework does with it.
const OLD_DEAL_ID = /^deal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEAL_PATH = /^\/([^/]+)\/deals\/([^/]+?)(\.html)?(\/+)?$/;

async function canonicalDealRedirect(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return null;
  const match = DEAL_PATH.exec(url.pathname);
  if (!match || !CACHEABLE_LOCALES.has(match[1])) return null;
  const [, locale, segment, htmlSuffix, trailingSlash] = match;
  // Still percent-encoded, exactly as it arrived, so a variant is redirected to the same bytes.
  let slugPath = segment;
  if (OLD_DEAL_ID.test(segment) && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT slug FROM deals WHERE id=? AND slug IS NOT NULL AND slug<>'' AND slug<>id")
        .bind(segment)
        .first<{ slug: string }>();
      if (row?.slug) slugPath = encodeURIComponent(row.slug);
    } catch {
      // D1 unavailable: fall through, and the page answers at the old path as it did before.
    }
  }
  if (slugPath === segment && !htmlSuffix && !trailingSlash) return null;
  const target = new URL(url.toString());
  target.pathname = `/${locale}/deals/${slugPath}`;
  // A day rather than forever. A bare 301 is cached by browsers with no end date, and a slug can
  // still be changed in admin; an old link should follow that change within a day.
  return new Response(null, { status: 301, headers: { Location: target.toString(), "Cache-Control": "public, max-age=86400" } });
}

// Deal pages, the home page, the static pages and the sign-in shells (BAKED_PAGES) are prerendered
// into dist/client at deploy by scripts/prerender-deals.mjs, and wrangler.jsonc lists them under
// run_worker_first so this handler sees them BEFORE the asset layer would serve them. That inversion
// is deliberate: asset matching ignores the query string, and every in-app navigation reaches a
// deal page with `?return=`, which changes the back link and the per-location distances. Letting
// the asset layer answer those directly would silently drop both. So the baked file is used only
// for a request that has already been judged impersonal (pageLookup), and everything else still
// renders.
//
// What this buys over the colo cache below: the cache can only be filled by a render, and a
// render is exactly what can fail under the platform's per-request CPU limit — so the first request
// for any page in any colo was still a coin flip. A baked file is present everywhere from the
// moment of deploy.
//
// Marked `x-radar-served: baked`, which is how the deploy checks that the home, static and sign-in
// pages it just shipped are the baked ones (.github/workflows/deploy.yml), along with their bytes.
async function prerenderedPage(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!env.ASSETS || !isBakedPath(url.pathname)) return null;
  const locale = url.pathname.split("/")[1];
  // Asked for by path alone. The incoming request's headers are not forwarded: they are what the
  // asset layer would negotiate against, and this is a fixed file either way. A HEAD asks for the
  // headers alone.
  //
  // Except the one that asks whether the reader's copy is still the page. A baked page is sent
  // `private, no-cache`, so a browser keeps it and asks before every reuse - and was sent the whole
  // page again each time, since the question never reached the asset layer. With If-None-Match
  // passed on, a reader whose copy is this deploy's file is told so (304) and nothing is sent.
  const head = request.method === "HEAD";
  const assetHeaders: Record<string, string> = { accept: "text/html" };
  const held = request.headers.get("if-none-match");
  if (held) assetHeaders["if-none-match"] = held;
  const asset = await env.ASSETS.fetch(new Request(`${url.origin}${url.pathname}`, { method: head ? "HEAD" : "GET", headers: assetHeaders }));
  if (asset.status !== 200 && asset.status !== 304) {
    // A deal published since the last deploy has no baked file yet, and neither does anything under
    // `vinext dev` or a deploy that skipped the prerender. Release the body and fall through to
    // rendering it, which the colo cache will then hold.
    await asset.body?.cancel();
    return null;
  }
  const headers = new Headers(asset.headers);
  // A static file carries no Set-Cookie, but the rendered page does — next-intl writes NEXT_LOCALE
  // on every response. Reproduced here so a visitor's locale is remembered whichever path served
  // them; without it, someone arriving on a shared /fr link would later be re-detected from their
  // Accept-Language instead. The value is the path's own locale, exactly as the render derives it.
  // Secure over https, as next-intl's own cookie is in production (localeCookie in i18n/routing.ts):
  // it holds only a language, but there is no reason for it to travel over plain http either.
  const secure = url.protocol === "https:" ? "; Secure" : "";
  headers.set("Set-Cookie", `NEXT_LOCALE=${locale}; Path=/; SameSite=lax${secure}`);
  // The asset layer's own caching headers describe a file; this URL is a page, answered the same
  // way to every reader, so it is sent as impersonalPage marks every such page. See there.
  headers.set("Cache-Control", IMPERSONAL_PAGE_CACHE_CONTROL);
  headers.set(SERVED_HEADER, "baked");
  if (asset.status === 304) {
    await asset.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (head) {
    await asset.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(asset.body, { status: 200, headers });
}

// Signed out, /{locale}/dashboard and /{locale}/dashboard/{section} are a redirect to the sign-in
// page and nothing else: requireAppUser (app/auth.ts) finds no user and the page answers 307 to
// /{locale}/sign-in?redirect_url=<the dashboard path>. Rendering that took a whole trip through the
// framework - 2-4.5 ms of CPU locally, nine to eighteen in production - for an empty body, every
// time a signed-out reader followed a dashboard link: the home page's bottom bar, a digest email
// opened in another browser, a crawler.
//
// So the Worker answers it, with the response the app sends, header for header: the Location
// requireAppUser builds (safeReturnTo leaves these paths as they are), and next-intl's locale cookie
// when the middleware would set one (it adds no hreflang Link header: alternateLinks is off in
// i18n/routing.ts). The cookie is the one part that depends on the reader. next-intl sets it on a document
// request (Sec-Fetch-Dest absent or "document") whose NEXT_LOCALE is missing or names another
// locale - except that with no cookie at all it first negotiates the reader's Accept-Language
// against the three locales, and skips the cookie when that lands on this page's own. That
// negotiation is CLDR language matching (@formatjs/intl-localematcher), not something to copy
// here, so a request it would decide is left to the app: in practice, a browser that has never been
// sent the cookie, which every baked page and nearly every render sets. tests/worker-pages.test.mjs
// holds this to the app's own 307 for every locale and section.
//
// Only for a GET that is not a flight (a client-side navigation follows the framework's own redirect
// protocol instead), from a reader with no session cookie and no bearer token, for a path the app
// would send to sign-in: the overview without the legacy `?section=` parameter, which the app
// redirects elsewhere first, and only the sections that exist, since any other is redirected to
// the overview.
const DASHBOARD_PATH = /^\/([^/]+)\/dashboard(?:\/([^/]+))?$/;

function signedOutDashboardRedirect(request: Request, url: URL): Response | null {
  if (request.method !== "GET" || isFlightRequest(request, url) || isSignedIn(request)) return null;
  const match = DASHBOARD_PATH.exec(url.pathname);
  if (!match || !CACHEABLE_LOCALES.has(match[1])) return null;
  const [, locale, section] = match;
  if (section === undefined ? url.searchParams.has("section") : !(dashboardSections as readonly string[]).includes(section)) return null;
  const cookie = localeCookieFor(request, locale);
  if (cookie === undefined) return null;
  const dashboard = `/dashboard${section ? `/${section}` : ""}`;
  const headers = new Headers({
    Location: `/${locale}/sign-in?redirect_url=${encodeURIComponent(`/${locale}${dashboard}`)}`,
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 307, headers });
}

// The cookie next-intl's middleware would set on this request for a page in `locale`: the cookie
// string, "" for none, or undefined when only Accept-Language negotiation could say (see above).
// Its value is the locale and nothing else; its attributes are next-intl's defaults plus Secure in a
// production build (localeCookie in i18n/routing.ts), written the way the framework serializes them.
function localeCookieFor(request: Request, locale: string): string | undefined {
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null && destination !== "document") return "";
  const cookie = `NEXT_LOCALE=${locale}; Path=/${import.meta.env.PROD ? "; Secure" : ""}; SameSite=lax`;
  // Parsed the way the framework parses a Cookie header for middleware (vinext's
  // parseEdgeRequestCookieHeader): split on ";" and the spaces after it, the name taken as it is,
  // the value percent-decoded, a value that fails to decode skipped, and a later pair of the same
  // name winning over an earlier one.
  let current: string | undefined;
  for (const part of (request.headers.get("cookie") || "").split(/; */)) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      if (part === "NEXT_LOCALE") current = "true";
      continue;
    }
    if (part.slice(0, separator) !== "NEXT_LOCALE") continue;
    try { current = decodeURIComponent(part.slice(separator + 1)); } catch { /* skipped, as the framework skips it */ }
  }
  if (current !== undefined) return current === locale ? "" : cookie;
  return request.headers.get("accept-language") ? undefined : cookie;
}

// What a page that is identical for every reader tells the browser: keep it if you like, but check
// with the server before reusing it. The framework marks every page `no-store`, which also bars a
// page from the back/forward cache, so pressing Back to the home page reloaded it and re-ran
// /api/deals — extra load at exactly the moments the site had least to spare. `private`
// keeps shared caches out of it regardless; the colo cache is written by this Worker, not by
// Cache-Control. Anything personal — a signed-in reader, a `?return=` — never reaches this and
// keeps the framework's no-store.
const IMPERSONAL_PAGE_CACHE_CONTROL = "private, no-cache";

function impersonalPage(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", IMPERSONAL_PAGE_CACHE_CONTROL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Resolved through a guard rather than referenced directly, because `caches` is a Workers global
// that simply is not there when the built bundle is loaded in plain Node — which is what
// tests/rendered-html.test.mjs does to render pages outside workerd. It is also a no-op on a
// workers.dev subdomain. Returning null in those cases degrades to "render every time", the
// behavior before this cache existed, instead of a ReferenceError, and keeps this the only
// place that has to know the API might be missing.
function edgeCache(): Cache | null {
  try {
    return typeof caches === "undefined" ? null : caches.default || null;
  } catch { return null; }
}

// The headers a proxy in front of an origin uses to tell it what the client asked the proxy for.
// Nothing stands in front of this Worker but Cloudflare, which overwrites X-Forwarded-Proto with the
// real scheme and passes a client's own X-Forwarded-Host and X-Forwarded-Port through untouched -
// and request.url already carries the real scheme and host, so nothing here needs any of them.
// next-intl's middleware builds the Link alternates of every page it answers from the host and the
// scheme (getAlternateLinksHeaderValue), so one request carrying X-Forwarded-Host: evil.example
// that landed on a colo miss, or on the stale hit that set off a refresh, stored a page whose Link
// named evil.example in every language, for every reader after it until the next refresh replaced
// it: fifteen minutes at the least, and an hour for a not-found page, which is never refreshed.
// Only crawlers read hreflang from a header, but /pro, every locale's 404 and the deal pages with
// no baked file were all exposed. The HTML itself never was: its canonical, og:url and hreflang
// tags come from the Host header (getSiteOrigin in app/siteMetadata.ts).
const FORWARDED_HEADERS = ["x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"];

function renderPage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Server Components can't `import { env } from "cloudflare:workers"` themselves without
  // pulling that Workers-only module into their SSR bundle — harmless in production, but it
  // breaks the local Node-based render test (tests/rendered-html.test.mjs), which loads the
  // built bundle outside workerd and can't resolve a "cloudflare:" specifier. Passing the one
  // public (non-secret) var pages need as a request header keeps it reachable through the
  // same `headers()`-based pattern siteMetadata.ts's getSiteOrigin already uses safely.
  //
  // A request with no User-Agent gets a stand-in one. The framework streams page metadata into
  // <body> for any request without one, whatever next.config's htmlLimitedBots says, and the
  // prerender (scripts/prerender-deals.mjs) sends none - so every baked deal page, the copy crawlers
  // and link previews are actually served, had its title, canonical and og: tags after </head>.
  //
  // And none goes in with a forwarded host, port or scheme (FORWARDED_HEADERS): this is the one
  // door every render passes through - a visitor's, and the refresh of a stored copy, which is
  // rendered with the headers of whoever's stale hit set it off. So the headers are always copied,
  // as production already did, since it always has a Turnstile key to add.
  const forwarded = new Request(request, { headers: new Headers(request.headers) });
  for (const name of FORWARDED_HEADERS) forwarded.headers.delete(name);
  if (env.TURNSTILE_SITE_KEY) forwarded.headers.set("x-turnstile-site-key", env.TURNSTILE_SITE_KEY);
  if (!request.headers.get("user-agent")) forwarded.headers.set("user-agent", "Radar-Render");
  return handler.fetch(forwarded, env, ctx);
}

// Whether this response may be reused for every signed-out reader of its address — a 200 page, or
// the not-found page of a locale path outside /deals/. Anything else (a redirect, an error, a
// non-HTML body) is not what the next visitor should be handed.
//
// Not-found pages are stored because every one of them was a full render of the site's 404 page,
// header and footer and flight data included, for an answer that is the same until the next deploy:
// whether a path under a locale is a page is decided by the routes in app/[locale], which only a
// deploy changes - and a deploy starts a new key namespace (cacheKeyFor). Deal pages are the
// exception, and are never stored as a 404: a deal published between deploys must appear the
// moment it is published, not an hour later. /launch also 404s until APP_STORE_URL is set, but
// setting a variable or a secret is itself a new version of the Worker, with a new namespace. Kept
// an hour (NOT_FOUND_KEEP_MS) and never refreshed, so a not-found page costs one render per colo per
// hour rather than one per request.
//
// Decided from headers alone, never touching the body, because the caller only takes its clone
// once the answer is yes. A clone whose body nobody reads is not free: the two branches of a tee
// share a buffer, so an abandoned branch fills and then applies backpressure to the branch the
// visitor is still being served, turning "this response was not cacheable" into a request that
// hangs until it times out.
function isStorable(response: Response, url: URL): boolean {
  if (response.status !== 200 && !(response.status === 404 && notFoundIsStorable(url))) return false;
  if (!(response.headers.get("content-type") || "").includes("text/html")) return false;
  // next-intl writes NEXT_LOCALE on every single response, which is what made the first version
  // of this cache store nothing at all. That cookie is not per-reader: its value is the locale
  // segment of the URL being requested, verified against the path here, and that segment is part
  // of the cache key — so replaying it to the next visitor of this same URL hands them exactly
  // the cookie they would have been sent anyway. Any other cookie identifies a reader and stops
  // the response being stored.
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 1) return false;
  return cookies.length === 0 || cookies[0].startsWith(`NEXT_LOCALE=${url.pathname.split("/").filter(Boolean)[0]};`);
}

function notFoundIsStorable(url: URL): boolean {
  const segments = url.pathname.split("/").filter(Boolean);
  return CACHEABLE_LOCALES.has(segments[0]) && segments[1] !== "deals";
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A deal page whose render says the deal is no longer there to be shown: a 404 or a 410 - it was
// put back to draft or scheduled, its publication moved into the future, it was hidden or deleted -
// or a redirect, because it was folded into another listing and its address is now an alias. Each
// is what the deal's address answers from now on, so a copy of the page from before is not a stale
// version of the answer but a different one: the offer, its price, its hours and its address, for
// a deal staff took down. Kept, it was served for up to a day (EDGE_CACHE_MAX_STALE_MS) with a
// discarded render behind it every minute, and after that held as the watchdog's fallback for a
// week. So it is deleted the moment a render says so (refreshPage, and a miss that finds a copy
// too old to serve). The 404 itself is still never stored, so a deal published again between
// deploys appears at once. A 5xx or a render that never finishes says nothing about the deal and
// leaves the copy alone. Baked deal pages are not touched: they last until the next deploy, which
// is what the daily deploy and its "Run workflow" button are for (.github/workflows/deploy.yml).
function isWithdrawnDealPage(response: Response, url: URL): boolean {
  const segments = url.pathname.split("/").filter(Boolean);
  if (!CACHEABLE_LOCALES.has(segments[0]) || segments[1] !== "deals") return false;
  return response.status === 404 || response.status === 410 || REDIRECT_STATUSES.has(response.status);
}

// The bare address's render, standing in for a request that came with parameters its route's
// server render ignores, as the answer to that request. Everything in it is the same for both but
// one thing: a redirect's target, which the query would have ridden along to. An alias deal's
// redirect forwards the page's searchParams, and the framework's trailing-slash redirect and
// next-intl's keep the request's search, so a shared link's click id or a creator's ?c= reaches the
// page it ends up on. So the query is carried onto the Location here, as it was sent, after any
// query of the Location's own (none of the redirects a bare address can be answered with has one,
// since the parameters that would choose one make a request personal and it is rendered as it came)
// and ahead of a fragment. Anything that is not a redirect is returned as it is.
function withQueryCarried(response: Response, search: string): Response {
  const location = response.headers.get("location");
  if (!REDIRECT_STATUSES.has(response.status) || location === null || !search) return response;
  const hash = location.indexOf("#");
  const target = hash === -1 ? location : location.slice(0, hash);
  const fragment = hash === -1 ? "" : location.slice(hash);
  const headers = new Headers(response.headers);
  headers.set("Location", `${target}${target.includes("?") ? "&" : "?"}${search.slice(1)}${fragment}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Only ever called on a response isStorable has already approved.
function storableResponse(response: Response): Response {
  const cookies = response.headers.getSetCookie();
  const headers = new Headers(response.headers);
  // Carried verbatim rather than rebuilt from the locale, so whatever attributes next-intl sets
  // on it stay exactly what next-intl set.
  headers.delete("Set-Cookie");
  if (cookies.length === 1) headers.set(CACHED_COOKIE_HEADER, cookies[0]);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  // The framework marks every dynamic render `no-store`, which the Cache API honors by refusing
  // to store the response at all. The claim being made here is narrower than that header's — this
  // exact body is reusable for anonymous readers of this one URL — so it is replaced rather than
  // worked around from the outside.
  const keep = response.status === 404 ? NOT_FOUND_KEEP_MS : EDGE_CACHE_KEEP_MS;
  headers.set("Cache-Control", `public, max-age=0, s-maxage=${Math.floor(keep / 1000)}`);
  // Vary lists ten RSC negotiation headers, which would shard the cache per router state and make
  // it useless. Only document requests get this far, so the URL alone is the correct key.
  headers.delete("Vary");
  return new Response(response.body, { status: response.status, headers });
}

// Writes a render isStorable has approved into the colo cache, under the key it was looked up by.
//
// The Pro page is the one render whose headers cannot say whether it is fit to keep. When Stripe
// cannot be reached, displayPrices answers {} and the page is drawn with no price on it - right for
// the one reader it was rendered for, and wrong to hand everyone in the colo who shares that
// currency for the next fifteen minutes. The page marks a render that does carry prices
// (PRICED_PAGE_MARKER in app/pricing.ts), so its body is read here, off the visitor's path, and an
// unpriced one is dropped.
async function storePage(cache: Cache, cacheKey: Request, response: Response, url: URL): Promise<void> {
  if (isPricedPage(url.pathname)) {
    const html = await response.text();
    if (!html.includes(PRICED_PAGE_MARKER)) return;
    response = new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  await cache.put(cacheKey, storableResponse(response));
}

// Restores what the stored copy had to give up, so a hit is indistinguishable from a fresh
// render: the locale cookie goes back on, the bookkeeping headers come off, and Cache-Control
// becomes what a fresh render of the same impersonal page is sent (impersonalPage). The
// `public, s-maxage=...` written into the stored copy is an instruction to this cache, not to the
// visitor's browser, and must not reach it. A HEAD gets the same status and headers with no body,
// which is all a HEAD is; the stored body is released unread.
function fromCache(hit: Response, request: Request): Response {
  const headers = new Headers(hit.headers);
  const cookie = headers.get(CACHED_COOKIE_HEADER);
  headers.delete(CACHED_COOKIE_HEADER);
  headers.delete(CACHED_AT_HEADER);
  headers.delete(REFRESH_LEASE_HEADER);
  if (cookie) headers.set("Set-Cookie", cookie);
  headers.set("Cache-Control", IMPERSONAL_PAGE_CACHE_CONTROL);
  headers.set(SERVED_HEADER, "cache");
  if (request.method === "HEAD") {
    void hit.body?.cancel().catch(() => {});
    return new Response(null, { status: hit.status, headers });
  }
  return new Response(hit.body, { status: hit.status, headers });
}

// The keys this isolate is re-rendering in the background, and when each started. A Map of start
// times rather than a set, because a request the runtime kills for CPU never runs its `finally`: a
// key left behind by one is let go once it is older than the colo lease, instead of keeping this
// isolate from ever refreshing that page again - the same lesson as the admission slots above.
const backgroundRenders = new Map<string, number>();

function claimBackgroundRender(key: string, now: number): boolean {
  const since = backgroundRenders.get(key);
  if (since !== undefined && now - since < REFRESH_LEASE_MS) return false;
  backgroundRenders.set(key, now);
  return true;
}

function releaseBackgroundRender(key: string, claimed: number): void {
  if (backgroundRenders.get(key) === claimed) backgroundRenders.delete(key);
}

// Renders the bare address of a page in the background and stores it: the stale-while-revalidate
// refresh of a colo copy past EDGE_CACHE_FRESH_MS.
//
// Always the bare address, origin and path with no query string, so the copy stored has an empty
// navigation echo whatever the request that prompted it carried. With that request's headers
// otherwise, which carry its country to the Pro page's render and are no more personal than its
// address: a request carrying a session or a token never gets this far, and renderPage takes off
// the forwarded host and scheme a client could send.
//
// A render that cannot be stored leaves the stale copy where it is, to be served until a later
// refresh succeeds (REFRESH_LEASE_MS) - except a deal page's that says the deal has been withdrawn
// (isWithdrawnDealPage), whose copy is deleted instead.
async function refreshPage(request: Request, env: Env, ctx: ExecutionContext, url: URL, cacheKey: Request): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  try {
    // Under the watchdog too. A refresh on a wedged isolate would otherwise hold its waitUntil open
    // until the runtime gives up on it, and it is as good a sign of a wedge as a visitor's render.
    const deadline = renderDeadlineMs(Date.now(), env.RENDER_DEADLINE_MS);
    // Rendered as a signed-out reader whoever's stale hit set it off: the copy is for every reader,
    // and a signed-in reader's hit can set one off too (pageLookup).
    const bare = new Request(`${url.origin}${url.pathname}`, { method: "GET", headers: signedOutHeaders(request.headers) });
    const fresh = await withinDeadline(renderPage(bare, env, ctx), deadline);
    if (fresh === RENDER_TIMED_OUT) {
      noteRenderTimeout(Date.now());
      console.error(`render watchdog: background refresh of ${url.pathname} had no response after ${deadline} ms`);
      return;
    }
    if (isStorable(fresh, url)) {
      await storePage(cache, cacheKey, fresh, url);
      return;
    }
    // Nobody is waiting on this one — it was rendered only to refresh the cache — so releasing
    // the body explicitly keeps a rejected refresh from leaving a stream open behind it.
    await fresh.body?.cancel();
    if (isWithdrawnDealPage(fresh, url)) await cache.delete(cacheKey);
  } catch { /* the stale copy already went out; a failed refresh just retries once its lease runs out */ }
}

// A stale hit's refresh, at most one per key per colo per REFRESH_LEASE_MS (see there): skipped when
// this isolate is already re-rendering the key or the stored copy is leased to a refresh elsewhere,
// and otherwise preceded by re-storing the stale copy with the lease on it. The lease is its own
// header rather than a rewritten CACHED_AT, so a copy whose refreshes keep failing still stops being
// served at EDGE_CACHE_MAX_STALE_MS. GET only: a HEAD is answered from the copy and changes nothing.
function refreshInBackground(request: Request, env: Env, ctx: ExecutionContext, url: URL, cache: Cache, cacheKey: Request, hit: Response): void {
  const now = Date.now();
  if (request.method !== "GET" || Number(hit.headers.get(REFRESH_LEASE_HEADER) || 0) > now) return;
  if (!claimBackgroundRender(cacheKey.url, now)) return;
  const leased = hit.clone();
  ctx.waitUntil((async () => {
    try {
      const headers = new Headers(leased.headers);
      headers.set(REFRESH_LEASE_HEADER, String(now + REFRESH_LEASE_MS));
      await cache.put(cacheKey, new Response(leased.body, { status: leased.status, headers })).catch(() => {});
      await refreshPage(request, env, ctx, url, cacheKey);
    } finally {
      releaseBackgroundRender(cacheKey.url, now);
    }
  })());
}

// An anonymous /api/deals request whose answer the colo already holds, answered without the app.
//
// The route keeps one copy of each anonymous answer in the colo (app/deals-answer.ts) and looks for
// it first thing, but by then the request has been through the framework's router, which costs
// about as much CPU as the lookup saves on a small answer. Asked here, a shared answer is a cache
// read and nothing else. A miss, a signed-in reader, or any other method falls through to the
// route, which answers and stores exactly as before.
//
// The search a stored answer stands for is still counted, as the route counts it on its own hits:
// the same row, written off the reader's path.
async function sharedDealsAnswer(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response | null> {
  if (request.method !== "GET" || url.pathname !== "/api/deals") return null;
  const cache = edgeCache();
  const key = cache ? sharedAnswerKey(request, url) : null;
  if (!cache || !key) return null;
  const hit = await cache.match(key).catch(() => undefined);
  if (!hit) return null;
  const { answer, searchEvent } = answerFromShared(hit);
  if (searchEvent && env.DB) {
    try {
      const event = JSON.parse(searchEvent) as { market?: string | null; properties?: string };
      ctx.waitUntil(
        env.DB.prepare("INSERT INTO product_events(id,type,market,properties) VALUES(?,?,?,?)")
          .bind(crypto.randomUUID(), "search", event.market ?? null, event.properties ?? "{}")
          .run()
          .catch(() => {}),
      );
    } catch { /* a torn header is not worth an error */ }
  }
  return answer;
}

// The render watchdog.
//
// Page renders on an isolate can hang: each one canceled after a few milliseconds of CPU, with a
// wall time equal to however long the client had been willing to wait, and no log or exception.
// Other routes, prerendered deal pages and colo-cache hits keep answering, and a fresh isolate
// renders the same pages fine; new isolates are what end it.
//
// That is the shape of state that is cleaned up only on a path a killed request never reaches — the
// same failure app/api/deals/route.ts documents for its snapshot guards (SNAPSHOT_BUILD_DEADLINE_MS)
// and that the admission slots above age out for. vinext loads route modules lazily and has every
// concurrent request for a route await one shared in-flight load, cleared only when it settles; the
// message catalogues were a per-request dynamic import every locale render awaited. A request
// hard-killed on the platform's CPU limit while one of those loads is being evaluated can
// leave it pending for good, and every later render on that isolate awaits it and hangs. The
// catalogues are now static imports, evaluated once when the isolate starts (i18n/request.ts), but
// this is a class of failure, not one bug, and nothing in this file can reach into the framework
// and clear a load that will never settle.
//
// So nothing waits on a render without a limit. A page render that has produced no response within
// renderDeadlineMs is answered without it (answerWithoutRender): the page's prerendered file if it
// has one, standing in even for a personalized deal page or a signed-in reader's home page; the
// colo's copy of the page if there is one, however old; otherwise a 503 that says so, instead of a
// tab that spins until the visitor gives up. The path goes to console.error so
// `wrangler tail` shows which routes an isolate is stuck on. Its admission slot is released when it
// returns, like any other request's. After a miss the isolate uses a much shorter deadline for a
// while (WEDGED_RENDER_DEADLINE_MS), so a wedged isolate does not hold each visitor for the full
// eight seconds, while one that has recovered still renders within it.
//
// Pages only: GET and HEAD outside /api. An API route or a server action (a POST) may be partway
// through writes, and answering for it while it keeps running would report a failure for work that
// then completes. /_vinext/image never reaches the renderer.
function isWatchedRender(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return url.pathname !== "/api" && !url.pathname.startsWith("/api/");
}

async function answerWithoutRender(
  request: Request,
  env: Env,
  url: URL,
  cache: Cache | null,
  cacheKey: Request | null,
  staleHit: Response | undefined,
  impersonal: boolean,
  deadline: number,
  signedIn = false,
): Promise<Response> {
  noteRenderTimeout(Date.now());
  let answer: Response | null = null;
  let served = "a 503";
  // The prerendered file first, when the page has one. For an impersonal request it is the very
  // page the render would have produced, from this deploy - it was only skipped on the way in if
  // the asset binding did not answer, so it is worth asking again. A deal page reached with
  // `?return=`, or a deal page asked for by a signed-in reader, is personalized and never had a
  // stored copy — but its prerendered file is the same page without the back link, the distances or
  // the reader's name in the header, which is far better than an error. Sent no-store then: it is
  // standing in for a personal page, and must not be kept under that page's URL. A signed-in reader
  // of a page that reads nothing of them gets the shared copy marked for them, as a hit would.
  if (impersonal || signedIn || isDocumentRequest(request, url)) {
    const baked = await prerenderedPage(request, env, new URL(url.pathname, url.origin)).catch(() => null);
    if (baked) {
      if (!impersonal && !signedIn) baked.headers.set("Cache-Control", "no-store");
      answer = signedIn ? await signedInCopy(baked) : baked;
      served = "the prerendered page";
    }
  }
  if (answer) {
    await staleHit?.body?.cancel().catch(() => {});
  } else {
    // Kept from the lookup at the top of fetch when it was past EDGE_CACHE_MAX_STALE_MS, or looked
    // up again, since another request may have stored a copy while this one waited.
    const stale = staleHit ?? (cache && cacheKey ? await cache.match(cacheKey).catch(() => undefined) : undefined);
    if (stale) {
      answer = signedIn ? await signedInCopy(fromCache(stale, request)) : fromCache(stale, request);
      served = "the colo's cached copy";
    }
  }
  // The pathname only: a query string can carry a postal code.
  console.error(`render watchdog: ${request.method} ${url.pathname} had no response after ${deadline} ms; served ${served}`);
  return withSecurityHeaders(answer ?? unavailableResponse(request, url, "timeout"), url);
}

// The audit row for a cron step that failed. Written so that failing to write it cannot stop the
// steps after it either: the row is how a failure gets noticed, but the next job running matters
// more than the record of this one, and the likeliest reason a step failed — D1 refusing — is also
// the likeliest reason this insert would. The console line is what is left then, and `wrangler
// tail` shows it.
async function recordCronFailure(env: Env, action: string, targetId: string, details: Record<string, unknown>): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES('system:cron','system',?,'job',?,?)",
    ).bind(action, targetId, JSON.stringify(details).slice(0, 1500)).run();
  } catch (cause) {
    console.error(`cron: ${action} (${targetId}) and its audit row could not be written`, cause);
  }
}

function failureDetails(cause: unknown): Record<string, unknown> {
  return { error: cause instanceof Error ? cause.message : "UNKNOWN" };
}

// One job route, run through the Worker's own handler with the job's secret. A non-2xx answer and
// a thrown error are both recorded and neither is rethrown, so each job runs whatever happened to
// the one before it.
async function runCronJob(env: Env, ctx: ExecutionContext, origin: string, secret: string, job: string, failedAction: string): Promise<void> {
  try {
    const response = await handler.fetch(
      new Request(`${origin}/api/jobs/${job}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    if (!response.ok) await recordCronFailure(env, failedAction, job, { status: response.status });
  } catch (cause) {
    await recordCronFailure(env, failedAction, job, failureDetails(cause));
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);

    // First of all, on the URL exactly as it arrived: www.radar.cheap to the apex, then plain http
    // to https. 301 for a GET or HEAD; 308 for anything else, which a browser must repeat with the
    // same method and body rather than turn into a GET.
    const redirect = wwwRedirectFor(url) ?? httpsRedirectFor(url);
    if (redirect) {
      const safe = request.method === "GET" || request.method === "HEAD";
      const headers = new Headers({ Location: redirect });
      // Only www's redirect is ever sent over https, and it is the one https response that never
      // passes through withSecurityHeaders or public/_headers, so it carries the policy itself.
      if (url.protocol === "https:") headers.set("Strict-Transport-Security", HSTS);
      return new Response(null, { status: safe ? 301 : 308, headers });
    }

    // Then a file at the top of dist/client, which only reaches this Worker so that the scheme and
    // the name could be put right above (TOP_LEVEL_FILES). Ahead of the admission gate, like a baked
    // deal page or a cache hit: a file costs a call to the asset binding, not a render, and turning
    // one away for concurrency would refuse the cheapest request there is - robots.txt among them,
    // which a crawler stops crawling over. Nothing between here and the gate could change the
    // answer: the affiliate rewrite leaves any path with a file extension alone (affiliatePathFor),
    // and no file is named like an internal cache key.
    const file = await topLevelFile(request, env, url);
    if (file) return file;

    // security.txt (RFC 9116): where to report a vulnerability. Written here rather than kept as a
    // file because its Expires has to stay in the future, under a year out, and a file would quietly
    // lapse; this one always says six months from today.
    if (url.pathname === "/.well-known/security.txt" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : securityTxt(url), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      });
    }

    // A deal's share card (scripts/deal-og.mjs), a file the deploy writes, for the same reason every
    // other file is routed here (run_worker_first): so plain http and www are put right first. The
    // file is handed back as it is. A card that is not there is a deal published since the last
    // deploy, or one the generator skipped, and the site's own image stands in for it until the next
    // deploy rather than a broken preview - short-lived, so the card is picked up once it exists.
    if (url.pathname.startsWith("/og/deals/") && (request.method === "GET" || request.method === "HEAD")) {
      const card = env.ASSETS ? await env.ASSETS.fetch(new Request(`${url.origin}${url.pathname}`, { method: request.method })) : null;
      if (card && card.status === 200) return card;
      await card?.body?.cancel();
      return withSecurityHeaders(new Response(null, { status: 302, headers: { Location: "/og.png", "Cache-Control": "public, max-age=3600" } }), url);
    }

    // Then the addresses only a scanner asks for - /wp-login.php, /.env, /xmlrpc.php - with a small
    // static 404 in the address's language (worker/probe-paths.ts), on the address as it arrived. Each
    // used to be a full render of the not-found page, and a scanner asks for hundreds at a time: ahead
    // of the admission gate, so a burst of them neither costs a render nor holds a slot a reader is
    // waiting for.
    if (isProbePath(url.pathname)) return withSecurityHeaders(probeNotFoundResponse(request, url), url);

    // The two requests a page of deals makes most, answered here when the answer is already known:
    // a stored photo (worker/stored-photo.ts) and a deals answer the colo already holds
    // (sharedDealsAnswer). Neither needs the app, and reaching it through the framework's router
    // cost more CPU than either answer does. Ahead of the admission gate for the reason a baked page
    // is: turning away the cheapest requests protects nothing.
    const photo = await storedPhoto(request, url, env.PHOTOS, edgeCache(), (promise) => ctx.waitUntil(promise));
    if (photo) return withSecurityHeaders(photo, url);
    const sharedAnswer = await sharedDealsAnswer(request, env, ctx, url);
    if (sharedAnswer) return withSecurityHeaders(sharedAnswer, url);

    // Ahead of everything, so the cache key, the prerender lookup and the renderer all see the
    // path the app actually routes on. Rewritten rather than redirected: the visitor stays on
    // affiliate.radar.cheap, which is the whole point of having the name.
    const affiliatePath = affiliatePathFor(url);
    if (affiliatePath) {
      url = new URL(url.toString());
      url.pathname = affiliatePath;
      request = new Request(url.toString(), request);
    }

    // With the query exactly as it was sent, so the address bar ends up with everything it started
    // with, campaign tags and click ids included.
    const canonical = await canonicalDealRedirect(request, env, url);
    if (canonical) return withSecurityHeaders(canonical, url);

    // Ahead of the page cache below, so that a request naming a cache key can never be the thing
    // that looks one up. Moved under the default locale, where it is just another path no route
    // claims (app/[locale]/[...rest]), and so renders the site's own not-found page; it is never
    // looked up in the bake or the page cache, and its 404 is never stored. Without a trailing
    // slash, which the framework would otherwise answer with a 308 naming the rewritten path.
    let internal = false;
    if (INTERNAL_CACHE_PATH.test(url.pathname)) {
      internal = true;
      url = new URL(url.toString());
      url.pathname = `/en${url.pathname.replace(/\/+$/, "")}`;
      request = new Request(url.toString(), request);
    }

    // A signed-out reader's dashboard link is a redirect to sign-in, answered here; see
    // signedOutDashboardRedirect.
    const signIn = signedOutDashboardRedirect(request, url);
    if (signIn) return withSecurityHeaders(signIn, url);

    // Deliberately ahead of the admission gate: neither a baked file nor a cache hit costs
    // meaningful CPU, so refusing one for concurrency would be turning away the cheap requests to
    // protect capacity that only the expensive ones consume. The baked file first, then the colo's
    // copy, both found under the request's path alone (pageLookup).
    const lookup = internal ? null : pageLookup(request, url);
    // Whether the request is answered with the page every reader of its address gets. A signed-in
    // reader of a page that reads nothing of them is (pageLookup): the shared copy with the mark
    // added (signedInCopy), and on a miss a render made as a signed-out reader's, which is stored
    // for everyone and handed to them marked.
    const impersonal = lookup !== null;
    const shared = (page: Response) => (lookup?.signedIn ? signedInCopy(page) : page);
    if (lookup) {
      const prerendered = await prerenderedPage(request, env, lookup.url);
      if (prerendered) return withSecurityHeaders(await shared(prerendered), url);
    }
    const cache = edgeCache();
    const cacheKey = cache && lookup ? cacheKeyFor(lookup.url, env, request) : null;
    // A copy too old to serve while a render can replace it, held for the case where the render
    // cannot (answerWithoutRender).
    let staleHit: Response | undefined;
    if (cache && cacheKey && lookup) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const age = Date.now() - Number(hit.headers.get(CACHED_AT_HEADER) || 0);
        if (hit.status === 404) {
          // A not-found page is served for its hour and then rendered again, never refreshed.
          if (age < NOT_FOUND_KEEP_MS) return withSecurityHeaders(await shared(fromCache(hit, request)), url);
          await hit.body?.cancel().catch(() => {});
        } else if (age < EDGE_CACHE_MAX_STALE_MS) {
          if (age >= EDGE_CACHE_FRESH_MS) refreshInBackground(request, env, ctx, lookup.url, cache, cacheKey, hit);
          return withSecurityHeaders(await shared(fromCache(hit, request)), url);
        } else {
          staleHit = hit;
        }
      }
    }

    const requestId = admission.admit(Date.now());
    if (requestId === null) {
      // A page navigation used to be shown this refusal as raw English JSON, in /fr and /es too. A
      // browser loading a page now gets a small page in the path's language that retries by itself;
      // everything else still gets the JSON error it has always had.
      await staleHit?.body?.cancel().catch(() => {});
      return withSecurityHeaders(unavailableResponse(request, url, "overloaded"), url);
    }
    const heartbeat = keepAlive(requestId);
    try {
      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
        const imageResponse = await handleImageOptimization(request, {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        }, allowedWidths);
        return withSecurityHeaders(imageResponse,url);
      }

      // See "The render watchdog" above. Returning from here, timed out or not, runs the finally
      // below, which is what gives the admission slot back.
      //
      // A request whose query holds only parameters its route's server render ignores is rendered as
      // the bare address it was looked up under (pageLookup): one render, which answers it and is
      // what is stored for the next reader (see SERVER_READ_PARAMS). From here on `request` is that
      // bare request, with this one's method and headers; `url` is still the address as it was sent.
      if (lookup && !lookup.bare) request = new Request(lookup.url.toString(), request);
      // A signed-in reader's miss is rendered as a signed-out reader's: the copy is for everyone,
      // and RootShell would mark and personalize a render that saw the session cookie.
      if (lookup?.signedIn) request = new Request(request, { headers: signedOutHeaders(request.headers) });
      const deadline = renderDeadlineMs(Date.now(), env.RENDER_DEADLINE_MS);
      let outcome = isWatchedRender(request, url)
        ? await withinDeadline(renderPage(request, env, ctx), deadline)
        : await renderPage(request, env, ctx);
      if (outcome === RENDER_TIMED_OUT) {
        return await answerWithoutRender(request, env, url, cache, cacheKey, staleHit, impersonal, deadline, lookup?.signedIn ?? false);
      }
      if (lookup && !lookup.bare) outcome = withQueryCarried(outcome, url.search);
      const response = outcome;
      await staleHit?.body?.cancel().catch(() => {});
      // A copy too old to serve is still the watchdog's fallback for as long as the cache keeps it,
      // so a deal withdrawn since it was stored takes it with it (isWithdrawnDealPage). A HEAD
      // changes nothing.
      if (staleHit && cache && cacheKey && request.method === "GET" && isWithdrawnDealPage(response, url)) {
        ctx.waitUntil(cache.delete(cacheKey).catch(() => {}));
      }
      // Stored from a clone so the visitor's copy streams out without waiting on the write, and
      // after the security headers have been decided rather than before — those are applied on
      // the way out of every response, hit or miss, so a change to them takes effect immediately
      // instead of waiting for entries cached under the old policy to age out.
      //
      // Only a GET is stored, and only ever a render of the bare address, so a stored copy's
      // navigation echo is always empty. A HEAD stores nothing.
      const storable = impersonal && isStorable(response, url);
      if (cache && cacheKey && lookup && storable && request.method === "GET") {
        ctx.waitUntil(storePage(cache, cacheKey, response.clone(), lookup.url).catch(() => {}));
      }
      // The same page a later cache hit or the prerendered file would be, so it is sent the same way.
      return withSecurityHeaders(await shared(storable ? impersonalPage(response) : response), url);
    } finally {
      clearInterval(heartbeat);
      admission.release(requestId);
    }
  },

  // Retires deals whose expires_at passed more than EXPIRY_GRACE_PERIOD_DAYS
  // ago: flips them from live to expired/inactive so they drop out of public
  // search and land in the admin "Deals ended" tab. Deals with no expires_at
  // (e.g. recurring happy-hour listings) are never touched by this query.
  //
  // Every step below is isolated from the others: a failure is recorded in audit_log and the hour
  // moves on to the next step. The first two used not to be — a transient D1 error in the expiry
  // UPDATE rejected scheduled() before geocoding, billing, digests or translation had run, so one
  // hiccup skipped every job that hour.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const result = await env.DB.prepare(expireDealsStatement).run();
      const changed = result.meta.changes || 0;
      if (changed) {
        await env.DB.prepare(
          "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES('system:cron','system','deals_expired','deal','bulk',?)",
        ).bind(JSON.stringify({ count: changed })).run();
      }
    } catch (cause) {
      await recordCronFailure(env, "deal_expiry_failed", "expire-deals", failureDetails(cause));
    }

    // Affiliate commissions that have sat out their holding period become payable. Run here
    // rather than derived on read, so `approved_at` is a date somebody can point at — see
    // MATURE_COMMISSIONS_SQL, whose text this shares with app/affiliate-payouts.ts so there is
    // one definition of when money becomes payable.
    //
    // Plain SQL against env.DB, exactly like expireDealsStatement above, rather than a job route:
    // it needs no secret, calls nothing external, and cannot half-fail. Importing the payout
    // engine instead would pull Stripe into the Worker entry for one UPDATE.
    try {
      const matured = await env.DB.prepare(MATURE_COMMISSIONS_SQL).bind(holdCutoffModifier()).run();
      if (matured.meta.changes) {
        await env.DB.prepare(
          "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES('system:cron','system','affiliate_commissions_matured','creator_commission','bulk',?)",
        ).bind(JSON.stringify({ count: matured.meta.changes })).run();
      }
    } catch (cause) {
      await recordCronFailure(env, "commission_maturing_failed", "mature-commissions", failureDetails(cause));
    }

    // Rate-limit windows that have closed. app/api-utils.ts keys a row per caller per window, and
    // nothing else ever deletes one, so the table grew by a row for every address that touched a
    // limited route in every window, forever. A day is far past the longest window (an hour).
    try {
      await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(new Date(Date.now() - 86_400_000).toISOString()).run();
    } catch (cause) {
      await recordCronFailure(env, "rate_limit_sweep_failed", "sweep-rate-limits", failureDetails(cause));
    }

    // Personal data past its retention period (app/retention.ts), once a day. Audited with counts
    // so the published retention schedule can be shown to be running, not just written down.
    if (isRetentionHour(new Date(event?.scheduledTime ?? Date.now()))) {
      try {
        const removed = await sweepRetention(env.DB);
        if (Object.values(removed).some(Boolean)) {
          await env.DB.prepare(
            "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES('system:cron','system','retention_sweep','personal_data','bulk',?)",
          ).bind(JSON.stringify(removed)).run();
        }
      } catch (cause) {
        await recordCronFailure(env, "retention_sweep_failed", "sweep-retention", failureDetails(cause));
      }
    }

    // Staff reminders to renew or confirm deals (app/staff-reminders.ts): cleared every hour once the
    // deal has moved on, opened once a day on the noon tick in New York. After expiry above, so a
    // deal retired this hour clears its reminder this hour rather than the next.
    try {
      const swept = await sweepStaffReminders(env.DB, new Date(event?.scheduledTime ?? Date.now()));
      if (swept.opened) {
        await env.DB.prepare(
          "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES('system:cron','system','staff_reminders_opened','staff_reminder','bulk',?)",
        ).bind(JSON.stringify(swept)).run();
      }
    } catch (cause) {
      await recordCronFailure(env, "staff_reminders_failed", "staff-reminders", failureDetails(cause));
    }

    // IndexNow (app/indexnow.ts): the deal pages that changed in the hour before this tick -
    // published, edited, checked, retired or deleted - submitted once, so Bing recrawls them now
    // rather than whenever it next gets round to them. The previous whole hour rather than "since the
    // last run", which needs no stored cursor and submits each change exactly once; a deal expired by
    // the step above, this tick, goes out on the next one. Production only, so a local run or a test
    // never submits radar.cheap's pages. Best-effort: a refusal is recorded, never retried.
    if (indexNowEnabled(env.PUBLIC_APP_URL)) {
      try {
        const hour = Math.floor((event?.scheduledTime ?? Date.now()) / 3_600_000) * 3_600_000;
        const { results } = await env.DB.prepare(CHANGED_DEAL_PAGES_SQL)
          .bind(new Date(hour - 3_600_000).toISOString(), new Date(hour).toISOString())
          .all<ChangedDealRow>();
        const status = await submitToIndexNow(dealPageUrls(results || []));
        if (status !== null && status !== 200 && status !== 202) {
          await recordCronFailure(env, "indexnow_failed", "indexnow", { status });
        }
      } catch (cause) {
        await recordCronFailure(env, "indexnow_failed", "indexnow", failureDetails(cause));
      }
    }

    const origin = env.PUBLIC_APP_URL || "https://radar.cheap";

    // Tracked-area geocoding. Deliberately ahead of the digest step, which returns early when
    // EMAIL_JOB_SECRET is unset — this job's output is what makes the digest's distance matching
    // work, so it must not be gated behind the digest's configuration.
    if (env.GEOCODE_JOB_SECRET) await runCronJob(env, ctx, origin, env.GEOCODE_JOB_SECRET, "geocode", "geocode_job_failed");

    // Subscription lifecycle: cancel anything past its payment grace period, resume pauses Stripe
    // should have ended, send win-backs. Ahead of the digest because the first of those decides who
    // still has Pro, and a person canceled an hour late is an hour of access nobody paid for.
    if (env.BILLING_JOB_SECRET) await runCronJob(env, ctx, origin, env.BILLING_JOB_SECRET, "billing", "billing_job_failed");

    // Deal roundups. Routed through the worker's own handler rather than a network call so the
    // job keeps its existing auth check, its hour-precision duplicate-run guard, and its
    // per-recipient timezone matching — this is just the trigger the cron never had.
    // Without EMAIL_JOB_SECRET set there is nothing to authenticate with, so skip quietly;
    // the job's own gates decide whether anything actually sends. Skipped with an `if`, not an
    // early `return` — a missing email secret used to take the translation job below down with it.
    if (env.EMAIL_JOB_SECRET) await runCronJob(env, ctx, origin, env.EMAIL_JOB_SECRET, "digests", "digest_job_failed");

    // The daily rebuild. Deal pages are prerendered at deploy, so a price fixed in admin reaches
    // its static page only on the next deploy, and a Worker cannot redeploy itself. Deploys run on
    // Cloudflare Workers Builds (docs/DEPLOY.md), which a deploy hook can start: once a day, at
    // DAILY_REBUILD_HOUR_UTC, this asks for one. Without DEPLOY_HOOK_URL set it is skipped.
    if (env.DEPLOY_HOOK_URL && isDailyRebuildHour(new Date(event?.scheduledTime ?? Date.now()))) {
      try {
        const response = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
        if (!response.ok) await recordCronFailure(env, "daily_rebuild_failed", "deploy-hook", { status: response.status });
      } catch (cause) {
        await recordCronFailure(env, "daily_rebuild_failed", "deploy-hook", failureDetails(cause));
      }
    }

    // Deal translation (fr/es). Same self-fetch/auth/dedup pattern as the digest job above —
    // without TRANSLATE_JOB_SECRET set there's no DeepL rollout yet, so skip quietly.
    if (env.TRANSLATE_JOB_SECRET) await runCronJob(env, ctx, origin, env.TRANSLATE_JOB_SECRET, "translate", "translate_job_failed");
  },
};

export default worker;
