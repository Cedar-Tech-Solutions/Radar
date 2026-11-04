// The city guides' index arrangement (app/city-groups.ts): grouping by country and province or
// state, the search match, and which guides a city page points to instead of every other one.
import assert from "node:assert/strict";
import test from "node:test";
import "./route-harness.mjs";

const { groupGuideCities, matchesCityQuery, relatedGuides, topGuideCities, fold } = await import("../app/city-groups.ts");

const city = (name, region, country, deals, restaurants = Math.ceil(deals / 2)) => ({ name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${region.toLowerCase()}`, region, country, deals, restaurants });

const CITIES = [
  city("Ottawa", "ON", "CA", 120),
  city("Toronto", "ON", "CA", 90),
  city("Kingston", "ON", "CA", 12),
  city("Montréal", "QC", "CA", 70),
  city("Trois-Rivières", "QC", "CA", 8),
  city("Vancouver", "BC", "CA", 60),
  city("Nowhere", "", "CA", 6),
  city("Austin", "TX", "US", 50),
  city("Houston", "TX", "US", 40),
  city("Vancouver", "WA", "US", 7),
  city("Portland", "OR", "US", 30),
];

test("cities are grouped by country, then province or state, alphabetically inside each", () => {
  const groups = groupGuideCities(CITIES);
  assert.deepEqual(groups.map((group) => group.name), ["Canada", "United States"], "the country with the most guides comes first");
  const canada = groups[0];
  assert.equal(canada.cities, 7);
  assert.equal(canada.deals, 366);
  assert.deepEqual(canada.regions.map((region) => region.name), ["British Columbia", "Ontario", "Quebec", "Other"], "regions by name, with the blank one last");
  assert.deepEqual(canada.regions[1].cities.map((c) => c.name), ["Kingston", "Ottawa", "Toronto"]);
  assert.equal(canada.regions[1].deals, 222);
  const us = groups[1];
  assert.deepEqual(us.regions.map((region) => region.name), ["Oregon", "Texas", "Washington"]);
  assert.deepEqual(us.regions[1].cities.map((c) => c.name), ["Austin", "Houston"]);
});

test("the search matches a city by name, province or state (code or name), or country, accents aside", () => {
  const find = (query) => CITIES.filter((c) => matchesCityQuery(c, query)).map((c) => `${c.name} ${c.region}`);
  assert.deepEqual(find("montreal"), ["Montréal QC"]);
  assert.deepEqual(find("trois rivieres"), ["Trois-Rivières QC"]);
  assert.deepEqual(find("Trois-Riv"), ["Trois-Rivières QC"]);
  assert.deepEqual(find("ontario"), ["Ottawa ON", "Toronto ON", "Kingston ON"]);
  assert.deepEqual(find("tx"), ["Austin TX", "Houston TX"]);
  assert.deepEqual(find("vancouver wa"), ["Vancouver WA"]);
  assert.deepEqual(find("vancouver"), ["Vancouver BC", "Vancouver WA"]);
  assert.deepEqual(find("united states").length, 4);
  assert.equal(find("   ").length, CITIES.length, "a blank query keeps everything");
  assert.deepEqual(find("zzz"), []);
  assert.equal(fold("Trois-Rivières"), "trois rivieres");
});

test("the shortcut row is the deepest cities, most deals first", () => {
  assert.deepEqual(topGuideCities(CITIES, 3).map((c) => c.name), ["Ottawa", "Toronto", "Montréal"]);
});

test("a city page points to the rest of its province or state, then the deepest cities in its country, never itself", () => {
  const kingston = CITIES[2];
  const related = relatedGuides(CITIES, kingston, 4).map((c) => `${c.name} ${c.region}`);
  assert.deepEqual(related, ["Ottawa ON", "Toronto ON", "Montréal QC", "Vancouver BC"]);
  const vancouverWa = CITIES[9];
  assert.deepEqual(relatedGuides(CITIES, vancouverWa, 10).map((c) => `${c.name} ${c.region}`), ["Austin TX", "Houston TX", "Portland OR"], "the other Vancouver is another country");
  assert.deepEqual(relatedGuides([kingston], kingston, 5), []);
});
