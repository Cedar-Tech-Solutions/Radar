// The render watchdog, and the page a visitor gets when the Worker cannot answer.
//
// Kept apart from worker/index.ts, and free of imports, so tests can load it on its own: the entry
// imports vinext's handler and Cloudflare-only modules, which plain Node cannot. worker/index.ts
// says where each of these is used and why.

// How long a page render may take to produce its response headers before the visitor is given
// something else instead. A healthy render answers in well under a second, even on a cold isolate
// with a cold D1; eight seconds is far past anything that is merely slow, and still short of the
// point where a browser or a crawler has given up on its own.
export const RENDER_DEADLINE_MS = 8_000;

// The deadline while this isolate has recently missed the one above. An isolate that has wedged
// does not come back by itself: every later render of the same route awaits the same load that
// never finishes (see worker/index.ts). Holding each visitor for the full eight seconds before
// telling them so turns one stuck isolate into a queue of people staring at a blank tab. Short
// enough that a wedged isolate answers quickly, long enough that a render on an isolate that has
// recovered still gets through, so the isolate can show it has recovered.
export const WEDGED_RENDER_DEADLINE_MS = 1_500;

// How long one missed deadline keeps the short one in force. Each further miss restarts it, so an
// isolate that stays wedged stays on the short deadline, and one that recovers leaves it within a
// minute of its last miss.
export const WEDGED_WINDOW_MS = 60_000;

export const RENDER_TIMED_OUT: unique symbol = Symbol("render timed out");

// Module state, so per isolate: a new isolate starts with a clean record, which is right, since a
// new isolate has none of the stuck loads the record is about.
let lastTimeoutAt = Number.NEGATIVE_INFINITY;
let timeouts = 0;

export function noteRenderTimeout(now: number): void {
  lastTimeoutAt = now;
  timeouts += 1;
}

export function renderTimeoutCount(): number {
  return timeouts;
}

/**
 * The deadline for a render starting now.
 *
 * `override` is the RENDER_DEADLINE_MS var, which production never sets. It exists for the two
 * callers that are not a visitor: tests, which need the watchdog to fire in milliseconds rather
 * than seconds, and scripts/prerender-deals.mjs, which renders every deal page in plain Node at
 * deploy time and must never have a slow page cut short — a cut there would fail the deploy.
 */
export function renderDeadlineMs(now: number, override?: string): number {
  const configured = Number(override);
  const base = Number.isFinite(configured) && configured > 0 ? configured : RENDER_DEADLINE_MS;
  return now - lastTimeoutAt < WEDGED_WINDOW_MS ? Math.min(base, WEDGED_RENDER_DEADLINE_MS) : base;
}

/**
 * Resolves with the render's response, or with RENDER_TIMED_OUT if it has not produced one within
 * `ms`.
 *
 * The render is not canceled — nothing can cancel it — but it is no longer waited on. If it does
 * produce a response later, nobody is going to read that response's body, so it is released
 * rather than left holding a stream open. A rejection before the deadline propagates exactly as it
 * would have without the watchdog.
 */
export async function withinDeadline<T extends Response | null>(render: Promise<T>, ms: number): Promise<T | typeof RENDER_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof RENDER_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(RENDER_TIMED_OUT), ms);
  });
  try {
    const winner = await Promise.race([render, deadline]);
    if (winner === RENDER_TIMED_OUT) {
      render.then((late) => late?.body?.cancel().catch(() => {}), () => {});
    }
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A browser loading a page, as opposed to anything that reads the body as data.
 *
 * vinext marks a client-side navigation's flight request with an `RSC: 1` header or a `.rsc`
 * suffix; the router state header travels with it. Those are fetched by the page's own script,
 * which expects JSON-shaped failure, not a document.
 */
export function isDocumentRequest(request: Request, url: URL): boolean {
  if (request.headers.get("RSC") === "1" || request.headers.has("Next-Router-State-Tree")) return false;
  if (url.pathname.endsWith(".rsc")) return false;
  return (request.headers.get("accept") || "").includes("text/html");
}

export type Unavailable = "overloaded" | "timeout";

// Inline, not from messages/*.json: the Worker entry deliberately keeps next-intl and the
// catalogues out of itself (see CACHEABLE_LOCALES in worker/index.ts), and this page has to render
// precisely when the app's own rendering is the thing that is not working.
const COPY = {
  en: {
    title: "Radar is busy",
    heading: "This page didn't load",
    overloaded: "Radar is getting more requests than it can handle this second.",
    timeout: "The page took too long to load.",
    retry: "It will try again by itself in a few seconds.",
    action: "Try again now",
  },
  fr: {
    title: "Radar est très sollicité",
    heading: "Cette page ne s'est pas chargée",
    overloaded: "Radar reçoit plus de demandes qu'il ne peut en traiter en ce moment.",
    timeout: "La page a mis trop de temps à se charger.",
    retry: "Elle va se recharger d'elle-même dans quelques secondes.",
    action: "Réessayer maintenant",
  },
  es: {
    title: "Radar está saturado",
    heading: "Esta página no se cargó",
    overloaded: "Radar está recibiendo más solicitudes de las que puede atender en este momento.",
    timeout: "La página tardó demasiado en cargar.",
    retry: "Se volverá a cargar sola en unos segundos.",
    action: "Intentar de nuevo",
  },
} as const;

type Lang = keyof typeof COPY;

// The JSON bodies keep the shape and the English message /api clients already handle; the mobile
// app reads `error.code`, and OVERLOADED is the code it has always seen.
const JSON_BODY: Record<Unavailable, { code: string; message: string }> = {
  overloaded: { code: "OVERLOADED", message: "We're seeing unusually high traffic right now — please try again in a few seconds." },
  timeout: { code: "RENDER_TIMEOUT", message: "This page took too long to load. Please try again in a few seconds." },
};

// Seconds. The overload clears as soon as the requests ahead of this one finish; a render that
// missed its deadline is a sign of an isolate in trouble, and asking again at once mostly lands on
// the same isolate.
const RETRY_AFTER: Record<Unavailable, number> = { overloaded: 2, timeout: 5 };

function pageLanguage(url: URL): Lang {
  const segment = url.pathname.split("/").filter(Boolean)[0];
  return segment === "fr" || segment === "es" ? segment : "en";
}

/**
 * The 503 for a request the Worker is not going to answer properly: a small, self-contained page
 * for a browser, and the JSON error for everything else.
 *
 * The page has no script, no stylesheet and no image — each would be one more request to a Worker
 * that is already failing to answer — and it reloads itself with a meta refresh, which the CSP does
 * not govern. It is never stored: `no-store` keeps it out of the colo cache, the browser's cache and
 * the service worker's (public/sw.js stores nothing that is not a 200 either).
 */
export function unavailableResponse(request: Request, url: URL, reason: Unavailable): Response {
  const headers = new Headers({ "Retry-After": String(RETRY_AFTER[reason]), "Cache-Control": "no-store" });
  if (!isDocumentRequest(request, url)) {
    return Response.json({ error: JSON_BODY[reason] }, { status: 503, headers });
  }
  const lang = pageLanguage(url);
  const copy = COPY[lang];
  headers.set("Content-Type", "text/html; charset=utf-8");
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="5">
<title>${copy.title}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070707;color:#f5f5f5;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;padding:24px 16px}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 .75rem}
p{margin:0 0 .75rem;color:#c9c9c9}
a{color:#ff6f4a;font-weight:600}
</style>
</head>
<body>
<main>
<h1>${copy.heading}</h1>
<p>${copy[reason]} ${copy.retry}</p>
<p><a href="">${copy.action}</a></p>
</main>
</body>
</html>
`;
  return new Response(html, { status: 503, headers });
}
