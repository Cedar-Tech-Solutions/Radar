import { Space_Grotesk, Work_Sans, Geist_Mono } from "next/font/google";
import ClerkClientProvider from "./ClerkClientProvider";
import { HasSessionProvider } from "./has-session";
import ThemeMenu from "./ThemeMenu";
import { ToastProvider } from "./Toast";
import InstallPrompt from "./InstallPrompt";
import RouteAnnouncer from "./RouteAnnouncer";
import { getSiteOrigin } from "./siteMetadata";
import { appStoreListingUrl } from "./app-release";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

// Next.js/vinext requires exactly one `<html>`/`<body>` per root layout, and a locale-aware
// `<html lang>` can only be set by a layout that actually receives the `[locale]` param — which
// the true top-level app/layout.tsx never does (a layout only sees params for its own segment
// and the ones above it). So there is no single shared root layout: `app/[locale]/layout.tsx`
// and `app/(operator)/layout.tsx` are each their own independent root, and this component is
// the one piece of markup/providers they'd otherwise have to duplicate.
//
// It imports no stylesheet. The two roots reach it through PublicShell and OperatorShell, which
// import the same thirteen stylesheets in the same order - the operator one as they are, the
// public one without the rules only operator pages can match (see scripts/public-css.mjs).
function organizationJsonLd(base: URL, sameAs: string[]) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      // The logo is the square app icon. og.png is a 1200x630 share card, and a search engine
      // shows an Organization's logo in a square: the card was cropped to its middle.
      // sameAs names the other places that are unambiguously Radar, which is how a search engine
      // ties them to this site; only ones that exist, so it is left out until one does.
      { "@type": "Organization", name: "Radar", url: base.toString(), logo: new URL("/icon-512.png", base).toString(), ...(sameAs.length ? { sameAs } : {}) },
      // No SearchAction: Google retired the sitelinks search box in November 2024, and no other
      // consumer of it is worth the markup.
      { "@type": "WebSite", name: "Radar", url: base.toString() },
    ],
  };
}

const spaceGrotesk = Space_Grotesk({ variable: "--font-display", subsets: ["latin"], weight: ["500", "600", "700"] });
const workSans = Work_Sans({ variable: "--font-body", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
// Not preloaded. The mono face draws nothing on a public page but the 11px "Ctrl K" hint on the
// command palette's trigger (newfeatures.css) and a few admin and dashboard details, and a preload
// is a high-priority fetch: its 23 KB went out on every page beside the two faces the text is set
// in, ahead of the page's own scripts. Unpreloaded it is still fetched, by the @font-face rule, the
// moment something set in it is drawn, and falls back to the system monospace until then.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], preload: false });

// Radar's own profiles elsewhere, for the Organization's sameAs. The App Store listing joins once the
// app has shipped (app/app-release.ts); a social profile belongs here the day Radar has one.
const PROFILES: readonly string[] = [];

async function organizationProfiles(): Promise<string[]> {
  let appStore: string | null = null;
  // A render with no Worker env (vinext's own prerender) answers "not shipped" rather than failing
  // every page over a link.
  try { appStore = await appStoreListingUrl(); } catch { appStore = null; }
  return [...PROFILES, ...(appStore ? [appStore] : [])];
}

export async function RootShell({ lang, children }: { lang: string; children: React.ReactNode }) {
  const base = await getSiteOrigin();
  // Whether to load Clerk at all. Its client library is ~240KB compressed and 780KB to parse, and
  // the only Clerk component a public page renders is the <UserButton/> in the header, which a
  // signed-out reader never sees. So it is mounted for readers who have a session cookie, and by
  // the sign-in and sign-up pages themselves; everyone arriving from search gets none of it.
  //
  // Cookie presence only - this decides what to download, never what anyone is allowed to do. The
  // token is still verified server-side on every request in app/auth.ts, so a forged cookie buys
  // a bigger download and nothing else. It also lines up with the colo page cache, which never
  // stores a render that saw __session (see worker/index.ts): the cached copy is always the
  // signed-out one, which is always the copy that omits Clerk. A signed-in reader of a page that
  // reads nothing else of them - the home page, the static pages, the city guides - is handed that
  // copy with the data-signed-in mark below added by the Worker (signedInCopy), and the provider
  // and HasSessionProvider read the mark once hydrated.
  //
  // The same fact picks the kind of link the site's pages render (HasSessionProvider below, read by
  // app/ChromeLink.tsx): plain page loads without the cookie, which the Worker answers from its
  // baked and cached copies, and client-side navigations with it, since the Worker renders every
  // page such a reader opens either way and a flight is the cheaper render. RouteAnnouncer, below,
  // tells a screen reader about those navigations, which the browser does not.
  const hasSession = Boolean((await cookies()).get("__session")?.value);
  // Built from the request host so local and preview origins preconnect to something that
  // exists instead of to production. In production there is one host, radar.cheap, and this
  // resolves to clerk.radar.cheap — the same origin worker/index.ts allows in the CSP.
  //
  // Only for readers Clerk will actually load for (the same cookie gate as the provider below):
  // for everyone else the preconnect opened a TLS connection nothing ever used. The Mapbox one is
  // gone for the same reason - geocoding runs on the server (app/geocode.ts) and the deal map is
  // an OpenStreetMap frame, so the browser never talks to api.mapbox.com.
  const clerkHost = `https://clerk.${base.hostname}`;
  // RootShell sits outside NextIntlClientProvider, so the toast stack cannot translate for itself.
  const tToast = await getTranslations({ locale: lang, namespace: "toast" });
  return (
    // data-signed-in: the home page's header gives a signed-in bar its second row from the first
    // paint (site-chrome.css), rather than once /api/session answers and the bar jumps. The same
    // cookie fact as above, so the cached signed-out copy never carries it.
    <html lang={lang} data-signed-in={hasSession ? "" : undefined} suppressHydrationWarning>
      <head>
        {hasSession && <link rel="preconnect" href={clerkHost} />}
        <link rel="dns-prefetch" href="https://challenges.cloudflare.com" />
        <script
          dangerouslySetInnerHTML={{
            // Duplicates the accent hex pairs from theme-accents.ts: this blocking pre-paint
            // script can't import a module, and the alternative (a render-blocking fetch of one)
            // would be strictly worse than keeping six colors in sync by hand.
            // It also puts a theme-color first in <head> for the theme actually chosen: the two
            // in siteViewport follow the OS setting, and the site defaults to dark regardless, so a
            // phone in light mode painted a cream browser bar above a dark page. The first
            // theme-color in the document wins; ThemeMenu keeps this one current afterwards.
            __html: `try{var t=localStorage.getItem('radar-theme')||'dark';var r=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.dataset.theme=r;var m=document.createElement('meta');m.name='theme-color';m.id='radar-theme-color';m.content=r==='dark'?'#070707':'#f7f3e9';document.head.prepend(m);var accents={coral:['#e95f3b','#ff6f4a'],amber:['#b9790f','#f5b942'],teal:['#1f8a70','#3ddba0'],blue:['#2f5fd6','#6fa0ff'],violet:['#7c3aed','#b98bff'],rose:['#be185d','#ff6fa5']};var a=accents[localStorage.getItem('radar-accent')]||accents.coral;document.documentElement.style.setProperty('--coral',r==='dark'?a[1]:a[0])}catch(e){}`,
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd(base, await organizationProfiles())).replace(/</g, "\\u003c") }}
        />
      </head>
      <body className={`${workSans.variable} ${spaceGrotesk.variable} ${geistMono.variable} antialiased`}>
        <ClerkClientProvider active={hasSession} locale={lang}><HasSessionProvider value={hasSession}><ThemeMenu /><ToastProvider dismissLabel={tToast("dismiss")}><InstallPrompt />{children}</ToastProvider></HasSessionProvider></ClerkClientProvider>
        {/* Says which page a client-side navigation opened, and moves focus to it (app/RouteAnnouncer.tsx). */}
        <RouteAnnouncer />
      </body>
    </html>
  );
}
