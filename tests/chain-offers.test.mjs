import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { code } from "./source.mjs";

// A chain's branches are compacted into one card, and each branch's own offer is carried through
// `chain_locations[].offer` so the picker can show what that address runs. That assumed one deal
// per address. Boston Pizza on Memorial Drive runs three — Wing Wednesday, Pasta Tuesday and a
// weekday lunch combo — and `new Map(brand_offers.map((o) => [o.address, o]))` kept the last one
// read. Twelve Boston Pizza addresses were in that state on the live API, and every East Side
// Mario's and Montana's draft is four deals at one address by design, one per night of the week.

const route = code(readFileSync(new URL("../app/api/deals/route.ts", import.meta.url), "utf8"));
const home = code(readFileSync(new URL("../app/HomeClient.tsx", import.meta.url), "utf8"));

test("offers are grouped by address, never keyed by it", () => {
  // The exact shape that dropped them. A Map built from pairs keeps one value per key.
  assert.doesNotMatch(
    route,
    /new Map\(\s*deal\.brand_offers\.map\(/,
    "building a Map straight from brand_offers keeps one offer per address",
  );
  assert.match(route, /const offersByAddress = new Map<string,OfferSummary\[\]>\(\)/);
  assert.match(route, /offersByAddress\.get\(location\.address\) \|\| \[\]/);
});

test("a location carries every offer, and `offer` stays as the first", () => {
  // `offer` is read outside this file, so it keeps working rather than becoming undefined.
  assert.match(route, /offers,offer:offers\[0\] \|\| null/);
  assert.match(route, /offers\?: OfferSummary\[\];/);
});

test("the card renders from the list, not from the single offer", () => {
  assert.match(home, /offers\?: LocationOffer\[\]/, "the client type must carry the list");
  assert.match(
    home,
    /offerLocation\?\.offers\?\.length/,
    "the client must prefer the full list when the API sends one",
  );
  // The chosen branch for a chain, the one address for an independent.
  assert.match(home, /const offerLocation = chosenChainLocation \|\| venueLocation;/);
  // Falling back to `offer` matters: a cached response from before this change has no `offers`,
  // and the modal must not go blank while that is being served.
  assert.match(home, /:\s*offerLocation\?\.offer\s*\n?\s*\?\s*\[offerLocation\.offer\]/);
});

test("more than one offer at an address is reachable", () => {
  // Without a control, the extra offers are in the payload and invisible, which is where they were.
  assert.match(home, /locationOffers\.length > 1/);
  assert.match(home, /setOfferIndex\(index\)/);
});

test("choosing a different address resets which offer is shown", () => {
  // Offer 3 of one branch is not offer 3 of the next, and an index left behind would show the
  // wrong deal or nothing. The reset is to "nobody has chosen", which shows today's offer, not to
  // the first one - the first one is Monday's.
  assert.match(home, /setChainLocation\(e\.target\.value\); setOfferIndex\(null\);/);
  assert.match(home, /setChainLocation\(""\);\s*\n\s*setOfferIndex\(null\);/);
});

// A chain collapses to one card per brand, and that card was rendered from whichever deal
// represented the group — so Montana's, which runs Wing Monday, Taco Tuesday, rib Wednesday and a
// Thursday platter at one address, advertised Wing Monday alone. The other three existed in the
// payload the whole time, on the shown location's `offers`, and were reachable only by opening
// the card and changing location.
test("a chain card lists every offer at the location it is showing", () => {
  const source = home;
  assert.match(source, /function offersForCard\(deal: Deal\): LocationOffer\[\]/);
  // The offers come from the location the card's address points at, not from brand_offers
  // wholesale — those carry the brand's specials in other cities.
  assert.match(source, /deal\.chain_locations\?\.find\(\(location\) => location\.address === deal\.address\)/);
  assert.match(source, /const offers = offersForCard\(d\)/);
  assert.match(source, /if \(offers\.length < 2\) return/, "one offer should render exactly as before");
  assert.match(source, /offer-week-row/);
});

// The same offer running at four addresses is one thing to tell the reader, not four.
test("identical offers collapse before the card lists them", () => {
  const source = home;
  const body = source.slice(source.indexOf("function offersForCard"));
  assert.match(body.slice(0, 900), /\$\{offer\.schedule\}\|\$\{offer\.title\}\|\$\{offer\.price\}/);
  assert.match(body.slice(0, 900), /seen\.has\(key\)/);
});

// `is_chain` was standing in for "has more than one location", and those come apart: Radar carries
// one address for CRAFT Beer Market and LOCAL Public Eatery, so the card replaced a street address
// with "1 confirmed location" and offered a location chooser holding a single entry.
test("a chain Radar knows one address for still shows that address", () => {
  const source = home;
  // Anchored on the card's own location line: the first <MapPin /> in this file belongs to the
  // search box, several hundred lines earlier.
  const at = source.indexOf('"dealCard.confirmedLocation"');
  assert.ok(at > -1, "expected the card's location line");
  const cardBody = source.slice(at - 200, at + 400);
  // Still counting locations rather than reading is_chain — but through brandLocationCount, which
  // prefers the total /api/deals measured over the length of an array it capped at 40. The three
  // sites below all ask the same question and so all ask it the same way.
  assert.match(cardBody, /brandLocationCount\(d\) > 1 \?/, "the location line should count locations");
  assert.doesNotMatch(cardBody, /d\.is_chain \?/, "it must not branch on the chain flag here");
  assert.match(source, /const brandLocationCount = \(deal: Deal\) => deal\.chain_location_count \|\| deal\.chain_locations\?\.length \|\| 0;/,
    "and the count it reads must still fall back to the array");
  assert.match(source, /\{brandLocationCount\(d\) <= 1 && \(/, "directions should show for a single-location chain");
  assert.match(source, /\{brandLocationCount\(d\) > 1 \? \(\s*<button onClick=\{\(e\) => \{ e\.stopPropagation\(\); openDeal\(d\); \}\}/);
});

// Opening on today. Montana's four nights are four deals at one address, and whichever of them
// reached the grouping first spoke for the card every day of the week: on a Wednesday the card
// said Wing Monday, its availability line said the offer was not on, and it opened Monday's page.
test("a card leads with the offer that runs today", () => {
  assert.match(route, /available_today: deal\.available_today \}/, "each offer has to say whether it runs today");
  // The candidates are the passing offers at the card's branch.
  assert.match(route, /const here = byWeek\(branch \? branchOffers\.filter\(\(offer\) => passingIds\.has\(offer\.id\)\) : origin \? \[\] : deal\.brand_offers\.filter\(\(offer\) => passingIds\.has\(offer\.id\)\)\)/);
  // Today's, unless the request named a day - then that day's.
  assert.match(route, /const onTheDay = day \? here : here\.filter\(\(offer\) => offer\.available_today\)/);
  // Of those, the one that runs on the fewest days: St-Hubert's Wednesday special, not the daily
  // 4 à 7 that is on every day and so says nothing about this one.
  assert.match(route, /onTheDay\.reduce\(\(best, offer\) => scheduleWeekdays\(offer\.schedule\)\.length < scheduleWeekdays\(best\.schedule\)\.length \? offer : best\)/);
  // The whole offer is swapped in, so the headline, the availability line and the link agree -
  // but what belongs to the place survives the swap.
  const at = route.indexOf("Object.assign(deal, source, {");
  assert.ok(at > -1, "expected the lead swap");
  const swap = route.slice(at, at + 600);
  for (const field of ["brand_offers", "chain_locations", "participating_locations", "other_brand_locations", "offer_varies_by_location", "search_keywords", "search_score", "verified_at"]) {
    assert.ok(swap.includes(`${field}: deal.${field}`), `${field} belongs to the brand and must survive the swap`);
  }
});

// `ids` has to exist before the grouping reads it: a const read above its declaration throws.
test("the requested ids are known before the grouping uses them", () => {
  const declared = route.indexOf("const ids = new Set(");
  assert.ok(declared > -1);
  assert.ok(declared < route.indexOf("const grouped = Array.from("));
});

// The sheet opens on what the card was showing, so opening a card never changes the subject; at an
// address the card was not about, on what runs today there.
test("the detail sheet opens on the card's offer, else today's, until someone picks one", () => {
  assert.match(home, /\[offerIndex, setOfferIndex\] = useState<number \| null>\(null\)/);
  assert.match(home, /const leadIndex = locationOffers\.findIndex\(\(offer\) => offer\.id === selected\?\.id\)/);
  assert.match(home, /const todayIndex = locationOffers\.findIndex\(\(offer\) => offer\.available_today\)/);
  assert.match(home, /const shownIndex = offerIndex \?\? \(leadIndex >= 0 \? leadIndex : todayIndex >= 0 \? todayIndex : 0\)/);
  assert.match(home, /className=\{index === shownIndex \? "on" : ""\}/);
});

test("the card's week marks today's row", () => {
  assert.match(home, /offer-week-row\$\{offer\.available_today \? " today" : ""\}/);
});

// A filter tests the card's lead, so the lead has to be an offer that passes it. It was whichever
// deal reached the grouping first, which meant a Kelseys with a happy hour dropped out of the
// happy-hour filter whenever another of its offers led.
test("the lead is chosen from the offers that pass the request's filters", () => {
  const declared = route.indexOf("const offerMatches = (deal: NormalizedDeal) =>");
  assert.ok(declared > -1 && declared < route.indexOf("const grouped = Array.from("), "the predicate must exist before the grouping");
  const predicate = route.slice(declared, route.indexOf(";", declared));
  for (const clause of ["matchesNormalizedQuery(", "categories.some(", "priceTiers.has(", "offerRunsOn(weekday", "startTime", "endTime", "deal.available_now", "effective_verification_status", "drinkVerdict(deal)", "sponsored === \"true\""]) {
    assert.ok(predicate.includes(clause), `${clause} describes an offer, so it belongs in offerMatches`);
  }
  assert.match(route, /return !!source && offerMatches\(source\)/, "candidates are judged by their own deal row");
  // And the card filter still applies the same predicate, to the lead, once.
  const filter = route.slice(route.indexOf("let filtered = grouped.filter((deal) =>"), route.indexOf("const facets = facetsFor(filtered,"));
  assert.match(filter, /offerMatches\(deal\) &&/);
  assert.doesNotMatch(filter, /categories\.some\(/, "the category clause lives in offerMatches now, not twice");
});

// One card per place, independents included. Rabbit Hole on Sparks runs five specials and was five
// cards, none of which could show the week.
test("an independent is one card per address, and a saved-deals request is not grouped", () => {
  assert.match(route, /const key = ids\.size \|\| !deal\.canonical_restaurant_id \? deal\.id : deal\.is_chain \? deal\.canonical_restaurant_id : `\$\{deal\.canonical_restaurant_id\}\|\$\{deal\.address\}`/);
  // The per-address offers and the lead are worked out for any place with more than one offer. A
  // place left with one - drinks hidden, its happy hour pruned - leads with that one, and is found
  // by that one's text alone.
  assert.match(route, /if \(!deal\.is_chain && deal\.brand_offers\.length < 2\) \{\s*deal\.offer_varies_by_location = false;[^}]*const only = deal\.brand_offers\[0\];\s*const pruned = deal\.brand_offers\.length < offersBefore;\s*const source = only && \(pruned \|\| only\.id !== deal\.id\) \? rawById\.get\(only\.id\) : undefined;\s*if \(source\) leadWith\(deal, source, pruned\);\s*continue;\s*\}/);
  // "Price varies by location" is a chain's statement; an independent has one location.
  assert.match(route, /deal\.offer_varies_by_location = deal\.is_chain && new Set\(/);
  // The client lists the week and offers the tabs without asking whether it is a chain.
  const cardHelper = home.slice(home.indexOf("function offersForCard"), home.indexOf("function offersForCard") + 200);
  assert.doesNotMatch(cardHelper, /is_chain/);
  assert.match(home, /const venueLocation = selected && !selected\.is_chain \? selected\.chain_locations\?\.find/);
  assert.match(home, /\{locationOffers\.length > 1 && \(/);
});

// With a happy-hour filter on an Ottawa search, Montana's - none of whose Ottawa offers is a happy
// hour - led with a Kitchener one, 440 km away and run by no Ottawa branch.
test("the card's branch has to run something that passes within the radius, or the card goes", () => {
  // Only branches running a passing offer are considered, and only inside the radius.
  assert.match(route, /if \(location\.latitude == null \|\| location\.longitude == null \|\| !passingAt\(location\.address\)\.length\) continue;/);
  assert.match(route, /if \(km <= radius && \(branchKm == null \|\| km < branchKm\)\) \{ branch = location; branchKm = km; \}/);
  // With a location and no such branch, nothing is a candidate.
  assert.match(route, /: origin \? \[\] :/);
  assert.match(route, /if \(!here\.length\) unmatched\.add\(deal\)/);
  const filter = route.slice(route.indexOf("let filtered = grouped.filter((deal) =>"), route.indexOf("const facets = facetsFor(filtered)"));
  assert.match(filter, /!unmatched\.has\(deal\) &&/, "a place with nothing that passes must not survive on its leftover lead");
});

test("a place's offers are listed as a week", () => {
  assert.match(route, /const byWeek = \(offers: OfferSummary\[\]\) => \[\.\.\.offers\]\.sort\(\(a, b\) => weekRank\(a\.schedule\) - weekRank\(b\.schedule\)\)/);
  assert.match(route, /const offers = byWeek\(/);
});

// 17 of Ottawa's 37 chain cards named one branch and measured another: the address came from the
// stored row of whichever deal was closest, the distance from wherever that deal was confirmed.
test("a chain card's address, pin, distance and week all come from one branch", () => {
  // The grouping no longer moves the address; the branch is chosen afterwards, once.
  const reduce = route.slice(route.indexOf("const grouped = Array.from(raw.reduce("), route.indexOf("const rawById = new Map("));
  assert.doesNotMatch(reduce, /existing\.address = deal\.address/);
  // Offers are attributed to their own stored address and to every branch they are confirmed at,
  // from each deal's own flags. The stored address counts even unconfirmed: `needs_review` is not
  // "does not run here", and 49 live deals would otherwise have vanished from the feed.
  assert.match(route, /const addresses = new Set\(\[offer\.address\]\);/);
  assert.match(route, /for \(const location of rawById\.get\(offer\.id\)\?\.chain_locations \|\| \[\]\) if \(location\.offer_available\) addresses\.add\(location\.address\);/);
  // The branch's list is what runs there; other branches keep what is stored at them, so a
  // national offer is not repeated at every branch in the payload.
  assert.match(route, /byWeek\(location === branch \? branchOffers : offersByAddress\.get\(location\.address\) \|\| \[\]\)/);
  assert.match(route, /for \(const offer of runsAt\.get\(branch\.address\) \|\| \[\]\) \{/);
  // One offer per title and schedule at the branch - the same promotion stored at three branches
  // and confirmed brand-wide is one row, not three - preferring the copy stored at this branch.
  assert.match(route, /const key = `\$\{normalizeSearch\(offer\.title\)\}\|\$\{normalizeSearch\(offer\.schedule\)\}`;/);
  assert.match(route, /if \(!held \|\| \(held\.address !== branch\.address && offer\.address === branch\.address\)\) kept\.set\(key,offer\);/);
  // After the lead is swapped in, the place is put back to the branch.
  const at = route.search(/if \(branch\) \{\s*Object\.assign\(deal, \{/);
  assert.ok(at > -1, "expected the branch to be applied to the card");
  assert.ok(at > route.indexOf("Object.assign(deal, source, {"), "the branch must be applied after the lead swap, or the lead's stored address wins");
  const place = route.slice(at, at + 700);
  for (const field of ["address: branch.address", "city: branch.city", "primary_city: branch.city", "postal_prefix: branch.postal_prefix", "latitude: branch.latitude", "longitude: branch.longitude", "eligible_location_id: branch.location_id", "distance_km: branchKm"]) {
    assert.ok(place.includes(field), `${field} must describe the branch`);
  }
});

// The first deal of a group was copied shallowly and then pushed into, which wrote into the array
// the cached snapshot holds.
test("grouping does not write into the snapshot's arrays", () => {
  assert.match(route, /map\.set\(key,\{ \.\.\.deal,participating_locations:\[\.\.\.deal\.participating_locations\],brand_offers:\[offerSummary\(deal\)\] \}\)/);
});
