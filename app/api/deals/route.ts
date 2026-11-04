import { env, waitUntil } from "cloudflare:workers";
import { getAppUser, isPro } from "../../auth";
import { publicDealPredicate } from "../../deal-lifecycle";
import { underReviewSql } from "../../accuracy-reports";
import {
  availabilityFromSchedule,
  availabilityFromStructuredSchedule,
  foldSearch,
  kmBetween,
  matchesNormalizedQuery,
  nextRadius,
  normalizeSearch,
  offerRunsOn,
  optionalCoordinate,
  parseList,
  relevanceOfNormalized,
  safeCursor,
  safeLimit,
  scheduleShape,
  scheduleWeekdays,
  weekdayNumber,
  weekRank,
} from "../../search";
import { marketCenters, marketFor, type MarketCenter } from "../../market-coverage";
import { clientKey, normalizedPostal, rateLimit, validPostal } from "../../api-utils";
import { estimatePriceTier, expiryTimeZone, narrowPriceTier, parseSqlTimestamp } from "../../verification";
import { COVERAGE_REACH_KM, autoWidenRadius, clampRadius, maxRadiusKm } from "../../radius";
import { canonicalCity, regionCode, type ResolvedLocation } from "../../geocode";
import { deviceCountry, roughTimezone } from "../../country-at";
import { displayCity, resolveCityText, resolvePostal, type GeocodeGuard } from "../../postal";
import { categoryLabel, cuisineLabel } from "../../i18n/staticEnums";
import { dealLabels, isSupportedLocale, type SupportedLocale } from "../../i18n/dealLabels";
import { capDealLocations, compactDeal } from "../../dealView";
import { READABLE_FIELDS as PRINTED_FIELDS, referencesAlcohol } from "../../alcohol";
import { baseRow, rowBase } from "../../deals-snapshot-rows";
import { ANONYMOUS_ANSWER_CACHE_CONTROL, NETWORK_REGION_KM, answerFromShared, answerToShare, knownTimezone, networkOf, sharedAnswerKey, type Network } from "../../deals-answer";

interface DealRow {
  id: string;
  restaurant: string;
  title: string;
  category: string;
  cuisine: string;
  schedule: string;
  city: string;
  postal_prefix: string;
  address: string;
  price: string;
  emoji: string;
  source_url: string;
  sponsored: number;
  active: number;
  verified_at: string;
  created_at: string;
  price_tier: number | null;
  restaurant_id: string | null;
  location_id: string | null;
  status: string;
  publish_at: string | null;
  expires_at: string | null;
  terms: string | null;
  restrictions: string | null;
  internal_notes: string | null;
  owner_confirmed_at: string | null;
  verification_status: string;
  deleted_at: string | null;
  slug: string | null;
  description: string | null;
  locale: string;
  discount_percent: number | null;
  savings_cents: number | null;
  updated_at: string;
  canonical_restaurant: string;
  restaurant_website: string | null;
  restaurant_photo_url: string | null;
  restaurant_phone: string | null;
  amenities: string | null;
  dietary_options: string | null;
  accessibility: string | null;
  canonical_restaurant_id: string | null;
  is_chain: number | null;
  hidden_gem: number | null;
  // A brand known across the country, not merely a chain (drizzle/0051).
  national_chain: number | null;
  // The brand, where the restaurant row is named for one branch of it; null when the name is the
  // brand (drizzle/0052).
  brand: string | null;
  // 'quick' (counter or app) or 'sit_down' (a table and a server); NULL where the catalog has
  // no answer, which matches neither filter. See drizzle/0047_service_style.sql.
  service_style: string | null;
  vertical: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  country: string | null;
  region: string | null;
  eligible_location_id: string | null;
  neighborhood: string | null;
  location_website: string | null;
  schedule_days: string | null;
  start_time: string | null;
  end_time: string | null;
  recurring: number | null;
  save_count: number;
  effective_verification_status: string;
  /** 1 while a reader's report that the deal has ended or is wrong waits on staff (app/accuracy-reports.ts). */
  under_review: number;
  // 'brand' when the offer runs at every operating branch of its restaurant (drizzle/0049);
  // 'national' when it runs at a chain whose branches Radar does not hold (drizzle/0050).
  location_scope: string | null;
  redemption: string | null;
  redemption_note: string | null;
  promo_code: string | null;
  photo_url: string | null;
  restaurant_logo_url: string | null;
  // The brand row's market, the regions it trades in as JSON, and its own store finder: what a
  // 'national' deal, which has no location, is placed by. See drizzle/0050.
  restaurant_country: string | null;
  restaurant_footprint: string | null;
  restaurant_locator_url: string | null;
  // How many branches run a per-branch deal, in two halves - see DEAL_COLUMNS and buildBases.
  confirmed_rows: number | null;
  own_confirmed: number | null;
}

/** One operating branch of a restaurant that has at least one public deal. */
interface BranchRow {
  location_id: string;
  restaurant_id: string;
  address: string;
  city: string;
  region: string | null;
  country: string;
  postal_prefix: string;
  latitude: number | null;
  longitude: number | null;
  official_url: string | null;
  /** 1 when the coordinate is a city centroid (geo_precision 'city'); see ChainLocation.approximate. */
  approximate: number;
}

/** A deal_locations row: what one deal says about one branch. */
interface EligibilityRow {
  deal_id: string;
  location_id: string;
  eligibility: string;
  source_url: string | null;
}

interface SearchTermRow {
  entity_type: string;
  entity_id: string;
  term: string;
  weight: number;
}

interface DealTranslationRow {
  deal_id: string;
  locale: string;
  title: string | null;
  description: string | null;
  schedule: string | null;
  price: string | null;
  terms: string | null;
  restrictions: string | null;
}

interface MarketCoverageRow {
  market: string;
  region: string;
  country: string;
  status: string;
  minimum_offers: number;
  notes: string | null;
  updated_at: string;
}


type ChainLocation = {
  city: string;
  address: string;
  postal_prefix: string;
  source_url: string;
  offer_available?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  region?: string | null;
  // Present, and true, only where the branch's coordinate is a city centroid standing in for an
  // address the geocoder could not place (restaurant_locations.geo_precision = 'city'). A map draws
  // that point as an area, not a door. Absent everywhere else, which is nearly every branch.
  approximate?: true;
};

type NormalizedLocation = ChainLocation & {
  location_id: string | null;
  eligibility: string;
  offer_available: boolean;
  // Every offer this address runs, not one. A chain branch commonly has several - Boston Pizza on
  // Memorial Drive has Wing Wednesday, Pasta Tuesday and a weekday lunch combo - and `offer` used
  // to be built by a Map keyed on address, so the last one read won and the rest were unreachable.
  // `offer` stays as the first of them, because callers outside this file read it.
  offer?: OfferSummary | null;
  offers?: OfferSummary[];
};

interface OfferSummary {
  id: string;
  slug: string;
  title: string;
  price: string;
  schedule: string;
  category: string;
  address: string;
  city: string;
  source_url: string;
  /**
   * Whether this offer runs today, in the venue's own timezone. A brand running a different
   * special every night is one card, and the card has to know which night it is to open on the
   * right one - a Wednesday reader clicking Montana's should land on rib Wednesday, not on
   * whichever of the four happened to represent the group. Computed per request alongside the
   * deal's own availability, never stored in the snapshot, so it cannot go stale at midnight.
   */
  available_today: boolean;
}

type NormalizedDeal = Omit<DealRow, "restaurant" | "slug" | "is_chain" | "hidden_gem" | "national_chain" | "confirmed_rows" | "own_confirmed"> & {
  restaurant: string;
  slug: string;
  is_chain: boolean;
  hidden_gem: boolean;
  national_chain: boolean;
  primary_city: string;
  chain_brand: string | null;
  chain_location_count: number;
  chain_locations: NormalizedLocation[];
  participating_locations: NormalizedLocation[];
  other_brand_locations: NormalizedLocation[];
  /**
   * How many of the chain's branches run the offer, measured over every branch when the deal's
   * shard was built; the shard itself carries only the branches near its readers. The lists above
   * are never longer than this. Compare chain_location_count, the chain's branches in all.
   */
  participating_location_count: number;
  /**
   * A 'national' deal's regions, from its brand's footprint: the states or provinces the chain
   * trades in. Null when nobody has counted, which places the deal everywhere in its country.
   */
  footprint_regions?: string[] | null;
  search_keywords: string;
  /**
   * Everything a keyword search reads of the deal - search_keywords, its restaurant, title, schedule
   * and price - already normalized (foldSearch in app/search.ts), worked out once when its shard of
   * the snapshot is built. A search used to normalize this for every deal on every request: a dozen
   * regular expressions over the catalogue's whole text, and most of what a keyword search cost. A
   * card's is every deal's it groups, joined.
   */
  search_text: string;
  distance_km: number | null;
  availability: string;
  available_today: boolean;
  available_now: boolean;
  availability_phase: "now" | "upcoming" | "ended" | "unavailable";
  /**
   * Whether the offer runs tonight in the venue's own timezone: still to come or on now today,
   * with hours that reach past 3 PM (see availabilityFromSchedule). What the "Tonight" chip filters
   * on and the card's tag shows. The stored category used to say "Tonight" instead, and said it of
   * a Monday wing night every day of the week.
   */
  tonight: boolean;
  search_score: number;
  /** The zone expires_at's calendar date is read in; see expiryTimeZone in app/verification.ts. */
  expiry_timezone: string | null;
};

type GroupedDeal = NormalizedDeal & {
  brand_offers: OfferSummary[];
  offer_varies_by_location?: boolean;
  /** Under group=brand: the brand as the card names it, and every offer on the card, lead first. */
  brand_name?: string;
  chain_offers?: ChainOffer[];
};

/** One offer on a nationwide card - what the card prints for it, and where it links. */
type ChainOffer = {
  id: string;
  slug: string;
  title: string;
  price: string;
  schedule: string;
  availability: string;
  available_today: boolean;
  available_now: boolean;
  /** The phase the availability line words in the reader's locale, for a client that cannot parse it. */
  availability_phase: NormalizedDeal["availability_phase"];
  redemption: string | null;
  redemption_note: string | null;
  promo_code: string | null;
  expires_at: string | null;
  expiry_timezone: string | null;
  location_scope: string | null;
  city: string;
  /** How many branches run it; null for a promotion with no branches at all (drizzle/0050). */
  participating_location_count: number | null;
  /** Its branches run it on different days or hours; the line carries the lead branch's. */
  schedule_varies?: boolean;
};

const keywordSets: Record<string, string[]> = {
  "Happy hour": ["happy hour", "drinks", "cocktails", "beer", "wine", "bar", "discount drinks", "appetizers"],
  "Food deal": ["food special", "meal deal", "discount food", "value menu", "specials"],
  Tonight: ["tonight", "evening", "night", "daily special"],
  Pub: ["pub", "bar", "beer", "wings", "burgers", "pints"],
  Steakhouse: ["steak", "steakhouse", "prime rib", "beef", "dinner"],
  Italian: ["italian", "pizza", "pasta"],
  Mexican: ["mexican", "tacos", "margaritas"],
  Seafood: ["seafood", "oysters", "fish", "shellfish"],
  Global: ["global", "international", "casual dining", "restaurant"],
};
/** The next radius out from `radius` that this plan reaches, or null at its ceiling. */
function widerRadius(radius: number, maxRadius: number) {
  const next = nextRadius(radius);
  return next != null && next <= maxRadius ? next : null;
}

function searchKeywords(deal: Pick<DealRow, "canonical_restaurant" | "restaurant" | "title" | "category" | "cuisine">) {
  return Array.from(new Set([
    deal.canonical_restaurant, deal.restaurant, deal.title, deal.category, deal.cuisine,
    ...(keywordSets[deal.category] || []), ...(keywordSets[deal.cuisine] || []),
  ].filter(Boolean))).join(" ").toLowerCase();
}


// Both resolvers now live in app/postal.ts so the background jobs can use them too. This route
// keeps its own guard: a genuinely new lookup is bounded per client IP, so one visitor cannot
// drive external geocoder calls on everyone else's behalf. `refused` lets GET tell a rate-limited
// lookup (429) apart from an ordinary "no such postal code" miss (404), which the old version did
// by throwing through the call stack.
function requestGeocodeGuard() {
  const state = { refused: false };
  const guard: GeocodeGuard = async () => {
    const allowed = await rateLimit(await clientKey("geocode"), 30, 60);
    if (!allowed) state.refused = true;
    return allowed;
  };
  return { guard, state };
}

// The catalogue is held in a snapshot — the visitor-independent half of every public deal, indexed
// once — so that a request is a map lookup and some filtering rather than four D1 round trips and
// a full re-index. Only q/location/filters differ per request, and those are applied further down.
//
// The snapshot is in shards (see DealsShard): a request loads the one or few it is about and never
// the rest. It used to be one object holding the whole catalogue, and every request paid for all of
// it: a cold isolate parsed three megabytes before it could answer anyone, and a search from
// downtown Ottawa measured, grouped and filtered every deal in Vancouver and Austin to find the
// thirty it reached. On the Workers free plan a request has ten milliseconds of CPU, and the whole
// catalogue cost more than that before the search began. Each shard is small enough that reading it
// is well under the limit, and building one from D1 is a bounded query rather than a pass over
// everything.
//
// What is held is still only each deal's static half, and everything time-dependent — availability,
// "Available now" vs "Later today", distance, search score — is computed per request from
// `new Date()` against these rows. The response says max-age=60 because that live half really does
// go stale in a minute; the rows underneath it only change when staff edit a deal, which is a
// several-times-a-day event, not a per-minute one.
//
// A day, which in practice means never: the revision below moves on every write to anything a shard
// is built from, and a shard is replaced when it does. The TTL is a backstop for a write that
// changes a row without touching anything the revision reads, and nothing more.
const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
/** A verified deal whose check is older than this is labelled stale (app/verification.ts says the same of its page). */
const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

/**
 * How far past a map cell's own edges its deals' branch lists reach, in kilometres. A located search
 * is answered from the cells its radius touches, and a card's branches are read from the copy of the
 * deal in the reader's own cell: that copy has to carry every branch within the largest radius of
 * any point in the cell, which is this far past the cell's edge. See maxRadiusKm in app/radius.ts.
 */
const CELL_BRANCH_REACH_KM = 50;

/**
 * The branches a deal carries in a country's shard, per state or province of its chain. An unplaced
 * card shows a page of branches and the province filter asks whether the chain has one in the
 * province; a sample of each answers both. The true totals travel beside them (chain_location_count,
 * participating_location_count), measured over every branch when the shard is built.
 */
const BRANCHES_PER_REGION = 8;

/** The largest page of the compact nationwide list - see where `limit` is read in GET. */
const NATIONAL_PAGE_MAX = 200;
/** The most ids one request may ask for - see where `id` is read in GET. */
const MAX_REQUESTED_IDS = 50;
// Everything about a deal that is the same for every visitor at every moment: its locations, its
// search text, its price tier. Built once per shard instead of once per request.
//
// Splitting the per-deal work this way is the point. The old map rebuilt all of this on every
// request — for 133 deals it re-derived each one's chain_locations array, re-concatenated its
// search keywords and re-estimated its price tier, none of which can change between two requests
// a millisecond apart. What genuinely does change per request is small and stays below:
// availability (the clock), distance (where the visitor is) and search score (what they typed).
type DealBase = Omit<NormalizedDeal, "availability" | "available_today" | "available_now" | "availability_phase" | "tonight" | "distance_km" | "search_score" | "expiry_timezone"> & {
  /** Kept for metadataWeight, which depends on the query and so cannot be precomputed. Each term already normalized. */
  indexed: Array<{ term: string; weight: number }>;
};

/**
 * One shard of the snapshot: the deals one kind of request reads, with their translations.
 *
 * Keyed by what a request is about, and built by a bounded D1 query for exactly that:
 *
 *   cell:<lat>:<lng>   the deals confirmed at a branch inside one map cell, a degree of latitude and
 *                      longitude (70-111 km across where Radar is read). A located search loads the
 *                      cells its radius reaches - one to four, nine at most. Each deal carries the
 *                      branches within CELL_BRANCH_REACH_KM of the cell, which is every branch any
 *                      search from inside it can reach.
 *   country:<CC>       every deal with a branch in the country, for a search with no place: each
 *                      chain's branches as a sample per province or state (BRANCHES_PER_REGION).
 *                      One shard for the country, not one per province: a request may make fifty
 *                      subrequests on the free plan, and every shard read is one of them, as is
 *                      every D1 query and every cache write of a build. Reading a dozen provinces
 *                      for one unplaced search was over that budget before any deal was looked at.
 *   national:<CC>      the promotions with no branch at all, placed by their brand's country and
 *                      footprint (drizzle/0050).
 *
 * A request for deals by id - the Saved tab - is answered from a shard built for its ids and held
 * by nobody: fifty deals at most, read from D1 as asked.
 */
type DealsShard = {
  key: string;
  bases: DealBase[];
  translationsByDeal: Map<string, Partial<Record<SupportedLocale, DealTranslationRow>>>;
  expiresAt: number;
  /** The data revision this shard was built from. See readRevision. */
  revision: string;
};

/** The homepage's hero numbers, counted over the whole catalogue - see catalogCounts. */
type CountSet = { cards: number; cities: number; foodCities: number };

/**
 * What every request reads whatever it asks for, held as a shard of its own under the key "meta":
 * the markets and where they are, the alias map, which countries the catalogue has deals in, and
 * the catalogue's own counts, which a request answered from one cell cannot count for itself.
 */
type DealsMeta = {
  key: typeof META_KEY;
  coverageRows: MarketCoverageRow[];
  /**
   * Where each market is, for a search that names none - see app/market-coverage.ts. Worked out
   * when the shard is built and carried in its copies, because it is a pass over every deal.
   */
  centers: MarketCenter<MarketCoverageRow>[];
  /**
   * deal_aliases, as the old id or slug of a folded duplicate to the id of the deal it was folded
   * into, followed to the end. Ten rows after drizzle/0056. See where `ids` is read in GET.
   */
  aliases: Map<string, string>;
  /** The countries with a public deal, for a search that names no country and no place. */
  countries: string[];
  /** With national chains in the local list (`all`), and with them in a section of their own (`separate`). */
  counts: { all: CountSet; separate: CountSet };
  /** The newest source check over the whole public catalogue; see where latestVerificationDate is set. */
  latestSourceCheck: string | null;
  expiresAt: number;
  revision: string;
};

type Stored = DealsShard | DealsMeta;
const META_KEY = "meta";
const isMeta = (stored: Stored): stored is DealsMeta => stored.key === META_KEY;

// How often an isolate re-asks whether the underlying data has changed. Not the same question as
// the TTL above, which asks whether this copy is old; this asks whether it is wrong.
//
// Asking is free: the answer comes from the colo's Cache API (see currentRevision), and only goes
// to D1 when the colo's copy of it is REVISION_SHARED_MS old. A colo runs the Worker on as many
// machines as its traffic needs, each machine its own isolate, so a D1 query per isolate grows
// with traffic where one per colo does not - at one a minute per isolate, a few dozen busy
// isolates alone would have read a million rows a day at 19 rows a check.
//
// So a staff edit reaches a visitor within about six minutes: the colo's answer may be five
// minutes old, this isolate may not ask again for one, and the response is cached for sixty
// seconds on top. Nothing else a visitor sees depends on it - availability, distance and "on now"
// are computed per request from the clock.
const REVISION_CHECK_MS = 60_000;
const REVISION_SHARED_MS = 5 * 60_000;
let revisionCheckedAt = 0;

/**
 * A cheap fingerprint of everything the snapshot is built from.
 *
 * The snapshot is shared between the isolates of a colo through the Cache API, and the Cache API is
 * per-colo: `cache.delete` in one datacenter cannot reach the copy another datacenter is serving.
 * So a purge is not available, and an invalidation has to work by changing the key rather than by
 * removing what is under it. Every colo then misses on its own, without anything having to be told
 * to, and takes the new revision from R2 if another colo has already built it (see
 * readGlobalSnapshot) - so a change is built from D1 about once, not once per colo.
 *
 * `updated_at` across the four tables buildSnapshot reads: a merge, a price edit, a new deal or a
 * branch becoming eligible all move at least one of these maxima.
 *
 * deal_locations belongs here because the select below LEFT JOINs it, and it decides per deal and
 * per address whether the offer is confirmed there - which is both what the card reports as "N
 * confirmed locations" and what the radius filter tests before a deal counts as in range. Leaving
 * it out meant an eligibility change could not publish at all: 740 rows confirming national chain
 * promotions at every branch were written, deployed, and still invisible, because the fingerprint
 * they should have moved did not read the table they were in.
 *
 * Deletions are counted by the delete itself. A maximum cannot fall, so a DELETE leaves a
 * fingerprint built purely from MAX(updated_at) byte-for-byte identical - thirteen duplicate branch
 * locations were removed and every colo went on serving them. drizzle/0046 closed that with a
 * COUNT(*) per table, believing SQLite would answer it cheaply from an index. It walks the index,
 * and D1 bills every entry: 46,182 rows a check once the US branches were in, which on its own was
 * two million rows a day. The triggers in drizzle/0049 bump `data_changes` instead, so this reads
 * one row per table for the same answer.
 *
 * The same counters cover the four small tables buildSnapshot reads - deal_schedules,
 * search_terms, deal_translations, market_coverage - on every write, since none of them has an
 * indexed updated_at. With them in, nothing the snapshot is built from changes without moving this
 * value, which is what let the TTL stop rebuilding on a timer. (favorites is read too, for
 * save_count, and deliberately left out: a count of saves a day behind is not worth a global
 * rebuild per tap.)
 *
 * MAX(rowid) is for an insert that states an old updated_at of its own, which would not raise the
 * maximum above. It is answered from the end of the table's b-tree: one row.
 *
 * deal_aliases has only that one. An alias is inserted, never edited, and usually beside the
 * archive of the deal it names, which moves deals' maximum anyway; the rowid is for one written on
 * its own, which the snapshot's alias map would otherwise never see.
 *
 * The waiting count is for publish_at. A deal scheduled for later becomes public when its time
 * passes without any row changing; the count of deals still waiting falls at that moment, from a
 * partial index holding only the scheduled ones.
 *
 * The date is not here any more. It was, for the 30-day "stale" label the select computes, and it
 * made every colo rebuild the whole snapshot at midnight UTC; the label is read against the clock
 * per request now (see where effective_verification_status is set in GET), so nothing is rebuilt
 * on a timer.
 */
async function readRevision(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT (SELECT MAX(updated_at) FROM deals) d," +
      " (SELECT MAX(updated_at) FROM restaurants) r," +
      " (SELECT MAX(updated_at) FROM restaurant_locations) l," +
      " (SELECT MAX(updated_at) FROM deal_locations) e," +
      " (SELECT MAX(rowid) FROM deals) dn," +
      " (SELECT MAX(rowid) FROM restaurants) rn," +
      " (SELECT MAX(rowid) FROM restaurant_locations) ln," +
      " (SELECT MAX(rowid) FROM deal_locations) en," +
      " (SELECT MAX(rowid) FROM deal_aliases) an," +
      " (SELECT group_concat(n,'.') FROM data_changes) x," +
      " (SELECT COUNT(*) FROM deals WHERE publish_at IS NOT NULL AND datetime(publish_at)>datetime('now')) w",
  ).first<{ d: string | null; r: string | null; l: string | null; e: string | null;
            dn: number | null; rn: number | null; ln: number | null; en: number | null; an: number | null;
            x: string | null; w: number | null }>();
  return [row?.d ?? "", row?.r ?? "", row?.l ?? "", row?.e ?? "",
          row?.dn ?? "", row?.rn ?? "", row?.ln ?? "", row?.en ?? "", row?.an ?? "",
          row?.x ?? "", row?.w ?? ""].join("|");
}

/**
 * The data revision, asked of D1 at most once per colo per REVISION_SHARED_MS.
 *
 * The answer is kept in the colo's Cache API beside the snapshots, stamped with when D1 gave it, and
 * every isolate in the colo reads it from there until it is REVISION_SHARED_MS old. The isolate
 * that finds it missing or old asks D1 and publishes the new answer. Two isolates doing that at the
 * same moment both ask, which costs one extra 19-row read and nothing else.
 *
 * "current-revision" cannot collide with a snapshot key: those are "r" and a base-36 hash, or
 * "latest".
 */
const revisionCacheKey = (origin: string) =>
  new Request(`${origin}/__deals-snapshot/v${SNAPSHOT_CACHE_VERSION}/current-revision`, { method: "GET" });

async function currentRevision(origin: string): Promise<string> {
  const cache = snapshotCache();
  if (cache) {
    try {
      const hit = await cache.match(revisionCacheKey(origin));
      if (hit) {
        const record = (await hit.json()) as { revision?: unknown; askedAt?: unknown };
        if (typeof record.revision === "string" && record.revision && typeof record.askedAt === "number" &&
            Date.now() - record.askedAt < REVISION_SHARED_MS) {
          return record.revision;
        }
      }
    } catch {
      // An unreadable record is a miss.
    }
  }
  const revision = await readRevision();
  if (cache && revision) {
    const put = cache.put(
      revisionCacheKey(origin),
      new Response(JSON.stringify({ revision, askedAt: Date.now() }), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(REVISION_SHARED_MS / 1000)}` },
      }),
    ).catch(() => {});
    try {
      waitUntil(put);
    } catch {
      // No request context to attach to; the put is already running either way.
    }
  }
  return revision;
}
// The shards this isolate holds, by key, most recently used last. Bounded: a busy isolate in a big
// colo is asked about many cells, and the ones it has not been asked about in a while are let go.
const held = new Map<string, Stored>();
const HELD_MAX = 64;
function hold(stored: Stored) {
  held.delete(stored.key);
  held.set(stored.key, stored);
  while (held.size > HELD_MAX) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}
// The data revision this isolate last learned (see currentRevision): what every held shard is
// compared with. Empty until the first request learns it, or while D1 will not say.
let knownRevision = "";
// Requests this isolate has answered, for the x-radar-isolate header in GET.
let isolateRequests = 0;
// Single-flight guards, per shard: without them a burst of concurrent requests arriving on a cold
// or just-expired isolate would each launch their own copy of the build.
//
// A build running inside a request the Workers runtime hard-kills for exceeding its own resource
// limit is torn down without ever settling: the promise neither resolves nor rejects, so a
// `.finally` never runs and a guard keeps pointing at it forever. Every later request on that
// isolate then awaits a promise that will never complete: requests that burn almost no CPU and then
// sit until the client gives up — no exception, just a hang, on an isolate that stays wedged for
// the rest of its life while its neighbors serve the same URL fine.
//
// This is the same failure as the leaked admission slots in worker/index.ts, which self-heal by
// aging out for exactly this reason: state cleaned up only on a path a killed request never
// reaches needs a deadline, not a `finally`. An in-flight build older than this is abandoned and
// a fresh one started, so a wedged isolate recovers on its next request instead of never.
const SNAPSHOT_BUILD_DEADLINE_MS = 10_000;
type InFlight = { promise: Promise<Stored>; startedAt: number };
const buildsInFlight = new Map<string, InFlight>();
const catchUpsInFlight = new Map<string, InFlight>();

// Sharing one snapshot across the isolates in a colo, through the Cache API.
//
// Each isolate used to build its own. That is fine until a deploy, which discards every isolate at
// once: each replacement then rebuilt the snapshot out of D1 on its first request — once per
// isolate, everywhere. That multiplies row reads by the number of isolates on every deploy, and
// once the database's read allowance runs out a cold isolate cannot build at all and /api/deals
// returns 500 while its warm neighbors serve the same URL perfectly.
//
// So the build is written where the next isolate can find it. A cold isolate reads the colo's copy
// instead of D1, which makes a deploy cost one build per colo rather than one per isolate, and lets
// a cold isolate serve even when D1 is unavailable.
//
// Versioned by hand, and deliberately not by deployment id: keying on the deploy would throw this
// away on every deploy, which is the exact cost it exists to avoid. Bump this for a change to the
// serialised shape, or to what buildBases puts into a shard. Do not bump it to publish a data
// change: the key carries the data revision, so that happens by itself. See snapshotCacheKey and
// readRevision.
//
// It went from 1 to 2 on 2026-09-19 for exactly that wrong reason, and the history is worth
// keeping because it is what the revision mechanism was built from. scripts/chain-groups.mjs
// merged 39 branch restaurant records into 9 brands. D1 was correct immediately and the site still
// served the pre-merge names 48 minutes later: loadSnapshot served the stale copy and scheduled a
// background refresh that did rebuild and did call writeSharedSnapshot, but the shared copy never
// changed, so every fresh isolate adopted the same stale snapshot again. A TTL answers "is this
// old?", and nothing was asking "is this wrong?".
// 3 on 2026-09-27: large brands' branches moved out of their deals into `brands`.
// 4 and 5 on 2026-09-28: deals as positional rows, then back to objects with each branch sent once.
// 6, 7 on 2026-09-28: national_chain and `brand` on every deal (drizzle/0051, 0052).
// 8 on 2026-09-30: `aliases` and `centers`.
// 9 on 2026-10-03: most deals as positional rows again, rebuilt by an object literal
// (app/deals-snapshot-rows.ts). A v8 reader would take a row for a deal with no fields.
// 10, 11, 12 on 2026-10-07: approximate coordinates, under_review, owner_confirmed_at.
// 13 on 2026-10-11: internal_notes is blank in every copy.
// 14 on 2026-11-04: the snapshot in shards. A copy is one cell, country or nationwide list, or the
// meta shard, each under its own key; a deal carries its normalized search text and its measured
// branch totals, and no deal refers to a brand index any more. A v13 copy is the whole catalogue
// under one key, which no reader asks for.
const SNAPSHOT_CACHE_VERSION = 14;
// A fallback, not a source of truth: the in-memory TTL above still decides when a refresh happens.
// This only bounds how long a colo may hold a copy nothing has refreshed.
const SNAPSHOT_CACHE_MAX_AGE_S = 24 * 60 * 60;

// Absent when the bundle runs outside Workers — the render tests load this module in plain Node,
// where touching `caches` is a ReferenceError rather than a miss.
function snapshotCache(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

// The revision is part of the key, not merely part of the payload. That is the whole invalidation
// mechanism: a data change produces a different key, every colo misses it, and each rebuilds from
// D1 without anything having to purge anything. Copies under superseded keys are never read again
// and fall out on their own when SNAPSHOT_CACHE_MAX_AGE_S expires.
//
// Hashed rather than interpolated because the revision is a dozen timestamps and counters, which
// carry spaces and colons, and a cache key is a URL. The shard's own key follows: "meta", or
// "cell:45:-76", "country:CA", "national:US".
const snapshotCacheKey = (origin: string, key: string, revision: string) =>
  new Request(`${origin}/__deals-snapshot/v${SNAPSHOT_CACHE_VERSION}/r${revisionTag(revision)}/${key}`, { method: "GET" });

/**
 * Where the newest copy of a shard is also published, under a name that needs no D1 lookup to
 * construct.
 *
 * Learning the revision costs a query, and the one moment that matters most is the moment D1 will
 * not answer one: a cold isolate during an outage could otherwise not even work out which key to
 * ask for, and would 500 — the exact failure the shared snapshot was built to prevent. So every
 * build writes here too, and this is read only when the revision is unavailable. It is knowingly
 * the stale copy; serving yesterday's deals beats serving an error.
 *
 * The "r" prefix on revision tags above keeps them disjoint from this name, so a hash can never
 * collide with it; "current-revision" (revisionCacheKey) is disjoint from both.
 */
const snapshotFallbackKey = (origin: string, key: string) =>
  new Request(`${origin}/__deals-snapshot/v${SNAPSHOT_CACHE_VERSION}/latest/${key}`, { method: "GET" });

/** A short, URL-safe tag for a revision string. Collision-resistance is all that is asked of it. */
function revisionTag(revision: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < revision.length; i += 1) {
    hash ^= revision.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// The deals go over as rows, and every branch a deal names once, in `sites`. Both halves of that
// are about CPU, because a cold isolate parses a shard before it can answer anyone, and every
// kilobyte parsed is CPU taken from the request's allowance.
//
// Size. The two lists derived from chain_locations - the branches that carry the offer and the
// ones that do not - are not sent, and are rebuilt from offer_available exactly as buildBases makes
// them. chain_locations itself goes as [site, eligibility, source?] per branch: every deal a chain
// runs used to repeat the chain's whole branch list, when all that differs from one deal to the
// next is what the deal says about each branch.
//
// Shape. Version 4 sent the deals as positional rows under one list of field names, which halved
// the bytes, and rebuilt each deal by assigning its fields by computed name. V8 keeps an object
// built that way in dictionary mode, and a request copies every deal it reads: the copy went from
// under 1 ms to 12.5 ms, so the snapshot got smaller and every request after the first got slower.
// JSON.parse builds its objects the fast way, and so does an object literal: version 9 sends rows
// again and rebuilds each with one (app/deals-snapshot-rows.ts), and a deal is only ever given
// fields by name afterwards.

/** A branch as a deal's location uses it: the fields locationOf reads. */
type Site = { location_id: string | null; address: string; city: string; region: string | null; postal_prefix: string; latitude: number | null; longitude: number | null; approximate?: number | boolean };
type PackedSite = [string | null, string, string, string | null, string, number | null, number | null, number];
type PackedLocation = [number, string] | [number, string, string];
const packSite = (l: NormalizedLocation): PackedSite =>
  [l.location_id, l.address, l.city, l.region ?? null, l.postal_prefix, l.latitude ?? null, l.longitude ?? null, l.approximate ? 1 : 0];
const unpackSite = (p: PackedSite): Site =>
  ({ location_id: p[0], address: p[1], city: p[2], region: p[3], postal_prefix: p[4], latitude: p[5], longitude: p[6], approximate: p[7] });

/** Same fields, same order, same values: what the response serializes, compared without serializing. */
function sameFields(a: object, b: object) {
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  return aKeys.length === bKeys.length &&
    aKeys.every((key, i) => key === bKeys[i] && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * A deal's locations as references into `sites`, or null to send them as they are. Only a location
 * the reader rebuilds identically is packed, so one carrying a field locationOf does not write
 * costs its deal a few bytes rather than coming back different.
 */
function packLocations(base: DealBase, sites: PackedSite[], siteIndex: Map<string, number>): PackedLocation[] | null {
  const packed: PackedLocation[] = [];
  for (const location of base.chain_locations) {
    const site = packSite(location);
    const source = location.source_url === base.source_url ? null : location.source_url;
    if (!sameFields(locationOf(unpackSite(site), location.eligibility, source, base), location)) return null;
    const key = JSON.stringify(site);
    let index = siteIndex.get(key);
    if (index === undefined) {
      index = sites.length;
      sites.push(site);
      siteIndex.set(key, index);
    }
    packed.push(source === null ? [index, location.eligibility] : [index, location.eligibility, source]);
  }
  return packed;
}

function serializeSnapshot(stored: Stored) {
  if (isMeta(stored)) {
    return JSON.stringify({
      v: SNAPSHOT_CACHE_VERSION,
      key: stored.key,
      expiresAt: stored.expiresAt,
      revision: stored.revision,
      coverageRows: stored.coverageRows,
      aliases: [...stored.aliases],
      countries: stored.countries,
      counts: stored.counts,
      latestSourceCheck: stored.latestSourceCheck,
      // A centre names its market by its place in coverageRows, which travel beside it. Only one the
      // reader will accept: an entry it refuses costs the whole copy, and every isolate that read it
      // would go back to D1.
      centers: stored.centers.flatMap((center) => {
        const index = stored.coverageRows.indexOf(center.row);
        return index >= 0 && Number.isFinite(center.latitude) && Number.isFinite(center.longitude) ? [[index, center.latitude, center.longitude]] : [];
      }),
    });
  }
  const sites: PackedSite[] = [];
  const siteIndex = new Map<string, number>();
  const bases = stored.bases.map((base) => {
    const { participating_locations: _participating, other_brand_locations: _others, ...rest } = base;
    const packed = packLocations(base, sites, siteIndex);
    const deal = packed ? { ...rest, chain_locations: packed } : rest;
    // As a row of values where the deal is the usual shape - see app/deals-snapshot-rows.ts.
    return baseRow(deal) ?? deal;
  });
  return JSON.stringify({
    v: SNAPSHOT_CACHE_VERSION,
    key: stored.key,
    expiresAt: stored.expiresAt,
    revision: stored.revision,
    sites,
    bases,
    translations: [...stored.translationsByDeal],
  });
}

// Strict on purpose. Anything unrecognised returns null and the caller builds from D1, so a shape
// change that forgets to bump the version costs one rebuild rather than serving a copy whose
// fields the reading code no longer understands. `key` is what the caller asked for: a copy of
// another shard under this name is refused too.
function deserializeSnapshot(raw: unknown, key: string): Stored | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.v !== SNAPSHOT_CACHE_VERSION || data.key !== key) return null;
  if (typeof data.expiresAt !== "number") return null;
  const revision = typeof data.revision === "string" ? data.revision : "";
  if (key === META_KEY) {
    if (!Array.isArray(data.coverageRows) || !Array.isArray(data.aliases) || !Array.isArray(data.centers) ||
        !Array.isArray(data.countries) || !data.counts || typeof data.counts !== "object") return null;
    for (const entry of data.aliases as unknown[]) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") return null;
    }
    const counts = data.counts as Record<string, unknown>;
    const countSet = (value: unknown): CountSet | null => {
      if (!value || typeof value !== "object") return null;
      const set = value as Record<string, unknown>;
      return typeof set.cards === "number" && typeof set.cities === "number" && typeof set.foodCities === "number"
        ? { cards: set.cards, cities: set.cities, foodCities: set.foodCities } : null;
    };
    const all = countSet(counts.all), separate = countSet(counts.separate);
    if (!all || !separate) return null;
    const coverageRows = data.coverageRows as MarketCoverageRow[];
    const centers: DealsMeta["centers"] = [];
    for (const entry of data.centers as unknown[]) {
      if (!Array.isArray(entry)) return null;
      const [index, latitude, longitude] = entry as unknown[];
      const row = typeof index === "number" ? coverageRows[index] : undefined;
      if (!row || typeof latitude !== "number" || typeof longitude !== "number") return null;
      centers.push({ row, latitude, longitude });
    }
    return {
      key: META_KEY,
      coverageRows,
      centers,
      aliases: new Map(data.aliases as Array<[string, string]>),
      countries: (data.countries as unknown[]).filter((value): value is string => typeof value === "string"),
      counts: { all, separate },
      latestSourceCheck: typeof data.latestSourceCheck === "string" ? data.latestSourceCheck : null,
      expiresAt: data.expiresAt,
      revision,
    };
  }
  if (!Array.isArray(data.sites) || !Array.isArray(data.bases) || !Array.isArray(data.translations)) return null;
  const sites: Site[] = [];
  for (const packed of data.sites as unknown[]) {
    if (!Array.isArray(packed) || packed.length !== 8) return null;
    sites.push(unpackSite(packed as PackedSite));
  }
  // A deal sent as a row is rebuilt by a literal (rowBase); one sent as an object is left as
  // JSON.parse made it. A row of any other length is a copy this code does not understand.
  const bases: DealBase[] = [];
  for (const entry of data.bases as unknown[]) {
    const base = Array.isArray(entry) ? rowBase(entry) : entry;
    if (!base || typeof base !== "object") return null;
    bases.push(base as DealBase);
  }
  for (const base of bases) {
    if (!Array.isArray(base.chain_locations) || typeof base.search_text !== "string") return null;
    const locations: NormalizedLocation[] = [];
    for (const entry of base.chain_locations as unknown[]) {
      if (Array.isArray(entry)) {
        const site = sites[entry[0] as number];
        if (!site || typeof entry[1] !== "string") return null;
        locations.push(locationOf(site, entry[1], typeof entry[2] === "string" ? entry[2] : null, base));
      } else if (entry && typeof entry === "object") {
        locations.push(entry as NormalizedLocation);
      } else {
        return null;
      }
    }
    base.chain_locations = locations;
    base.participating_locations = locations.filter((location) => location.offer_available);
    base.other_brand_locations = locations.filter((location) => !location.offer_available);
  }
  return {
    key,
    bases,
    translationsByDeal: new Map(data.translations as Array<[string, Partial<Record<SupportedLocale, DealTranslationRow>>]>),
    expiresAt: data.expiresAt,
    revision,
  };
}

/** The fixed-name copy, read only when the revision could not be learned. See snapshotFallbackKey. */
async function readFallbackSnapshot(origin: string, key: string): Promise<Stored | null> {
  const cache = snapshotCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(snapshotFallbackKey(origin, key));
    return hit ? deserializeSnapshot(await hit.json(), key) : null;
  } catch {
    return null;
  }
}

async function readSharedSnapshot(origin: string, key: string, revision: string): Promise<Stored | null> {
  const cache = snapshotCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(snapshotCacheKey(origin, key, revision));
    if (!hit) return null;
    return deserializeSnapshot(await hit.json(), key);
  } catch {
    // A torn or truncated entry is a miss, never an error the visitor sees.
    return null;
  }
}

// Never awaited by the request that triggered the build: the visitor is owed the deals, not the
// bookkeeping. waitUntil keeps the isolate alive for it where there is a request context to hang
// it on, and its absence is not worth failing over.
function writeSharedSnapshot(origin: string, stored: Stored) {
  let serialized: string;
  try {
    serialized = serializeSnapshot(stored);
  } catch {
    return;
  }
  const writes = [publishToColo(origin, stored.key, stored.revision, serialized)];
  const bucket = snapshotBucket();
  // Only a copy that knows its revision: one built while the revision could not be read would
  // match no reader's request here, and would displace one that does.
  if (bucket && stored.revision) {
    writes.push(bucket.put(snapshotObjectKey(stored.key), serialized, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { revision: stored.revision },
    }).catch(() => {}));
  }
  try {
    waitUntil(Promise.all(writes));
  } catch {
    // No request context to attach to; the writes are already running either way.
  }
}

function publishToColo(origin: string, key: string, revision: string, serialized: string): Promise<unknown> {
  const cache = snapshotCache();
  if (!cache) return Promise.resolve();
  const headers = { "content-type": "application/json", "cache-control": `max-age=${SNAPSHOT_CACHE_MAX_AGE_S}` };
  // Twice: once under this revision, which is what a healthy read asks for, and once under the
  // fixed name a cold isolate can build without asking D1 anything. A separate Response for each
  // because a body can only be consumed once.
  return Promise.all([
    cache.put(snapshotCacheKey(origin, key, revision), new Response(serialized, { headers })).catch(() => {}),
    cache.put(snapshotFallbackKey(origin, key), new Response(serialized, { headers })).catch(() => {}),
  ]);
}

// Across colos, through R2.
//
// The Cache API is per colo, so every revision used to be built from D1 once in each colo that
// served a request after it, times however many datacenters the traffic touched - a number that
// grows with the audience, not with the data. The first colo to build a shard of a revision now
// writes it here as well, and every other colo reads it instead of D1, so a change is built about
// once whatever the traffic.
//
// One object per shard, overwritten, holding its revision in its metadata; a reader after a
// different revision leaves the body unread. Two colos building different revisions at the same
// moment can leave the older one here, and the next reader after the newer one then misses, builds
// and overwrites it: one extra build, never the wrong data, because a reader only takes the
// revision it asked for.
//
// In radar-photos, under keys app/api/photo will not serve (it answers image extensions only), in
// a bucket with public access off: the objects are reachable from this Worker and nowhere else.
//
// It is also the last resort when D1 will not answer at all. A cold colo that cannot learn the
// revision takes whatever is here, the way readFallbackSnapshot does within a colo, rather than
// returning an error because the daily read allowance ran out.
const SNAPSHOT_OBJECT_KEY = `internal/deals-snapshot/v${SNAPSHOT_CACHE_VERSION}/`;
const snapshotObjectKey = (key: string) => `${SNAPSHOT_OBJECT_KEY}${key}`;

function snapshotBucket(): R2Bucket | null {
  try {
    return env.PHOTOS ?? null;
  } catch {
    return null;
  }
}

/** The shared copy of `key` at `revision`, or at whatever revision is there when `revision` is null. */
async function readGlobalSnapshot(origin: string, key: string, revision: string | null): Promise<Stored | null> {
  const bucket = snapshotBucket();
  if (!bucket) return null;
  try {
    const object = await bucket.get(snapshotObjectKey(key));
    if (!object) return null;
    if (revision !== null && object.customMetadata?.revision !== revision) {
      await object.body.cancel();
      return null;
    }
    const serialized = await object.text();
    const stored = deserializeSnapshot(JSON.parse(serialized), key);
    if (!stored) return null;
    // Into this colo as well, so its other isolates find it without going back to R2.
    const publish = publishToColo(origin, key, stored.revision, serialized);
    try {
      waitUntil(publish);
    } catch {
      // No request context; the puts are already running.
    }
    return stored;
  } catch {
    // A torn object or a failed read is a miss, never an error the visitor sees.
    return null;
  }
}

// Which shards a request is about.

// A 1-degree grid: at the latitudes Radar covers a cell is 70-111 km across, so a 50 km radius is
// never more than a few cells in any direction, and a dense metro is still only a few hundred deals.
const cellKey = (latitude: number, longitude: number) => `cell:${Math.floor(latitude)}:${Math.floor(longitude)}`;
const countryKey = (country: string) => `country:${country}`;
const nationalKey = (country: string) => `national:${country}`;
/** A country code a shard can be named for: two letters, else nothing. The request's own spelling is not a key. */
const shardCountry = (value: string | null | undefined) => (value && /^[A-Z]{2}$/.test(value) ? value : null);

/** Degrees of latitude and longitude that `km` spans at `latitude`; longitude never shorter than a fifth of a degree per 111 km. */
function degreesAt(latitude: number, km: number) {
  return { lat: km / 111, lng: km / (111 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180))) };
}

/**
 * The cells a search from `point` reaching `reachKm` touches: every cell its bounding box overlaps,
 * the point's own first. First matters: a deal is read from the first cell it is found in, and the
 * copy in the reader's own cell carries every branch a search from there can reach.
 */
function cellsWithin(point: { latitude: number; longitude: number }, reachKm: number): string[] {
  const span = degreesAt(point.latitude, reachKm);
  const keys = [cellKey(point.latitude, point.longitude)];
  for (let lat = Math.floor(point.latitude - span.lat); lat <= Math.floor(point.latitude + span.lat); lat++) {
    for (let lng = Math.floor(point.longitude - span.lng); lng <= Math.floor(point.longitude + span.lng); lng++) {
      const key = `cell:${lat}:${lng}`;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** What a shard holds, read off its key; null for a key no shard is built for. */
type ShardSpec =
  | { kind: "cell"; south: number; north: number; west: number; east: number }
  | { kind: "country"; country: string }
  | { kind: "national"; country: string }
  | { kind: "ids"; ids: string[]; point: { latitude: number; longitude: number } | null };

function shardSpec(key: string): ShardSpec | null {
  const cell = /^cell:(-?\d+):(-?\d+)$/.exec(key);
  if (cell) {
    const lat = Number(cell[1]), lng = Number(cell[2]);
    if (lat < -90 || lat > 89 || lng < -180 || lng > 179) return null;
    return { kind: "cell", south: lat, north: lat + 1, west: lng, east: lng + 1 };
  }
  const country = /^(country|national):([A-Z]{2})$/.exec(key);
  if (country) return { kind: country[1] as "country" | "national", country: country[2] };
  return null;
}

/** A bounding box as the four binds a `BETWEEN ? AND ?` pair reads, with a hard bound on latitude. */
const boxBinds = (south: number, north: number, west: number, east: number) =>
  [Math.max(-90, south), Math.min(90, north), Math.max(-180, west), Math.min(180, east)];

/** `IN (SELECT value FROM json_each(?))`: a list of any length as one bound parameter, since D1 allows a hundred. */
const inList = (values: readonly string[]) => JSON.stringify(values);
const IN_LIST = "IN (SELECT value FROM json_each(?))";

async function buildSnapshot(key: string): Promise<Stored> {
  if (key === META_KEY) return buildMeta();
  const spec = shardSpec(key);
  if (!spec) throw new Error(`no such deals shard: ${key}`);
  return buildShard(key, spec);
}

// The columns every shard's deals carry; `SELECT d.*` first, so the deals table's own columns lead
// the row in the table's order (tests/snapshot-rows.test.mjs).
//
// A deal a reader has reported as ended or wrong, and staff have not yet closed the report on:
// "Re-checking" to every client, and lower in the recommended order (app/accuracy-reports.ts).
//
// confirmed_rows and own_confirmed are the two halves of how many branches run a per-branch deal
// (see eligibilityAt): its confirmed deal_locations rows, and whether the branch at its own address
// counts by default, having no row of its own. Both are answered from an index, a few rows a deal.
// A brand-wide deal runs at every branch, and a nationwide one at none that Radar holds.
const DEAL_COLUMNS = () => {
  const underReview = underReviewSql("d");
  return `d.*,COALESCE(r.name,d.restaurant) canonical_restaurant,r.website restaurant_website,r.photo_url restaurant_photo_url,r.logo_url restaurant_logo_url,r.country restaurant_country,r.footprint restaurant_footprint,r.locator_url restaurant_locator_url,r.phone restaurant_phone,r.amenities,r.dietary_options,r.accessibility,r.id canonical_restaurant_id,r.is_chain,r.hidden_gem,r.national_chain,r.brand,r.service_style,COALESCE(r.vertical,'restaurant') vertical,l.latitude,l.longitude,l.timezone,l.country,l.region,l.id eligible_location_id,l.neighborhood,l.official_url location_website,s.days schedule_days,s.start_time,s.end_time,s.recurring,(SELECT COUNT(*) FROM favorites f WHERE f.deal_id=d.id) save_count,CASE WHEN ${underReview} THEN 'stale' WHEN d.verification_status='verified' AND julianday('now')-julianday(d.verified_at)>30 THEN 'stale' ELSE d.verification_status END effective_verification_status,${underReview} under_review,(SELECT COUNT(*) FROM deal_locations dl WHERE dl.deal_id=d.id AND dl.eligibility='confirmed') confirmed_rows,EXISTS(SELECT 1 FROM restaurant_locations x WHERE x.restaurant_id=d.restaurant_id AND x.address=d.address AND x.status='operating' AND NOT EXISTS(SELECT 1 FROM deal_locations dl WHERE dl.deal_id=d.id AND dl.location_id=x.id)) own_confirmed`;
};
const DEAL_FROM = "FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id LEFT JOIN deal_schedules s ON s.id=(SELECT id FROM deal_schedules WHERE deal_id=d.id ORDER BY id LIMIT 1)";
const DEAL_ORDER = "ORDER BY d.sponsored DESC,d.verified_at DESC,d.restaurant";

/**
 * The branches of `restaurants` an operating branch each, as a shard carries them: `where` narrows
 * them (a bounding box, or a sample per region), and the deals' own branches come whatever it says.
 */
const BRANCH_COLUMNS = "l.id location_id,l.restaurant_id,l.address,l.city,l.region,l.country,l.postal_prefix,l.latitude,l.longitude,l.official_url,CASE WHEN l.geo_precision='city' THEN 1 ELSE 0 END approximate";

/**
 * Several statements as one D1 batch, each answered in its place; a null is a statement not worth
 * sending, answered empty. One subrequest for all of them - see where buildShard reads.
 */
async function batched<T extends unknown[]>(statements: Array<D1PreparedStatement | null>): Promise<{ [K in keyof T]: D1Result<T[K]> }> {
  const sent = statements.filter((statement): statement is D1PreparedStatement => statement !== null);
  const answers = sent.length ? await env.DB.batch(sent) : [];
  let next = 0;
  return statements.map((statement) => (statement ? answers[next++] : { results: [], success: true, meta: {} })) as { [K in keyof T]: D1Result<T[K]> };
}

/** The deals of one shard and everything they refer to, read from D1 and built. */
async function buildShard(key: string, spec: ShardSpec): Promise<DealsShard> {
  // Read alongside the rest, not before it: taken after the reads, a write landing mid-build would
  // be stamped as already included and the next revision check would see nothing to do. Taken with
  // them, the worst case is a revision older than the rows, which costs one extra rebuild and
  // cannot lose a change.
  const select = `SELECT ${DEAL_COLUMNS()} ${DEAL_FROM} WHERE ${publicDealPredicate}`;
  let dealsRead: D1PreparedStatement;
  if (spec.kind === "cell") {
    // A deal is in a cell when it is confirmed at a branch inside it: at its own branch, at every
    // branch of its chain for a brand-wide deal, or at one its deal_locations rows confirm. The
    // branches in the cell are found first, by the (latitude, longitude) index (drizzle/0139), and
    // each test below is a lookup against that small set.
    const box = boxBinds(spec.south, spec.north, spec.west, spec.east);
    dealsRead = env.DB.prepare(
      `WITH here AS (SELECT id,restaurant_id FROM restaurant_locations WHERE status='operating' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?) ${select} AND d.location_scope IS NOT 'national' AND (d.location_id IN (SELECT id FROM here) OR (d.location_scope='brand' AND d.restaurant_id IN (SELECT restaurant_id FROM here)) OR d.id IN (SELECT dl.deal_id FROM deal_locations dl WHERE dl.eligibility='confirmed' AND dl.location_id IN (SELECT id FROM here))) ${DEAL_ORDER}`,
    ).bind(...box);
  } else if (spec.kind === "country") {
    dealsRead = env.DB.prepare(`${select} AND d.location_scope IS NOT 'national' AND l.country=? ${DEAL_ORDER}`).bind(spec.country);
  } else if (spec.kind === "national") {
    dealsRead = env.DB.prepare(`${select} AND d.location_scope='national' AND r.country=? ${DEAL_ORDER}`).bind(spec.country);
  } else {
    const list = inList(spec.ids);
    dealsRead = env.DB.prepare(`${select} AND (d.id ${IN_LIST} OR d.slug ${IN_LIST}) ${DEAL_ORDER}`).bind(list, list);
  }
  const [revision, publicRows] = await Promise.all([readRevision(), dealsRead.all<DealRow>()]);
  const rows = publicRows.results;
  const dealIds = rows.map((row) => row.id);
  const restaurantIds = [...new Set(rows.flatMap((row) => (row.restaurant_id && row.location_scope !== "national" ? [row.restaurant_id] : [])))];
  const ownIds = [...new Set(rows.flatMap((row) => (row.location_id && row.location_scope !== "national" ? [row.location_id] : [])))];
  // The deals that still decide per branch: a 'brand' deal runs everywhere and its rows are not
  // needed, and a 'national' one has no branches at all.
  const perBranchIds = rows.filter((row) => !["brand", "national"].includes(String(row.location_scope || ""))).map((row) => row.id);

  // The branches each deal carries - see DealsShard for what each kind holds.
  let branchesRead: D1PreparedStatement | null;
  if (!restaurantIds.length) {
    branchesRead = null;
  } else if (spec.kind === "cell" || (spec.kind === "ids" && spec.point)) {
    const reach = spec.kind === "cell"
      ? { south: spec.south, north: spec.north, west: spec.west, east: spec.east, latitude: (spec.south + spec.north) / 2 }
      : { south: spec.point!.latitude, north: spec.point!.latitude, west: spec.point!.longitude, east: spec.point!.longitude, latitude: spec.point!.latitude };
    const span = degreesAt(reach.latitude, CELL_BRANCH_REACH_KM);
    branchesRead = env.DB.prepare(
      `SELECT ${BRANCH_COLUMNS} FROM restaurant_locations l WHERE l.status='operating' AND l.restaurant_id ${IN_LIST} AND ((l.latitude BETWEEN ? AND ? AND l.longitude BETWEEN ? AND ?) OR l.id ${IN_LIST})`,
    ).bind(inList(restaurantIds), ...boxBinds(reach.south - span.lat, reach.north + span.lat, reach.west - span.lng, reach.east + span.lng), inList(ownIds));
  } else {
    branchesRead = env.DB.prepare(
      `SELECT ${BRANCH_COLUMNS} FROM (SELECT l.*,ROW_NUMBER() OVER (PARTITION BY l.restaurant_id,l.region ORDER BY l.id) sampled FROM restaurant_locations l WHERE l.status='operating' AND l.restaurant_id ${IN_LIST}) l WHERE l.sampled<=? OR l.id ${IN_LIST}`,
    ).bind(inList(restaurantIds), BRANCHES_PER_REGION, inList(ownIds));
  }
  // As one batch: one subrequest of the fifty a request has, where five statements would be five.
  // An empty list reads nothing - a statement that would match nothing is not sent.
  const empty = <T>(): D1Result<T> => ({ results: [] as T[], success: true, meta: {} } as unknown as D1Result<T>);
  const [branchRows, eligibilityRows, terms, translationRows, totalRows] = dealIds.length
    ? await batched<[BranchRow, EligibilityRow, SearchTermRow, DealTranslationRow, { restaurant_id: string; n: number }]>([
      branchesRead,
      perBranchIds.length
        ? env.DB.prepare(`SELECT dl.deal_id,dl.location_id,dl.eligibility,dl.source_url FROM deal_locations dl WHERE dl.deal_id ${IN_LIST}`).bind(inList(perBranchIds))
        : null,
      env.DB.prepare(`SELECT entity_type,entity_id,term,weight FROM search_terms WHERE (entity_type='deal' AND entity_id ${IN_LIST}) OR (entity_type='restaurant' AND entity_id ${IN_LIST})`).bind(inList(dealIds), inList(restaurantIds)),
      env.DB.prepare(`SELECT deal_id,locale,title,description,schedule,price,terms,restrictions FROM deal_translations WHERE deal_id ${IN_LIST}`).bind(inList(dealIds)),
      // How many branches each chain has in all, counted over every one of them: what a card says
      // beside the few branches it carries.
      restaurantIds.length
        ? env.DB.prepare(`SELECT restaurant_id,COUNT(*) n FROM restaurant_locations WHERE status='operating' AND restaurant_id ${IN_LIST} GROUP BY restaurant_id`).bind(inList(restaurantIds))
        : null,
    ])
    : [empty<BranchRow>(), empty<EligibilityRow>(), empty<SearchTermRow>(), empty<DealTranslationRow>(), empty<{ restaurant_id: string; n: number }>()];
  const termsByDeal = terms.results.reduce((map, row) => {
    const key = `${row.entity_type}:${row.entity_id}`, list = map.get(key) || [];
    list.push({ term: foldSearch(String(row.term || "")), weight: row.weight });
    map.set(key, list);
    return map;
  }, new Map<string, Array<{ term: string; weight: number }>>());
  const translationsByDeal = translationRows.results.reduce((map, row) => {
    if (!isSupportedLocale(row.locale)) return map;
    const byLocale = map.get(row.deal_id) || {}; byLocale[row.locale] = row; map.set(row.deal_id, byLocale); return map;
  }, new Map<string, Partial<Record<SupportedLocale, DealTranslationRow>>>());
  const branchTotals = new Map(totalRows.results.map((row) => [row.restaurant_id, Number(row.n)]));
  const bases = buildBases(rows.map(normalizePlace), branchRows.results.map(normalizePlace), eligibilityRows.results, termsByDeal, branchTotals);
  return { key, bases, translationsByDeal, expiresAt: Date.now() + SNAPSHOT_TTL_MS, revision };
}

// City and region are normalized here, at the edge of the snapshot, rather than at each of the
// places that reads one.
//
// A city with a province or state still stuck on the end ("Austin, TX") is a second entry in
// `facets.cities`, a second suggestion in the app's place picker, and a second unit in the
// homepage's "N cities" count, even though it is the same city as the bare name beside it. A
// region written out in full ("Texas") is invisible to the `province=TX` filter below, which
// compares the two strings directly.
//
// Neither is written by the code any more — the deals editor strips a city suffix, the
// geocoders reduce a region to its code, and 0033 cleaned out the rows that had either — but
// that code is not the only way a row gets in. The seed scripts, the suggestion conversion, and
// a staff member with a SQL console all write these columns too. Doing it once on the way out
// means no later reader has to remember to. A null region stays null: the filter and the
// response already treat that as "not recorded", which is different from a blank string.
const normalizePlace = <T extends { city: string; region?: string | null }>(row: T) => ({
  ...row, city: canonicalCity(row.city), region: row.region ? regionCode(row.region) : row.region,
});

/** What the meta shard is built from: one slim row per public deal. */
interface MetaRow {
  id: string;
  city: string;
  address: string;
  restaurant_id: string | null;
  location_scope: string | null;
  verification_status: string;
  verified_at: string | null;
  restaurant: string;
  title: string;
  price: string;
  description: string | null;
  category: string;
  cuisine: string;
  terms: string | null;
  restrictions: string | null;
  schedule: string;
  canonical_restaurant_id: string | null;
  is_chain: number | null;
  national_chain: number | null;
  restaurant_country: string | null;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  country: string | null;
}

/**
 * The shard every request reads: markets, aliases, countries and the catalogue's counts. One slim
 * row per public deal - the columns the counts and the market centres need, two dozen of the
 * hundred a shard's deals carry - and nothing per branch.
 */
async function buildMeta(): Promise<DealsMeta> {
  const [revision, rows, coverageRows, aliasRows] = await Promise.all([
    readRevision(),
    env.DB.prepare(
      `SELECT d.id,d.city,d.address,d.restaurant_id,d.location_scope,d.verification_status,d.verified_at,COALESCE(r.name,d.restaurant) restaurant,d.title,d.price,d.description,d.category,d.cuisine,d.terms,d.restrictions,d.schedule,r.id canonical_restaurant_id,r.is_chain,r.national_chain,r.country restaurant_country,l.latitude,l.longitude,l.region,l.country FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id WHERE ${publicDealPredicate}`,
    ).all<MetaRow>(),
    env.DB.prepare("SELECT * FROM market_coverage").all<MarketCoverageRow>(),
    env.DB.prepare("SELECT alias_id,canonical_deal_id FROM deal_aliases").all<{ alias_id: string; canonical_deal_id: string }>(),
  ]);
  // Followed to the end, so a duplicate folded into a deal that was itself folded later still finds
  // the survivor. Bounded, because a loop written by hand in a SQL console must not hang a build.
  const aliasTargets = new Map((aliasRows.results || []).map((row) => [row.alias_id, row.canonical_deal_id] as const));
  const aliases = new Map<string, string>();
  for (const [alias, first] of aliasTargets) {
    let target = first;
    for (let hop = 0; hop < 5 && aliasTargets.has(target); hop++) target = aliasTargets.get(target)!;
    if (target !== alias) aliases.set(alias, target);
  }
  const places = rows.results.map(normalizePlace);
  const countries = [...new Set(places.flatMap((row) => {
    const country = shardCountry(String((row.location_scope === "national" ? row.restaurant_country : row.country) || "").toUpperCase());
    return country ? [country] : [];
  }))].sort();

  // The newest source check, which the results header prints as "Latest source check". Taken over
  // every public deal, and only from the deals a check was actually recorded on - verified ones,
  // including those gone stale since, whose date is still a real check. A needs_review deal's
  // verified_at is only the moment it was imported.
  let latestSourceCheck: string | null = null, latestMs = -Infinity;
  for (const row of places) {
    if (row.verification_status !== "verified" && row.verification_status !== "stale") continue;
    const at = row.verified_at ? parseSqlTimestamp(row.verified_at).getTime() : NaN;
    if (Number.isFinite(at) && at > latestMs) { latestMs = at; latestSourceCheck = row.verified_at; }
  }
  return {
    key: META_KEY,
    coverageRows: coverageRows.results,
    centers: marketCenters(coverageRows.results, places),
    aliases,
    countries,
    counts: { all: catalogCounts(places, false), separate: catalogCounts(places, true) },
    latestSourceCheck,
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    revision,
  };
}

/**
 * The homepage's "N restaurants · M cities", counted over the whole catalogue the way the local list
 * groups it: one card per chain, one per address of an independent, before any filter or place
 * narrows them, so the hero and the list's own "N matches" count one thing. A request answered from
 * one cell cannot count the rest, so the counts travel in the meta shard.
 *
 * Cities are the offers' own, not the cards' (a card's city moves to whichever branch is nearest
 * the reader), and `foodCities` leaves out a city whose every listing names a drink: a reader who
 * has hidden drinks sees neither the listings nor the city. A nationwide promotion has no city and
 * is in no city's count; with national chains in a section of their own (chains=separate), their
 * branch deals are out of the local list and out of both counts.
 */
function catalogCounts(rows: readonly MetaRow[], chainsSeparate: boolean): CountSet {
  const cards = new Set<string>(), cities = new Set<string>(), foodCities = new Set<string>();
  for (const row of rows) {
    if (row.location_scope === "national" || (chainsSeparate && row.national_chain)) continue;
    cards.add(!row.canonical_restaurant_id ? row.id : row.is_chain ? row.canonical_restaurant_id : `${row.canonical_restaurant_id}|${row.address}`);
    if (!row.city) continue;
    cities.add(row.city);
    if (!foodCities.has(row.city) && !referencesAlcohol(row)) foodCities.add(row.city);
  }
  return { cards: cards.size, cities: cities.size, foodCities: foodCities.size };
}

/**
 * The region codes in a national chain's footprint ({"TN": 214, ...}), or null when there is none
 * to read. Null is "not counted", and a request treats it as anywhere in the chain's country: a
 * reader shown a chain that turns out to have no branch near them has lost a click, where one never
 * shown a chain that does has lost the deal.
 */
function footprintRegions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const regions = Object.entries(parsed as Record<string, unknown>)
      .filter(([, count]) => Number(count) > 0)
      .map(([region]) => region.toUpperCase());
    return regions.length ? regions.sort() : null;
  } catch {
    return null;
  }
}

/** One branch as a location of one deal: the branch, and what that deal says about it. */
function locationOf(branch: Site, eligibility: string, source: string | null, deal: { source_url: string }): NormalizedLocation {
  return { city: branch.city, address: branch.address, postal_prefix: branch.postal_prefix, region: branch.region, source_url: source || deal.source_url, latitude: branch.latitude, longitude: branch.longitude, location_id: branch.location_id, eligibility, offer_available: eligibility === "confirmed", ...(branch.approximate ? { approximate: true as const } : {}) };
}

type EligibilityLookup = { get(id: string): readonly [string, string | null] | undefined };

/**
 * What one deal says about one branch. A 'brand' deal runs at every branch. Otherwise its own
 * deal_locations row decides, and with no row the branch at the deal's own address is confirmed
 * and every other one is not - the rule this route has always applied.
 */
function eligibilityAt(
  deal: { location_scope: string | null; address: string },
  explicit: EligibilityLookup | undefined,
  branch: BranchRow,
): readonly [string, string | null] {
  if (deal.location_scope === "brand") return ["confirmed", null];
  const row = explicit?.get(branch.location_id);
  if (row) return row;
  return [branch.address === deal.address ? "confirmed" : "unconfirmed", null];
}

/** The visitor-independent half of each deal, derived once per shard. */
function buildBases(
  publicRows: DealRow[],
  branchRows: BranchRow[],
  eligibilityRows: EligibilityRow[],
  termsByDeal: Map<string, Array<{ term: string; weight: number }>>,
  branchTotals: Map<string, number>,
): DealBase[] {
  // Pre-bucketed once instead of re-scanned per deal, which was an O(deals × locations) pass.
  const branchesByRestaurant = branchRows.reduce((map, row) => {
    const list = map.get(row.restaurant_id); if (list) list.push(row); else map.set(row.restaurant_id,[row]); return map;
  }, new Map<string, BranchRow[]>());
  const eligibilityByDeal = eligibilityRows.reduce((map, row) => {
    const byLocation = map.get(row.deal_id) || new Map<string, readonly [string, string | null]>();
    byLocation.set(row.location_id, [row.eligibility, row.source_url] as const); map.set(row.deal_id, byLocation); return map;
  }, new Map<string, Map<string, readonly [string, string | null]>>());

  return publicRows.map((row): DealBase => {
    // The two counts are the shard's measurement, not fields of the deal; they are read here and
    // become chain_location_count and participating_location_count below.
    const { confirmed_rows, own_confirmed, ...deal } = row;
    const normalizedRestaurant = deal.canonical_restaurant || deal.restaurant;
    const indexed = [...(termsByDeal.get(`deal:${deal.id}`) || []),...(termsByDeal.get(`restaurant:${deal.canonical_restaurant_id}`) || [])];
    const search_keywords = `${searchKeywords(deal)} ${indexed.map((item) => item.term).join(" ")}`;
    const common = {
      ...deal,
      restaurant: normalizedRestaurant,
      slug: deal.slug || deal.id,
      primary_city: deal.city,
      is_chain: !!deal.is_chain,
      national_chain: !!deal.national_chain,
      hidden_gem: !!deal.hidden_gem,
      chain_brand: normalizedRestaurant,
      search_keywords,
      price_tier: narrowPriceTier(deal.price_tier) ?? estimatePriceTier(deal.price),
      indexed,
      // Staff notes are never read past this point, and the snapshot is stored outside the
      // database. Overwritten rather than left out, so the field keeps its place in a row.
      internal_notes: null,
      // What a keyword search reads of the deal, normalized once - see DealBase.search_text.
      search_text: foldSearch(`${search_keywords} ${normalizedRestaurant} ${deal.title} ${deal.schedule} ${deal.price}`),
    };
    // A national deal has no location and no branches: its brand row says which country it is in
    // and which regions it trades in, and a request places it by those. See drizzle/0050.
    if (deal.location_scope === "national") {
      return {
        ...common,
        country: deal.restaurant_country,
        footprint_regions: footprintRegions(deal.restaurant_footprint),
        chain_location_count: 0,
        participating_location_count: 0,
        chain_locations: [],
        participating_locations: [],
        other_brand_locations: [],
      };
    }

    // Every restaurant_locations row sharing this deal's restaurant_id is a real location — no
    // guessing chain membership from a regex on the name. A restaurant with one location comes
    // back with exactly one row, so this is also the single-location path; the empty-array
    // fallback only fires for a deal with no restaurant_id at all, or whose chain has no branch in
    // reach of this shard.
    const branches = (deal.restaurant_id && branchesByRestaurant.get(deal.restaurant_id)) || [];
    const explicit = eligibilityByDeal.get(deal.id);
    const locations: NormalizedLocation[] = branches.length
      ? branches.map((branch) => { const [eligibility, source] = eligibilityAt(deal, explicit, branch); return locationOf(branch, eligibility, source, deal); })
      : [{ city: deal.city, address: deal.address, postal_prefix: deal.postal_prefix, region: deal.region, source_url: deal.source_url, latitude: deal.latitude, longitude: deal.longitude, location_id: deal.eligible_location_id, eligibility: "confirmed", offer_available: true }];
    const participating = locations.filter((location) => location.offer_available);
    // The totals are measured over every branch of the chain, however many this shard carries: the
    // chain's branches in all, and the ones that run the offer - all of them for a brand-wide deal,
    // else its confirmed rows plus its own address where no row says otherwise. Never fewer than
    // the shard itself holds.
    const total = (deal.restaurant_id && branchTotals.get(deal.restaurant_id)) || 0;
    const confirmed = deal.location_scope === "brand" ? total : Number(confirmed_rows || 0) + (own_confirmed ? 1 : 0);
    return {
      ...common,
      chain_location_count: Math.max(total, locations.length),
      participating_location_count: Math.max(confirmed, participating.length),
      chain_locations: locations,
      participating_locations: participating,
      other_brand_locations: locations.filter((location) => !location.offer_available),
    };
  });
}

function refreshSnapshot(cacheOrigin: string, key: string): Promise<Stored> {
  const running = buildsInFlight.get(key);
  if (running && Date.now() - running.startedAt < SNAPSHOT_BUILD_DEADLINE_MS) return running.promise;
  const build: Promise<Stored> = buildSnapshot(key)
    .then((stored) => {
      hold(stored);
      // Fresher than the colo's record, which may be five minutes old: a shard built from D1 at a
      // revision the colo has not learned yet is the current one, not a stale one to catch up.
      if (stored.revision) knownRevision = stored.revision;
      writeSharedSnapshot(cacheOrigin, stored);
      return stored;
    })
    // Never let one failed build poison later requests — clear the guard either way. Compared by
    // identity so an abandoned build that does eventually settle cannot clear the guard belonging
    // to the newer build that replaced it.
    .finally(() => { if (buildsInFlight.get(key)?.promise === build) buildsInFlight.delete(key); });
  buildsInFlight.set(key, { promise: build, startedAt: Date.now() });
  return build;
}

/**
 * Brings one shard up to date, preferring a copy another isolate in the colo has already built over
 * building one from D1, and a copy another colo built over that.
 *
 * Both ways a shard goes out of date used to go straight to a rebuild: a revision change, and the
 * TTL running out. Every isolate in a colo reaches either at about the same moment, so each one
 * read the whole catalogue out of D1 to build the same thing its neighbour had just published to
 * the Cache API under the same key. The shared copy is consulted first on every path, and D1 is
 * asked only when nobody has built this revision yet - or when the copy there is itself past its
 * TTL.
 *
 * Single-flight per shard, with the same deadline as the build, for the same reason: once the TTL
 * has run out every request comes through here until one of them finishes.
 */
function catchUp(cacheOrigin: string, key: string): Promise<Stored> {
  const running = catchUpsInFlight.get(key);
  if (running && Date.now() - running.startedAt < SNAPSHOT_BUILD_DEADLINE_MS) return running.promise;
  const attempt: Promise<Stored> = (async () => {
    // Learning which key to ask for is the cost of the key carrying the revision - usually the
    // colo's record of it, at most one small query - and it buys the thing a fixed key could not do:
    // a copy built before the last write is not merely detected, it is unaddressable, so no colo
    // can serve it by accident.
    const revision = knownRevision || (await currentRevision(cacheOrigin).catch(() => ""));
    if (revision) {
      knownRevision = revision;
      revisionCheckedAt = Date.now();
      // This colo's copy first, then the one another colo built, and D1 only when neither has it.
      for (const read of [() => readSharedSnapshot(cacheOrigin, key, revision), () => readGlobalSnapshot(cacheOrigin, key, revision)]) {
        const shared = await read();
        if (shared && shared.expiresAt > Date.now()) {
          hold(shared);
          return shared;
        }
      }
      return refreshSnapshot(cacheOrigin, key);
    }
    // D1 may be refusing reads, which is when this path matters most. A revision we cannot learn
    // falls back to the copy published under the fixed name, then to whatever R2 holds — knowingly
    // stale, and far better than the 500 a cold isolate used to return during an outage.
    const fallback = (await readFallbackSnapshot(cacheOrigin, key)) ?? (await readGlobalSnapshot(cacheOrigin, key, null));
    if (!fallback) return refreshSnapshot(cacheOrigin, key);
    hold(fallback);
    return fallback;
  })().finally(() => { if (catchUpsInFlight.get(key)?.promise === attempt) catchUpsInFlight.delete(key); });
  catchUpsInFlight.set(key, { promise: attempt, startedAt: Date.now() });
  return attempt;
}

/**
 * Has the data changed under the shards we are holding?
 *
 * Runs at most once every REVISION_CHECK_MS per isolate and never blocks the request that triggers
 * it: a moved revision marks what is held as out of date and starts catching the held shards up
 * behind the request; a request that arrives before that finishes serves the shard it has and the
 * catch-up replaces it (loadSnapshot). A visitor is owed deals, not the freshest possible deals,
 * and the difference is bounded by the response's own sixty-second max-age either way.
 */
function checkRevision(cacheOrigin: string) {
  // Only ever asked about shards we are holding. On a cold isolate there is nothing to compare
  // against; the cold path learns the revision for itself.
  if (!knownRevision) return;
  if (Date.now() - revisionCheckedAt < REVISION_CHECK_MS) return;
  revisionCheckedAt = Date.now();
  try {
    waitUntil(
      currentRevision(cacheOrigin)
        .then((revision) => {
          // An empty revision means the query failed to produce one; moving to that would rebuild forever.
          if (!revision || revision === knownRevision) return;
          knownRevision = revision;
          // Every shard held at the old revision is caught up now, behind this request, rather than
          // behind the next request about each: an edit staff just made is then in hand for the
          // next request, and a shard nobody asks for again costs one shared-cache read.
          const behind = [...held.values()].filter((stored) => stored.revision !== revision);
          return Promise.allSettled(behind.map((stored) => catchUp(cacheOrigin, stored.key)));
        })
        .catch(() => {}),
    );
  } catch {
    // No request context to hang it on. The TTL is still a backstop.
  }
}

/** One shard, from this isolate if it holds it, else from wherever it can be found. */
async function loadSnapshot(cacheOrigin: string, key: string): Promise<Stored> {
  // Asked on every path, including the fresh one. A shard inside its TTL can still be wrong -
  // that is exactly what a staff edit makes it - and the TTL alone cannot tell the difference
  // between old and wrong.
  checkRevision(cacheOrigin);
  const stored = held.get(key);
  if (stored) {
    hold(stored);
    // Current while it names the revision this isolate knows, or while nobody knows one.
    if ((!knownRevision || stored.revision === knownRevision) && stored.expiresAt > Date.now()) return stored;
    // Stale but present: serve it now and let a single background catch-up replace it. Without
    // this, a concurrent burst arriving right as the revision moves would all block together on a
    // fresh rebuild, a stampede that can push the Worker past its resource limits under load.
    try { waitUntil(catchUp(cacheOrigin, key)); } catch { /* no request context */ }
    return stored;
  }
  // Nothing in memory. Before spending D1 queries, ask whether another isolate in this colo has
  // already built one — after a deploy, one of them almost certainly has — and then whether another
  // colo has.
  return catchUp(cacheOrigin, key);
}

/** The shards a request reads, loaded together. */
async function loadShards(cacheOrigin: string, keys: readonly string[]): Promise<DealsShard[]> {
  const loaded = await Promise.all(keys.map((key) => loadSnapshot(cacheOrigin, key)));
  return loaded.filter((stored): stored is DealsShard => !isMeta(stored));
}

async function loadMeta(cacheOrigin: string): Promise<DealsMeta> {
  const stored = await loadSnapshot(cacheOrigin, META_KEY);
  if (!isMeta(stored)) throw new Error("the meta shard is not meta");
  return stored;
}

/**
 * The deals of several shards as one list, each deal once. A deal confirmed at branches in two cells
 * is in both; the first copy met is kept, which is why cellsWithin puts the reader's own cell first.
 */
function mergeShards(shards: readonly DealsShard[]): DealBase[] {
  if (shards.length === 1) return shards[0].bases;
  const seen = new Set<string>();
  const bases: DealBase[] = [];
  for (const shard of shards) {
    for (const base of shard.bases) {
      if (seen.has(base.id)) continue;
      seen.add(base.id);
      bases.push(base);
    }
  }
  return bases;
}

// A restaurant offering several distinct deals (a happy hour AND a trivia night, say) rightly
// gets a card per deal — chains already get compacted into one card upstream, but non-chain
// multi-deal restaurants don't, so their cards can otherwise land back-to-back in "Recommended"
// whenever two of their deals score identically (most commonly: verified in the same batch).
// Adjacent same-restaurant cards read as duplicated content to a first-time visitor even though
// the data is correct, so this spreads each restaurant's own deals apart by round-robining
// across restaurants while preserving each restaurant's own relative priority order.
function diversifyByRestaurant(deals: GroupedDeal[]): GroupedDeal[] {
  const order: string[] = [], buckets = new Map<string,GroupedDeal[]>();
  for (const deal of deals) {
    const key = deal.restaurant_id || deal.restaurant;
    if (!buckets.has(key)) { buckets.set(key,[]); order.push(key); }
    buckets.get(key)!.push(deal);
  }
  const result: GroupedDeal[] = [];
  for (let round = 0; result.length < deals.length; round++) {
    for (const key of order) { const bucket = buckets.get(key)!; if (bucket[round]) result.push(bucket[round]); }
  }
  return result;
}

function offerKey(deal: Pick<DealBase, "id" | "is_chain" | "canonical_restaurant_id" | "title" | "category" | "schedule" | "price">) {
  return deal.is_chain && deal.canonical_restaurant_id
    ? [deal.canonical_restaurant_id,deal.title,deal.category,deal.schedule,deal.price].map((value) => normalizeSearch(String(value || ""))).join("|")
    : deal.id;
}

function chainOffer(deal: GroupedDeal): ChainOffer {
  return {
    id: deal.id,
    slug: deal.slug,
    title: deal.title,
    price: deal.price,
    schedule: deal.schedule,
    availability: deal.availability,
    available_today: deal.available_today,
    available_now: deal.available_now,
    availability_phase: deal.availability_phase,
    redemption: deal.redemption ?? null,
    redemption_note: deal.redemption_note ?? null,
    promo_code: deal.promo_code ?? null,
    expires_at: deal.expires_at ?? null,
    expiry_timezone: deal.expiry_timezone ?? null,
    location_scope: deal.location_scope ?? null,
    city: deal.city,
    // The snapshot's own total where it measured one, as capDealLocations reads it.
    participating_location_count: deal.location_scope === "national"
      ? null
      : Math.max(deal.participating_location_count ?? 0, deal.participating_locations.length),
  };
}

// Whether two offers on one brand's card are one offer worded twice. Boston Pizza's Pasta Tuesday
// is "Pasta from $11.99" on its promotions page, "Gourmet pasta or custom creations from $11.99"
// beside it, and "From $11.99" at twelve branches out west: three lines on the card saying one
// thing, which offerKey keeps apart because it compares the words. The same title on the same days
// and hours, for the same amounts, redeemed the same way, is one offer however it was written. Any
// difference in those - a later close on Fridays, another price - keeps its own line, unless the
// difference is only when, at different branches: see samePromotionKey.
function sameOfferKey(deal: GroupedDeal) {
  return `${samePromotionKey(deal)}|${scheduleShape(String(deal.schedule || ""))}`;
}

// The offer without its days and hours. Earls runs one happy hour, but not at one time: 3-6 PM at
// one restaurant and 3-5 PM at the next, with a later close on weekends at some. Each branch's row
// is right about its own branch, and a line for each time read as five happy hours. The grouping
// makes them one line that says the schedule varies - but only across branches, so two rows for
// one restaurant at different times are still two lines, where a wrong one can be seen.
function samePromotionKey(deal: GroupedDeal) {
  const price = String(deal.price || "");
  const amounts = price.match(/\d+(?:\.\d+)?/g)?.map((amount) => String(Number(amount))).join(",");
  return [
    normalizeSearch(deal.title),
    amounts || normalizeSearch(price),
    String(deal.redemption || "").toLowerCase(),
    String(deal.promo_code || "").toUpperCase(),
  ].join("|");
}

/**
 * Every city a card has an offer in, as its offers name them - see facetsFor and cityCount. A
 * nationwide promotion has no city, and is in no city's count.
 */
function offerCities(deal: GroupedDeal) {
  const cities = new Set<string>();
  for (const offer of deal.brand_offers) if (offer.city) cities.add(offer.city);
  return cities;
}

/**
 * The filter sheet's counts. `citiesByOffer` is for a request that names no place: then a city is
 * counted for every card with an offer there, not only for the city the card happens to lead with.
 *
 * The phone's place picker is this list, asked for with no place (mobile/lib/places.ts), and it
 * promises every city in the catalogue. Counted by lead it was 38 cities of 52: a chain is one card,
 * led from one city, and Winnipeg - three listings, each a branch of a chain whose card leads from
 * somewhere else - was not in the picker at all, with Kitchener, Kingston, Sudbury and ten more,
 * while the homepage beside it counted all 52. Where the request is placed, a card is at the branch
 * nearest the reader, and that branch's city is the one worth counting: a chain's offers in other
 * provinces are not somewhere this search reaches.
 */
function facetsFor(deals: GroupedDeal[], citiesByOffer: boolean) {
  const count = (key: "cuisine" | "category" | "primary_city" | "effective_verification_status") => Object.entries(deals.reduce((map, deal) => {
    const value = String(deal[key] || "Unknown"); map[value] = (map[value] || 0) + 1; return map;
  }, {} as Record<string, number>)).map(([value,total]) => ({ value, total }));
  const cityTotals = () => {
    const totals = new Map<string, number>();
    for (const deal of deals) for (const city of offerCities(deal)) totals.set(city, (totals.get(city) || 0) + 1);
    return [...totals].map(([value, total]) => ({ value, total }));
  };
  // price_tier is a number and may be null, so it cannot go through `count` above, which keys
  // on string columns and folds missing values into an "Unknown" bucket.
  const priceTiers = deals.reduce((map, deal) => {
    if (deal.price_tier == null) return map;
    map[deal.price_tier] = (map[deal.price_tier] || 0) + 1;
    return map;
  }, {} as Record<number, number>);
  const serviceStyles = deals.reduce((map, deal) => {
    if (deal.service_style !== "quick" && deal.service_style !== "sit_down") return map;
    map[deal.service_style] = (map[deal.service_style] || 0) + 1;
    return map;
  }, {} as Record<string, number>);
  return { cuisines: count("cuisine"), categories: count("category"), cities: citiesByOffer ? cityTotals() : count("primary_city"), verification: count("effective_verification_status"),
    priceTiers: Object.entries(priceTiers).map(([value,total]) => ({ value: Number(value), total })).sort((a,b) => a.value - b.value),
    serviceStyles: Object.entries(serviceStyles).map(([value,total]) => ({ value, total })) };
}

// How many distinct offers a market holds, for market_coverage.minimum_offers: the deals with a
// confirmed branch within reach of where the request resolved, counted as the homepage counts
// offers (offerKey, so a chain's promotion stored once per branch is one). Every deal, not the ones
// that passed this request's filters - coverage describes the area, and a reader who filtered to
// oysters has not found a thinner market. National promotions are left out: they run everywhere,
// and a market is not covered by the chains that trade in every market.
//
// Counted only as far as `enough`, the market's minimum: the question is whether it has that many,
// and a covered market answers it in its first few dozen deals. Asked on nearly every located
// search now that a point finds its market, and a chain deal's key is five normalized fields
// joined, so each key is kept beside the deal it was worked out for, for as long as that deal's
// shard is held - and only for the deals a request reached.
const OFFER_KEYS = new WeakMap<DealBase, string>();
function marketOfferCount(deals: readonly NormalizedDeal[], baseById: Map<string, DealBase>, reachKm: number, enough: number) {
  const offers = new Set<string>();
  for (const deal of deals) {
    if (deal.location_scope === "national" || deal.distance_km == null || deal.distance_km > reachKm) continue;
    const base = baseById.get(deal.id);
    let key = base && OFFER_KEYS.get(base);
    if (key === undefined) {
      key = offerKey(deal);
      if (base) OFFER_KEYS.set(base, key);
    }
    offers.add(key);
    if (offers.size >= enough) break;
  }
  return offers.size;
}

/** What the schedule readers in app/search.ts say about a deal at one moment. */
type Availability = NonNullable<ReturnType<typeof availabilityFromStructuredSchedule>> | ReturnType<typeof availabilityFromSchedule>;

// Each deal's availability, kept for the rest of the minute it was worked out in.
//
// Every request read every deal's schedule against the clock - its timed row, else its text - to
// say whether it is on now, later today or not today, and in which words: about half the cost of
// the per-deal copy below. Requests arrive many to a minute under load, and within a minute they
// all get the same answers.
//
// Kept to the minute because that is exactly what the readers see of `now`: the time where the
// venue is, as a weekday, a date, an hour and a minute (localPartsIn in app/search.ts). Every zone
// in use is a whole number of minutes from UTC, so one minute of UTC is one local minute everywhere,
// and an answer from earlier in the same UTC minute is the answer. It is kept per zone and per
// locale as well, since a national offer is read in the reader's zone and the line is worded in
// theirs. An offer's own end date is not in here: that can fall mid-minute, and is asked per request.
//
// Kept beside the deal itself, in a WeakMap keyed by the snapshot's own object for it: a rebuilt
// shard is new objects, which start with no answers, so an edit to a schedule is read afresh.
const AVAILABILITY = new WeakMap<DealBase, Array<{ zone: string | null; locale: SupportedLocale; minute: number; value: Availability }>>();
/** The zones and locales one deal's answers are kept for at once - a bound, not an expectation. */
const AVAILABILITY_PER_DEAL_MAX = 8;

function availabilityReader(now: Date, locale: SupportedLocale) {
  const minute = Math.floor(now.getTime() / 60_000);
  return (deal: DealBase, zone: string | null): Availability => {
    let answers = AVAILABILITY.get(deal);
    if (!answers) AVAILABILITY.set(deal, answers = []);
    const known = answers.find((answer) => answer.zone === zone && answer.locale === locale);
    if (known && known.minute === minute) return known.value;
    const value = availabilityFromStructuredSchedule(deal.schedule_days,deal.start_time,deal.end_time,zone,now,locale) || availabilityFromSchedule(deal.schedule,now,zone,locale);
    if (known) Object.assign(known, { minute, value });
    else {
      if (answers.length >= AVAILABILITY_PER_DEAL_MAX) answers.length = 0;
      answers.push({ zone, locale, minute, value });
    }
    return value;
  };
}

// referencesAlcohol's answer for each deal and each card, kept for the life of the deal's shard.
//
// The phone sends hideAlcohol=true on every deal read unless its reader has told the age gate they
// may see drinks (withAudience in mobile/lib/api.ts), and a request that hides drinks asked the
// check about most of the catalogue two or three times over: once to prune each card's offers,
// again for every offer left while the card's lead was chosen, and once per card in the final
// filter. Each answer runs up to a dozen Unicode-aware patterns over a deal's printed copy, and
// together they were 1.6 ms of the 4.3 ms a located phone search took locally - several times that
// in production, on the request a phone sends by default.
//
// Nothing the check reads changes from one request to the next. A deal's words are the snapshot's:
// each request's copy of a deal adds its live half (availability, distance, relevance) and never
// writes them. So a deal's answer is kept beside the snapshot's own object for it, and a rebuilt
// shard - new objects - starts again. A card is the words of the deal it leads with plus the offers
// it lists, and is kept beside its lead by the ids of those offers.
//
// Either is kept only after confirming that what is in hand prints exactly the snapshot's words:
// a deal its own row's, a card its lead's, and each of a card's offers its own deal's. The words
// are compared with the snapshot's rows themselves (`baseById`), not with the request's copy of
// each deal - a change that rewrote the request's copy, the natural place to translate a deal into
// the reader's language, would rewrite the thing compared with as well, and the first locale to
// ask in a snapshot would decide every other's. Compared with the snapshot, a rewritten copy is
// asked afresh: that change would cost speed here, never a wrong answer. Today every copy prints
// its row's words, the translation is laid over after the filter, and the comparison is nine string
// checks.
//
// "Exactly" is every field the check reads, PRINTED_FIELDS: READABLE_FIELDS in app/alcohol.ts, the
// list its `Readable` type is built from, so a field the check starts to read is compared here too.
// The list used to be a copy kept here by hand, which a new field would have passed by: a card's
// branch address, say, is the reader's nearest, and the first reader's would have decided the card
// for everyone until the next snapshot.
const DEAL_VERDICTS = new WeakMap<DealBase, boolean>();
const CARD_VERDICTS = new WeakMap<DealBase, Map<string, boolean>>();
/** The most cards one deal is remembered leading at once - a bound, not an expectation. */
const CARD_VERDICTS_PER_DEAL_MAX = 32;

function drinkVerdicts(baseById: Map<string, DealBase>) {
  // The snapshot's row for deal `id`, when `copy` prints its words in every field the check reads.
  const printing = (copy: NormalizedDeal | GroupedDeal, id: string) => {
    const row = baseById.get(id);
    return row && PRINTED_FIELDS.every((field) => copy[field] === row[field]) ? row : undefined;
  };
  return (deal: NormalizedDeal | GroupedDeal): boolean => {
    const offers = "brand_offers" in deal ? deal.brand_offers : undefined;
    const row = printing(deal, deal.id);
    // One deal: every caller passes the request's copy of it today - the pruning, the offers a card
    // may lead with, the nationwide list - and a copy that no longer prints its row's words is asked
    // afresh rather than given the verdict those words had.
    if (!offers) {
      if (!row) return referencesAlcohol(deal);
      let verdict = DEAL_VERDICTS.get(row);
      if (verdict === undefined) DEAL_VERDICTS.set(row, verdict = referencesAlcohol(deal));
      return verdict;
    }
    const faithful = !!row && offers.every((offer) => {
      const own = baseById.get(offer.id);
      return !!own && offer.title === own.title && offer.price === own.price && offer.category === own.category;
    });
    if (!faithful || !row) return referencesAlcohol(deal);
    let cards = CARD_VERDICTS.get(row);
    if (!cards) CARD_VERDICTS.set(row, cards = new Map());
    const key = offers.map((offer) => offer.id).join("|");
    let verdict = cards.get(key);
    if (verdict === undefined) {
      if (cards.size >= CARD_VERDICTS_PER_DEAL_MAX) cards.clear();
      cards.set(key, verdict = referencesAlcohol(deal));
    }
    return verdict;
  };
}

// Whole answers are shared across a colo's anonymous readers: see app/deals-answer.ts, which holds
// the key, the lifetime and the two copies (the colo's and the reader's), for this route and for
// the Worker's entry, which reads the shared copy ahead of the framework.

// A device point names no state or province, and the nationwide list places chains by one: without
// it a Knoxville reader was shown Del Taco and Carl's Jr., neither of which has a restaurant in
// Tennessee. The visitor's network usually knows. It is taken when it is in the point's country and
// places the visitor within NETWORK_REGION_KM of the point - a reader on a VPN, or travelling on
// their home network, is left unplaced, and shown every chain, rather than placed in the wrong state.
function networkRegionAt(network: Network, point: { latitude: number; longitude: number }, market: string): string | null {
  if (!network.region || !network.point || network.country !== market) return null;
  return kmBetween(point, network.point) <= NETWORK_REGION_KM ? regionCode(network.region) : null;
}

// `new Date(value).getTime()`, kept per string. A stored timestamp is "2026-09-29 12:00:00", which
// is not the ISO form, so the engine reads it with its slow general-purpose parser: 400 comparisons
// of two such dates took 0.26 ms locally. The grouping makes one for every deal it merges into a
// card - 149 to 249 a request over a copy of production's catalogue - and the two date sorts one per
// step, over values that are the same few hundred strings on every request. The answer depends on
// the string alone (and the runtime's own zone, which does not change under it), so a kept one is
// the answer; the bound is only a bound.
const PARSED_TIMES = new Map<string | null | undefined, number>();
const PARSED_TIMES_MAX = 4096;
function timeOf(value: string | null | undefined): number {
  let time = PARSED_TIMES.get(value);
  if (time === undefined) {
    if (PARSED_TIMES.size >= PARSED_TIMES_MAX) PARSED_TIMES.clear();
    PARSED_TIMES.set(value, time = new Date(value as string).getTime());
  }
  return time;
}

// What people searched for, and whether Radar could answer it.
//
// Recorded here rather than in the client because this is the only place that knows both halves:
// the normalized query, and how many deals actually matched it. The rows worth having are the ones
// with `matches: 0` - they name inventory the catalog is missing, which is the difference between
// guessing at what to source next and reading it off a list.
//
// waitUntil, so a reader never waits on a write they will never see.
function recordSearch(event: { market: string | null; properties: string }) {
  try {
    waitUntil(
      env.DB.prepare("INSERT INTO product_events(id,type,market,properties) VALUES(?,?,?,?)")
        .bind(crypto.randomUUID(), "search", event.market, event.properties)
        .run()
        .catch(() => {}),
    );
  } catch {
    // No request context to hang it on.
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const answerKey = sharedAnswerKey(request, url);
  const answers = answerKey ? snapshotCache() : null;
  if (answers && answerKey) {
    const hit = await answers.match(answerKey).catch(() => undefined);
    if (hit) {
      const { answer, searchEvent } = answerFromShared(hit);
      if (searchEvent) {
        try { recordSearch(JSON.parse(searchEvent)); } catch { /* a torn header is not worth an error */ }
      }
      return answer;
    }
  }
  // Capped: nobody searches with a paragraph, and the query is normalized, tokenized and scored
  // against every deal in the catalogue.
  const q = (url.searchParams.get("q")?.trim() || "").slice(0, 200);
  const postal = normalizedPostal(url.searchParams.get("postal"));
  const requestedCity = url.searchParams.get("city")?.trim() || "";
  // Through regionCode for the same reason the stored column is: the filter below compares the two
  // strings directly, so "province=Texas" and "province=tx" have to arrive as the "TX" every row
  // now holds or they match nothing at all.
  const requestedProvince = regionCode(url.searchParams.get("province"));
  const requestedCountry = url.searchParams.get("country")?.trim().toUpperCase() || "";
  const requestedLocale = url.searchParams.get("locale");
  const locale: SupportedLocale = isSupportedLocale(requestedLocale) ? requestedLocale : "en";
  const latitude = optionalCoordinate(url.searchParams.get("lat"), -90, 90);
  const longitude = optionalCoordinate(url.searchParams.get("lng"), -180, 180);
  const devicePoint = latitude != null && longitude != null
    ? { latitude, longitude } : null;
  if (postal && !validPostal(postal)) return Response.json({ error: { code: "INVALID_LOCATION", message: "Enter a complete Canadian postal code or US ZIP code." } }, { status: 422 });
  // Restaurants a signed-in visitor has chosen to hide from their own search results
  // (Dashboard → Restaurant preferences). Read per-request rather than folded into the
  // shared snapshot below, since that snapshot is cached across every visitor.
  const signedInUser = await getAppUser();
  // The ceiling follows the plan. 50 km is what the plans page sells as Pro, and the pickers offer
  // it only to Pro (allowedRadii); this used to clamp to the Pro ceiling for every caller, so
  // anyone - signed out included - got the Pro reach by editing the query string. Clamped rather
  // than refused, so a Pro session that lapses mid-visit still gets results at 25, and an old link
  // asking for 100 km still searches.
  const searcherPro = Boolean(signedInUser && isPro(signedInUser));
  const maxRadius = maxRadiusKm(searcherPro);
  const radius = clampRadius(url.searchParams.get("radius"), searcherPro);
  const excludedRestaurantIds = signedInUser
    ? new Set((await env.DB.prepare("SELECT restaurant_id FROM excluded_restaurants WHERE user_id=?").bind(signedInUser.userId).all<{ restaurant_id: string }>()).results.map((row) => row.restaurant_id))
    : new Set<string>();
  // Ahead of resolving the place, because a typed city is resolved against the markets it names.
  // The deals themselves come after: which shards of the snapshot a request reads depends on where
  // it resolved to and what it asks for.
  isolateRequests += 1;
  const arrivedWarm = held.size > 0;
  const meta = await loadMeta(url.origin);
  const { coverageRows, aliases, centers } = meta;

  // A bare point is the reader's own position: it names no country and no clock, and both used to
  // default to Canada's - Toronto time and Canada's chains for a reader in Knoxville. Its country is
  // read off the map (app/country-at.ts), and its clock is the one the client sent, else its
  // network's where that network is in the same country, else a guess by longitude.
  const network = networkOf(request);
  const requestedTimezone = knownTimezone(url.searchParams.get("tz"));
  const deviceMarket = devicePoint ? requestedCountry || deviceCountry(devicePoint.latitude, devicePoint.longitude, network.country) || "" : "";
  const deviceZone = devicePoint
    ? requestedTimezone ||
      (network.timezone && network.country === deviceMarket ? knownTimezone(network.timezone) : null) ||
      roughTimezone(deviceMarket === "US" || deviceMarket === "CA" ? deviceMarket : null, devicePoint.latitude, devicePoint.longitude)
    : "";
  // Its state or province, for the nationwide list alone - see networkRegionAt.
  const deviceRegion = devicePoint && !requestedProvince && url.searchParams.get("scope") === "national" ? networkRegionAt(network, devicePoint, deviceMarket) : null;
  const { guard, state: geocodeState } = requestGeocodeGuard();
  const resolvedLocation: ResolvedLocation | null = devicePoint
    ? { ...devicePoint, city: requestedCity || "Current location", region: requestedProvince, country: deviceMarket, timezone: deviceZone, accuracy: "device" as const }
    : postal ? await resolvePostal(postal, guard)
    : requestedCity ? await resolveCityText(requestedCity, guard, coverageRows)
    : null;
  if (geocodeState.refused) return Response.json({ error: { code: "RATE_LIMITED", message: "Too many location searches — try again in a few minutes." } }, { status: 429 });
  if (postal && !resolvedLocation) return Response.json({ error: { code: "UNSUPPORTED_LOCATION", message: "That postal or ZIP code is outside current coverage." } }, { status: 404 });
  if (requestedCity && !postal && !resolvedLocation) return Response.json({ error: { code: "UNSUPPORTED_LOCATION", message: "That city isn't recognized — try a nearby supported city or a postal/ZIP code." } }, { status: 404 });
  // The clock a national offer is read against. It has no branch and so no zone of its own, and
  // read in Toronto's, a "Tuesday only" offer turned over at 9 PM on Monday for a reader in Los
  // Angeles. A deal with a branch keeps the branch's zone: that is where it is redeemed.
  const readerTimezone = resolvedLocation?.timezone || requestedTimezone || null;

  // Hoisted out of the loop: `now` so that every deal in one response is judged against the same
  // instant rather than drifting across the map, and the query normalization because it does not
  // depend on the deal.
  const now = new Date();
  const nowMs = now.getTime();
  const origin = resolvedLocation ? { latitude:resolvedLocation.latitude,longitude:resolvedLocation.longitude } : devicePoint;
  const normalizedQuery = normalizeSearch(q);

  // Fetch specific deals by id or slug. Added for the mobile Saved tab, which holds a list of
  // favorited ids and would otherwise have to request each one separately — a phone firing
  // dozens of parallel requests to render one screen. Everything else about the pipeline applies
  // unchanged, so a saved deal that is no longer public simply does not come back.
  // The app asks for its Saved list in pages of 50, the largest page this answers; ids past that
  // could only cost matching time.
  const ids = new Set(parseList(url.searchParams.getAll("id")).slice(0, MAX_REQUESTED_IDS));
  // And a saved deal that was folded into another as a duplicate (drizzle/0056) comes back as the
  // deal it was folded into, the way its page and the favorite button already resolve it. Asked for
  // by the old id alone it used to come back as nothing, so a Saved list lost it without a word.
  const wantedIds = new Set(ids);
  for (const id of ids) {
    const canonical = aliases.get(id);
    if (canonical) wantedIds.add(canonical);
  }
  const wanted = (deal: { id: string; slug: string | null }) => wantedIds.has(deal.id) || Boolean(deal.slug && wantedIds.has(String(deal.slug)));
  // Deal vertical the navbar's category switcher is scoped to (restaurants, retail, ...).
  // Defaults to "restaurant" so existing links/behavior are unchanged for the current data.
  const vertical = (url.searchParams.get("vertical") || "restaurant").trim().toLowerCase();
  // Nationwide chain promotions - 'national' deals, which have no location - are asked for on their
  // own, one card per offer. Mixed into the local feed they would sit at no distance among cards that
  // each name a branch, and every client that plots, measures or groups by branch would have had to
  // learn them before the first one shipped. See drizzle/0050. A saved one still comes back by id.
  const nationalOnly = url.searchParams.get("scope") === "national";
  // A client that shows national chains in a section of their own - the homepage's NationalDeals -
  // says so, and both lists change with it: the local one leaves national chains out, and the
  // nationwide one takes in their branch deals near the reader beside the promotions with no
  // branch at all. That is what gives Canada the section, where every chain deal has a branch.
  // Without it both lists are as they were, which is what the phone app still asks for.
  const chainsSeparate = url.searchParams.get("chains") === "separate";
  // And the nationwide list as a card per brand rather than per offer - see where it is grouped,
  // after the sort. Only the nationwide list is grouped this way; the local one is already a card
  // per place.
  const groupByBrand = url.searchParams.get("group") === "brand";

  // The shards of the snapshot this request reads - see DealsShard. A request for deals by id reads
  // a shard built for those ids alone; a nationwide list its country's promotions, and with national
  // chains in their own section their branch deals as the local list would find them: the cells
  // around a placed reader, else the country; a placed search the cells its reach covers; and a
  // search with no place its country, or every country the catalogue has deals in.
  //
  // Few, on purpose: the free plan allows a request fifty subrequests, and a shard read, a D1 query
  // and a cache write are each one. A placed search is the meta shard and at most six cells.
  //
  // Reach is at least the default radius, because the market-coverage verdict below is measured
  // over that much whatever the reader narrowed to.
  const reachKm = Math.max(radius, COVERAGE_REACH_KM);
  const requestedShardCountry = shardCountry(requestedCountry);
  const countryKeys = (country: string | null) => (country ? [country] : meta.countries).map(countryKey);
  let shards: DealsShard[];
  if (ids.size) {
    shards = [await buildShard("ids", { kind: "ids", ids: [...wantedIds], point: origin })];
  } else if (nationalOnly) {
    const marketCountry = requestedShardCountry || shardCountry(String(resolvedLocation?.country || "").toUpperCase());
    const keys = (marketCountry ? [marketCountry] : meta.countries).map(nationalKey);
    if (chainsSeparate) keys.push(...(origin ? cellsWithin(origin, reachKm) : countryKeys(marketCountry)));
    shards = await loadShards(url.origin, keys);
  } else {
    shards = await loadShards(url.origin, origin ? cellsWithin(origin, reachKm) : countryKeys(requestedShardCountry));
  }
  const bases = mergeShards(shards);
  // The snapshot's own object for each deal, which the memories below are kept beside.
  const baseById = new Map(bases.map((base) => [base.id, base]));
  const translationOf = (id: string) => {
    for (const shard of shards) {
      const translation = shard.translationsByDeal.get(id);
      if (translation) return translation;
    }
    return undefined;
  };

  // Each deal's schedule against the clock, from what this minute already worked out - see AVAILABILITY.
  const availabilityOf = availabilityReader(now, locale);
  const raw = bases.map((base): NormalizedDeal => {
    // A deal past its own expires_at can still be `status='live'` for up to
    // EXPIRY_GRACE_PERIOD_DAYS until the cleanup cron catches up — the time-of-day schedule
    // check has no idea about that and would otherwise call it "Available now" the moment
    // today's happy-hour window opens, contradicting the "Recently ended" badge on the same card.
    const isPastExpiry = !!base.expires_at && parseSqlTimestamp(base.expires_at).getTime() <= nowMs;
    const zone = base.timezone || (base.location_scope === "national" ? readerTimezone : null);
    const available = isPastExpiry
      ? { eligibleToday: false, availableNow: false, phase: "ended" as const, label: dealLabels(locale).offerEnded, tonight: false }
      : availabilityOf(base, zone);
    const eligibleDistances = origin ? base.chain_locations.filter((location) => location.offer_available && location.latitude != null && location.longitude != null).map((location) => kmBetween(origin,{latitude:Number(location.latitude),longitude:Number(location.longitude)})) : [];
    const metadataWeight = normalizedQuery ? base.indexed.reduce((total,item) => item.term.includes(normalizedQuery) ? total + Number(item.weight || 0) : total,0) : 0;
    return {
      ...base,
      // The 30-day "stale" label, read against the clock here rather than fixed when the shard was
      // built, so that a check ageing past thirty days shows as stale without a rebuild (the
      // revision used to carry the date for this, and rebuilt every colo's snapshot at midnight).
      effective_verification_status: base.under_review
        ? "stale"
        : base.verification_status === "verified" && nowMs - timeOf(base.verified_at) > STALE_AFTER_MS ? "stale" : base.verification_status,
      distance_km: eligibleDistances.length ? Math.min(...eligibleDistances) : null,
      availability: available.label,
      available_today: available.eligibleToday,
      available_now: available.availableNow,
      availability_phase: available.phase,
      tonight: available.tonight,
      search_score: relevanceOfNormalized(base.search_text,q,base.restaurant,base.title) + metadataWeight,
      expiry_timezone: expiryTimeZone(base),
    };
  });
  const rawById = new Map(raw.map((deal) => [deal.id, deal]));
  // What the drink filter says of a deal or a card, from the snapshot's memory where it can be.
  const drinkVerdict = drinkVerdicts(baseById);
  function offerSummary(deal: NormalizedDeal): OfferSummary {
    return { id: deal.id, slug: deal.slug, title: deal.title, price: deal.price, schedule: deal.schedule, category: deal.category, address: deal.address, city: deal.city, source_url: deal.source_url, available_today: deal.available_today };
  }
  const cuisines = parseList(url.searchParams.getAll("cuisine"));
  const categories = parseList(url.searchParams.getAll("category"));
  // Three price tiers, multi-select like cuisine/category. Matching happens against the same
  // effective tier the response exposes (staff-set price_tier, else estimatePriceTier of the
  // free-text price), so a deal can never be filtered by one number and displayed with another.
  // Narrowed, not range-checked. A ?priceTier=4 link written while the site had five tiers would
  // otherwise leave the set empty, and an empty set means "no price filter" - so the one request
  // that asked for the most expensive deals came back with the entire catalog. Folding it onto
  // $$$ is the answer that link was asking for.
  const priceTiers = new Set(parseList(url.searchParams.getAll("priceTier"))
    .map((value) => narrowPriceTier(Number(value)))
    .filter((tier): tier is number => tier != null));
  // Fast food or a sit-down meal. Multi-select like the others, so asking for both is the same as
  // asking for neither except that it excludes the rows the catalog could not classify - which
  // is the honest behavior, since those rows are not a third kind of restaurant, they are rows
  // nobody has answered the question for.
  const serviceStyles = new Set<string>(parseList(url.searchParams.getAll("serviceStyle"))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value === "quick" || value === "sit_down"));
  const day = url.searchParams.get("day") || "";
  // The weekday it names, read once: "tue", "Tuesday", or 0-6 from Sunday. Anything else is a day
  // no offer runs on, as a misspelt day always was, rather than no filter at all.
  const weekday = day ? weekdayNumber(day) : null;
  const startTime = url.searchParams.get("startTime") || "";
  const endTime = url.searchParams.get("endTime") || "";
  const availableNow = url.searchParams.get("availableNow") === "true";
  const verifiedOnly = url.searchParams.get("verifiedOnly") === "true";
  // The age-rating control. Applied inside the same predicate as every other filter so it lands
  // before facetsFor() below — a hidden deal must not leave its cuisine sitting in the filter
  // sheet offering a category that returns nothing, and must not be counted in "40 on now within
  // 5 km" either. See app/alcohol.ts for why this is a compliance surface rather than a taste
  // setting, and why it rounds toward hiding.
  const hideAlcohol = url.searchParams.get("hideAlcohol") === "true";
  const sponsored = url.searchParams.get("sponsored");
  const point = resolvedLocation ? { latitude:resolvedLocation.latitude,longitude:resolvedLocation.longitude } : devicePoint;
  // The filters that describe one offer rather than a place: what it is, when it runs, what it
  // costs. Declared ahead of the grouping because they decide which of a card's offers leads it,
  // not only whether the card is shown - see the lead chosen below.
  //
  // "Tonight" is asked for as a category - the homepage's chip and the phone's filter both send
  // category=Tonight - but it is a time, so it is answered from the schedule (`tonight`, computed
  // above), not from the stored word. Matched on the stored word it returned a Wednesday wing night
  // on a Tuesday, which was most of what it returned on any given day.
  const offerMatches = (deal: NormalizedDeal) =>
    (!q || matchesNormalizedQuery(deal.search_text,q)) &&
    (!categories.length || categories.some((value) => value.toLowerCase() === "tonight" ? deal.tonight : value.toLowerCase() === deal.category.toLowerCase())) &&
    (!priceTiers.size || (deal.price_tier != null && priceTiers.has(deal.price_tier))) &&
    (!day || (weekday != null && offerRunsOn(weekday, deal.schedule, deal.schedule_days, deal.start_time, deal.end_time))) &&
    (!startTime || !deal.start_time || String(deal.start_time) >= startTime) &&
    (!endTime || !deal.end_time || String(deal.end_time) <= endTime) &&
    (!availableNow || deal.available_now) &&
    (!verifiedOnly || deal.effective_verification_status === "verified") &&
    (!hideAlcohol || !drinkVerdict(deal)) &&
    (sponsored == null || Boolean(deal.sponsored) === (sponsored === "true"));

  // One card per place.
  //
  // Every branch of a chain (eg. every "Earls") is compacted into a single card keyed on its real
  // restaurant_id, so browsing/search show one entry per restaurant. Each branch's own price and
  // schedule is preserved per-location via `brand_offers`/`location.offers` so the location
  // picker can surface exactly what that address offers.
  //
  // An independent is one card per address, for the same reason. It used to be one card per deal,
  // so a bar with a different special every night - Rabbit Hole on Sparks runs five - filled five
  // slots of the feed with the same name, and none of them could show the week the way a chain's
  // card does. Keyed on the restaurant and the address together, so a small local group that was
  // never marked as a chain keeps a card per location rather than having them merged.
  //
  // Except when the request names deals by id. That is the Saved tab asking for what someone
  // saved, and two saved nights at one bar are two things they saved: grouped, only one of them
  // would come back.
  const local = nationalOnly ? [] : raw.filter((deal) =>
    ids.size > 0 || (deal.location_scope !== "national" && !(chainsSeparate && deal.national_chain)));
  // The addresses each merged card is confirmed at, carried from one merge to the next.
  const confirmedAt = new Map<GroupedDeal, Set<string>>();
  const grouped = Array.from(local.reduce((map, deal) => {
    const key = ids.size || !deal.canonical_restaurant_id ? deal.id : deal.is_chain ? deal.canonical_restaurant_id : `${deal.canonical_restaurant_id}|${deal.address}`, existing = map.get(key);
    // A copy of participating_locations, not the deal's own array. The push below used to go into
    // the array the cached snapshot holds, so the first deal of every chain group gradually became
    // "confirmed" at every branch any sibling ran at - persisting across requests in the isolate,
    // and showing in the map pins of a deal fetched on its own by id.
    if (!existing) map.set(key,{ ...deal,participating_locations:[...deal.participating_locations],brand_offers:[offerSummary(deal)] });
    else {
      // A Set lookup, not participating_locations.some() per branch: that was branches x branches,
      // harmless at a Canadian chain's 20 and a hundred million comparisons at McDonald's 10,482.
      let confirmed = confirmedAt.get(existing);
      if (!confirmed) confirmedAt.set(existing, confirmed = new Set(existing.participating_locations.map((location) => location.address)));
      for (const location of deal.participating_locations) {
        if (!confirmed.has(location.address)) { existing.participating_locations.push(location); confirmed.add(location.address); }
      }
      existing.brand_offers.push(offerSummary(deal));
      existing.search_text += ` ${deal.search_text}`;
      if (deal.search_score > existing.search_score) existing.search_score = deal.search_score;
      if (timeOf(deal.verified_at) > timeOf(existing.verified_at)) existing.verified_at = deal.verified_at;
    }
    return map;
  },new Map<string,GroupedDeal>()).values());
  // A merged card's branches, flagged by every address its deals are confirmed at - once, from the
  // first deal's list, after the last merge. They used to be copied and re-flagged at every merge,
  // each copy thrown away by the next, with the Set of confirmed addresses rebuilt from scratch for
  // each: up to 1,315 branch copies a request over a copy of production's catalogue, of which 268
  // were kept - Kelseys' 16 branches for each of its 25 deals, Boston Pizza's 22 for each of 17.
  // Nothing reads them in between, and the last copy made is this one: the same branches in the
  // same order, flagged by the same final union.
  for (const [card, confirmed] of confirmedAt) {
    card.chain_locations = card.chain_locations.map((location) => ({ ...location,offer_available:confirmed.has(location.address) }));
    card.other_brand_locations = card.chain_locations.filter((location) => !location.offer_available);
  }
  // Another of a card's offers as its lead - see where the lead is chosen below. The whole offer
  // is swapped in, and what belongs to the place rather than the offer is carried across.
  //
  // `alone` is for a card the drink filter has left with this one offer: then the text it is found
  // by, its relevance and its newest check are the offer's own too. Carried across from the offers
  // pruned, a search for "beer" with drinks hidden found Radius's steak supper and Hometown's wing
  // night through the happy hours nobody could see on them.
  const leadWith = (deal: GroupedDeal, source: NormalizedDeal, alone = false) => Object.assign(deal, source, {
    brand_offers: deal.brand_offers,
    chain_locations: deal.chain_locations,
    participating_locations: deal.participating_locations,
    other_brand_locations: deal.other_brand_locations,
    offer_varies_by_location: deal.offer_varies_by_location,
    ...(alone ? {} : { search_keywords: deal.search_keywords, search_text: deal.search_text, search_score: deal.search_score, verified_at: deal.verified_at }),
  });
  // Places none of whose offers pass the request's offer filters - see the lead below.
  const unmatched = new Set<GroupedDeal>();
  // Whether a card runs anywhere within the radius of a located search: one of the filter's clauses
  // at the end, asked of a card before this loop too - see where the loop leaves a card early.
  const inReach = (deal: GroupedDeal) =>
    !resolvedLocation || deal.location_scope === "national" || deal.chain_locations.some((location) => location.offer_available && location.latitude != null && location.longitude != null && kmBetween(point!,{latitude:Number(location.latitude),longitude:Number(location.longitude)}) <= radius);
  for (const deal of grouped) {
    // With drinks hidden, a card carries only the offers this visitor may see.
    //
    // Everything below builds from `brand_offers` — the per-address lists, the branch list, the
    // week shown on the card, and the lead — so pruning here prunes all of them, and the card
    // that reaches the filter at the end is one whose every offer is food.
    //
    // This is what the alcohol check needs to be correct rather than merely safe. That check
    // walks `brand_offers` and drops the card if any one of them names a drink, which was right
    // while the card shipped all of them: the offer would have been on screen. But it meant a
    // restaurant running a wing night *and* a happy hour lost its card entirely — Boston Pizza on
    // 27 food deals out of 29, Montana's on 9 of 10, Father & Sons on a $8.99 breakfast — and a
    // minor was shown nothing at a place with plenty to eat. 22 cards were in that state.
    //
    // Pruned by the alcohol predicate alone, not by `offerMatches`. The other filters are
    // inclusions — a card matches if any offer matches, which is why `brand_offers` is otherwise
    // kept whole so a Kelseys with a happy hour is still a happy-hour result on Wine Wednesday.
    // `hideAlcohol` is the one exclusion in the set, and an exclusion applied to a list that
    // answers "any" is how a card holding one drink lost its other nine offers.
    const offersBefore = deal.brand_offers.length;
    // Whether the card can end up in the country asked for. It only ever takes a country from one of
    // its own deals - the first, or whichever it comes to lead with - so it can when one of them is.
    // Read before the pruning, because a card that prunes its first deal's offer and leads with
    // nothing else still carries that deal's fields.
    const inCountry = !requestedCountry || deal.brand_offers.some((offer) => String(rawById.get(offer.id)?.country || "").toUpperCase() === requestedCountry);
    if (hideAlcohol) {
      deal.brand_offers = deal.brand_offers.filter((offer) => {
        const source = rawById.get(offer.id);
        return source ? !drinkVerdict(source) : true;
      });
    }
    // A card the filter at the end is sure to drop goes no further than the pruning just done, which
    // the catalogue's city count still reads. Two of the filter's clauses are settled already: the
    // country, above, and whether the card runs anywhere within the radius of a located search - this
    // loop copies a card's branches without moving one or changing what runs there, and never changes
    // whether a card is national: a card only takes the scope of one of its own deals, and a national
    // deal shares a card with nothing. Everything else it would work out for such a card - the
    // branch, the week, the lead - nothing reads. The phone's search from downtown Ottawa keeps 36 of
    // the catalogue's 169 cards, and worked out all 169.
    if (!inCountry || !inReach(deal)) continue;
    if (!deal.is_chain && deal.brand_offers.length < 2) {
      deal.offer_varies_by_location = false;
      // A place left with one offer leads with it. With drinks hidden, a bar running a happy hour
      // and a wing night is down to the wings - but the card still led with whichever of the two
      // was read first, and when that was the happy hour, the alcohol check at the end dropped the
      // whole place for an offer it no longer carried. Hometown's half-price wings vanished that
      // way for every phone, which hides drinks by default. And a place pruned down to one offer is
      // that offer alone - see leadWith.
      const only = deal.brand_offers[0];
      const pruned = deal.brand_offers.length < offersBefore;
      const source = only && (pruned || only.id !== deal.id) ? rawById.get(only.id) : undefined;
      if (source) leadWith(deal, source, pruned);
      continue;
    }
    // A national deal asked for by id - a saved one - has no branch to choose and nothing to share a
    // card with. Left to the branch logic below it would find no branch and be dropped as unmatched.
    if (deal.location_scope === "national") { deal.offer_varies_by_location = false; continue; }
    // Grouped, not keyed: `new Map(brand_offers.map((o) => [o.address, o]))` kept one offer per
    // address, so a branch running three deals showed whichever happened to be read last and the
    // other two could not be reached from the card at all. Twelve Boston Pizza addresses were in
    // that state in production, and every East Side Mario's and Montana's draft would have joined
    // them - those are four deals at one address by design, one for each night of the week.
    const offersByAddress = new Map<string,OfferSummary[]>();
    for (const offer of deal.brand_offers) {
      const existing = offersByAddress.get(offer.address);
      if (existing) existing.push(offer);
      else offersByAddress.set(offer.address,[offer]);
    }
    // Every offer by each branch it runs at: its own stored address, and every branch it is
    // confirmed at. The second is the one stored address alone missed - a national promotion is
    // one deal row with a confirmed eligibility row at every branch, so the branch a reader is
    // standing next to seemed to run none of it. The first is kept because unconfirmed is not the
    // same as absent: 49 live deals are `needs_review` at their own address, among them State &
    // Main's Wednesday wings, and confirmed branches alone would have hidden them from the feed.
    // Confirmation is read from chain_locations, whose flags are the deal's own;
    // participating_locations on the group is a union across its deals.
    const runsAt = new Map<string,OfferSummary[]>();
    for (const offer of deal.brand_offers) {
      const addresses = new Set([offer.address]);
      for (const location of rawById.get(offer.id)?.chain_locations || []) if (location.offer_available) addresses.add(location.address);
      for (const address of addresses) {
        const existing = runsAt.get(address);
        if (existing) existing.push(offer);
        else runsAt.set(address,[offer]);
      }
    }
    // As a week reads, so the card's list and the detail sheet's tabs run Monday to Sunday rather
    // than in the order the rows were written - see weekRank in app/search.ts.
    const byWeek = (offers: OfferSummary[]) => [...offers].sort((a, b) => weekRank(a.schedule) - weekRank(b.schedule));
    // The offers that pass the request's offer filters: what the card may lead with, and what a
    // branch has to run to be the one the card is about.
    const passingIds = new Set(deal.brand_offers.filter((offer) => {
      const source = rawById.get(offer.id);
      return !!source && offerMatches(source);
    }).map((offer) => offer.id));
    const passingAt = (address: string) => (runsAt.get(address) || []).filter((offer) => passingIds.has(offer.id));

    // Which branch the card is about.
    //
    // With a location in the request, the nearest branch running an offer that passes, within the
    // radius. The card's address used to be the stored address of whichever deal had the
    // smallest distance, while that distance was measured to wherever the deal was confirmed, so 17
    // of Ottawa's 37 chain cards named one branch and measured another: Subway said 161 Montreal Rd
    // at 0.2 km, and 0.2 km was 180 Elgin. Choosing the branch first and taking the address, the
    // pin and the distance all from it makes them one place. No such branch means nothing on this
    // card passes nearby - an Ottawa search filtered to happy hours, against a Montana's whose only
    // happy hour is in Kitchener - and the card goes.
    //
    // Without a location there is nothing to be near: the branch the card was grouped under if it
    // runs something that passes, else the first that does. Failing both, the lead is simply the
    // first passing offer at its own address.
    let branch: NormalizedLocation | undefined;
    let branchKm: number | null = null;
    if (origin) {
      for (const location of deal.chain_locations) {
        if (location.latitude == null || location.longitude == null || !passingAt(location.address).length) continue;
        const km = kmBetween(origin,{latitude:Number(location.latitude),longitude:Number(location.longitude)});
        if (km <= radius && (branchKm == null || km < branchKm)) { branch = location; branchKm = km; }
      }
    } else {
      branch = [deal.chain_locations.find((location) => location.address === deal.address), ...deal.chain_locations]
        .find((location) => location && passingAt(location.address).length);
    }

    // The card's own branch lists every offer that runs there; every other branch keeps the offers
    // stored at its address. Listing each national offer at every branch would be the consistent
    // answer and a heavy one - Tim Hortons' one national deal is confirmed at 120 branches, and
    // chain_locations carries all of them on every card - so it is done for the branch the card
    // shows, which is the list anyone reads.
    //
    // One offer per title and schedule there. The same promotion is often stored once for each
    // branch it was found at, and every copy confirmed brand-wide, so St. Louis on Clyde held its
    // Tuesday wing night three times in three wordings and Boston Pizza on the Portage held Pasta
    // Tuesday twice. The copy stored at this branch wins, so the card links to this branch's page.
    const branchOffers: OfferSummary[] = [];
    if (branch) {
      const kept = new Map<string,OfferSummary>();
      for (const offer of runsAt.get(branch.address) || []) {
        const key = `${normalizeSearch(offer.title)}|${normalizeSearch(offer.schedule)}`;
        const held = kept.get(key);
        if (!held || (held.address !== branch.address && offer.address === branch.address)) kept.set(key,offer);
      }
      branchOffers.push(...kept.values());
    }
    deal.chain_locations = deal.chain_locations.map((location) => {
      const offers = byWeek(location === branch ? branchOffers : offersByAddress.get(location.address) || []);
      return { ...location,offers,offer:offers[0] || null };
    });
    deal.participating_locations = deal.chain_locations.filter((location) => location.offer_available);
    deal.other_brand_locations = deal.chain_locations.filter((location) => !location.offer_available);
    deal.offer_varies_by_location = deal.is_chain && new Set(deal.brand_offers.map((offer) => `${offer.title}|${offer.price}|${offer.schedule}`)).size > 1;

    // Which of the branch's offers the card is about.
    //
    // A group takes its title, price, schedule, availability line and slug from whichever deal
    // reached the reduce above first, so Montana's - Wing Monday, Taco Tuesday, rib Wednesday, a
    // Thursday platter, all at one address - was "Wing Monday" every day of the week: the headline
    // said Monday, the availability line said the offer was not on, and the card opened Monday's
    // page. On a Wednesday that is three wrong answers to "what is on here tonight".
    //
    // So the lead is chosen from the branch's offers that pass the request's offer filters: a
    // search for tacos leads with Taco Tuesday, and the happy-hour filter with the happy hour,
    // whatever night it is. Among those, one that runs today in the venue's timezone, and of those
    // the one running on the fewest days - St-Hubert's Wednesday special over its daily 4 à 7,
    // which is on every day and so says nothing about this one. Failing today, the first in week
    // order.
    //
    // The filter below tests the lead, so choosing it this way is also what lets a filter see
    // every offer a card holds rather than whichever one leads: a Kelseys with a happy hour is a
    // happy-hour result on Wine Wednesday too. When nothing passes, the card is dropped outright
    // rather than left to the filter, because the lead it kept - whichever deal reached the
    // grouping first - might pass on its own.
    //
    // The whole offer is swapped in, not just its title, so the headline, the availability line,
    // the category tag and the link all describe the same deal. What belongs to the place rather
    // than the offer - the merged location lists, the accumulated search text, the newest
    // verification - is carried across unchanged.
    const here = byWeek(branch ? branchOffers.filter((offer) => passingIds.has(offer.id)) : origin ? [] : deal.brand_offers.filter((offer) => passingIds.has(offer.id)));
    if (!here.length) unmatched.add(deal);
    // "Today" unless the request named a day: then every candidate already runs on it, and the
    // question is only which is most that day's - Rabbit Hole's Tuesday pizza, not the Tue-Fri
    // happy hour that also happens to be on today.
    const onTheDay = day ? here : here.filter((offer) => offer.available_today);
    const lead = onTheDay.length
      ? onTheDay.reduce((best, offer) => scheduleWeekdays(offer.schedule).length < scheduleWeekdays(best.schedule).length ? offer : best)
      : here[0];
    const source = lead && lead.id !== deal.id ? rawById.get(lead.id) : undefined;
    if (source) leadWith(deal, source);
    // And the place is the branch, whichever deal leads: a national offer's stored address is
    // wherever it was first found, not the branch it is being shown at. The pin and the postal
    // area go with it - the phone app plots `latitude`/`longitude` - and the two fields that only
    // describe the stored location are cleared rather than left naming a different branch.
    if (branch) {
      Object.assign(deal, {
        address: branch.address,
        city: branch.city,
        primary_city: branch.city,
        postal_prefix: branch.postal_prefix,
        region: branch.region ?? deal.region,
        latitude: branch.latitude,
        longitude: branch.longitude,
        eligible_location_id: branch.location_id,
        distance_km: branchKm,
        ...(branch.location_id !== deal.eligible_location_id ? { neighborhood: null, location_website: null } : {}),
      });
    }
  }
  // The homepage's "N restaurants · M cities", counted over the whole catalogue the way the local
  // list is grouped, before any filter or place narrows it - see catalogCounts, which is where the
  // counting moved when a request stopped reading the whole catalogue. With drinks hidden, a city
  // whose every listing is a drink is in neither the count nor the place picker (facetsFor).
  const counts = chainsSeparate ? meta.counts.separate : meta.counts.all;
  const totalCanonicalOffers = counts.cards;
  const cityCount = hideAlcohol ? counts.foodCities : counts.cities;
  let filtered = grouped.filter((deal) =>
    (!ids.size || wanted(deal)) &&
    (deal.vertical || "restaurant").toLowerCase() === vertical &&
    (!requestedProvince || deal.location_scope === "national" || deal.chain_locations.some((location) => String(location.region || deal.region || "").toLowerCase() === requestedProvince.toLowerCase())) &&
    (!requestedCountry || String(deal.country || "").toUpperCase() === requestedCountry) &&
    inReach(deal) &&
    (!cuisines.length || cuisines.some((value) => value.toLowerCase() === deal.cuisine.toLowerCase())) &&
    (!serviceStyles.size || (deal.service_style != null && serviceStyles.has(deal.service_style))) &&
    !unmatched.has(deal) &&
    offerMatches(deal) &&
    (!excludedRestaurantIds.size || !deal.canonical_restaurant_id || !excludedRestaurantIds.has(deal.canonical_restaurant_id))
  );
  if (nationalOnly) {
    // The reader's market and region: as the request names them, else wherever it resolved to. A
    // region the chain's footprint does not include is a chain with no restaurant there - Del Taco
    // to a Knoxville reader - and an unknown footprint is shown rather than hidden.
    const marketCountry = requestedCountry || String(resolvedLocation?.country || "").toUpperCase();
    const marketRegion = String(requestedProvince || resolvedLocation?.region || deviceRegion || "").toUpperCase();
    // A national chain's branch deal is placed as the local list places it: by its branches, in the
    // named province and within the radius of wherever the request resolved to. By the branches
    // that run it, in both: the local list's card is the whole chain and leads with a branch in the
    // province, but a card here is one offer, and an Ottawa price does not become a BC one because
    // the chain also has a restaurant in Vancouver.
    const branchNearby = (deal: NormalizedDeal) =>
      (!requestedProvince || deal.chain_locations.some((location) => location.offer_available && String(location.region || deal.region || "").toLowerCase() === requestedProvince.toLowerCase())) &&
      (!resolvedLocation || deal.chain_locations.some((location) => location.offer_available && location.latitude != null && location.longitude != null && kmBetween(point!,{latitude:Number(location.latitude),longitude:Number(location.longitude)}) <= radius));
    filtered = raw.filter((deal) =>
      (deal.location_scope === "national"
        ? !marketRegion || !deal.footprint_regions || deal.footprint_regions.includes(marketRegion)
        : chainsSeparate && deal.national_chain && branchNearby(deal)) &&
      (!ids.size || wanted(deal)) &&
      (deal.vertical || "restaurant").toLowerCase() === vertical &&
      (!marketCountry || String(deal.country || "").toUpperCase() === marketCountry) &&
      (!cuisines.length || cuisines.some((value) => value.toLowerCase() === deal.cuisine.toLowerCase())) &&
      (!serviceStyles.size || (deal.service_style != null && serviceStyles.has(deal.service_style))) &&
      offerMatches(deal) &&
      (!excludedRestaurantIds.size || !deal.canonical_restaurant_id || !excludedRestaurantIds.has(deal.canonical_restaurant_id))
    ).map((deal) => ({ ...deal, brand_offers: [offerSummary(deal)], offer_varies_by_location: false }));
    // One card per offer, not one per branch. Boston Pizza runs the same Pasta Tuesday at twelve
    // branches, each its own deal, and as twelve cards a city apart the section would say one thing
    // twelve times - 180 branch deals were 114 offers when this was written. The card kept is the
    // nearest branch's when the request is placed, and it takes in every branch running the offer,
    // so the count the card shows is theirs. Offers that differ in anything - Ottawa's Pasta
    // Tuesday is written differently - stay apart; see offerKey.
    if (chainsSeparate) {
      const byOffer = new Map<string, GroupedDeal>();
      for (const deal of filtered) {
        const key = deal.location_scope === "national" ? `national:${deal.id}` : offerKey(deal);
        const kept = byOffer.get(key);
        if (!kept) { byOffer.set(key, { ...deal, participating_locations: [...deal.participating_locations] }); continue; }
        const lead = (deal.distance_km ?? Infinity) < (kept.distance_km ?? Infinity)
          ? { ...deal, participating_locations: [...deal.participating_locations] }
          : kept;
        const confirmed = new Set(lead.participating_locations.map((location) => location.address));
        for (const location of (lead === kept ? deal : kept).participating_locations) {
          if (!confirmed.has(location.address)) { lead.participating_locations.push(location); confirmed.add(location.address); }
        }
        lead.chain_locations = lead.chain_locations.map((location) => ({ ...location, offer_available: confirmed.has(location.address) }));
        lead.other_brand_locations = lead.chain_locations.filter((location) => !location.offer_available);
        byOffer.set(key, lead);
      }
      filtered = [...byOffer.values()];
    }
  }
  const facets = facetsFor(filtered, !origin && !requestedProvince);
  const sort = url.searchParams.get("sort") || "recommended";
  // An offer past its own end date, still public for EXPIRY_GRACE_PERIOD_DAYS until the expiry cron
  // retires it: "ended", and not on today. Every other "ended" is ended for today and on today.
  const pastItsEnd = (deal: NormalizedDeal) => deal.availability_phase === "ended" && !deal.available_today;
  filtered.sort((a,b) => {
    // Nothing national has a distance, so the recommended order's distance step says nothing about
    // it. What is on today goes first: a Tuesday-only price is the wrong lead on a Monday.
    //
    // And what has ended goes last. The grace period keeps an ended promotion listed, saying "Offer
    // ended", on purpose: it replaced deals vanishing the moment their date passed (0103151), and
    // the phone words that phase on a brand card (offerPhase in mobile/lib/national.ts). But
    // sorted among the offers still running, Dunkin', Krispy Kreme and Sonic sat between live
    // cards for two days with nothing on them to have. Last, a brand whose every offer has ended
    // is the end of the list, and one with anything still running leads with that.
    if (nationalOnly && sort === "recommended") return b.search_score - a.search_score || a.under_review - b.under_review || Number(b.available_today) - Number(a.available_today) || Number(pastItsEnd(a)) - Number(pastItsEnd(b)) || a.restaurant.localeCompare(b.restaurant) || a.title.localeCompare(b.title);
    if (sort === "distance") return (a.distance_km ?? 99999) - (b.distance_km ?? 99999);
    if (sort === "restaurant") return a.restaurant.localeCompare(b.restaurant);
    if (sort === "recently_verified") return timeOf(b.verified_at) - timeOf(a.verified_at);
    if (sort === "recently_added") return timeOf(b.created_at) - timeOf(a.created_at);
    // Untiered deals sort to the end regardless of direction, rather than masquerading as
    // cheapest (low sort) or priciest (high sort) — either would misrepresent a deal staff
    // simply haven't rated yet.
    if (sort === "price_low") return (a.price_tier ?? 99) - (b.price_tier ?? 99);
    if (sort === "price_high") return (b.price_tier ?? -99) - (a.price_tier ?? -99);
    if (sort === "highest_savings") return (b.discount_percent || b.savings_cents || 0) - (a.discount_percent || a.savings_cents || 0);
    if (sort === "available_now") return Number(b.available_now) - Number(a.available_now) || a.restaurant.localeCompare(b.restaurant);
    if (sort === "most_saved") return Number(b.save_count || 0) - Number(a.save_count || 0) || a.restaurant.localeCompare(b.restaurant);
    if (sort === "starting_soon") return String(a.start_time || "99:99").localeCompare(String(b.start_time || "99:99"));
    if (sort === "ending_soon") return String(a.end_time || "99:99").localeCompare(String(b.end_time || "99:99"));
    // A deal a reader has reported as ended or wrong goes after the ones that match as well and
    // nobody has questioned, until staff close the report (app/accuracy-reports.ts). After the
    // relevance score, not before it: someone who searched for that restaurant by name still finds
    // it first, marked "Re-checking".
    return b.search_score - a.search_score || a.under_review - b.under_review || b.sponsored - a.sponsored || (a.distance_km ?? 99999) - (b.distance_km ?? 99999) || a.restaurant.localeCompare(b.restaurant);
  });
  if (sort === "recommended" && sponsored == null) {
    // A sponsorship buys a slot for an offer Radar can stand behind. One under review takes its
    // organic place instead, and the reported deals are spread among themselves after the rest, so
    // the round-robin across restaurants cannot lift one back above a deal nobody has questioned.
    const promoted = filtered.filter((deal) => deal.sponsored && !deal.under_review),
      organic = [
        ...diversifyByRestaurant(filtered.filter((deal) => !deal.sponsored && !deal.under_review)),
        ...diversifyByRestaurant(filtered.filter((deal) => deal.under_review)),
      ],
      balanced:GroupedDeal[] = [];
    while (promoted.length || organic.length) { if (promoted.length) balanced.push(promoted.shift()!); balanced.push(...organic.splice(0,3)); }
    filtered = balanced;
  }
  // One card per brand in the nationwide section, listing everything the brand is running. A card
  // per offer had McDonald's four times over and Boston Pizza six, and JOEY twice under the names of
  // two of its restaurants (drizzle/0052) - a list of the same names, which read as a wall of
  // promotions rather than a list of places. Grouped after the sort, so a card leads with the
  // brand's first offer in that order - what is on today - and carries every offer in the same
  // order. By country as well as brand: a Canadian McDonald's price and an American one are not one
  // card's worth of dollars. And one line per offer on the card, however many sources wrote it
  // down - see sameOfferKey.
  if (nationalOnly && groupByBrand) {
    type Line = { offer: ChainOffer; places: Set<string> };
    // `lines` by offer, several keys to one line once a line takes in other hours; `promotions` by
    // the offer without its schedule, to the first line that ran it.
    const byBrand = new Map<string, { card: GroupedDeal; lines: Map<string, Line>; promotions: Map<string, Line> }>();
    for (const deal of filtered) {
      const brand = deal.brand || deal.restaurant;
      const brandKey = `${String(deal.country || "").toUpperCase()}|${normalizeSearch(brand)}`;
      let entry = byBrand.get(brandKey);
      if (!entry) byBrand.set(brandKey, entry = { card: { ...deal, brand_name: brand }, lines: new Map(), promotions: new Map() });
      const offer = chainOffer(deal), lineKey = sameOfferKey(deal), promotionKey = samePromotionKey(deal);
      const places = deal.participating_locations.map((place) => place.address);
      let line = entry.lines.get(lineKey);
      if (!line) {
        // The same promotion at other branches, on other days or hours: their line, which now says
        // the schedule varies. Never a nationwide one, which has no branches to differ.
        const promotion = entry.promotions.get(promotionKey);
        if (promotion && promotion.offer.participating_location_count != null && offer.participating_location_count != null
          && places.length && !places.some((place) => promotion.places.has(place))) {
          promotion.offer.schedule_varies = true;
          entry.lines.set(lineKey, line = promotion);
        }
      }
      if (!line) {
        const created = { offer, places: new Set(places) };
        entry.lines.set(lineKey, created);
        if (!entry.promotions.has(promotionKey)) entry.promotions.set(promotionKey, created);
        continue;
      }
      // A nationwide line already says everything a branch's could, and a nationwide offer says more
      // than the branch line it joins. Otherwise the line counts every branch either one runs at.
      if (line.offer.participating_location_count == null) continue;
      if (offer.participating_location_count == null) { line.offer = offer; continue; }
      for (const place of deal.participating_locations) line.places.add(place.address);
      line.offer.participating_location_count = Math.max(line.offer.participating_location_count, offer.participating_location_count, line.places.size);
    }
    filtered = [...byBrand.values()].map(({ card, lines }) => ({ ...card, chain_offers: [...new Set(lines.values())].map((line) => line.offer) }));
  }
  const totalMatches = filtered.length;
  const offset = safeCursor(url.searchParams.get("cursor"));
  // The nationwide section takes its whole list at once, and in the compact view it can: a page
  // costs the filter and sort above whatever its size, so Canada's hundred-odd chain offers as three
  // pages of 50 were three times the CPU of one - on a request that is uncached for every reader
  // who shares a location.
  const limit = nationalOnly && url.searchParams.get("view") === "compact"
    ? Math.max(1, Math.min(NATIONAL_PAGE_MAX, Number(url.searchParams.get("limit")) || 24))
    : safeLimit(url.searchParams.get("limit"));
  const results = filtered.slice(offset,offset+limit).map((deal) => {
    // Named only to exclude them from the rest spread returned below. The search reads every one of
    // them and no reader does: the ranking fields and curated search terms, the staff and lifecycle
    // columns, the row ids and joins the matching works through, and the restaurant columns its own
    // page shows from the database. A field reaches readers only by being left out of this list,
    // and tests/deals-public-fields.test.mjs fails on any field that appears here without a decision.
    const {
      search_keywords: unusedKeywords, search_text: unusedSearchText, search_score: unusedScore, indexed: unusedIndexed,
      footprint_regions: unusedFootprintRegions, internal_notes: unusedNotes, deleted_at: unusedDeletedAt, publish_at: unusedPublishAt,
      owner_confirmed_at: unusedOwnerConfirmed, under_review: unusedUnderReview,
      location_id: unusedLocationId, eligible_location_id: unusedEligibleLocation,
      primary_city: unusedPrimaryCity, national_chain: unusedNationalChain, discount_percent: unusedDiscount,
      savings_cents: unusedSavings, restaurant_footprint: unusedFootprint, restaurant_country: unusedCountry,
      restaurant_phone: unusedPhone, location_website: unusedLocationWebsite,
      ...rest
    } = deal as GroupedDeal & Pick<DealBase, "indexed">;
    // category/cuisine stay canonical English throughout matching, faceting, and sorting above —
    // category_label/cuisine_label are added display-only fields. title/description/etc. are
    // overlaid with machine-translated copy from deal_translations when available, falling back
    // per-field to the English original when that field hasn't been translated yet (or ever, if
    // DeepL isn't configured) rather than showing a blank.
    if (locale === "en") return { ...rest, category_label: rest.category, cuisine_label: rest.cuisine };
    const translation = translationOf(rest.id)?.[locale];
    return {
      ...rest,
      title: translation?.title || rest.title,
      description: translation?.description ?? rest.description,
      schedule: translation?.schedule || rest.schedule,
      price: translation?.price || rest.price,
      terms: translation?.terms ?? rest.terms,
      restrictions: translation?.restrictions ?? rest.restrictions,
      category_label: categoryLabel(rest.category,locale),
      cuisine_label: cuisineLabel(rest.cuisine,locale),
      // A brand card's offers are deals of their own, each with its own translation.
      ...(rest.chain_offers ? {
        chain_offers: rest.chain_offers.map((offer) => {
          const own = translationOf(offer.id)?.[locale];
          return own ? { ...offer, title: own.title || offer.title, schedule: own.schedule || offer.schedule, price: own.price || offer.price } : offer;
        }),
      } : {}),
    };
  // Last, on the page being returned rather than everything that matched: a national chain's
  // location arrays are bounded here, and their true totals become their own fields. See
  // app/dealView.ts. Applied to both shapes, because the full row is what the website reads.
  //
  // A request that names a province and no place is answered from the country's shard, whose cards
  // carry a sample of branches from every province (BRANCHES_PER_REGION); the filter above has
  // already kept only the chains with a branch in the province, and the card shows those branches,
  // not Texas's to a reader who asked for Tennessee. A located request keeps the branches in reach,
  // whatever province they are in - a reader in Ottawa is shown Gatineau. A nationwide promotion has
  // no branches to trim.
  }).map((deal) => {
    if (requestedProvince && !origin && deal.location_scope !== "national" && deal.chain_locations.length) {
      const inProvince = (location: { region?: string | null }) => String(location.region || deal.region || "").toLowerCase() === requestedProvince.toLowerCase();
      Object.assign(deal, {
        chain_locations: deal.chain_locations.filter(inProvince),
        participating_locations: deal.participating_locations.filter(inProvince),
        other_brand_locations: deal.other_brand_locations.filter(inProvince),
      });
    }
    return capDealLocations(deal as Record<string, unknown>, point) as typeof deal;
  });
  // A search with no resolved location at all (a bare keyword query, or the initial
  // nationwide load) has no "area" for a market-coverage verdict to be about — falling
  // through to the totalMatches-based guess below used to label a perfectly successful
  // nationwide search "limited"/"not covered yet" just because there was no market row to
  // match against an empty city string, which is misleading rather than informative.
  //
  // A located search is about the market it names or stands in - see app/market-coverage.ts. Its
  // names are the reader's own words, then the place its postal code or city resolved to without the
  // FSA's list of neighbourhoods; a bare device point has none, and is placed by where it is. Only a
  // typed city used to find its row, and the website sends a point for every search.
  const placeNames = resolvedLocation
    ? [requestedCity, resolvedLocation.accuracy === "device" ? null : displayCity(resolvedLocation.city)].map((name) => canonicalCity(name))
    : [];
  const coverageRow = resolvedLocation
    ? marketFor(coverageRows, centers, {
      names: placeNames,
      region: resolvedLocation.region || null,
      country: resolvedLocation.country || null,
      point: origin,
      reachKm,
    })
    : undefined;
  // What the search is filed under in the demand table (recordSearch): the market, so a point or a
  // postal code in Ottawa counts toward Ottawa, else the place's own name.
  const coverageMarket = coverageRow?.market || placeNames.find(Boolean) || "";
  // A market's row says whether Radar covers it, and how many offers covering it takes. Only the
  // status was ever read, so Toronto and Laval, rows set to 20 offers with 4 and 1 live, reported
  // full coverage and never showed the "still growing" note. Measured over at least the default
  // radius, so a reader who narrows to 2 km downtown is not told the city is thin. A place in no
  // market is thin when anything is there and uncovered when nothing is.
  const coverage = !resolvedLocation
    ? "covered"
    : !coverageRow
      ? (totalMatches ? "limited" : "no_coverage")
      : coverageRow.status !== "no_coverage" && Number(coverageRow.minimum_offers) > 0
          && marketOfferCount(raw, baseById, reachKm, Number(coverageRow.minimum_offers)) < Number(coverageRow.minimum_offers)
        ? "limited"
        : coverageRow.status;
  // Over the whole public catalogue, not this page - see buildMeta.
  const latestVerificationDate = meta.latestSourceCheck;
  // The search this was, for recordSearch. Only real keyword searches: a bare browse, a filter
  // change and a map pan all arrive here too, and none of them is a question anyone asked in words.
  //
  // Normalized with the same function the matcher uses, so "Tacos" and "taco's" group together
  // rather than sitting in the table as three different-looking misses.
  //
  // The browser's own 60s cache can still answer a repeated identical search without reaching this
  // line, which slightly understates popular queries and never invents one. The colo's shared copy
  // does not: it carries the event with it, and a search answered from it is counted all the same.
  // Not for the national list: the homepage asks for it alongside the local one with the same words,
  // and one question would be counted twice.
  const term = q && !nationalOnly ? normalizeSearch(q).slice(0,80) : "";
  const searchEvent = term ? { market: coverageMarket || null, properties: JSON.stringify({ term,matches:totalMatches,vertical }) } : null;
  if (searchEvent) recordSearch(searchEvent);
  // `deals` used to carry a second, byte-identical copy of `results` — 140 KB of a 261 KB response,
  // on every request, to every client. Nothing read it: each caller already does
  // `results || deals`, so the fallback was never reached. It is gone rather than kept as a
  // deprecated alias, because the cost was paid on the wire by everyone rather than by whoever
  // still depended on it.
  //
  // `view=compact` is the phone app's shape: the same fields under the same names, minus the
  // 34 KB of chain and brand rows a card never renders. See app/dealView.ts.
  const answer = Response.json({
    results: url.searchParams.get("view") === "compact" ? results.map(compactDeal) : results,
    facets,
    resolvedLocation,
    resolvedCity:resolvedLocation?.city || requestedCity || null,
    coverage,
    nextCursor:offset+limit < totalMatches ? String(offset+limit) : null,
    totalMatches,
    uniqueOfferCount:totalCanonicalOffers,
    cityCount,
    appliedFilters:{ q,ids:[...ids],postal,city:requestedCity,province:requestedProvince,country:requestedCountry,radius,cuisines,categories,day,startTime,endTime,availableNow,verifiedOnly,sponsored,sort,vertical,scope:nationalOnly ? "national" : null,chains:chainsSeparate ? "separate" : null,group:groupByBrand ? "brand" : null },
    // The next step out, if this plan can take it: a free search at 25 km used to be offered 50,
    // which the clamp above then quietly searched at 25 again.
    expandRadius:!nationalOnly && totalMatches < 4 ? widerRadius(radius, maxRadius) : null,
    // Where a client should retry a search the reader left on the default radius: one step out,
    // never past 25 km (app/radius.ts). Computed here so the website and the app widen the same
    // way; a client never applies it to a radius the reader picked themselves.
    autoWidenRadius:!nationalOnly && resolvedLocation ? autoWidenRadius(radius, totalMatches, searcherPro) : null,
    latestVerificationDate:latestVerificationDate || null,
    generatedAt:new Date().toISOString(),
  },{ headers: signedInUser
    // A signed-in reader's answer leaves out the restaurants they hid, so it is theirs alone: never
    // for a shared cache, and never for the browser to hand back once the session has changed. It
    // was sent public like everyone's, which let any cache between the reader and the Worker keep
    // one person's list and serve it to the next.
    ? { "cache-control": "private, max-age=60", vary: "Cookie, Authorization" }
    : { "cache-control": ANONYMOUS_ANSWER_CACHE_CONTROL } });
  if (answers && answerKey) {
    const shared = answerToShare(answer, searchEvent ? JSON.stringify(searchEvent) : null, Date.now());
    try { waitUntil(answers.put(answerKey, shared).catch(() => {})); } catch { /* no request context */ }
  }
  // How many requests this isolate has answered, and whether it already held a snapshot when this
  // one arrived. On the reader's copy only, not the shared one, where it would describe another
  // isolate. A cold isolate parses the snapshot and runs this file for the first time, which is
  // most of what an uncached request costs; this is how to see how often that happens.
  answer.headers.set("x-radar-isolate", `${isolateRequests};${arrivedWarm ? "warm" : "cold"}`);
  return answer;
}
