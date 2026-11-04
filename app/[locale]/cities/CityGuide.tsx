import ChromeLink from "../../ChromeLink";
import { GUIDES_PATH, cityPath, shortDate, type CityDeal, type GuideCity, type Topic } from "../../city-pages";

// The server-rendered list every city guide page shares. Plain links and plain text, no client
// state: the point of these pages is that the deals are in the HTML (see app/city-pages.ts).

function checkedLine(deal: CityDeal): string {
  if (deal.verified) {
    const date = shortDate(deal.verifiedAt);
    return date ? `Checked ${date}` : "Checked";
  }
  const date = shortDate(deal.createdAt);
  return date ? `Listed ${date}` : "Listed";
}

/** "Ottawa, ON": the name a reader knows the city by, with its province or state when there is one. */
export const cityLabel = (city: Pick<GuideCity, "name" | "region">) => (city.region ? `${city.name}, ${city.region}` : city.name);

export function DealList({ city, deals }: { city: Pick<GuideCity, "name">; deals: readonly CityDeal[] }) {
  return (
    <ul className="city-deals">
      {deals.map((deal) => (
        <li key={deal.id}>
          <ChromeLink href={`/deals/${encodeURIComponent(deal.slug || deal.id)}`} className="city-deal-link">
            <span className="city-deal-restaurant">{deal.restaurant}</span>
            <span className="city-deal-title">{deal.title}</span>
          </ChromeLink>
          <span className="city-deal-meta">
            {[
              deal.price,
              deal.schedule,
              deal.locations > 1 ? `${deal.locations} ${city.name} locations` : deal.address,
            ].filter(Boolean).join(" · ")}
          </span>
          <span className="city-deal-checked">{checkedLine(deal)}</span>
        </li>
      ))}
    </ul>
  );
}

export function TopicLinks({ city, topics, current }: { city: Pick<GuideCity, "slug">; topics: readonly { topic: Topic; deals: readonly CityDeal[] }[]; current?: string }) {
  return (
    <ul className="city-topics">
      {topics.map(({ topic, deals }) => (
        <li key={topic.slug}>
          {topic.slug === current
            ? <strong aria-current="page">{topic.label} ({deals.length})</strong>
            : <ChromeLink href={cityPath(city, topic.slug)}>{topic.label} ({deals.length})</ChromeLink>}
        </li>
      ))}
    </ul>
  );
}

/** Other guides as chips: a city page's nearby guides (app/city-groups.ts relatedGuides), or a topic page's. */
export function CityLinks({ cities, current }: { cities: readonly GuideCity[]; current?: string }) {
  const others = cities.filter((city) => city.slug !== current);
  if (!others.length) return null;
  return (
    <ul className="city-topics">
      {others.map((city) => (
        <li key={city.slug}><ChromeLink href={cityPath(city)}>{cityLabel(city)} ({city.deals})</ChromeLink></li>
      ))}
    </ul>
  );
}

const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** schema.org breadcrumb and ItemList of the page's deals, escaped for a <script> the way the home page's FAQ is. */
export function itemListJson(origin: string, city: GuideCity, name: string, deals: readonly CityDeal[], topic?: string): string {
  const hub = `${origin}/en${cityPath(city)}`;
  return json({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Radar", item: `${origin}/en` },
          { "@type": "ListItem", position: 2, name: "City guides", item: `${origin}/en${GUIDES_PATH}` },
          { "@type": "ListItem", position: 3, name: `${city.name} deals`, item: hub },
          ...(topic ? [{ "@type": "ListItem", position: 4, name, item: `${origin}/en${cityPath(city, topic)}` }] : []),
        ],
      },
      {
        "@type": "ItemList",
        name,
        numberOfItems: deals.length,
        itemListElement: deals.map((deal, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${origin}/en/deals/${encodeURIComponent(deal.slug || deal.id)}`,
          name: `${deal.title} at ${deal.restaurant}`,
        })),
      },
    ],
  });
}

/** The index's breadcrumb and its list of guides. */
export function guidesIndexJson(origin: string, cities: readonly GuideCity[]): string {
  return json({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Radar", item: `${origin}/en` },
          { "@type": "ListItem", position: 2, name: "City guides", item: `${origin}/en${GUIDES_PATH}` },
        ],
      },
      {
        "@type": "ItemList",
        name: "Radar city guides",
        numberOfItems: cities.length,
        itemListElement: cities.map((city, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${origin}/en${cityPath(city)}`,
          name: `${cityLabel(city)} happy hours and food deals`,
        })),
      },
    ],
  });
}
