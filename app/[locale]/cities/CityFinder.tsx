"use client";
import { useId, useMemo, useState } from "react";
import ChromeLink from "../../ChromeLink";
import { cityPath, type GuideCity } from "../../city-pages";
import { groupGuideCities, matchesCityQuery, topGuideCities } from "../../city-groups";
import { cityLabel } from "./CityGuide";

// The city guides' index: a search box and a country switch over the cities grouped by province
// or state (app/city-groups.ts). Every link is in the server HTML - this component renders the
// same list on the server, with nothing filtered - and the script only hides what a typed query
// or a picked country rules out. A reader without the script, or a crawler, sees the whole index.

const TOP_COUNT = 8;

export default function CityFinder({ cities }: { cities: readonly GuideCity[] }) {
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const id = useId();

  const groups = useMemo(() => groupGuideCities(cities), [cities]);
  const top = useMemo(() => topGuideCities(cities, TOP_COUNT), [cities]);
  const shown = useMemo(() => {
    const trimmed = query.trim();
    return groups
      .filter((group) => !country || group.country === country)
      .map((group) => ({
        ...group,
        regions: group.regions
          .map((region) => ({ ...region, cities: trimmed ? region.cities.filter((city) => matchesCityQuery(city, trimmed)) : region.cities }))
          .filter((region) => region.cities.length),
      }))
      .filter((group) => group.regions.length);
  }, [groups, query, country]);
  const matched = shown.reduce((sum, group) => sum + group.regions.reduce((inner, region) => inner + region.cities.length, 0), 0);
  const narrowed = Boolean(query.trim()) || Boolean(country);
  // One heading level per group when a country is picked: its name is already the filter's label.
  const manyCountries = shown.length > 1 || !country;

  return (
    <div className="city-finder">
      <div className="city-finder-controls" role="search">
        <label className="city-finder-search">
          <span>Find a city</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="City, province or state"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-status`}
          />
        </label>
        {groups.length > 1 && (
          <div className="city-finder-countries" role="group" aria-label="Country">
            <button type="button" aria-pressed={country === ""} onClick={() => setCountry("")}>All</button>
            {groups.map((group) => (
              <button key={group.country} type="button" aria-pressed={country === group.country} onClick={() => setCountry(group.country)}>
                {group.name} <span className="city-finder-count">{group.cities}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p id={`${id}-status`} className="city-finder-status" role="status" aria-live="polite">
        {narrowed ? `${matched} ${matched === 1 ? "city" : "cities"} match` : ""}
      </p>

      {!narrowed && top.length > 1 && (
        <section className="city-finder-top" aria-labelledby={`${id}-top`}>
          <h2 id={`${id}-top`}>Most deals</h2>
          <ul className="city-topics">
            {top.map((city) => (
              <li key={city.slug}><ChromeLink href={cityPath(city)}>{cityLabel(city)} <span className="city-finder-count">{city.deals}</span></ChromeLink></li>
            ))}
          </ul>
        </section>
      )}

      {shown.length === 0 ? (
        <p className="city-finder-empty">
          No city guide matches &ldquo;{query.trim()}&rdquo;. Radar writes a guide once a city has enough restaurants in it;
          until then, <ChromeLink href="/">search the map</ChromeLink> for that city.
        </p>
      ) : shown.map((group) => (
        <section key={group.country} className="city-finder-country" aria-labelledby={`${id}-${group.country}`}>
          <h2 id={`${id}-${group.country}`}>
            {group.name} {manyCountries && <span className="city-finder-count">{group.cities} {group.cities === 1 ? "city" : "cities"}</span>}
          </h2>
          <div className="city-finder-regions">
            {group.regions.map((region) => (
              <div key={region.region || "other"} className="city-finder-region">
                <h3>{region.name}</h3>
                <ul>
                  {region.cities.map((city) => (
                    <li key={city.slug}>
                      <ChromeLink href={cityPath(city)}>
                        <span className="city-finder-name">{city.name}</span>
                        <span className="city-finder-meta">{city.deals} {city.deals === 1 ? "deal" : "deals"} · {city.restaurants} {city.restaurants === 1 ? "restaurant" : "restaurants"}</span>
                      </ChromeLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
