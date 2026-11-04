import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { translatedAlternates } from "../../alternates";
import { pageMetadata } from "../../siteMetadata";
import ChromeLink from "../../ChromeLink";
import PublicPage from "../../PublicPage";
import LegalToc from "../LegalToc";
import { PRIVACY_LAST_UPDATED, legalDate } from "../legal-meta";
import PrivacyFr, { PRIVACY_FR_META } from "./PrivacyFr";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const alternates = translatedAlternates(locale, "/privacy", ["fr"]);
  if (locale === "fr") return pageMetadata({ alternates, ...PRIVACY_FR_META, imageAlt: "Radar — offres de restaurants et 5 à 7 à proximité" });
  return pageMetadata({
    alternates,
    title: "Privacy Policy — Radar",
    description:
      "What information Radar collects, how it is used, who processes it, how long it is kept, and the choices available to you.",
  });
}

// English, and a French translation in PrivacyFr.tsx. Quebec's Charter of the French Language
// (s. 55, as amended by Bill 96) entitles Quebec readers to these documents in French; the French
// is a machine translation for now, approved by the operator until a professional one replaces
// it, and says so at the top. Spanish readers get the English article inside Spanish chrome, and
// the page's canonical says it is the English document (translatedAlternates).
//
// The two articles have to say the same thing. A change to this one is a change to PrivacyFr.tsx
// in the same commit, with the same section ids, so a deep link (/fr/privacy#payments) still lands.
const SECTIONS = [
  ["scope", "1. Scope of this policy"],
  ["collect", "2. Information we collect"],
  ["use", "3. How we use information"],
  ["location", "4. Location information"],
  ["storage", "5. Cookies and browser storage"],
  ["payments", "6. Payments"],
  ["email", "7. Email notifications"],
  ["providers", "8. Service providers"],
  ["sharing", "9. When we share information"],
  ["transfers", "10. Where information is processed"],
  ["retention", "11. How long we keep information"],
  ["security", "12. Security and accountability"],
  ["rights", "13. Your rights and choices"],
  ["us-states", "14. Additional information for US residents"],
  ["children", "15. Children"],
  ["changes", "16. Changes to this policy"],
  ["contact", "17. Contact and Privacy Officer"],
] as const;

// Every row here is a provider that handles a reader's information because of Radar: one the
// server calls, or one a Radar page or app screen makes the reader's own browser or device load.
// The second kind is the one that went missing. The Google favicon behind every card's logo and
// the OpenStreetMap frame on every deal page are fetched by the visitor, not by us, so nothing on
// the server side ever named them — but the visitor's IP address reaches them all the same, and
// the map frame is sent the deal page's full address (DealMap.tsx sets no-referrer-when-downgrade).
// Keeping the list in one table rather than scattered through prose is what makes it auditable —
// if a provider is added or dropped, there is exactly one place this page has to change.
//
// Mapbox is geocoding only (app/geocode.ts). It used to be credited with "rendering maps", which
// it never did on this site: the deal-page map is the OpenStreetMap embed.
const PROVIDERS = [
  ["Clerk", "Account creation, sign-in, and session management", "Email address, name, account identifier, authentication events"],
  ["Cloudflare", "Application hosting, database, image storage, and bot protection (Turnstile)", "All stored service data; IP address and request metadata in transit"],
  ["Stripe", "Radar Pro subscription checkout and billing management", "Email address, payment method details you enter with Stripe, subscription status"],
  ["Mapbox", "Resolving a postal or ZIP code, or a restaurant's address, to an approximate location", "The postal or ZIP code searched; approximate coordinates"],
  ["OpenStreetMap (Nominatim)", "Fallback postal and ZIP code lookup when Mapbox is unavailable", "The postal or ZIP code searched"],
  ["OpenStreetMap (map embed)", "The map on a deal page, which your browser loads from openstreetmap.org", "Your IP address and browser details, and the address of the deal page you are viewing"],
  ["Google", "Restaurant website icons shown on listings, which your browser loads from Google's favicon service when Radar has no stored logo; the map in the Android app (Google Maps)", "Your IP address and browser details, the restaurant's web address, and that the request came from radar.cheap; for the map, the area your device shows"],
  ["Apple", "In-app purchases and subscription status for the iOS app, and the map in the iOS app (Apple Maps)", "Transaction and subscription identifiers issued by Apple; subscription status; for the map, the area your device shows"],
  ["Expo", "Delivering push notifications to the Radar app", "The push token for your installation and the contents of the notification"],
  ["Resend", "Delivering pilot alert and confirmation email", "Email address; delivery, bounce, complaint, and unsubscribe events"],
  ["DeepL", "Machine translation of deal descriptions into French and Spanish", "Deal listing text only — no personal information"],
] as const;

// How long each kind of record is kept, one row per category, so Quebec's Law 25 and PIPEDA's
// "retain only as long as necessary" are answered with a period rather than a shrug. Every row is
// a promise the code keeps: app/account-deletion.ts deletes or detaches the account's rows,
// email_suppressions is keyed by address and deliberately survives it, and the hourly cron in
// worker/index.ts sweeps rate-limit rows a day after their window closes. A row that changes here
// changes in PrivacyFr.tsx and, if it is a deletion rule, in account-deletion.ts.
const RETENTION = [
  ["Account and profile", "While your account is open. Deleted when you delete the account."],
  ["Favorites, tracked areas, hidden restaurants, alert settings", "Until you remove them, or delete the account."],
  ["App push tokens", "Until you turn notifications off, sign out or delete the account. A token the platform reports as invalid is deleted 30 days later."],
  ["Email consent history and delivery history", "While your account is open, so you can see what was sent and we can show you agreed to it. Deleted with the account."],
  ["Do-not-email (suppression) list", "Your email address and the reason (unsubscribed, bounced or complained) are kept after the account is deleted, for as long as we send email, so the address is never mailed again."],
  ["Waitlist and update sign-ups", "Until you unsubscribe or ask us to remove the address. An address that unsubscribes moves to the do-not-email list. An address that never confirms is deleted 30 days after the confirmation email."],
  ["Delivery reports from our email provider (sent, opened, bounced)", "Deleted automatically after 400 days, or with the account."],
  ["Reports, feedback, product events and creator applications linked to your account", "Deleted with the account."],
  ["Deal suggestions", "The suggestion stays as part of the listing's history. When the account is deleted, its link to you and the contact email are erased."],
  ["Cancellation reasons and save-offer answers", "Kept as anonymous statistics. Their link to you is erased when the account is deleted."],
  ["Creator referral on your account", "Deleted with the account. A commission already earned keeps its amount and date with no link to you."],
  ["Billing records", "Subscription identifiers are deleted with the account. Invoices and payment records are kept by Stripe and by us for six years after the end of the tax year they belong to, as Canadian tax law requires."],
  ["Rate-limit records (a one-way hash of your network address)", "Deleted automatically within a day after the limit window closes."],
  ["Request logs at our hosting provider", "Kept by Cloudflare for at most seven days."],
  ["Staff audit records", "Kept to show who changed a listing, an account or a permission, and when. They identify the staff member and the record, not you by contact details."],
] as const;

// The categories California law (Cal. Civ. Code s. 1798.110 and .130) and the other US state laws
// ask a business to name, mapped onto what Radar actually holds. Objects, not the three-string rows
// PROVIDERS uses, so tests/site-claims.test.mjs's provider scan cannot mistake one for a provider.
const US_CATEGORIES = [
  { category: "Identifiers", examples: "Email address, display name, account identifier, push token, IP address (in transit)" },
  { category: "Commercial information", examples: "Radar Pro plan, subscription status and billing identifiers" },
  { category: "Internet or other electronic network activity", examples: "Favorites, hidden restaurants, alert delivery history, reports and feedback you send" },
  { category: "Geolocation data", examples: "Postal or ZIP codes you search or track. Precise device location is used for one search and not stored" },
  { category: "Sensitive personal information", examples: "None kept. Precise location is used only for the search you asked for" },
] as const;

export default async function Privacy({ params }: { params: Promise<{ locale: string }> }) {
  // The page's links to its sibling pages are ChromeLinks (app/ChromeLink.tsx): for a reader
  // without a session cookie, a page load the Worker answers without rendering; for one with it, a
  // client-side navigation, since that reader's pages are rendered either way and a flight is the
  // cheaper render. Never a prefetching <Link>: each of those was prefetched as it scrolled into
  // view, a render of the page it named.
  const { locale } = await params;
  setRequestLocale(locale);
  if (locale === "fr") {
    return (
      <PublicPage className="legal">
        <PrivacyFr />
      </PublicPage>
    );
  }
  return (
    <PublicPage className="legal">
      {/* lang="en" because the prose is English under the Spanish <html lang> too: without it a
          screen reader on /es/privacy reads English words with Spanish pronunciation. */}
      <article lang="en">
        <span className="kicker">LAST UPDATED {legalDate(PRIVACY_LAST_UPDATED, "en")}</span>
        <h1>Privacy Policy</h1>
        <p className="lead">
          Radar helps people find nearby restaurant offers. This policy explains what information we
          handle, why, who processes it on our behalf, how long we keep it, and the choices you
          have. We do not sell personal information, we do not share it for cross-context
          behavioral advertising, and we do not use it for third-party advertising of any kind.
        </p>

        <LegalToc sections={SECTIONS} />

        <h2 id="scope">1. Scope of this policy</h2>
        <p>
          This policy covers the Radar website at radar.cheap, including the user dashboard and the
          restaurant portal, and the Radar apps for iOS and Android. The two
          handle the same information in the same way, with two exceptions the sections below
          describe: the app can ask the operating system for your location, and it can register for
          push notifications. Cedar Tech Solutions is responsible for the personal information
          described here (its &ldquo;controller&rdquo;) and can be reached at{" "}
          <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a>. Your use of Radar is also
          governed by our <ChromeLink href="/terms">Terms of Service</ChromeLink>.
        </p>
        <p>
          <strong>Privacy Officer.</strong> The person in charge of the protection of personal
          information at Cedar Tech Solutions is our Privacy Officer. They can be reached at{" "}
          <a href="mailto:support@cedartechsolutions.ca?subject=Attention%3A%20Privacy%20Officer">
            support@cedartechsolutions.ca
          </a>
          , with &ldquo;Attention: Privacy Officer&rdquo; in the subject line. See{" "}
          <a href="#contact">Contact and Privacy Officer</a>.
        </p>
        <p>
          This policy does not cover restaurant websites or other external sites we link to. Those
          have their own privacy practices.
        </p>

        <h2 id="collect">2. Information we collect</h2>
        <p>
          <strong>Account information.</strong> When you sign in, our identity provider supplies your
          account identifier, email address, and optional display name. Your dashboard profile may
          also hold a display name, preferred language, country, distance units, time zone, and your
          chosen theme and accent color.
        </p>
        <p>
          <strong>Things you save and track.</strong> The deals you favorite, the restaurants you
          have hidden from your results, the postal or ZIP areas you track with their labels and
          radii, your home postal or ZIP code, and your alert schedule.
        </p>
        <p>
          <strong>Submissions.</strong> Deal suggestions may include the restaurant, offer, location,
          schedule, and a contact email you supply. Incorrect-deal reports and product feedback may
          include the category, your message, the market and page you were on, the associated deal,
          and your signed-in contact information. Restaurant inquiries include the business and
          contact details you enter.
        </p>
        <p>
          <strong>Waitlist and update sign-ups.</strong> If you leave your email address in a
          &ldquo;keep me posted&rdquo; or app-launch box without an account, we store the address,
          the postal code if you gave one, where you signed up, and when you confirmed it. Nothing is
          sent to it except one confirmation message until you follow the link in that message.
        </p>
        <p>
          <strong>Subscription information.</strong> If you subscribe to Radar Pro we store your plan
          and subscription status and the customer and subscription identifiers issued by our payment
          processor. A subscription bought inside the iOS app goes through Apple instead: we store the
          transaction identifier Apple issues, the product, the status and the renewal date, and we
          never receive your payment details. See <a href="#payments">Payments</a>.
        </p>
        <p>
          <strong>Communication records.</strong> Your email consent status and its timestamps, the
          policy version you consented to, and a delivery history of messages we sent you including
          status and any error or bounce code.
        </p>
        <p>
          <strong>Device registration.</strong> If you turn on notifications in the Radar app, we store
          the push token the platform issues for that installation and whether it is an iOS or Android
          device, so alerts can be delivered to it. The token identifies an installation rather than a
          person, and it is removed when you turn notifications off, sign out, or the platform reports
          it as no longer valid.
        </p>
        <p>
          <strong>Technical and usage information.</strong> Standard request data such as IP address
          and user agent is processed by our infrastructure provider to serve and secure the site,
          including rate limiting and bot checks. We also record coarse campaign-visit events — a
          referral source, campaign and medium from a link&rsquo;s query string, the page path, and
          the market. These visit events are not linked to your account.
        </p>
        <p>
          <strong>Page-view counts.</strong> When a public page opens, your browser tells Radar that a
          page of a certain kind (the home page, a deal, a city guide, or another page) was viewed,
          and which kind of site you came from, such as a search engine or a social network. Radar adds
          one to a daily counter for that combination, together with the country your request came from
          as reported by our infrastructure provider. Nothing else is kept: no cookie is set, and no
          account, IP address, device identifier or page address is stored with the count, so it cannot
          be traced to you. If your browser sends Do Not Track or Global Privacy Control, the page is
          not counted at all.
        </p>
        <p>
          <strong>Creator referrals.</strong> Some creators share links to Radar that carry their
          handle (a <code>?c=</code> in the address). When you arrive through one, your browser keeps
          that handle, and the campaign label if the link has one, in two cookies for 30 days (see{" "}
          <a href="#storage">Cookies and browser storage</a>). If you create a Radar account while
          they are there, we store the handle and label on your account as the creator who referred
          you, and if you later pay for Radar Pro on the website, we copy them onto the commission
          record for that payment so the creator can be paid their share. The referral is written
          once, when the account is created, and an existing account is never re-attributed. The
          creator sees how many people signed up and subscribed through their links and what they
          earned, never your name or email address. If your browser sends Global Privacy Control, no
          referral is recorded from a link.
        </p>
        <p>
          <strong>Referral codes.</strong> You can also type a creator&rsquo;s referral code yourself,
          on the sign-up page or in your dashboard within 7 days of creating your account. Because you
          chose to enter it, it is recorded even if your browser sends Global Privacy Control, and it
          is used exactly like a link referral. An account has one referral, and once it is set you
          cannot change or remove it. Our staff can correct one made by mistake if you ask; each
          correction needs an owner&rsquo;s approval and is kept in our audit log.
        </p>

        <h2 id="use">3. How we use information</h2>
        <ul>
          <li>To run search and show results near the area you asked about.</li>
          <li>To keep your favorites, tracked areas, hidden restaurants, and display preferences.</li>
          <li>To create and administer your account and keep you signed in.</li>
          <li>To process Radar Pro subscriptions and apply the right plan limits to your account.</li>
          <li>To send the alerts and confirmations you asked for, and to record their delivery.</li>
          <li>To review, moderate, and publish community submissions, with an audit history.</li>
          <li>To protect the service — rate limiting, bot checks, abuse prevention, and security investigation.</li>
          <li>To understand which markets and campaigns bring people to Radar, in aggregate.</li>
          <li>To credit the creator whose link brought you to Radar, and to pay their commission.</li>
          <li>To meet legal obligations and to establish, exercise, or defend legal claims.</li>
        </ul>
        <p>
          We use personal information only for these purposes, or for a purpose consistent with them,
          unless you consent to another or the law requires it. Where the law requires a legal basis,
          we rely on performing our contract with you (running your account and subscription), your
          consent (marketing email and precise device location), our legitimate interests (securing
          and improving the service), and legal obligation (tax and accounting records). Radar does
          not make decisions about you based solely on automated processing: the order of search
          results depends on the deals and your search, not on a profile of you.
        </p>

        <h2 id="location">4. Location information</h2>
        <p>
          <strong>Off by default.</strong> Radar never locates you on its own. Searching works from the
          postal or ZIP code, or city, that you type, and location features stay off until you turn
          them on yourself by choosing &ldquo;Use my location&rdquo; and granting your browser&rsquo;s
          or device&rsquo;s permission.
        </p>
        <p>
          <strong>On the website.</strong> When you choose &ldquo;Use my location&rdquo;, your browser
          asks your permission and supplies a position for that search only. We do not continuously
          monitor your device and we do not store the precise coordinates your browser returned. You
          can withdraw the permission at any time in your browser&rsquo;s site settings.
        </p>
        <p>
          <strong>In the app.</strong> The Radar app asks the operating system for permission the
          first time you use a location search. The position is sent with that search, used to choose
          and order nearby results, and not written down. Location is only ever requested while the
          app is open, and Radar does not collect location in the background. You can turn it off at
          any time in your device&rsquo;s settings. Refusing is not a dead end: typing a postal or ZIP
          code reaches the same results.
        </p>
        <p>
          <strong>From your network.</strong> Like any website, Radar&rsquo;s hosting provider sees the
          IP address your request comes from and reports the country, province or state, and time zone
          it belongs to. Radar uses that approximate reading only while answering the request: to
          show prices in the right currency, to tell which side of a border a search near one is on,
          and to read the clock when your device did not send one. It is not stored with your account.
        </p>
        <p>
          <strong>What is kept.</strong> The postal or ZIP codes you save as tracked areas, and your
          home postal or ZIP code, are stored with your account and can be removed at any time from
          your dashboard.
        </p>

        <h2 id="storage">5. Cookies and browser storage</h2>
        <p>
          Radar does not use advertising cookies. What we do use:
        </p>
        <ul>
          <li>
            <strong>Authentication cookies</strong> set by our identity provider to keep you signed
            in. These are necessary for the account features to work.
          </li>
          <li>
            <strong>A language preference cookie</strong> so the site opens in the language you last
            chose.
          </li>
          <li>
            <strong>Creator referral cookies</strong>, <code>radar_creator</code> and{" "}
            <code>radar_creator_campaign</code>, set only when you arrive through a creator&rsquo;s
            link. They hold the creator&rsquo;s handle and the link&rsquo;s campaign label for 30
            days, so the creator can be credited if you create an account in that time; at sign-up
            they are written onto your account as described under{" "}
            <a href="#collect">Information we collect</a>. While they are set, the home page shows
            that creator&rsquo;s picks, and the deals you open are counted in the creator&rsquo;s
            totals without being linked to you. A later creator link replaces them. If your browser
            sends Global Privacy Control, they are not set, any already set are removed, and an
            account created from that browser is not attributed to a creator through a link.
          </li>
          <li>
            <strong>Referral code cookie</strong>, <code>radar_referral_code</code>, set only when you
            enter a referral code on the sign-up page. It holds the creator&rsquo;s handle for up to 7
            days so it can be written onto your account when the account is created, and is removed if
            you clear the code. It cannot be read by scripts on the page.
          </li>
          <li>
            <strong>Local storage on your device</strong> for your theme and accent color, so the
            page paints in the right colors before it finishes loading, and for a few conveniences:
            the deals you viewed recently, whether you have chosen to show chain restaurants, which
            country you last browsed, how many visits before the site offers to be installed, and
            which notices you have dismissed. Session storage keeps the way back to your search
            results while you look at a deal, and whether the page was opened from the iOS app.
            This stays in your browser and is not stored by us.
          </li>
          <li>
            <strong>Bot-protection tokens</strong> issued by Cloudflare Turnstile when you submit a
            form, used to distinguish people from automated abuse.
          </li>
        </ul>
        <p>
          You can clear this data through your browser&rsquo;s settings; clearing authentication
          cookies signs you out.
        </p>

        <h2 id="payments">6. Payments</h2>
        <p>
          Radar Pro payments are processed by Stripe. Card numbers and other payment credentials are
          entered on Stripe&rsquo;s own checkout and billing pages and are handled by Stripe — we
          never receive or store them. What Radar stores is your plan, your subscription status, and
          the Stripe customer and subscription identifiers needed to keep the two in sync and to open
          your billing portal. Stripe processes this information as an independent controller under
          its own privacy policy, and may use it for payment processing, fraud prevention, and its
          own legal obligations.
        </p>

        <h2 id="email">7. Email notifications</h2>
        <p>
          Deal alerts are optional and creating an account never means marketing consent. Delivery is
          limited to a controlled pilot and requires a confirmed consent record, an enabled
          preference, no active suppression, and pilot eligibility. We record when you gave and
          withdrew consent, and the policy version in force at the time, because that record is what
          demonstrates the consent was valid.
        </p>
        <p>
          Our email provider processes delivery, bounce, complaint, and unsubscribe events so that we
          can stop sending to addresses that bounce or complain. Every marketing message includes a
          one-click way to stop future messages, and you can disable alerts in your dashboard at any
          time. Transactional messages about your account are sent regardless of marketing
          preferences.
        </p>

        <h2 id="providers">8. Service providers</h2>
        <p>
          We share information with the following providers only to the extent they need it to
          perform their function for us, and each of those is bound to handle it for that purpose.
          A few of the services below work differently: Google&rsquo;s favicon service, the
          OpenStreetMap map embed, and the maps in the apps are loaded by your own browser or device
          when a page shows their content, so they receive your IP address and browser details the
          way any site you visit does, and handle them under their own privacy policies.
        </p>
        <div className="legal-table-wrap">
          <table className="legal-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">What it does for Radar</th>
                <th scope="col">Information involved</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map(([provider, purpose, data]) => (
                <tr key={provider}>
                  <th scope="row">{provider}</th>
                  <td>{purpose}</td>
                  <td>{data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Restaurant photographs shown on listings may be fetched from the restaurant&rsquo;s own
          website. Loading a listing does not send your account information to those sites.
        </p>

        <h2 id="sharing">9. When we share information</h2>
        <p>
          Beyond the providers above, we disclose personal information only when required by law or
          valid legal process, when necessary to investigate or prevent fraud, abuse, or a security
          incident, to establish or defend legal claims, or as part of a merger, acquisition, or sale
          of assets — in which case we will give notice before your information becomes subject to a
          different privacy policy.
        </p>
        <p>
          Restaurant listing data and source links are public information. Your favorites, tracked
          areas, alert settings, and subscription status are not shown publicly. Deal suggestions and
          reports you submit may be published as listing content, but we do not publish your email
          address alongside them.
        </p>

        <h2 id="transfers">10. Where information is processed</h2>
        <p>
          Radar is operated from Ontario, Canada. Our providers process information outside Canada,
          and outside Quebec for Quebec residents: Clerk, Stripe, Mapbox, Resend, Expo, Apple and
          Google in the United States; Cloudflare on its global network, which serves each
          request from a data center near you; DeepL in Germany; and OpenStreetMap in the European Union and the
          United Kingdom. Information processed in another country is subject to that country&rsquo;s
          laws, and may be accessible to its courts and authorities.
        </p>
        <p>
          <strong>Before information leaves Quebec.</strong> As Quebec&rsquo;s Act respecting the
          protection of personal information in the private sector (Law 25) requires, before we
          communicate personal information about a Quebec resident outside Quebec we assess whether it
          will receive adequate protection, considering how sensitive it is, why it is being sent, the
          safeguards the provider applies (including encryption in transit and at rest, and access
          controls), and the legal framework of the place it goes. Each transfer is governed by a
          written agreement that limits the provider to the service it performs for us. We send each
          provider only what it needs: for most, that is an email address or an identifier, and we
          never send any of them your precise location.
        </p>

        <h2 id="retention">11. How long we keep information</h2>
        <p>
          We keep personal information only as long as it is needed for the purpose it was collected
          for, or as long as the law requires. When that ends, it is deleted, or anonymized so that it
          can no longer identify you.
        </p>
        <div className="legal-table-wrap">
          <table className="legal-table">
            <thead>
              <tr>
                <th scope="col">Information</th>
                <th scope="col">How long we keep it</th>
              </tr>
            </thead>
            <tbody>
              {RETENTION.map(([category, period]) => (
                <tr key={category}>
                  <th scope="row">{category}</th>
                  <td>{period}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 id="security">12. Security and accountability</h2>
        <p>
          We use access controls, role-based administration with audit logging, transport encryption,
          request-origin verification, rate limiting, and bot checks on public forms. Staff can reach
          only the information their role needs. Payment credentials never reach our systems. No
          internet service can guarantee absolute security, and you are responsible for keeping your
          own sign-in credentials safe.
        </p>
        <p>
          <strong>How we govern personal information.</strong> Our Privacy Officer is responsible
          for how Radar protects personal information, approves new uses of it and new service
          providers, and answers requests and complaints. Before we adopt a new system or provider
          that handles personal information, or send it outside Quebec, we assess the privacy risks
          and the protection it will receive, and collect only what the feature needs. Information is
          deleted or anonymized when the periods in{" "}
          <a href="#retention">How long we keep information</a> end, and some of those deletions run
          automatically. We keep a register of confidentiality incidents.
          If an incident creates a risk of serious harm, we notify the people affected and the
          relevant regulators (in Canada, the Office of the Privacy Commissioner and, for Quebec
          residents, the Commission d&rsquo;accès à l&rsquo;information) as the law requires.
        </p>

        <h2 id="rights">13. Your rights and choices</h2>
        <p>
          <strong>In the product.</strong> You can update your profile and alert preferences, add or
          remove tracked areas, remove favorites, change or cancel your subscription, download a
          copy of your account data, delete your account, and sign out — all from your dashboard.
        </p>
        <p>
          <strong>On request.</strong> Depending on where you live, you may have the right to access
          the personal information we hold about you, correct it, delete it, receive it in a
          structured, commonly used technological format, object to or restrict certain processing,
          and withdraw consent at any time without affecting processing already carried out.
          Residents of Quebec can also ask us to stop disseminating their personal information, or to
          de-index any hyperlink attached to their name, where its dissemination contravenes the law
          or a court order or causes them serious harm. We do not degrade the service for people who
          exercise any of these rights. Quebec residents may also ask how a piece of their
          information was collected.
        </p>
        <p>
          To make a request, write to our Privacy Officer at{" "}
          <a href="mailto:support@cedartechsolutions.ca?subject=Privacy%20request">support@cedartechsolutions.ca</a>{" "}
          from the address on your account, with &ldquo;privacy request&rdquo; in the subject line. We
          answer within 30 days (45 days for the US state rights in{" "}
          <a href="#us-states">section 14</a>), and may need to verify your identity first, usually by
          replying from the address on your account. Some records outlive an account in the reduced
          form set out in <a href="#retention">How long we keep information</a>.
        </p>
        <p>
          If you are not satisfied with our response you may complain to your privacy regulator: in
          Canada, the Office of the Privacy Commissioner of Canada; in Quebec, the Commission
          d&rsquo;accès à l&rsquo;information; in the United States, your state attorney general (or in
          California, the California Privacy Protection Agency); in the European Economic Area or the
          United Kingdom, your national supervisory authority.
        </p>

        <h2 id="us-states">14. Additional information for US residents</h2>
        <p>
          This section applies to residents of California and the other US states with comprehensive
          privacy laws. It adds to the rest of this policy.
        </p>
        <p>
          <strong>What we collect and why.</strong> In the past 12 months Radar has collected the
          categories below, from you, your device, and the identity and payment providers you use to
          sign in and pay, for the purposes in <a href="#use">How we use information</a>. We
          disclose each of them for a business purpose only to the service providers in{" "}
          <a href="#providers">Service providers</a>, and keep each for the periods in{" "}
          <a href="#retention">How long we keep information</a>.
        </p>
        <div className="legal-table-wrap">
          <table className="legal-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">What it means at Radar</th>
              </tr>
            </thead>
            <tbody>
              {US_CATEGORIES.map(({ category, examples }) => (
                <tr key={category}>
                  <th scope="row">{category}</th>
                  <td>{examples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>No sale, no sharing, no targeted advertising.</strong> Radar does not sell personal
          information, does not share it for cross-context behavioral advertising, does not process it
          for targeted advertising, and does not use it for profiling that produces legal or similarly
          significant effects. It has not done any of these in the past 12 months, and does not
          knowingly sell or share the information of anyone under 16.
        </p>
        <p>
          <strong>Do Not Track.</strong> Radar does not track you across other sites, and does not
          let others track you on Radar. If your browser sends Do Not Track, Radar does not count
          your page views.
        </p>
        <p>
          <strong>Global Privacy Control.</strong> We treat a Global Privacy Control signal from your
          browser as a request to opt out: a browser that sends it is not counted in page views and
          does not receive creator referral cookies, so no referral is attached to an account made
          from it. You do not need an account for this to work.
        </p>
        <p>
          <strong>Your rights.</strong> Depending on your state, you may ask to know and access the
          personal information we hold about you (including the categories and specific pieces),
          correct it, delete it, and receive a portable copy, and to opt out of sale, sharing,
          targeted advertising and profiling (which Radar does not do). We will not discriminate
          against you for using these rights. Make a request as described in{" "}
          <a href="#rights">Your rights and choices</a>.
        </p>
        <p>
          <strong>Authorized agents.</strong> Someone you authorize may make a request for you. We
          will ask for your signed permission and may ask you to confirm your identity with us
          directly, unless the agent holds a valid power of attorney.
        </p>
        <p>
          <strong>Appeals.</strong> If we decline your request, you can appeal by replying to our
          decision with &ldquo;appeal&rdquo; in the subject line. We will answer the appeal in writing
          within 60 days, explaining what we decided and why. If you disagree with the result, you can
          contact your state attorney general.
        </p>

        <h2 id="children">15. Children</h2>
        <p>
          Radar is not directed to children. You must be at least 14 to create an account, and we do
          not knowingly collect personal information from anyone younger. If we learn that an account
          belongs to someone under 14, we delete it. If you believe a child has provided us
          information, write to{" "}
          <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a> and we will delete it.
        </p>

        <h2 id="changes">16. Changes to this policy</h2>
        <p>
          We may update this policy as the service evolves or the law requires. The &ldquo;last
          updated&rdquo; date at the top identifies the current version. For material changes we will
          take reasonable steps to give notice before they take effect, and where the change requires
          your consent we will ask for it.
        </p>

        <h2 id="contact">17. Contact and Privacy Officer</h2>
        <p>
          Privacy questions, data requests, complaints, and everything else go to{" "}
          <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a>. For the
          Privacy Officer, put &ldquo;Attention: Privacy Officer&rdquo; in the subject line. A person
          reads every message.
        </p>
      </article>
    </PublicPage>
  );
}
