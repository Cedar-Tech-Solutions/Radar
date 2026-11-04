"use client";

import type { ClerkProviderProps } from "@clerk/react";
import { createContext, lazy, useContext, useEffect, useState, type ComponentType } from "react";
import { localizedPath } from "./locale-path";
import { loadClerkReact } from "./clerk-react";
import { documentIsSignedIn } from "./has-session";

// @clerk/react itself - the React bindings, not Clerk's hosted script - is a 120 KB chunk (31 KB
// gzipped), and as a static import here and in SiteHeader it was preloaded and parsed on every page
// for every reader, though nothing in it runs for a signed-out one. Behind this lazy() it is fetched
// only when the provider actually mounts: for a reader with a session cookie (fetched before
// hydration, see app/clerk-react.ts) and on the sign-in pages, which import it themselves anyway.
//
// A chunk that fails to load renders the page without Clerk, which is what a signed-out reader gets,
// rather than throwing the whole document into the error boundary.
const ClerkProvider = lazy(() =>
  loadClerkReact().then(
    (module) => ({ default: module.ClerkProvider as ComponentType<ClerkProviderProps> }),
    () => ({ default: (({ children }: { children?: React.ReactNode }) => <>{children}</>) as ComponentType<ClerkProviderProps> }),
  ),
);

type LocalizationResource = NonNullable<ClerkProviderProps["localization"]>;

// Clerk's own words - field labels, buttons, errors, "Continue with Google", the account menu -
// are English unless it is handed a translation, which it never was: /fr/sign-in wrapped a French
// heading around an English form. These are Clerk's published translations for the site's two
// other languages.
//
// Loaded on demand rather than imported: each is about 80 KB, this provider sits on every page,
// and Clerk itself only loads for signed-in readers and on the sign-in pages. An English reader
// fetches neither, and nobody fetches one until Clerk is actually being mounted. ClerkProvider
// applies a localization that arrives after it mounted (it watches the prop and updates the
// loaded instance), and Clerk's own script is a larger download from further away, so in practice
// the form is translated before it first draws.
const CLERK_LOCALIZATIONS: Record<string, () => Promise<LocalizationResource>> = {
  fr: () => import("@clerk/localizations/fr-FR").then((module) => module.frFR),
  es: () => import("@clerk/localizations/es-ES").then((module) => module.esES),
};

function currentIsDark() {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

// The site's own button colours (globals.css --coral-strong / --on-coral), so Clerk's Continue
// button is the same button as every other one. The lighter coral it used before put white text at
// 3.4:1 in light mode, and in dark mode the site sets dark text on coral, not white.
const lightVariables = { colorPrimary: "#c23916", colorPrimaryForeground: "#ffffff", borderRadius: "0.9rem" };
const darkVariables = {
  colorPrimary: "#ff6f4a",
  colorPrimaryForeground: "#17261e",
  borderRadius: "0.9rem",
  colorBackground: "#121212",
  colorForeground: "#f5f5f5",
  colorNeutral: "white",
  colorMuted: "#181818",
  colorMutedForeground: "#8f8f8f",
  // Inputs a step lighter than the card and borders that show against both, as the site's own
  // fields are (--field, --line); the same #121212 for both made every input and social button
  // an outline-less hole in the card.
  colorInput: "#1e1e1e",
  colorInputForeground: "#f5f5f5",
  colorBorder: "#3d3d3d",
  colorShadow: "#000000",
};

// Set once by whichever provider actually mounted Clerk, so a second one nested inside it becomes
// a pass-through instead of starting a rival instance. RootShell mounts the outer one for signed-in
// readers; the sign-in and sign-up pages mount their own because they need Clerk while nobody is
// signed in yet. A signed-in reader visiting /sign-in hits both, and without this they would get
// two ClerkProviders in one tree.
const ClerkMounted = createContext(false);

/**
 * Mounts Clerk, but only where Clerk is actually needed.
 *
 * Clerk is 8 files and ~240KB compressed — 780KB to parse — and it was loading on every page for
 * every reader, signed in or not. On a deal page arriving from Google that is the largest single
 * thing the browser does, and for a signed-out reader all of it is wasted: the only Clerk component
 * a public page renders is the <UserButton/> in the header, which signed-out readers never see.
 *
 * So it loads for signed-in readers (RootShell passes `active` when the session cookie is present,
 * and the Worker marks <html data-signed-in> on the shared copy of a page it hands a signed-in
 * reader - see signedInCopy in worker/index.ts - which is read here once hydrated) and on the two
 * pages whose whole job is signing in. Everyone else — every crawler, every visitor from search,
 * every reader browsing deals — gets none of it.
 *
 * Nothing about auth changes: the session cookie is what it always was, the server still verifies
 * it on every request in app/auth.ts, and SiteHeader reads /api/session for its own state rather
 * than asking Clerk. This decides only whether Clerk's client library is downloaded.
 */
export default function ClerkClientProvider({
  children,
  active: activeByRender = true,
  locale,
}: {
  children: React.ReactNode;
  active?: boolean;
  /** The page's language (en, fr, es). RootShell passes its `lang`; the sign-in pages their locale. */
  locale?: string;
}) {
  const alreadyMounted = useContext(ClerkMounted);
  // The Worker's mark, read after hydration so the first client render matches the server's HTML,
  // which was rendered for a signed-out reader. Clerk's chunk is already on its way by then
  // (app/clerk-react.ts reads the same mark at module evaluation).
  const [marked, setMarked] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the document after hydration
    if (!activeByRender && documentIsSignedIn()) setMarked(true);
  }, [activeByRender]);
  const active = activeByRender || marked;
  const [isDark, setIsDark] = useState(true);
  // Kept with the locale it was loaded for, so switching language never shows the old one.
  const [loaded, setLoaded] = useState<{ locale: string; resource: LocalizationResource } | null>(null);
  const loadLocalization = active && !alreadyMounted && locale ? CLERK_LOCALIZATIONS[locale] : undefined;
  useEffect(() => {
    if (!loadLocalization || !locale) return;
    let canceled = false;
    loadLocalization().then(
      (resource) => { if (!canceled) setLoaded({ locale, resource }); },
      // A chunk that failed to load leaves Clerk in English, which is what it was before.
      () => {},
    );
    return () => { canceled = true; };
  }, [loadLocalization, locale]);
  const localization = loaded && loaded.locale === locale ? loaded.resource : undefined;
  useEffect(() => {
    // Reading the DOM theme attribute on mount is a client-only sync with an external
    // system — SSR has no `document`, so a useState lazy initializer would incorrectly
    // bake in `false` from the server render and never re-run once hydrated on the client.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDark(currentIsDark());
    const observer = new MutationObserver(() => setIsDark(currentIsDark()));
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (alreadyMounted || !active || !publishableKey) return <>{children}</>;
  return (
    <ClerkMounted value={true}>
      <ClerkProvider
        publishableKey={publishableKey}
        // In the reader's language, so a redirect Clerk starts itself (an expired session, signing
        // out) lands on /fr/... rather than going through the middleware to whatever it guesses.
        signInUrl={localizedPath("/sign-in", locale)}
        signUpUrl={localizedPath("/sign-up", locale)}
        signInFallbackRedirectUrl={localizedPath("/dashboard", locale)}
        signUpFallbackRedirectUrl={localizedPath("/dashboard", locale)}
        afterSignOutUrl={localizedPath("/", locale)}
        localization={localization}
        appearance={{
          variables: isDark ? darkVariables : lightVariables,
        }}
      >
        {children}
      </ClerkProvider>
    </ClerkMounted>
  );
}
