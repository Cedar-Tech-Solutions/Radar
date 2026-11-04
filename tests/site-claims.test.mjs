import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { code } from "./source.mjs";

// What the site tells people about itself, checked against the code that decides whether it is
// true.
//
// Every claim below was false on the live site at some point: a support page (the App Store's
// support URL) naming two cities, one with four listings; an FAQ, repeated to search engines as
// structured data, saying every listing was checked at the source before it went live; a cookie
// banner denying the referral cookies a creator's link sets; a paid feature that was an empty
// list; creators told to write to a domain with no mail server. None of it throws or 500s, which
// is why it lasted. The assertions tie each claim to the thing it describes, so the claim and the
// code have to move together.

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const LOCALES = ["en", "fr", "es"];
const catalogs = Object.fromEntries(
  await Promise.all(LOCALES.map(async (locale) => [locale, JSON.parse(await read(`../messages/${locale}.json`))])),
);

// JSX prose with its markup and entities flattened, so a sentence broken across lines or around a
// <strong> can be matched as the sentence a reader sees.
function prose(source) {
  return code(source)
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&rsaquo;/g, "›")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

test("support describes where Radar works without a list or a count that goes stale", async () => {
  const support = prose(await read("../app/[locale]/support/page.tsx"));
  // lastIndexOf: the first occurrence of each heading is its entry in the contents list.
  const coverage = support.slice(support.lastIndexOf("2. Where Radar works"), support.lastIndexOf("3. Accounts and sign-in"));
  assert.ok(coverage.length > 200, "the coverage section was not found");
  assert.doesNotMatch(coverage, /Toronto and Ottawa/, "the two-city claim is back");
  assert.match(coverage, /Canada/);
  assert.match(coverage, /US cities/, "the US listings are part of the footprint");
  assert.match(coverage, /nationwide section/, "the chain section is part of the footprint");
  assert.match(coverage, /Chain restaurants/, "and it says how to turn the section on");
  assert.doesNotMatch(coverage, /\b\d+\s+(cities|restaurants|deals|listings)\b/, "a count here is wrong within a week");
  // How a thin area behaves, which is what the API does: a radius, an offer to widen it, and
  // never results from somewhere else.
  assert.match(coverage, /offers to search farther/);
  assert.match(coverage, /rather than filled with offers from somewhere else/);
  const route = code(await read("../app/api/deals/route.ts"));
  assert.match(route, /expandRadius:!nationalOnly && totalMatches < 4 \? widerRadius\(radius, maxRadius\) : null/);
  assert.match(route, /autoWidenRadius:!nationalOnly && resolvedLocation \? autoWidenRadius\(radius, totalMatches, searcherPro\) : null/);
  assert.match(coverage, /Radar looks one step farther, up to\s+25 km/);

  // The web sells a yearly plan beside the monthly one; Apple sells monthly only.
  assert.match(support, /monthly or yearly on the website and monthly in the iOS app/);
  assert.doesNotMatch(support, /Radar Pro is a monthly subscription\./);
});

test("the home FAQ, which is also the page's FAQPage structured data, says how listings are really checked", async () => {
  const page = code(await read("../app/[locale]/page.tsx"));
  // The JSON-LD is built from these same messages, so fixing the catalog fixes both.
  assert.match(page, /getTranslations\(\{ locale, namespace: "home\.faq" \}\)/);
  for (const locale of LOCALES) {
    const faq = catalogs[locale].home.faq;
    assert.ok(faq.q2.answer.length < 400, `${locale}: keep the answer short`);
  }
  const en = catalogs.en.home.faq;
  assert.doesNotMatch(en.q2.answer, /before it goes live/, "not every listing is checked at the source before it is published");
  assert.match(en.q2.answer, /links to its source/);
  assert.match(en.q2.answer, /last verified/);
  assert.match(en.q2.answer, /when it was listed/);
  assert.match(en.q2.answer, /Re-checking/);
  assert.doesNotMatch(en.q3.answer, /continuously/, "nothing ingests deals continuously");
  // "Re-checking" is the label the cards really carry.
  const labels = await read("../app/i18n/dealLabels.ts");
  assert.match(labels, /reChecking: "Re-checking"/);
  assert.match(catalogs.fr.home.faq.q2.answer, /Nouvelle vérification/);
  assert.match(catalogs.es.home.faq.q2.answer, /Reverificando/);
});

test("the privacy policy and the cookie banner disclose the creator referral cookies", async () => {
  const link = code(await read("../app/CreatorLink.tsx"));
  const cookie = link.match(/CREATOR_COOKIE = "([^"]+)"/)[1];
  const campaign = link.match(/CREATOR_CAMPAIGN_COOKIE = "([^"]+)"/)[1];
  assert.match(link, /THIRTY_DAYS = 60 \* 60 \* 24 \* 30;/, "the lifetime the policy states changed");

  const privacy = prose(await read("../app/[locale]/privacy/page.tsx"));
  const storage = privacy.slice(privacy.lastIndexOf("5. Cookies and browser storage"), privacy.lastIndexOf("6. Payments"));
  assert.ok(storage.includes(cookie) && storage.includes(campaign), "both cookie names are listed under Cookies and browser storage");
  assert.match(storage, /for 30 days/);
  assert.doesNotMatch(privacy, /does not use advertising or cross-site tracking cookies/, "the referral cookie is exactly the kind this denied");
  // What happens at sign-up, and afterwards.
  assert.match(privacy, /store the handle and label on your account/);
  assert.match(privacy, /commission record/);
  // And the account really is written at sign-up, from those same cookies.
  const auth = code(await read("../app/auth.ts"));
  assert.match(auth, new RegExp(`cookieStore\\.get\\("${cookie}"\\)`));
  assert.match(auth, new RegExp(`cookieStore\\.get\\("${campaign}"\\)`));
  assert.match(auth, /INSERT INTO users\(id,email,name,role,referred_by,referred_campaign\)/);

  for (const locale of LOCALES) {
    const body = catalogs[locale].home.cookieNotice.body;
    assert.match(body, /\b30\b/, `${locale}: the banner states how long the referral cookie lasts`);
    assert.doesNotMatch(body, /tracking|suivi|seguimiento/i, `${locale}: the banner must not deny tracking cookies`);
  }
  // The banner links straight to the section that lists them, and people who dismissed the old
  // wording see the new one once.
  const notice = code(await read("../app/CookieNotice.tsx"));
  // A ChromeLink, which writes the reader's locale in front of the path (app/ChromeLink.tsx).
  assert.match(notice, /<ChromeLink href="\/privacy#storage">/);
  assert.doesNotMatch(notice, /"radar:cookie-notice-dismissed"/);
});

test("every provider a page makes the browser load is in the privacy policy's table", async () => {
  const privacy = code(await read("../app/[locale]/privacy/page.tsx"));
  const rows = [...privacy.matchAll(/^\s*\["([^"]+)", "([^"]+)", "([^"]+)"\],$/gm)].map((match) => ({ name: match[1], purpose: match[2] }));
  assert.ok(rows.length >= 9, "the provider table was not found");

  const logo = code(await read("../app/BrandLogo.tsx"));
  if (logo.includes("https://www.google.com/s2/favicons")) {
    assert.ok(rows.some((row) => row.name === "Google" && /favicon/.test(row.purpose)), "BrandLogo loads Google's favicon service");
  }
  const map = code(await read("../app/[locale]/deals/[slug]/DealMap.tsx"));
  if (map.includes("https://www.openstreetmap.org/export/embed.html")) {
    assert.ok(rows.some((row) => /OpenStreetMap/.test(row.name) && /map on a deal page/.test(row.purpose)), "DealMap embeds openstreetmap.org");
  }
  // Mapbox geocodes; the site draws no Mapbox map.
  const mapbox = rows.find((row) => row.name === "Mapbox");
  assert.ok(mapbox && !/render/i.test(mapbox.purpose), "Mapbox is not what draws the maps");
});

test("the terms cover a subscription bought through Apple", async () => {
  const terms = prose(await read("../app/[locale]/terms/page.tsx"));
  const plans = terms.slice(terms.lastIndexOf("5. Free plan and Radar Pro"), terms.lastIndexOf("6. Deal alert emails"));
  assert.ok(plans.length > 500, "section 5 was not found");
  assert.match(plans, /Purchases in the iOS app\./);
  assert.match(plans, /App Store/);
  assert.match(plans, /Settings › your name › Subscriptions/, "the same cancel path support gives");
  assert.match(plans, /reportaproblem\.apple\.com/, "the same refund path support gives");
  assert.match(plans, /renews it automatically/);
  // The support page says the same, and the two must not drift apart.
  const support = prose(await read("../app/[locale]/support/page.tsx"));
  assert.match(support, /Settings › your name › Subscriptions/);
  assert.match(support, /reportaproblem\.apple\.com/);
});

test("alert copy promises the roundup the digest actually sends", async () => {
  const digest = code(await read("../app/api/jobs/digests/route.ts"));
  // The digest takes the top N live deals near the area, with no filter for new or newly verified
  // ones, and skips a recipient only when there are none.
  const size = Number(digest.match(/\.filter\(\(deal\) => nearRecipient\(deal, reach, prefix\)\)\.slice\(0, (\d+)\)/)[1]);
  assert.equal(size, 8);
  const dealSql = digest.slice(digest.indexOf("const DEAL_SQL"), digest.indexOf("function groupDeals"));
  assert.match(dealSql, /WHERE d\.status='live'/);
  assert.doesNotMatch(dealSql, /d\.(created_at|updated_at|verified_at|publish_at)\s*[<>]/, "the digest started filtering by age; the copy can say so again");
  assert.match(digest, /if \(!deals\.length\) continue;/);

  const en = catalogs.en;
  assert.doesNotMatch(en.pro.highlights.alerts.title, /the day it's verified/i);
  assert.match(en.pro.highlights.alerts.body, /\beight\b/, "the Pro highlight states the roundup's size");
  assert.match(en.pro.highlights.alerts.body, /waitlist/, "email delivery is gated on the pilot, and the page selling it says so");
  for (const text of [en.pro.highlights.alerts.body, en.home.faq.q4.answer, en.home.community.body, en.dashboard.sectionIntro.alerts]) {
    assert.doesNotMatch(text, /\bnew (deals|offers)\b|something new/i, `the digest does not select new deals: ${text}`);
  }
  // Choosing days and a time is Pro; the free plan is one day a week at a fixed hour.
  const user = code(await read("../app/api/user/route.ts"));
  // The rule is app/plan-limits.ts's, which the save and the digest job both apply.
  assert.match(user, /const \{ days, time \} = alertSchedule\(isPro\(user\), requestedDays\.map\(Number\), requestedTime\);/);
  const { alertSchedule, FREE_ALERT_TIME } = await import("../app/plan-limits.ts");
  assert.equal(FREE_ALERT_TIME, "08:00");
  assert.deepEqual(alertSchedule(false, [3, 5], "19:30"), { days: [3], time: "08:00" });
  assert.deepEqual(alertSchedule(true, [3, 5], "19:30"), { days: [3, 5], time: "19:30" });
  assert.match(code(await read("../app/api/jobs/digests/route.ts")), /alertSchedule\(pro, /, "the digest applies the plan at send time");
  assert.match(en.home.community.body, /Radar Pro adds more days/);
  assert.match(en.home.faq.q4.answer, /with Radar Pro/);

  const support = prose(await read("../app/[locale]/support/page.tsx"));
  assert.doesNotMatch(support, /nothing new has been listed/);
  assert.match(support, /skipped when nothing is listed within the area’s radius/);
  const launch = prose(await read("../app/[locale]/launch/page.tsx"));
  assert.doesNotMatch(launch, /when something new appears/);
});

test("Pro sells nothing that shows a subscriber nothing", async () => {
  // The dashboard's early-access section lists markets in 'researching' and renders only when
  // there is one. With no researching market, the feature is an empty list.
  const pro = code(await read("../app/[locale]/pro/page.tsx"));
  assert.doesNotMatch(pro, /earlyAccess/);
  for (const locale of LOCALES) assert.equal(catalogs[locale].pro.features.earlyAccess, undefined, `${locale} still has the row`);
  const terms = prose(await read("../app/[locale]/terms/page.tsx"));
  assert.doesNotMatch(terms, /coming-soon markets/);
  // Every row the table renders has its copy in all three catalogs.
  const keys = [...pro.matchAll(/\{ key: "(\w+)", icon: \w+, free: "\w+" \}/g)].map((match) => match[1]);
  assert.ok(keys.length >= 5);
  for (const locale of LOCALES) {
    for (const key of keys) assert.ok(catalogs[locale].pro.features[key]?.label, `${locale} has no copy for ${key}`);
  }
});

test("the launch page makes no claim the product has since stopped backing", async () => {
  const launch = prose(await read("../app/[locale]/launch/page.tsx"));
  assert.doesNotMatch(launch, /including the deal copy itself/, "deal text is not translated");
  assert.match(launch, /Canada and the United States/);
  assert.doesNotMatch(launch, /claim their page/, "restaurants cannot claim a page");
  assert.match(launch, /Radar for restaurants/);
});

test("the footer's restaurant link lands on the form it names", async () => {
  const footer = code(await read("../app/SiteFooter.tsx"));
  const anchor = footer.match(/href: "\/for-restaurants#(\w+)"/)[1];
  const page = code(await read("../app/[locale]/for-restaurants/page.tsx"));
  assert.match(page, new RegExp(`id="${anchor}"`), "the footer links to an anchor the page does not have");
  // And the section with that id is the one holding the form.
  const section = page.slice(page.indexOf(`id="${anchor}"`));
  const form = section.search(/<RestaurantInquiry[\s/]/);
  assert.ok(form > 0 && form < section.indexOf("</section>"));
  assert.doesNotMatch(footer, /key: "claim"/, "nobody can claim a restaurant page yet");
  for (const locale of LOCALES) {
    assert.equal(catalogs[locale].siteFooter.columns.restaurants.claim, undefined);
    assert.ok(catalogs[locale].siteFooter.columns.restaurants.correct);
  }
  const support = prose(await read("../app/[locale]/support/page.tsx"));
  assert.doesNotMatch(support, /explains how claiming works/);
});

test("no page tells anyone to write to an address at radar.cheap", async () => {
  // radar.cheap publishes no MX record; mail to it bounces. The one mailbox is on the company
  // domain. (The calendar file's UID is shaped like an address and is not one.)
  const files = [
    "../app/(operator)/affiliate/AffiliatePortalClient.tsx",
    "../app/[locale]/support/page.tsx",
    "../app/[locale]/privacy/page.tsx",
    "../app/[locale]/terms/page.tsx",
    "../app/[locale]/launch/page.tsx",
    "../app/[locale]/age-suitability/page.tsx",
    "../app/[locale]/for-creators/page.tsx",
    "../app/SiteFooter.tsx",
  ];
  for (const file of files) {
    assert.doesNotMatch(await read(file), /[a-z0-9._-]+@radar\.cheap/i, `${file} names a mailbox that does not exist`);
  }
  for (const locale of LOCALES) {
    assert.doesNotMatch(JSON.stringify(catalogs[locale]), /@radar\.cheap/, `${locale} catalog names a mailbox that does not exist`);
  }
  assert.match(await read("../app/(operator)/affiliate/AffiliatePortalClient.tsx"), /mailto:support@cedartechsolutions\.ca/);
});

test("French and Spanish do not call the catalog exclusive", () => {
  // The offers come from public restaurant sites and directories. "Pro-exclusive" colors are
  // genuinely only in Pro, and stay.
  for (const locale of ["fr", "es"]) {
    assert.doesNotMatch(JSON.stringify(catalogs[locale].home), /exclusi/i, `${locale} home copy claims exclusivity`);
  }
});

test("English-only documents say so to assistive technology", async () => {
  // Their prose is English under every locale's <html lang>, and a screen reader reads a page in
  // the language the markup declares.
  for (const file of ["privacy", "terms", "support", "age-suitability", "launch"]) {
    const source = code(await read(`../app/[locale]/${file}/page.tsx`));
    assert.match(source, /<article lang="en">/, `${file} does not mark its English prose`);
  }
  // Every page served English-only in all three locales is in that list.
  const { readdir } = await import("node:fs/promises");
  const pages = await readdir(new URL("../app/[locale]/", import.meta.url), { withFileTypes: true });
  for (const entry of pages.filter((item) => item.isDirectory())) {
    let source;
    try { source = await read(`../app/[locale]/${entry.name}/page.tsx`); } catch { continue; }
    if (/englishOnlyAlternates\(/.test(code(source))) assert.match(code(source), /<article lang="en">/, `${entry.name} is English-only without lang="en"`);
  }
});

test("the home hero counts the same cards the list does", async () => {
  const home = code(await read("../app/HomeClient.tsx"));
  assert.match(home, /setCatalogRestaurants\(d\.uniqueOfferCount \|\| 0\)/);
  assert.match(home, /setCatalogCities\(d\.cityCount \|\| 0\)/);
  assert.match(home, /t\("hero\.catalogCount", \{ restaurants: catalogRestaurants, cities: catalogCities \}\)/);
  const route = code(await read("../app/api/deals/route.ts"));
  // Both figures are counted over the whole catalogue the way the local list is grouped, before
  // any filter - once per meta shard (catalogCounts), since a request no longer reads the whole
  // catalogue to count it - and every request takes them from there.
  assert.match(route, /const grouped = Array\.from\(local\.reduce\(/);
  assert.match(route, /function catalogCounts\(rows: readonly MetaRow\[\], chainsSeparate: boolean\): CountSet/);
  assert.match(route, /cards\.add\(!row\.canonical_restaurant_id \? row\.id : row\.is_chain \? row\.canonical_restaurant_id : `\$\{row\.canonical_restaurant_id\}\|\$\{row\.address\}`\);/);
  assert.match(route, /const counts = chainsSeparate \? meta\.counts\.separate : meta\.counts\.all;\s*const totalCanonicalOffers = counts\.cards;\s*const cityCount = hideAlcohol \? counts\.foodCities : counts\.cities;/);
  // The cities the picker lists are counted by the same rule (tests/search-api.test.mjs runs both).
  assert.match(route, /cities: citiesByOffer \? cityTotals\(\) : count\("primary_city"\)/);
  assert.match(route, /uniqueOfferCount:totalCanonicalOffers,\s*cityCount,/);
  assert.doesNotMatch(route, /sourcedOfferCount|sourcedCityCount/);
  // The age page's figures are a dated snapshot, not a second live catalog size.
  const age = prose(await read("../app/[locale]/age-suitability/page.tsx"));
  assert.doesNotMatch(age, /the 38 cities it covers/);
  assert.match(age, /On the date in section 3/);
});

test("the app teaser leads with food", () => {
  // The iOS app is rated 13+ because drink listings are hidden by default; its marketing should not
  // lead with them.
  for (const locale of LOCALES) {
    assert.doesNotMatch(catalogs[locale].home.appTeaser.body, /pour|drink|beer|cocktail|happy hour|boisson|bière|bebida|cerveza/i, `${locale}`);
  }
});
