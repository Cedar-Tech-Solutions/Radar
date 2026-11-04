import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync,readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Pro page reaches Stripe's configuration through cloudflare:workers, which plain Node cannot
// resolve; an empty env stands in for it here, so the page renders without prices.
const ALIAS = `data:text/javascript,${encodeURIComponent(`
export const env = new Proxy({}, { get: (_target, key) => globalThis.__TEST_ENV__?.[key] });
export const waitUntil = (promise) => { if (promise && typeof promise.catch === "function") promise.catch(() => {}); };
`)}`;
registerHooks({
  resolve(specifier,context,nextResolve) {
    if (specifier === "cloudflare:workers") return { url:ALIAS,shortCircuit:true };
    return nextResolve(specifier,context);
  },
});

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js",import.meta.url);
  workerUrl.searchParams.set("test",`${process.pid}-${Date.now()}-${Math.random()}`);
  const { default:worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`,{ headers:{ accept:"text/html" } }),{ ASSETS:{ fetch:async () => new Response("Not found",{ status:404 }) } },{ waitUntil(){},passThroughOnException(){} });
}

test("renders the Radar discovery experience and metadata",async () => {
  const response = await render("/en");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("x-content-type-options"),"nosniff");
  assert.match(response.headers.get("content-security-policy") || "",/frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html,/<title>Radar — Nearby restaurant deals &amp; happy hours<\/title>/i);
  assert.match(html,/on your Radar\./);
  assert.match(html,/Restaurant, dish, drink, or deal/);
  // The count arrives with the first deals response; until then the badge says what Radar is
  // rather than printing a stand-in number that is ten times too small.
  assert.match(html,/Restaurant deals, deepest in Ottawa/);
  assert.doesNotMatch(html,/\d+ restaurants? · \d+ cit(y|ies)/);
  assert.doesNotMatch(html,/codex-preview|Your site is taking shape|Building your site/i);
});

test("renders public legal pages",async () => {
  for (const path of ["/en/privacy","/en/terms"]) {
    const response = await render(path);
    assert.equal(response.status,200);
    const html = await response.text();
    assert.match(html,/Radar/i);
    assert.match(html,path === "/en/privacy" ? /Privacy Policy/i : /Terms of Service/i);
  }
});

test("renders the restaurant submission proposition",async () => {
  const response = await render("/en/for-restaurants");
  assert.equal(response.status,200);
  const html = await response.text();
  assert.match(html,/Reach nearby diners/);
  assert.match(html,/Submit for verification/);
});

// A path under a locale that no route claims used to get the framework's own answer: nine bytes of
// plain text, "Not Found", with none of the site around it. It is the locale's not-found page now
// (app/[locale]/[...rest]), with the header and footer, in the reader's language.
test("an unknown path under a locale is the site's own not-found page, in that language",async () => {
  for (const [path,heading,home] of [
    ["/en/no/such/page","This page wandered off.",'href="/en"'],
    ["/fr/aucune-page","Cette page s&#x27;est égarée.",'href="/fr"'],
    ["/es/ninguna-pagina","Esta página se perdió.",'href="/es"'],
  ]) {
    const response = await render(path);
    assert.equal(response.status,404,path);
    assert.match(response.headers.get("content-type") || "",/text\/html/);
    const html = await response.text();
    assert.ok(html.includes(heading),`${path} speaks its locale`);
    assert.ok(html.includes(home),`${path} leads back to its own locale's deals`);
    assert.match(html,/class="site-footer/,`${path} keeps the site's footer`);
    assert.match(html,/noindex/);
    // One robots tag. The page's own metadata used to add "noindex, nofollow" beside the
    // framework's "noindex", two tags that disagreed.
    assert.equal((html.match(/<meta name="robots"/g) || []).length,1,`${path} has one robots tag`);
  }
});

// The framework streams page metadata into a hidden div after </head> unless it is told not to,
// and it is only ever told per user agent. The prerendered deal pages and the colo cache stored
// that variant for every reader - Googlebot included, and it honors a canonical only in <head>.
// next.config.ts makes metadata blocking for every agent, and worker/index.ts gives a request with
// no User-Agent (this one, and the prerender's) one to be matched by.
test("title, description, canonical and hreflang are in <head>, and in the page's language",async () => {
  for (const [path,title] of [
    ["/en","Radar — Nearby restaurant deals &amp; happy hours"],
    ["/fr","Radar — Offres de restaurants et 5 à 7 près de chez vous"],
    ["/es","Radar — Ofertas de restaurantes y horas felices cerca de ti"],
  ]) {
    const html = await (await render(path)).text();
    const head = html.slice(0,html.indexOf("</head>"));
    assert.ok(head.includes(`<title>${title}</title>`),`${path}: its own title, in <head>`);
    assert.match(head,new RegExp(`<link rel="canonical" href="http://localhost:3000${path}"/>`),`${path}: canonical in <head>`);
    assert.match(head,/hrefLang="x-default" href="http:\/\/localhost:3000\/en"/);
    assert.match(head,new RegExp(`<meta property="og:url" content="http://localhost:3000${path}"/>`),`${path}: previews as itself, not the bare domain`);
    assert.doesNotMatch(html,/<div hidden id="S:0">/);
  }
});

// A path the locale layout rejects renders the same page with no layout around it, and so with no
// messages from the layout. It has to stay a 404 rather than become a crash in the header.
// (/wp-login.php used to be the example; the Worker answers that one itself now, below.)
test("a path the locale layout rejects is still a 404",async () => {
  const response = await render("/humans.txt");
  assert.equal(response.status,404);
  assert.match(await response.text(),/This page wandered off\./);
});

// A scanner's address never reaches the renderer: the Worker answers it with a small static 404 in
// the address's language (worker/probe-paths.ts).
test("a scanner's address is a small 404 from the Worker, in the address's language",async () => {
  for (const [path,lang,heading] of [["/wp-login.php","en","There is nothing here."],["/fr/wp-admin","fr","Il n'y a rien ici."],["/es/.env","es","Aquí no hay nada."]]) {
    const response = await render(path);
    assert.equal(response.status,404,path);
    const html = await response.text();
    assert.ok(html.includes(`<html lang="${lang}">`),path);
    assert.ok(html.includes(heading),`${path}: ${heading}`);
    assert.match(html,/<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html,/<script/,"no framework, no script");
    assert.equal(response.headers.get("x-content-type-options"),"nosniff","still under the security headers");
  }
});

// The page a reader gets for an address whose query string its server render ignores is the bare
// address's page (SERVER_READ_PARAMS in worker/index.ts): the Worker answers both from one baked
// file, one colo copy or one render of the bare address. That is only honest while the two renders are the same page, so here both
// are rendered and compared - after removing the one place vinext writes the address it rendered:
// the navigation echo in the bootstrap script, and, for a page that is itself a client component
// (sign-in, sign-up), the searchParams prop it is handed as a flight row and never reads.
const ECHO = /nav:\{"pathname":"(?:[^"\\]|\\.)*","searchParams":\[(?:\["(?:[^"\\]|\\.)*","(?:[^"\\]|\\.)*"\],?)*\]\}/g;
function withoutAddressEcho(html) {
  let out = html.replace(ECHO,"nav:{}");
  const row = /\\"searchParams\\":\\"\$@([0-9a-z]+)\\"/.exec(out);
  if (row) out = out.replace(new RegExp(`rsc\\.push\\("${row[1]}:(?:[^"\\\\]|\\\\.)*"\\)`),`rsc.push("${row[1]}:<searchParams>")`);
  return out;
}

let shared;
async function renderShared(path,headers = {}) {
  if (!shared) {
    const workerUrl = new URL("../dist/server/index.js",import.meta.url);
    workerUrl.searchParams.set("test",`${process.pid}-shared`);
    shared = (await import(workerUrl.href)).default;
  }
  return shared.fetch(new Request(`http://localhost${path}`,{ headers:{ accept:"text/html",...headers } }),{ ASSETS:{ fetch:async () => new Response("Not found",{ status:404 }) } },{ waitUntil(){},passThroughOnException(){} });
}

// The Worker itself now renders such a request as its bare address (one render, which answers the
// reader and is stored), so asked through it the two would be the same render and this would compare
// nothing. The noisy one carries a cookie whose name merely contains "__session=", which the Worker's
// signed-in check (isSignedIn) takes for a session and so renders the address as it came, and which
// nothing in a render reads (REQUEST_READS in tests/route-params.test.mjs lists the cookies that are).
// A page that reads nothing of its reader (USER_BLIND_ROUTES in worker/index.ts) is rendered without
// the cookie and marked for the signed-in reader afterwards; the mark is the one difference meant,
// and is taken off before the two are compared.
const RENDER_AS_SENT = { cookie:"x__session=1" };
const withoutSignedInMark = (html) => html.replace('<html data-signed-in=""','<html');

// The sign-in pages render only in a build that carries Clerk's publishable key, as CI's and every
// deploy's does: without one, <SignIn/> has no provider and throws. A build made without the key (a
// fresh worktree, say) skips them rather than failing on something this test is not about.
function buildHasClerkKey() {
  const root = fileURLToPath(new URL("../dist/server/",import.meta.url));
  const walk = (dir) => readdirSync(dir,{ withFileTypes:true }).some((entry) => entry.isDirectory()
    ? walk(path.join(dir,entry.name))
    : entry.name.endsWith(".js") && /pk_(?:live|test)_[A-Za-z0-9]/.test(readFileSync(path.join(dir,entry.name),"utf8")));
  return walk(root);
}

test("a page asked for with parameters its server render ignores is the bare page",async (t) => {
  const shells = buildHasClerkKey() ? ["/en/sign-in","/es/sign-up"] : [];
  if (!shells.length) t.diagnostic("this build has no Clerk publishable key, so the sign-in pages are not compared");
  for (const path of ["/en","/fr","/es/terms","/en/privacy","/fr/support","/en/age-suitability","/es/for-restaurants","/en/for-creators","/fr/pro",...shells]) {
    const bare = await renderShared(path);
    const noisy = await renderShared(`${path}?v=1&country=CA&c=x&utm_source=y&q=z&redirect_url=%2Fdashboard`,RENDER_AS_SENT);
    assert.equal(bare.status,200,path);
    assert.equal(noisy.status,200,path);
    const [bareHtml,noisyHtml] = [await bare.text(),await noisy.text()];
    assert.notEqual(noisyHtml,bareHtml,`${path}: the echo should differ, or this compares nothing`);
    assert.equal(withoutAddressEcho(withoutSignedInMark(noisyHtml)),withoutAddressEcho(bareHtml),`${path} rendered differently for a query its server render should ignore`);
  }
});
