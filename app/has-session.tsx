"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Whether the reader carries Clerk's session cookie, for the client components that choose by it:
// app/ChromeLink.tsx, which picks the kind of link the site's pages render. RootShell reads the
// cookie and is the one place that sets this.
//
// Its own module, with nothing in it but React, because RootShell is the root of the operator area
// too, and the provider is all that area needs from it.
const HasSession = createContext(false);

/** The mark RootShell puts on <html> for a render that saw the cookie, and the Worker puts on the shared copy of a page for a signed-in reader. */
export function documentIsSignedIn(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-signed-in");
}

/**
 * Set once, by RootShell, from the cookie its render saw. Absent - a page rendered without
 * RootShell around it, such as the not-found page of a path the locale layout rejects - it reads
 * false, and every ChromeLink is a plain link, which works for every reader.
 *
 * A signed-in reader of the home page, a static page or a city guide is handed the page every
 * reader gets - rendered without the cookie, and so with `value` false - with the mark added to
 * <html> by the Worker (signedInCopy in worker/index.ts). The mark is read once hydrated, in an
 * effect, so the first client render matches the server's HTML and the links switch kind after it.
 */
export function HasSessionProvider({ value, children }: { value: boolean; children: ReactNode }) {
  const [marked, setMarked] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the document after hydration
    if (!value && documentIsSignedIn()) setMarked(true);
  }, [value]);
  return <HasSession value={value || marked}>{children}</HasSession>;
}

export function useHasSession(): boolean {
  return useContext(HasSession);
}
