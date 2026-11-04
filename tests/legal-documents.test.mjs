import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { code } from "./source.mjs";

// The privacy policy, the terms and the support page in English and French, and the promises the
// privacy policy makes about code elsewhere.
//
// Quebec's Charter of the French Language (s. 55, Bill 96) entitles Quebec readers to these documents
// in French, and the French has to be the same document: a section missing from it is a term a
// Quebec reader never saw. The ids are compared rather than the words, since the words differ.

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const DOCUMENTS = [
  ["privacy", "PrivacyFr"],
  ["terms", "TermsFr"],
  ["support", "SupportFr"],
];

/** The ids of the h2s in a document, in order. */
const headingIds = (source) => [...code(source).matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
/** The section ids of a SECTIONS constant, in order. */
const sectionIds = (source) => {
  const block = code(source).match(/const SECTIONS = \[([\s\S]*?)\] as const;/)[1];
  return [...block.matchAll(/\["([^"]+)",/g)].map((match) => match[1]);
};

for (const [page, french] of DOCUMENTS) {
  test(`${page}: the French document has every section of the English one, in order`, async () => {
    const en = await read(`../app/[locale]/${page}/page.tsx`);
    const fr = await read(`../app/[locale]/${page}/${french}.tsx`);
    assert.deepEqual(sectionIds(fr), sectionIds(en), "contents list");
    assert.deepEqual(headingIds(fr), headingIds(en), "headings");
    assert.deepEqual(headingIds(en), sectionIds(en), "the English contents list matches its headings");
    // The same number of links: a translation that drops one drops a way out (a mailto, a cancel path).
    const links = (source) => (code(source).match(/<(?:a|ChromeLink)\s[^>]*href=/g) ?? []).length;
    assert.equal(links(fr), links(en), "links");
  });

  test(`${page}: French readers get the French document, labelled as a machine translation`, async () => {
    const en = code(await read(`../app/[locale]/${page}/page.tsx`));
    const fr = code(await read(`../app/[locale]/${page}/${french}.tsx`));
    assert.match(en, new RegExp(`if \\(locale === "fr"\\) \\{\\s*return \\(\\s*<PublicPage className="legal">\\s*<${french} />`));
    assert.match(en, /translatedAlternates\(locale, "\/[a-z]+", \["fr"\]\)/, "fr is an hreflang alternate, es canonicalizes to en");
    assert.match(fr, /<article lang="fr">/);
    assert.match(fr, /<TranslationNotice \/>/);
    assert.doesNotMatch(fr, /version anglaise (?:prévaut|l’emporte)/, "a Quebec consumer may rely on the French version of the contract");
  });
}

test("the sitemap lists the French legal pages as alternates", async () => {
  const sitemap = code(await read("../app/sitemap.ts"));
  for (const [page] of DOCUMENTS) assert.match(sitemap, new RegExp(`translatedEntry\\(base, "/${page}", \\["fr"\\]`));
});

test("the privacy policy names a Privacy Officer by title, with a contact", async () => {
  for (const file of ["page", "PrivacyFr"]) {
    const source = code(await read(`../app/[locale]/privacy/${file}.tsx`));
    assert.match(source, file === "page" ? /Privacy Officer/ : /responsable de la protection des renseignements personnels/);
    assert.match(source, /mailto:support@cedartechsolutions\.ca\?subject=/);
  }
});

test("the retention table agrees with what account deletion actually does", async () => {
  const deletion = code(await read("../app/account-deletion.ts"));
  const personal = deletion.match(/PERSONAL_TABLES = \[([\s\S]*?)\] as const/)[1];
  const anonymised = deletion.match(/ANONYMISED_TABLES = \[([\s\S]*?)\] as const/)[1];
  const privacy = code(await read("../app/[locale]/privacy/page.tsx"));
  const retention = privacy.match(/const RETENTION = \[([\s\S]*?)\] as const;/)[1];
  // Consent and delivery history go with the account; the policy once said consents were kept.
  assert.match(personal, /"email_consents"/);
  assert.match(personal, /"email_deliveries"/);
  assert.match(retention, /Email consent history and delivery history", "[^"]*Deleted with the account\./);
  assert.doesNotMatch(privacy, /Consent and suppression records<\/strong> — retained after account deletion/);
  // The suppression list is keyed by address, not by account, so deletion leaves it: the policy says so.
  assert.doesNotMatch(personal, /"email_suppressions"/);
  assert.match(retention, /Do-not-email \(suppression\) list", "[^"]*kept after the account is deleted/);
  // Detached rather than deleted, as the table says.
  for (const table of ["suggestions", "cancellation_reasons", "save_offers", "creator_commissions"]) assert.match(anonymised, new RegExp(`"${table}"`));
  // Rate-limit rows really are swept a day after their window.
  const worker = code(await read("../worker/index.ts"));
  assert.match(worker, /DELETE FROM rate_limits WHERE window_start < \?"\)\s*\.bind\(new Date\(Date\.now\(\) - 86_400_000\)/);
  assert.match(retention, /Deleted automatically within a day after the limit window closes/);
});

test("creator referral cookies honour Global Privacy Control", async () => {
  const link = code(await read("../app/CreatorLink.tsx"));
  assert.match(link, /globalPrivacyControl === true/);
  // Not set, and cleared, for a browser that sends it.
  assert.match(link, /const optedOut = sendsGlobalPrivacyControl\(\);\s*if \(optedOut\) clearReferralCookies\(secure\);/);
  assert.match(link, /if \(!optedOut\) setReferralCookies\(handle, campaign, secure\);/);
  assert.equal((link.match(/max-age=\$\{THIRTY_DAYS\}/g) ?? []).length, 2, "the cookies are set in one place only");
  // And the sign-up that reads them ignores them on a request carrying Sec-GPC.
  const auth = code(await read("../app/auth.ts"));
  // A code the reader typed themselves is read first (their own choice, not a parked cookie);
  // every link cookie is read only after the GPC check.
  const referring = auth.slice(auth.indexOf("async function referringCreator"), auth.indexOf("async function mappedProfile"));
  assert.match(referring, /if \(\(await headers\(\)\)\.get\("sec-gpc"\) === "1"\) return \{ handle: null, campaign: null, source: null \};/);
  assert.ok(referring.indexOf('"sec-gpc"') < referring.indexOf('"radar_creator"'), "the link cookie must be read after the GPC check");
  assert.ok(referring.indexOf('"sec-gpc"') < referring.indexOf('"radar_creator_campaign"'));
  const privacy = code(await read("../app/[locale]/privacy/page.tsx"));
  assert.match(privacy, /If your browser\s+sends Global Privacy Control, they are not set/);
});
