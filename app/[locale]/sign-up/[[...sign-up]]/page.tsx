"use client";
import { useEffect } from "react";
import { SignUp } from "@clerk/react";
import { useLocale, useTranslations } from "next-intl";
import ClerkClientProvider from "../../../ClerkClientProvider";
import { safeAuthRedirect } from "../../../auth-redirect";
import RadarMark from "../../../RadarMark";
import ChromeLink from "../../../ChromeLink";
import ReferralCodeField from "./ReferralCodeField";
// ChromeLinks, not next-intl's <Link> (app/ChromeLink.tsx): for a reader without a session cookie a
// plain page load, which the Worker answers without a render - whoever reads this page is signed
// out, and the home page is baked - where a client-side link's flight is a render every time. For a
// reader with the cookie, a client-side navigation.

export default function SignUpPage() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const redirectUrl = safeAuthRedirect(
    typeof window === "undefined" ? "" : window.location.search,
    "/dashboard",
    locale,
  );
  useEffect(() => {
    document.title = t("signUpPageTitle");
  }, [t]);

  // Clerk is not loaded for signed-out readers - see app/ClerkClientProvider.tsx - and on this
  // page nobody is signed in yet, so the page mounts it for itself. A reader who IS signed in
  // already has RootShell's provider above this one, which makes this one a pass-through
  // rather than a second Clerk instance.
  return (
    <ClerkClientProvider active locale={locale}>
      <main className="auth-shell">
        <section className="auth-panel" aria-labelledby="auth-heading">
          <header className="auth-header">
            <ChromeLink href="/" className="auth-brand"><RadarMark />Radar.</ChromeLink>
            <span className="auth-kicker">{t("signUpKicker")}</span>
            <h1 id="auth-heading">{t("signUpHeading")}</h1>
            <p>{t("signUpSubtitle")}</p>
          </header>
          <ReferralCodeField />
          <SignUp
            path={`/${locale}/sign-up`}
            routing="path"
            signInUrl={`/${locale}/sign-in`}
            forceRedirectUrl={redirectUrl}
            appearance={{
              elements: {
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                card: "auth-clerk-card",
              },
            }}
          />
          {/* The same notice sign-in carries. Creating an account is the moment the Terms start to
              apply, so it is the one place the notice cannot be missing from. */}
          <p className="auth-legal">
            {t.rich("legal",{terms:(chunks) => <ChromeLink href="/terms">{chunks}</ChromeLink>,privacy:(chunks) => <ChromeLink href="/privacy">{chunks}</ChromeLink>})}
          </p>
        </section>
      </main>
    </ClerkClientProvider>
  );
}
