import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { freshDatabase, harness, post } from "./route-harness.mjs";

// What the public deal listing sends, decided field by field. The listing is the one answer anybody
// can ask for without an account, so anything it carries is as public as the deal itself: the
// columns staff and the search work with stay on the server. A field added to `deals`,
// `restaurants` or the snapshot reaches this answer through `d.*` and the joins without anyone
// choosing to send it, and these tests are where that choice gets made.

const { GET: dealsGet } = await import("../app/api/deals/route.ts");
const { GET: picksGet } = await import("../app/api/creator-picks/route.ts");
const { POST: creatorPost } = await import("../app/api/creator/route.ts");
const { sharedAnswerKey } = await import("../app/deals-answer.ts");

const SAMPLE = readFileSync(new URL("../scripts/sample-data.sql", import.meta.url), "utf8");
const NOTE = "staff-only-note-7d1c";

// Every field a reader is sent, and every field of a location in its lists. Adding one is a
// decision about what the public may read: add it here only if a client needs it.
const PUBLIC_FIELDS = new Set([
  "id", "slug", "restaurant", "canonical_restaurant", "title", "description", "category", "cuisine", "category_label",
  "cuisine_label", "schedule", "price", "price_tier", "emoji", "source_url", "sponsored", "active", "status", "locale",
  "city", "postal_prefix", "address", "region", "country", "neighborhood", "timezone", "latitude", "longitude",
  "verified_at", "verification_status", "effective_verification_status", "expires_at", "created_at", "updated_at",
  "terms", "restrictions", "location_scope", "redemption", "redemption_note", "promo_code", "photo_url",
  "restaurant_id", "canonical_restaurant_id", "restaurant_website", "restaurant_photo_url", "restaurant_logo_url",
  "restaurant_locator_url", "amenities", "dietary_options", "accessibility", "is_chain", "hidden_gem", "brand",
  "chain_brand", "service_style", "vertical", "schedule_days", "start_time", "end_time", "recurring", "save_count",
  "chain_locations", "chain_location_count", "participating_locations", "participating_location_count",
  "other_brand_locations", "brand_offers", "offer_varies_by_location", "brand_name", "chain_offers", "distance_km",
  "availability", "available_today", "available_now", "availability_phase", "tonight", "expiry_timezone",
]);
const LOCATION_FIELDS = new Set([
  "city", "address", "postal_prefix", "region", "source_url", "latitude", "longitude", "location_id", "eligibility",
  "offer_available", "offers", "offer", "approximate", "distance_km",
]);
// The ones that must never come back, named so a failure says which.
const SERVER_ONLY = [
  "search_keywords", "search_score", "indexed", "internal_notes", "deleted_at", "publish_at", "owner_confirmed_at",
  "under_review", "location_eligibility", "location_id", "eligible_location_id", "primary_city", "national_chain",
  "discount_percent", "savings_cents", "restaurant_footprint", "restaurant_country", "restaurant_phone", "location_website",
  "search_text", "footprint_regions",
];

function seed() {
  const db = freshDatabase();
  db.exec(SAMPLE);
  // Every column a staff member or the pipeline fills in, filled in, so that leaving one in would show.
  db.prepare(
    "UPDATE deals SET internal_notes=?,owner_confirmed_at=CURRENT_TIMESTAMP,discount_percent=50,savings_cents=600 WHERE id='sample-maple-tavern-happy-hour'",
  ).run(NOTE);
  db.prepare("UPDATE restaurants SET phone='+1 555 0100',footprint='local' WHERE id='sample-maple-tavern'").run();
  return db;
}

const listing = async (query) => {
  const response = await dealsGet(new Request(`https://radar.cheap/api/deals?${query}`));
  assert.equal(response.status, 200, query);
  return response.text();
};

const QUERIES = [
  "lat=45.4215&lng=-75.6972",
  "postal=K1P1J1",
  "q=tacos",
  "",
  "scope=national",
  "lat=45.4215&lng=-75.6972&group=brand",
  "lat=45.4215&lng=-75.6972&chains=separate",
  "id=sample-maple-tavern-happy-hour",
];

test("a listing carries only the fields readers are meant to have", async () => {
  seed();
  let seen = 0;
  for (const query of QUERIES) {
    const text = await listing(query);
    assert.doesNotMatch(text, new RegExp(NOTE), `${query}: staff notes`);
    for (const deal of JSON.parse(text).results) {
      seen += 1;
      for (const field of SERVER_ONLY) assert.ok(!Object.hasOwn(deal, field), `${query}: ${field} is sent`);
      for (const [field, value] of Object.entries(deal)) {
        assert.ok(PUBLIC_FIELDS.has(field), `${query}: ${field} is sent but has not been decided on - see PUBLIC_FIELDS`);
        if (!Array.isArray(value) || !/locations$/.test(field)) continue;
        for (const place of value) for (const key of Object.keys(place)) assert.ok(LOCATION_FIELDS.has(key), `${query}: ${field}[].${key}`);
      }
    }
  }
  assert.ok(seen >= QUERIES.length, "the queries found deals to check");
});

test("the copy of the catalog kept outside the database carries no staff notes", async () => {
  seed();
  const stored = [];
  harness.env.PHOTOS = {
    async get() { return null; },
    async put(key, value) { stored.push([key, String(value)]); },
  };
  try {
    // A module of its own is an isolate of its own: one with no snapshot in memory, which builds one
    // and stores it.
    const { GET } = await import("../app/api/deals/route.ts?cold-isolate");
    assert.equal((await GET(new Request("https://radar.cheap/api/deals?lat=45.4215&lng=-75.6972"))).status, 200);
  } finally {
    delete harness.env.PHOTOS;
  }
  // In shards: the meta shard carries no deal, and the cells around the point carry the deals.
  const snapshots = stored.filter(([key]) => key.startsWith("internal/deals-snapshot/"));
  assert.ok(snapshots.length > 0, "the snapshot was stored");
  assert.ok(snapshots.some(([, body]) => /Half-price appetizers/.test(body)), "a shard holds the deal");
  for (const [key, body] of snapshots) assert.doesNotMatch(body, new RegExp(NOTE), key);
});

test("a request for many ids is answered for the first page's worth", async () => {
  seed();
  const ids = [...Array.from({ length: 60 }, (_, i) => `id=missing-${i}`), "id=sample-maple-tavern-happy-hour"].join("&");
  const { results } = JSON.parse(await listing(ids));
  assert.equal(results.length, 0, "ids past the first 50 are not looked at");
  const { results: found } = JSON.parse(await listing(`id=sample-maple-tavern-happy-hour&${ids}`));
  assert.deepEqual(found.map((deal) => deal.id), ["sample-maple-tavern-happy-hour"]);
});

test("a zone the route would ignore does not stand in for the network's in the shared answer", () => {
  const ask = (query, timezone) => {
    const request = new Request(`https://radar.cheap/api/deals?${query}`);
    Object.defineProperty(request, "cf", { value: { country: "CA", timezone, regionCode: "ON", latitude: "45.4", longitude: "-75.7" } });
    return sharedAnswerKey(request, new URL(request.url)).url;
  };
  const point = "lat=45.4215&lng=-75.6972";
  assert.notEqual(ask(`${point}&tz=Not/AZone`, "America/Toronto"), ask(`${point}&tz=Not/AZone`, "America/Vancouver"));
  assert.notEqual(ask(`${point}&tz=`, "America/Toronto"), ask(`${point}&tz=`, "America/Vancouver"));
  assert.equal(ask(`${point}&tz=America/Toronto`, "America/Toronto"), ask(`${point}&tz=America/Toronto`, "America/Vancouver"));
  const national = `${point}&scope=national&tz=America/Toronto`;
  assert.notEqual(ask(`${national}&province=%20.`, "America/Toronto"), ask(`${national}&province=ON`, "America/Toronto"));
});

test("a deal scheduled for later is neither shown in a creator's picks nor pickable", async () => {
  const db = seed();
  db.prepare("INSERT INTO users (id,email,role) VALUES ('creator','c@example.test','creator')").run();
  db.prepare("INSERT INTO creator_profiles (user_id,handle,status,commission_rate_bps) VALUES ('creator','eats','active',2000)").run();
  db.prepare("UPDATE deals SET publish_at=datetime('now','+3 days') WHERE id='sample-casa-verde-taco-night'").run();
  db.prepare("INSERT INTO creator_picks (handle,deal_id,note,position) VALUES ('eats','sample-casa-verde-taco-night','soon',0),('eats','sample-lantern-noodle-ramen-tuesday','now',1)").run();

  const { picks } = await (await picksGet(new Request("https://radar.cheap/api/creator-picks?c=eats"))).json();
  assert.deepEqual(picks.map((pick) => pick.id), ["sample-lantern-noodle-ramen-tuesday"]);

  harness.user = { userId: "creator", email: "c@example.test", role: "creator", permissions: new Set() };
  const response = await creatorPost(post("https://radar.cheap/api/creator", { action: "save_pick", dealId: "sample-casa-verde-taco-night" }));
  assert.equal(response.status, 404);
  const saved = await creatorPost(post("https://radar.cheap/api/creator", { action: "save_pick", dealId: "sample-maple-tavern-happy-hour" }));
  assert.equal(saved.status, 200);
});
