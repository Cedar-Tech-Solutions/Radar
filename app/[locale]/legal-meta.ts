// A date per legal document, both declared here.
//
// One shared constant was the first fix, for a real problem: the date lived as a hand-edited
// string inside each page and the two drifted apart. Tying them together stopped the drift but
// bought it with a worse lie — editing the privacy policy moved the date on the terms as well,
// announcing a change to a document nobody had touched.
//
// Separate constants in one module keep what mattered about the shared version. Neither date is
// buried in a page, both are visible in the same diff, and a change to one document is a change
// to one line here. What they no longer do is speak for each other.
//
// Stored as ISO dates and written out per language by legalDate, because the French documents
// carry the same date as the English ones and "30 SEPTEMBRE 2026" should not be a second
// hand-edited string that can drift from "SEPTEMBER 30, 2026".
export const PRIVACY_LAST_UPDATED = "2026-11-04";
export const TERMS_LAST_UPDATED = "2026-10-17";

/** "SEPTEMBER 30, 2026" in English, "30 SEPTEMBRE 2026" in French, for the kicker above a document. */
export function legalDate(iso: string, locale: "en" | "fr") {
  return new Intl.DateTimeFormat(locale === "fr" ? "fr-CA" : "en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00Z`))
    .toLocaleUpperCase(locale === "fr" ? "fr-CA" : "en-US");
}
