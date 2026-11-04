// A deal of the snapshot as one positional row, and back.
//
// A cold isolate parses the whole snapshot before it can answer anyone, and 44% of what it parsed
// was field names: 76 of them, written out again for every deal - 706 KB of 1.6 MB on 2026-10-03.
// A deal whose fields are exactly ROW_FIELDS, in that order, is sent as an array of its values
// instead, and rebuilt by rowBase.
//
// Rebuilt by an object literal that names every field, and that is the point. Version 4 of the
// snapshot sent rows too, and rebuilt each deal by assigning its fields by computed name
// (`deal[name] = value`): V8 keeps an object built that way in dictionary mode, and copying every
// deal, which each request does, went from under 1 ms to 12.5 ms. A literal builds the same fast
// object JSON.parse does - measured: the copy costs the same 0.07 ms either way, and parsing and
// rebuilding the rows takes 2.3 ms where parsing the objects took 4.1.
//
// The price of a literal is that the list is written down, and a deal's fields are whatever
// `SELECT d.*` returns. So nothing depends on the list being current: baseRow returns null for a
// deal with any other set of fields, in any other order, or holding an undefined, and that deal is
// sent as the object it is, as every deal was before. A column added by a migration makes every
// deal travel that way until it is added here - slower to parse, never wrong - and
// tests/snapshot-rows.test.mjs fails until it is. Nationwide deals carry one more field
// (footprint_regions) and always travel as objects; they were 80 of 596.
//
// Imports nothing, so the test can load it on its own.

/** A deal's fields, in the order buildBases and serializeSnapshot leave them. */
export const ROW_FIELDS = [
  "id", "restaurant", "title", "category", "cuisine", "schedule",
  "city", "postal_prefix", "address", "price", "emoji", "source_url",
  "sponsored", "active", "verified_at", "restaurant_id", "location_id", "status",
  "publish_at", "expires_at", "terms", "restrictions", "internal_notes", "verification_status",
  "deleted_at", "slug", "description", "locale", "discount_percent", "savings_cents",
  "updated_at", "created_at", "price_tier", "location_scope", "redemption", "redemption_note",
  "photo_url", "promo_code", "owner_confirmed_at", "canonical_restaurant", "restaurant_website", "restaurant_photo_url", "restaurant_logo_url",
  "restaurant_country", "restaurant_footprint", "restaurant_locator_url", "restaurant_phone", "amenities", "dietary_options",
  "accessibility", "canonical_restaurant_id", "is_chain", "hidden_gem", "national_chain", "brand",
  "service_style", "vertical", "latitude", "longitude", "timezone", "country",
  "region", "eligible_location_id", "neighborhood", "location_website", "schedule_days", "start_time",
  "end_time", "recurring", "save_count", "effective_verification_status", "under_review", "primary_city",
  "chain_brand", "search_keywords", "indexed", "search_text", "chain_location_count", "participating_location_count",
  "chain_locations",
] as const;

/** `base` as a row, or null when it is not exactly ROW_FIELDS and has to travel as it is. */
export function baseRow(base: Record<string, unknown>): unknown[] | null {
  const keys = Object.keys(base);
  if (keys.length !== ROW_FIELDS.length) return null;
  const row = new Array<unknown>(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const value = base[keys[i]];
    // JSON writes an undefined in an array as null and leaves it out of an object.
    if (keys[i] !== ROW_FIELDS[i] || value === undefined) return null;
    row[i] = value;
  }
  return row;
}

/** The deal a row was made from: the same fields in the same order, built the way a literal is. */
export function rowBase(r: readonly unknown[]): Record<string, unknown> | null {
  if (r.length !== ROW_FIELDS.length) return null;
  return {
    id: r[0], restaurant: r[1], title: r[2], category: r[3], cuisine: r[4], schedule: r[5],
    city: r[6], postal_prefix: r[7], address: r[8], price: r[9], emoji: r[10], source_url: r[11],
    sponsored: r[12], active: r[13], verified_at: r[14], restaurant_id: r[15], location_id: r[16], status: r[17],
    publish_at: r[18], expires_at: r[19], terms: r[20], restrictions: r[21], internal_notes: r[22], verification_status: r[23],
    deleted_at: r[24], slug: r[25], description: r[26], locale: r[27], discount_percent: r[28], savings_cents: r[29],
    updated_at: r[30], created_at: r[31], price_tier: r[32], location_scope: r[33], redemption: r[34], redemption_note: r[35],
    photo_url: r[36], promo_code: r[37], owner_confirmed_at: r[38], canonical_restaurant: r[39], restaurant_website: r[40], restaurant_photo_url: r[41],
    restaurant_logo_url: r[42], restaurant_country: r[43], restaurant_footprint: r[44], restaurant_locator_url: r[45], restaurant_phone: r[46], amenities: r[47],
    dietary_options: r[48], accessibility: r[49], canonical_restaurant_id: r[50], is_chain: r[51], hidden_gem: r[52], national_chain: r[53],
    brand: r[54], service_style: r[55], vertical: r[56], latitude: r[57], longitude: r[58], timezone: r[59],
    country: r[60], region: r[61], eligible_location_id: r[62], neighborhood: r[63], location_website: r[64], schedule_days: r[65],
    start_time: r[66], end_time: r[67], recurring: r[68], save_count: r[69], effective_verification_status: r[70], under_review: r[71],
    primary_city: r[72], chain_brand: r[73], search_keywords: r[74], indexed: r[75], search_text: r[76], chain_location_count: r[77],
    participating_location_count: r[78], chain_locations: r[79],
  };
}
