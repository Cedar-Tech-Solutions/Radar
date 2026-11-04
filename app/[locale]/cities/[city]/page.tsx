import type { Metadata } from "next";
import { cache } from "react";
import { env } from "cloudflare:workers";
import { notFound, permanentRedirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { englishOnlyAlternates } from "../../../alternates";
import { GUIDES_PATH, cityDeals, cityHomeQuery, cityPath, guideCities, lastChecked, publishedTopics, restaurantCount } from "../../../city-pages";
import { relatedGuides } from "../../../city-groups";
import ChromeLink from "../../../ChromeLink";
import PublicPage from "../../../PublicPage";
import { getSiteOrigin, pageMetadata } from "../../../siteMetadata";
import { dealPageTitle } from "../../../deal-meta";
import { CityLinks, DealList, TopicLinks, cityLabel, itemListJson } from "../CityGuide";

export const dynamic = "force-dynamic";

/** How many other guides a city page points to: its province or state first, then the deepest in its country. */
const RELATED_GUIDES = 12;

const load = cache(async (slug: string) => {
  const cities = await guideCities(env.DB);
  const city = cities.find((candidate) => candidate.slug === slug);
  return city ? { city, cities, deals: await cityDeals(env.DB, city) } : null;
});

// English only in every locale, the convention the legal pages follow: the deal text is English, so
// a French page of it would be a translation of the frame around English. /fr/cities/... and
// /es/cities/... answer with a redirect to the one address that is indexed.
export async function generateMetadata({ params }: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const found = await load((await params).city);
  if (!found?.deals.length) return {};
  const { city, deals } = found;
  const date = lastChecked(deals);
  return pageMetadata({
    title: dealPageTitle(`${cityLabel(city)} happy hours and food deals`),
    description: `${deals.length} happy hours and daily food deals at ${restaurantCount(deals)} ${cityLabel(city)} restaurants, with the days, hours and prices each one runs.${date ? ` Last checked ${date}.` : ""}`,
    alternates: englishOnlyAlternates(cityPath(city)),
  });
}

export default async function CityGuidePage({ params }: { params: Promise<{ locale: string; city: string }> }) {
  const { locale, city: slug } = await params;
  if (locale !== "en") permanentRedirect(`/en${GUIDES_PATH}/${encodeURIComponent(slug)}`);
  setRequestLocale(locale);
  const found = await load(slug);
  if (!found?.deals.length) notFound();
  const { city, cities, deals } = found;
  const topics = publishedTopics(deals);
  const origin = (await getSiteOrigin()).origin;
  const happyHours = deals.filter((deal) => deal.category === "Happy hour");
  const date = lastChecked(deals);
  const related = relatedGuides(cities, city, RELATED_GUIDES);
  return (
    <PublicPage className="legal city-page">
      <article lang="en">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: itemListJson(origin, city, `${city.name} deals`, deals) }} />
        <span className="kicker">{cityLabel(city).toUpperCase()}</span>
        <h1>{city.name} happy hours and food deals</h1>
        <p className="lead">
          {deals.length} deals at {restaurantCount(deals)} {city.name} restaurants: {happyHours.length} happy hours and{" "}
          {deals.length - happyHours.length} food deals, each with the days and hours it runs.
          {date ? ` The most recent check was ${date}.` : ""}
        </p>
        <p>
          Every listing on Radar is read off the restaurant&rsquo;s own page and carries the date it was checked,
          or the date it was listed when nobody has checked it yet. Prices and hours change without notice, so
          confirm with the restaurant before you go. Want to see only what is running right now?{" "}
          <ChromeLink href={cityHomeQuery(city)}>Open {city.name} on the map</ChromeLink>.
        </p>

        {!!topics.length && <>
          <h2>Browse {city.name} deals by topic</h2>
          <TopicLinks city={city} topics={topics} />
        </>}

        <h2>Every {city.name} deal</h2>
        <DealList city={city} deals={deals} />

        {related.length > 0 && <>
          <h2>Nearby city guides</h2>
          <CityLinks cities={related} />
          <p>
            <ChromeLink href="/cities">All {cities.length} city guides</ChromeLink>, by province and state.
          </p>
        </>}
      </article>
    </PublicPage>
  );
}
