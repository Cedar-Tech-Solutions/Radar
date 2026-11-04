import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { code } from "./source.mjs";
import { COMPACT_DEAL_FIELDS, PAYLOAD_LOCATION_MAX, capDealLocations, compactDeal } from "../app/dealView.ts";

// Bounding the location arrays /api/deals puts on a national chain deal.
//
// The deal page caps its own list at 250 (see tests/offer-locations-scope.test.mjs). This is the
// same problem one layer out: a deal in the search response carries chain_locations,
// participating_locations and other_brand_locations, three arrays over the same set, and none was
// bounded. It stayed invisible while the biggest chain was a 120-branch Tim Hortons; McDonald's US
// is thousands.
//
// The assertion that matters most is not the cap itself but what the cap does to a count. An array
// that has been trimmed is no longer something to take a length of, and there is a card on the
// homepage whose whole text is that length.

const read = (path) => code(readFileSync(new URL(path, import.meta.url), "utf8"));
const homeClient = read("../app/HomeClient.tsx");
const dealsRoute = read("../app/api/deals/route.ts");

/** n branches on a north-south line, so "nearest" has one unambiguous answer. */
const places = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ address: `${i + offset} Main St`, city: "Austin", latitude: 30 + i * 0.01, longitude: -97 }));

const dealWith = (n) => ({
  id: "d1",
  chain_locations: places(n),
  participating_locations: places(n),
  other_brand_locations: places(n),
});

test("a deal with few locations is handed back untouched", () => {
  // The cap is for chains. A single-location deal must not pay for it, and must not have its rows
  // reordered by a sort that had nothing to do.
  const small = dealWith(3);
  const out = capDealLocations(small, { latitude: 99, longitude: 99 });
  assert.deepEqual(out.chain_locations, small.chain_locations);
  assert.deepEqual(out.participating_locations, small.participating_locations);
  assert.equal(out.chain_locations, small.chain_locations, "the same array, not a copy");
});

test("all three location arrays are bounded, not just the one the map reads", () => {
  // other_brand_locations is rendered as an unbounded <ul> in the detail drawer, and chain_locations
  // is the biggest of the three. Capping only participating_locations would have left both.
  const out = capDealLocations(dealWith(500), null);
  for (const field of ["chain_locations", "participating_locations", "other_brand_locations"]) {
    assert.equal(out[field].length, PAYLOAD_LOCATION_MAX, `${field} must be capped`);
  }
  assert.ok(PAYLOAD_LOCATION_MAX > 0 && PAYLOAD_LOCATION_MAX <= 100, `a map's worth of pins, got ${PAYLOAD_LOCATION_MAX}`);
});

test("the counts are the real totals, measured before the cap", () => {
  // This is the false claim the cap would otherwise introduce: a McValue offer confirmed at every
  // branch in the country, on a card reading "40 confirmed locations".
  const out = capDealLocations(dealWith(9812), null);
  assert.equal(out.chain_location_count, 9812);
  assert.equal(out.participating_location_count, 9812);
  assert.equal(out.participating_locations.length, PAYLOAD_LOCATION_MAX, "and the array really was cut");
});

test("the branches kept are the ones nearest the reader", () => {
  // A capped list is only useful if it is the near end of the list. The far end is a map of another
  // state.
  const deal = { chain_locations: places(300), participating_locations: places(300) };
  const out = capDealLocations(deal, { latitude: 30, longitude: -97 });
  assert.equal(out.participating_locations[0].address, "0 Main St", "closest first");
  const kept = new Set(out.participating_locations.map((p) => p.address));
  assert.ok(kept.has(`${PAYLOAD_LOCATION_MAX - 1} Main St`), "the nearest run is kept");
  assert.ok(!kept.has("299 Main St"), "the far end is dropped");
  // From the other end of the line the answer inverts, which is what proves it is distance and not
  // insertion order doing the work.
  const far = capDealLocations(deal, { latitude: 33, longitude: -97 });
  assert.equal(far.participating_locations[0].address, "299 Main St");
});

test("with nowhere to sort from, the order is left alone", () => {
  // A bare nationwide browse has no origin. Sorting by distance from nothing is either a crash or an
  // arbitrary shuffle; both are worse than the order the snapshot already built.
  const out = capDealLocations(dealWith(100), null);
  assert.equal(out.chain_locations[0].address, "0 Main St");
  assert.equal(out.chain_locations[PAYLOAD_LOCATION_MAX - 1].address, `${PAYLOAD_LOCATION_MAX - 1} Main St`);
});

test("a branch with no coordinates sorts last instead of first", () => {
  // Number(null) is 0 and Number.isFinite(0) is true, so a null-island guard written after the cast
  // lets a branch with no coordinates through as a real point at 0,0. Against a North American
  // reader that scores as very distant and the bug hides; the reader below stands on the null island
  // itself, where a leaked 0 is the nearest thing there is.
  const unplaceable = [
    { address: "null coords", city: "Austin", latitude: null, longitude: null },
    { address: "undefined coords", city: "Austin" },
    { address: "junk coords", city: "Austin", latitude: "n/a", longitude: "n/a" },
  ];
  const deal = { participating_locations: [...unplaceable, ...places(PAYLOAD_LOCATION_MAX + 5, 1)] };
  const out = capDealLocations(deal, { latitude: 0, longitude: 0 });
  assert.equal(out.participating_locations.length, PAYLOAD_LOCATION_MAX);
  for (const place of unplaceable) {
    assert.ok(!out.participating_locations.some((p) => p.address === place.address),
      `${place.address} is unplaceable and must not rank as nearest`);
  }
});

test("the phone app's shape carries the counts too", () => {
  // compactDeal drops chain_locations outright, so without the counts a card in the app could only
  // say how many rows it happened to receive.
  assert.ok(COMPACT_DEAL_FIELDS.includes("chain_location_count"));
  assert.ok(COMPACT_DEAL_FIELDS.includes("participating_location_count"));
  const compact = compactDeal(capDealLocations(dealWith(9812), null));
  assert.equal(compact.participating_location_count, 9812);
  assert.equal(compact.chain_locations, undefined, "still dropped");
  assert.equal(compact.participating_locations.length, PAYLOAD_LOCATION_MAX);
});

test("the route caps the page it returns, not everything that matched", () => {
  // Capping before paging would sort thousands of arrays to throw all but one page of them away.
  assert.match(dealsRoute, /return capDealLocations\(deal as Record<string, unknown>, point\) as typeof deal;/);
  assert.match(dealsRoute, /filtered\.slice\(offset,offset\+limit\)/);
});

test("the homepage card reads the count and never an array length", () => {
  // The regression this guards is a one-word edit: swapping the count back for `.length` restores a
  // card that states a number it was explicitly sent the truth for.
  assert.match(homeClient, /const confirmedLocationCount = \(deal: Deal\) => deal\.participating_location_count \?\?/);
  assert.match(homeClient, /count: confirmedLocationCount\(d\)/);
  assert.ok(!/count: d\.participating_locations\?\.length/.test(homeClient),
    "the card must not count a capped array");
});
