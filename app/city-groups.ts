import type { GuideCity } from "./city-pages";
import { regionName } from "./region-names";

// How the city guides' index arranges its cities, and which guides a city page points to.
//
// The index began as one flat row of chips, deepest city first. At a dozen cities that was a
// glance; at well over a hundred it was a wall a reader had to scan end to end for the one name
// they wanted, with Ottawa beside Omaha. Here they are grouped the way people place a city: by
// country, then by province or state, alphabetically inside each. The search box on top of it
// (app/[locale]/cities/CityFinder.tsx) narrows those groups by city, region or country name.
//
// Pure functions with no Worker imports, so the client component can run them in the browser;
// the data is the same GuideCity list guideCities() returns, a few hundred bytes a city at most.

export const COUNTRY_NAMES: Record<string, string> = { CA: "Canada", US: "United States" };

/** "Canada", or the code when it is one the index does not know. */
export const countryName = (code: string) => COUNTRY_NAMES[String(code || "").toUpperCase()] || code;

export interface RegionGroup {
  /** "ON", or "" for cities whose branches recorded no province or state. */
  region: string;
  /** "Ontario"; "Other" when the region is blank. */
  name: string;
  cities: GuideCity[];
  deals: number;
}

export interface CountryGroup {
  country: string;
  name: string;
  regions: RegionGroup[];
  cities: number;
  deals: number;
}

// The order the countries appear in: where most of the guides are first, then by name.
const byCountry = (a: CountryGroup, b: CountryGroup) => b.cities - a.cities || a.name.localeCompare(b.name, "en");
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

/** The cities by country and then province or state, each level sorted for a reader scanning for a name. */
export function groupGuideCities(cities: readonly GuideCity[]): CountryGroup[] {
  const countries = new Map<string, Map<string, GuideCity[]>>();
  for (const city of cities) {
    const country = String(city.country || "").toUpperCase();
    const region = String(city.region || "").toUpperCase();
    const regions = countries.get(country) || new Map<string, GuideCity[]>();
    regions.set(region, [...(regions.get(region) || []), city]);
    countries.set(country, regions);
  }
  return [...countries.entries()].map(([country, regions]): CountryGroup => {
    const groups = [...regions.entries()].map(([region, list]): RegionGroup => ({
      region,
      name: region ? regionName(region, country) : "Other",
      cities: [...list].sort(byName),
      deals: list.reduce((sum, city) => sum + city.deals, 0),
    })).sort((a, b) => (a.region ? 0 : 1) - (b.region ? 0 : 1) || byName(a, b));
    return {
      country,
      name: countryName(country),
      regions: groups,
      cities: groups.reduce((sum, group) => sum + group.cities.length, 0),
      deals: groups.reduce((sum, group) => sum + group.deals, 0),
    };
  }).sort(byCountry);
}

/** Lower-case, unaccented, so "trois rivieres" finds Trois-Rivières and "montreal" finds Montréal. */
export const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Whether a city answers a search: by its name, its province or state (code or full name), or its
 * country. Every word typed has to match somewhere, so "london on" is London, Ontario alone.
 */
export function matchesCityQuery(city: GuideCity, query: string): boolean {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = fold([city.name, city.region, regionName(city.region, city.country), city.country, countryName(city.country)].join(" "));
  return words.every((word) => haystack.includes(word));
}

/** The deepest guides, for the row of shortcuts above the full list. */
export function topGuideCities(cities: readonly GuideCity[], count: number): GuideCity[] {
  return [...cities].sort((a, b) => b.deals - a.deals || b.restaurants - a.restaurants || byName(a, b)).slice(0, count);
}

/**
 * The guides a city page points to instead of every other one: the rest of its province or state
 * first, then the deepest cities elsewhere in its country, up to `count`. A reader in Kingston
 * wants Ottawa and Toronto, not Omaha; the full list is one click away on the index.
 */
export function relatedGuides(cities: readonly GuideCity[], current: GuideCity, count: number): GuideCity[] {
  const others = cities.filter((city) => city.slug !== current.slug);
  const sameRegion = others.filter((city) => city.country === current.country && city.region === current.region).sort(byName);
  const sameCountry = others.filter((city) => city.country === current.country && city.region !== current.region)
    .sort((a, b) => b.deals - a.deals || byName(a, b));
  return [...sameRegion, ...sameCountry].slice(0, count);
}
