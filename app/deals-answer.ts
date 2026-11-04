// Whole /api/deals answers, shared by everyone in a colo.
//
// Everything below the snapshot runs per request: every deal in the catalog is scored, placed and
// grouped to answer each one, a real share of the CPU allowance even on a warm isolate, and a
// cold one parses the snapshot first. Most requests are not unique - the homepage's first load,
// the nationwide list for a state, a city someone picked - so the first reader in a colo pays and
// the rest are handed the same bytes, without the snapshot being touched at all.
//
// Only for a request nobody is signed in to. A signed-in reader's hidden restaurants shape their
// answer, and getAppUser reads exactly these two places to find one.
//
// Its own module, importing nothing but one function of app/search.ts, because two places ask the
// same question: the route (app/api/deals/route.ts), which writes the shared copy and reads it when
// it is asked directly, and the Worker's entry (worker/index.ts), which reads it ahead of the
// framework, so a shared answer costs a cache lookup and not a trip through the router as well.
// Both must build the same key, so there is one copy of how.
import { kmBetween } from "./search";

export const ANSWER_CACHE_VERSION = 1;
// The search event a cached answer stands for, so a search answered from the cache is still counted.
export const SEARCH_EVENT_HEADER = "x-radar-search-event";
// What an anonymous reader's browser is told, whichever path answered.
export const ANONYMOUS_ANSWER_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/**
 * Cloudflare's reading of the visitor's address: a country and a zone. A tiebreak for a point near
 * the border and a fallback for the clock, never a location of its own - it is the network's
 * location, and a phone roaming on a home carrier reads as home.
 */
export type Network = { country: string | null; timezone: string | null; region: string | null; point: { latitude: number; longitude: number } | null };

// What Cloudflare knows of the visitor's network. The headers are the same facts as Cloudflare's
// "visitor location headers" name them, for a request that did not come through the edge.
export function networkOf(request: Request): Network {
  const cf = (request as Request & { cf?: { country?: unknown; timezone?: unknown; regionCode?: unknown; latitude?: unknown; longitude?: unknown } }).cf;
  const text = (value: unknown, header: string) => (typeof value === "string" ? value : request.headers.get(header)) || null;
  const country = text(cf?.country, "cf-ipcountry"), region = text(cf?.regionCode, "cf-region-code");
  const latitude = Number(text(cf?.latitude, "cf-iplatitude") ?? NaN), longitude = Number(text(cf?.longitude, "cf-iplongitude") ?? NaN);
  return {
    country: country ? country.toUpperCase() : null,
    timezone: typeof cf?.timezone === "string" ? cf.timezone : null,
    region: region ? region.toUpperCase() : null,
    point: Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null,
  };
}

// How far the network may place a visitor from their device's point and still be believed about
// which state or province they are in. See networkRegionAt in the route.
export const NETWORK_REGION_KM = 150;

// Each zone's answer, kept. Finding out builds a DateTimeFormat, which loads ICU's data for the zone,
// and every located phone request sends one: 0.09 ms of each locally, for the same few dozen zones
// the readers are in. A runtime knows a zone or does not, so the answer cannot go stale; the bound
// is only for a client sending nonsense that happens to be shaped like a zone.
const KNOWN_TIMEZONES = new Map<string, string | null>();
const KNOWN_TIMEZONES_MAX = 256;

/** An IANA zone this runtime knows, or null. Checked before anything formats a date in it: an unknown zone throws. */
export function knownTimezone(value: string | null): string | null {
  if (!value || value.length > 64 || !/^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/.test(value)) return null;
  const known = KNOWN_TIMEZONES.get(value);
  if (known !== undefined) return known;
  let answer: string | null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    answer = value;
  } catch {
    answer = null;
  }
  if (KNOWN_TIMEZONES.size >= KNOWN_TIMEZONES_MAX) KNOWN_TIMEZONES.clear();
  KNOWN_TIMEZONES.set(value, answer);
  return answer;
}

/** The key an anonymous request's answer is shared under, or null for a request that is somebody's own. */
export function sharedAnswerKey(request: Request, url: URL): Request | null {
  if (request.headers.get("authorization")) return null;
  if (/(?:^|;\s*)__session(?:_[^=;]*)?=/.test(request.headers.get("cookie") || "")) return null;
  // By name only, and stably, so a repeated parameter keeps its order: an answer is the same
  // whatever order the client wrote its filters in, and those are sets.
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // A bare point is placed partly by the visitor's network - its country near the border, its zone
  // when the client sent no clock - so for one, the network's answer is part of the question.
  if (url.searchParams.has("lat") && url.searchParams.has("lng")) {
    const network = networkOf(request);
    // Each one judged the way the route reads it: a parameter it would ignore, like a zone this
    // runtime does not know, leaves the question to the network, and two networks would otherwise
    // be handed one answer.
    if (!url.searchParams.get("country")?.trim()) params.push(["~network-country", network.country || ""]);
    if (!knownTimezone(url.searchParams.get("tz"))) params.push(["~network-timezone", network.timezone || ""]);
    // And for the nationwide list, its state or province - see networkRegionAt.
    if (url.searchParams.get("scope") === "national" && !(url.searchParams.get("province") || "").replace(/\./g, "").trim()) {
      const point = { latitude: Number(url.searchParams.get("lat")), longitude: Number(url.searchParams.get("lng")) };
      params.push(["~network-region", network.region && network.point && kmBetween(point, network.point) <= NETWORK_REGION_KM ? network.region : ""]);
    }
  }
  // A browse that names no place and no country is placed in the network's country (browseCountry
  // in the route), so that is part of its question too.
  if (!url.searchParams.has("lat") && !url.searchParams.has("lng") && !url.searchParams.get("city")?.trim() && !url.searchParams.get("postal")?.trim() &&
      !url.searchParams.get("country")?.trim() && !url.searchParams.get("province")?.trim()) {
    params.push(["~network-country", networkOf(request).country || ""]);
  }
  return new Request(`${url.origin}/__deals-answer/v${ANSWER_CACHE_VERSION}/?${new URLSearchParams(params)}`, { method: "GET" });
}

// How long the colo keeps a shared answer: until the next five-minute mark on the clock.
//
// It used to be the sixty seconds the reader's own max-age promises, which on a site this size
// meant almost every request missed: two readers had to ask the same question in the same colo
// within a minute of each other. What goes stale inside an answer is what the clock decides - "on
// now", "later today", "ends today" - and offers start and stop on the hour, the half and the
// quarter, all of which are five-minute marks. Ending every copy on one keeps those turns as prompt
// as they were while a copy lives two and a half minutes on average instead of one. A staff edit is
// the cost: it may now take five minutes longer to show, on top of the six the snapshot's revision
// check already allows.
const SHARED_ANSWER_STEP_MS = 5 * 60_000;

export function sharedAnswerSeconds(now: number): number {
  return Math.max(1, Math.ceil((SHARED_ANSWER_STEP_MS - (now % SHARED_ANSWER_STEP_MS)) / 1000));
}

/** The copy of `answer` the colo keeps: its lifetime in place of the reader's, and the search it stands for. */
export function answerToShare(answer: Response, searchEvent: string | null, now: number): Response {
  const shared = new Response(answer.clone().body, answer);
  shared.headers.set("cache-control", `public, max-age=${sharedAnswerSeconds(now)}`);
  if (searchEvent) shared.headers.set(SEARCH_EVENT_HEADER, searchEvent);
  return shared;
}

/**
 * A shared copy as a reader is sent it, and the search event it carried. A copy, because a cached
 * Response's headers are immutable and whatever sends it on may add its own.
 */
export function answerFromShared(hit: Response): { answer: Response; searchEvent: string | null } {
  const searchEvent = hit.headers.get(SEARCH_EVENT_HEADER);
  const answer = new Response(hit.body, hit);
  answer.headers.delete(SEARCH_EVENT_HEADER);
  answer.headers.set("cache-control", ANONYMOUS_ANSWER_CACHE_CONTROL);
  return { answer, searchEvent };
}
