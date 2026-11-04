import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { adminSource, code } from "./source.mjs";
// Before the route below: it supplies the Worker-only modules the handbook route imports.
import { harness } from "./route-harness.mjs";

// The staff handbook, checked against the code it describes.
//
// A handbook is worse than no handbook once it is wrong: somebody follows it, gets a different
// result, and stops trusting the rest of it. Most of what it says cannot be checked mechanically
// — whether an explanation is clear is not a test — but the specific, falsifiable claims can be,
// and those are exactly the ones that rot. The rates the affiliate program pays, the four
// conditions for publishing a deal, the length of the holding period: each is asserted here
// against its real definition, so changing one and not the other fails the build rather than
// misleading a member of staff six months from now.

const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const read = async (path) => code(await readFile(new URL(path, import.meta.url), "utf8"));

const { HANDBOOK, HANDBOOK_KIND_LABELS, allArticles, handbookFor, searchTextFor, readableHandbook, canReadArticle } = await load("../app/(operator)/admin/handbook.ts");
const { ALL_PERMISSIONS, ACTION_PERMISSIONS, ALL_ROLES, WORKSPACE_ROLES, OWNER_APPROVAL_ACTIONS } = await load("../app/permissions.ts");
const { SUGGESTION_REJECTION_REASONS, MIN_CUSTOM_REASON_LENGTH } = await load("../app/suggestion-review.ts");
const { GET: handbookGet } = await import("../app/api/admin/handbook/route.ts");
const program = await load("../app/affiliate-program.ts");
const adminRoute = await read("../app/api/admin/route.ts");
const lifecycle = await read("../app/deal-lifecycle.ts");
const sections = await read("../app/(operator)/admin/sections.ts");
const adminClient = await read("../app/(operator)/admin/AdminClient.tsx");
const exportRoute = await read("../app/api/admin/export/route.ts");
const drinkRules = await read("../app/drink-rules.ts");
const handbookTab = code(adminSource("tabs/HandbookTab.tsx"));

const articles = allArticles().map(({ article }) => article);

test("every article is filed against a permission that exists", () => {
  for (const article of articles) {
    if (article.permission === null) continue;
    assert.ok(
      ALL_PERMISSIONS.includes(article.permission),
      `${article.id} is filed under "${article.permission}", which is not a permission`,
    );
  }
});

test("every permission has somewhere a holder of it can read about the job", () => {
  // The point of this one: adding a permission without adding a handbook entry means shipping a
  // capability nobody was told how to use. read_admin is the exception — it is the key to the
  // door rather than a job, and the whole "Start here" section is what it opens.
  const covered = new Set(articles.map((article) => article.permission).filter(Boolean));
  for (const permission of ALL_PERMISSIONS) {
    if (permission === "read_admin") continue;
    assert.ok(covered.has(permission), `no handbook article covers "${permission}"`);
  }
});

test("ids are unique and stable enough to link to", () => {
  const ids = articles.map((article) => article.id);
  assert.equal(new Set(ids).size, ids.length, "two articles share an id");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is not a usable anchor`);
  for (const section of HANDBOOK) assert.match(section.id, /^[a-z][a-z0-9-]*$/);
});

test("every article says what kind of thing it is, and means it", () => {
  for (const article of articles) {
    assert.ok(HANDBOOK_KIND_LABELS[article.kind], `${article.id} has an unknown kind`);
    // A how-to or a runbook without steps is a description pretending to be a procedure.
    if (article.kind === "howto" || article.kind === "runbook") {
      assert.ok(
        (article.steps || []).length > 0 || (article.body || []).length > 0,
        `${article.id} is a ${article.kind} with nothing in it`,
      );
    }
    assert.ok(article.summary.length > 20, `${article.id} needs a real one-line summary`);
  }
});

test("the publishing checklist matches what the server actually refuses", () => {
  // The four conditions are enforced in app/api/admin/route.ts's lifecycle branch. If one is
  // added or removed there, the article telling staff what to prepare has to follow.
  const branch = adminRoute.slice(adminRoute.indexOf('b.action === "lifecycle"'), adminRoute.indexOf('b.action === "verify"'));
  const enforced = [
    [/fields\.location = "At least one confirmed offer location is required"/, "confirmed"],
    [/fields\.source_url = "Source URL required"/, "source"],
    [/fields\.schedule = "Eligible schedule required"/, "schedule"],
    [/fields\.verification = "Verification required"/, "verif"],
  ];
  const article = articles.find((entry) => entry.id === "publish-a-deal");
  // The specific sentence that makes the claim, not the article as a whole: every one of these
  // words appears somewhere in the steps too, so searching the whole text would keep passing
  // after a condition was quietly dropped from the checklist.
  const claim = (article.gotchas || []).find((line) => line.startsWith("Publishing refuses"));
  assert.ok(claim, "the publishing article should state what publishing refuses on");
  for (const [pattern, word] of enforced) {
    assert.match(branch, pattern, "the server should still enforce this condition");
    assert.ok(claim.toLowerCase().includes(word), `the publishing checklist omits the ${word} requirement`);
  }
  // And the statuses it names are the ones the server accepts.
  assert.match(branch, /\["draft", "scheduled", "live", "paused", "expired", "archived"\]/);
  const statuses = searchTextFor(articles.find((entry) => entry.id === "lifecycle"));
  for (const status of ["draft", "scheduled", "live", "paused", "expired", "archived"]) {
    assert.ok(statuses.includes(status), `the lifecycle article does not explain "${status}"`);
  }
});

test("the expiry grace period in the handbook is the one the cron uses", () => {
  assert.match(lifecycle, /EXPIRY_GRACE_PERIOD_DAYS = 2/);
  assert.match(searchTextFor(articles.find((entry) => entry.id === "lifecycle")), /two days after its end date/);
});

test("the affiliate numbers match the program", () => {
  const text = searchTextFor(articles.find((entry) => entry.id === "affiliate-program"));
  assert.equal(program.DEFAULT_RATE_BPS, 2000);
  assert.equal(program.DEFAULT_YEARLY_RATE_BPS, 1000);
  assert.equal(program.DEFAULT_HOLD_DAYS, 30);
  assert.ok(text.includes("monthly subscriptions pay 20%"), "the handbook should state the monthly rate");
  assert.ok(text.includes("yearly ones 10%"), "the handbook should state the yearly rate");
  assert.ok(text.includes("thirty-day holding period"), "the handbook should state the hold period");
  // The two rules staff most need to not get wrong.
  assert.ok(text.includes("no 'mark as paid'") || text.includes("no ‘mark as paid’"));
  assert.ok(text.includes("iphone app earn nothing"));
});

test("the handbook holds nothing that should not be read by everyone who can open admin", () => {
  // It renders for every account with read_admin, including analyst. An address or a key-shaped
  // string in here is a leak to a wider audience than whoever wrote it had in mind.
  const everything = articles.map(searchTextFor).join(" ");
  assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(everything), "no email addresses in the handbook");
  assert.ok(!/\b(sk_live|sk_test|whsec_|pk_live|rk_live)/i.test(everything), "no key-shaped strings in the handbook");
  assert.ok(!/password/i.test(everything) || /never|not|do not/i.test(everything), "passwords are only ever mentioned to say not to handle them");
});

test("the handbook is reachable, and reachable by everyone who can open admin", () => {
  // Last in the routing order, after the Administration area's two tabs.
  assert.match(sections, /"developer",\s+"help",?\s*\]/);
  assert.match(sections, /help: "Staff handbook"/);
  assert.match(adminClient, /href="\/admin\/help"/);
  // Deliberately not wrapped in a permission check, unlike every other conditional nav entry:
  // the person most likely to need it is the one with the fewest permissions.
  const nav = adminClient.slice(adminClient.indexOf('href="/admin/help"') - 400, adminClient.indexOf('href="/admin/help"'));
  assert.ok(!/canManage\w+ && \($/.test(nav.trim()), "the handbook link must not be permission-gated");
});

test("every role that can open the workspace has a section written for it", () => {
  // The handbook is filed by role, so a role with no section is somebody who was hired and then
  // handed a workspace with no instructions for the part of it that is theirs.
  const written = new Set(HANDBOOK.flatMap((section) => section.roles));
  for (const role of ALL_ROLES) {
    if (role === "user" || WORKSPACE_ROLES.includes(role)) continue;
    assert.ok(written.has(role), `no handbook section is written for "${role}"`);
  }
  // And nothing claims to be written for a role that does not exist.
  for (const role of written) assert.ok(ALL_ROLES.includes(role), `"${role}" is not a role`);
});

test("the handbook opens on the reader's own role", () => {
  for (const [role, first] of [
    ["deal_editor", "deal-editors"],
    ["moderator", "moderators"],
    ["supervisor", "supervisors"],
    ["marketing", "marketing"],
    ["finance_manager", "finance"],
    ["analyst", "analysts"],
    ["developer", "developers"],
    ["admin", "admins"],
    ["owner", "admins"],
  ]) {
    const ordered = handbookFor(role, new Set());
    assert.equal(ordered[0].section.id, first, `${role} should open on their own section`);
    assert.equal(ordered.length, HANDBOOK.length, "ordering alone must never drop a section");
  }
  // A custom role is none of the presets, so it falls back to what the person can actually do.
  assert.equal(handbookFor("custom", new Set(["moderate_suggestions"]))[0].section.id, "moderators");
  // Everything after the promoted section keeps the handbook's own order, which runs from "how
  // this place works" to "when something looks wrong" for a reason.
  assert.deepEqual(
    handbookFor("analyst", new Set()).map((entry) => entry.section.id).slice(1),
    HANDBOOK.filter((section) => section.id !== "analysts").map((section) => section.id),
  );
});

test("the sections everybody reads hold nothing that is only one role's to do", () => {
  // The two role-less sections are orientation and troubleshooting, read by every kind of staff.
  // An article about paying an affiliate or changing somebody's role filed in one of them is
  // advice for a control the reader cannot see, which teaches them to stop reading.
  for (const section of HANDBOOK) {
    if (section.roles.length > 0) continue;
    for (const article of section.articles) {
      assert.equal(
        article.permission,
        null,
        `"${article.id}" needs ${article.permission} but sits in "${section.id}", which everybody reads`,
      );
    }
  }
  // And the converse: a section written for a role is where its permissioned articles live.
  const filed = HANDBOOK.filter((section) => section.roles.length > 0).flatMap((section) => section.articles);
  assert.ok(filed.filter((article) => article.permission !== null).length > 20, "the role sections carry the job");
});

test("the complicated jobs are written as steps, not as prose", () => {
  // The things people get wrong are the multi-part ones: publishing, verifying several addresses
  // at once, pausing a market, admitting somebody to a mailing list, approving an affiliate,
  // comping a subscription, paying real money. Each of those is a procedure, and a procedure
  // without an ordered list is a paragraph somebody has to turn into one under pressure.
  for (const id of [
    "publish-a-deal",
    "verification",
    "pause-a-market",
    "deal-without-locations",
    "suggestions",
    "reports",
    "admit-from-waitlist",
    "campaign-links",
    "commission-decisions",
    "pay-an-affiliate",
    "payout-failed",
    "change-someones-role",
    "restaurant-managers",
    "creator-accounts",
    "someone-lost-access",
    "comp-a-subscription",
    "covering-someone",
  ]) {
    const article = articles.find((entry) => entry.id === id);
    assert.ok(article, `the handbook should still explain "${id}"`);
    assert.ok((article.steps || []).length >= 4, `"${id}" is a complex job with fewer than four steps`);
  }
});

test("searching matches the sentence somebody is quoting, not only the title", () => {
  const article = articles.find((entry) => entry.id === "change-not-showing");
  // A phrase from the body of an article has to find it — that is how a reader searches.
  assert.ok(searchTextFor(article).includes("until the next deployment"));
  assert.ok(searchTextFor(article).includes("within about a minute"));
  // And the gotchas are searchable too, which is where the operationally useful sentences are.
  const payout = articles.find((entry) => entry.id === "payout-failed");
  assert.ok(searchTextFor(payout).includes("one payout becomes two transfers"));
});

test("every admin action a person can take is described somewhere", () => {
  // Not one article per action — that would be a manual of buttons. This checks the areas: every
  // action's permission has an article filed under it, which is the promise the grouping makes.
  const filed = new Set(articles.map((article) => article.permission).filter(Boolean));
  const needed = new Set(Object.values(ACTION_PERMISSIONS));
  for (const permission of needed) {
    assert.ok(filed.has(permission), `actions gated on "${permission}" have no handbook article`);
  }
});

// ── Who is served what ───────────────────────────────────────────────────────────────────────
//
// The handbook used to render whole for everybody and only chose the order. Articles about a job
// are now served to the people who hold it, by GET /api/admin/handbook, so these pin both halves:
// the rule itself (readableHandbook) and the route and page that apply it.

const viewer = (role, permissions) => ({ role, permissions: new Set(["read_admin", ...permissions]) });
const servedIds = (payload) => payload.sections.flatMap((section) => section.articles.map((article) => article.id));
const ANALYST = viewer("analyst", ["view_analytics"]);
const FINANCE = viewer("finance_manager", ["manage_finance", "manage_sponsorships", "view_analytics"]);
const DEVELOPER = viewer("developer", ["export_data", "developer_tools"]);
const ADMIN = viewer("admin", ALL_PERMISSIONS.filter((permission) => !["export_data", "developer_tools"].includes(permission)));
const OWNER = viewer("owner", ALL_PERMISSIONS);

test("an article is served only to somebody holding its permission", () => {
  const analyst = servedIds(readableHandbook(ANALYST));
  for (const id of ["pay-an-affiliate", "commission-decisions", "exports", "change-someones-role", "reopening-reports", "publish-a-deal"]) {
    assert.ok(!analyst.includes(id), `an analyst should not be served "${id}"`);
  }
  assert.ok(analyst.includes("reading-the-numbers"), "an analyst holds view_analytics, so reads where the numbers come from");
  const finance = servedIds(readableHandbook(FINANCE));
  assert.ok(finance.includes("pay-an-affiliate") && finance.includes("comp-a-subscription"));
  assert.ok(!finance.includes("exports"), "exports are the developer's");
  const developer = servedIds(readableHandbook(DEVELOPER));
  assert.ok(developer.includes("exports") && developer.includes("developer-tools"));
  assert.ok(!developer.includes("pay-an-affiliate"));
  // Every reader is served exactly what canReadArticle allows, and the rest is counted.
  for (const reader of [ANALYST, FINANCE, DEVELOPER, ADMIN, OWNER]) {
    const payload = readableHandbook(reader);
    const allowed = articles.filter((article) => canReadArticle(article, reader)).length;
    assert.equal(servedIds(payload).length, allowed);
    assert.equal(payload.withheld, articles.length - allowed);
    for (const section of payload.sections) assert.ok(section.articles.length > 0, `"${section.id}" was served empty`);
  }
  assert.equal(readableHandbook(OWNER).withheld, 0, "an owner reads everything");
});

test("the sections everybody reads reach everybody", () => {
  const everyone = HANDBOOK.filter((section) => section.roles.length === 0);
  assert.ok(everyone.some((section) => section.id === "drink-rules"), "the drink rules are everybody's");
  const served = readableHandbook(viewer("custom", []));
  for (const section of everyone) {
    const got = served.sections.find((entry) => entry.id === section.id);
    assert.ok(got, `"${section.id}" should reach somebody holding only read_admin`);
    assert.equal(got.articles.length, section.articles.length);
    assert.equal(got.everyone, true);
  }
});

test("the jobs that answer to a role are served to that role", () => {
  // Deciding an owner approval is the owner's alone; the audit log is owner and admin.
  assert.ok(servedIds(readableHandbook(OWNER)).includes("decide-owner-approvals"));
  assert.ok(!servedIds(readableHandbook(ADMIN)).includes("decide-owner-approvals"), "an admin cannot decide approvals");
  assert.ok(servedIds(readableHandbook(ADMIN)).includes("read-the-audit-log"));
  assert.ok(!servedIds(readableHandbook(viewer("custom", ["manage_users"]))).includes("read-the-audit-log"));
  // The roles an article names have to be real.
  for (const article of articles) for (const role of article.roles || []) assert.ok(ALL_ROLES.includes(role), `${article.id} names "${role}"`);
});

test("the route serves each reader their own handbook, and nobody else's", async () => {
  const request = () => new Request("https://radar.cheap/api/admin/handbook");
  const staffUser = (role, permissions) => ({ userId: role, email: `${role}@example.test`, role, displayName: role, permissions: new Set(["read_admin", ...permissions]) });

  harness.user = null;
  assert.equal((await handbookGet(request())).status, 401);
  harness.user = { ...staffUser("user", []), permissions: new Set() };
  assert.equal((await handbookGet(request())).status, 403, "no read_admin, no handbook");

  harness.user = staffUser("analyst", ["view_analytics"]);
  const response = await handbookGet(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/, "a per-reader answer must not be cached");
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.deepEqual(servedIds(payload), servedIds(readableHandbook(ANALYST)));
  // Not only the ids: the words of a restricted article are not in the response at all.
  const payout = articles.find((article) => article.id === "pay-an-affiliate");
  assert.ok(!text.includes(JSON.stringify(payout.summary).slice(1, -1)), "a restricted article's text reached a reader without the permission");
  assert.ok(payload.sections.some((section) => section.id === "drink-rules"));

  harness.user = staffUser("finance_manager", ["manage_finance", "manage_sponsorships", "view_analytics"]);
  assert.ok(servedIds(await (await handbookGet(request())).json()).includes("pay-an-affiliate"));
  harness.user = null;
});

test("the page fetches the handbook rather than bundling it", () => {
  // Every runtime import of the handbook module would put every article into the JavaScript all
  // staff download. Types are fine: they vanish at build time.
  const raw = adminSource("tabs/HandbookTab.tsx");
  const imports = raw.split("\n").filter((entry) => /from "\.\.\/handbook"/.test(entry));
  assert.ok(imports.length > 0);
  for (const line of imports) assert.match(line, /^import type /, `HandbookTab imports the handbook at runtime: ${line}`);
  assert.match(handbookTab, /fetch\("\/api\/admin\/handbook"/);
  // Loading, failing and finding nothing all read the same as everywhere else in the workspace.
  for (const kind of ["loading", "error", "empty"]) assert.match(handbookTab, new RegExp(`<StatePanel\\s+kind="${kind}"`));
  // The contents, the grouping filter and the search box.
  assert.match(handbookTab, /aria-label="Handbook contents"/);
  assert.match(handbookTab, /aria-label="Show articles about one part of the workspace"/);
  assert.match(handbookTab, /label="Search the handbook"/);
  // Deep links land on a section or an article, the drink-rule alert's among them.
  assert.match(handbookTab, /id=\{section\.id\}/);
  assert.match(handbookTab, /id=\{article\.id\}/);
});

// ── The new claims, checked against what they describe ───────────────────────────────────────

test("the drink rules name the states and ages the code applies", () => {
  const section = HANDBOOK.find((entry) => entry.id === "drink-rules");
  assert.ok(section, "/admin/help#drink-rules has to land on something");
  const text = section.articles.map(searchTextFor).join(" ");
  const names = { MA: "massachusetts", RI: "rhode island", VT: "vermont", NC: "north carolina", UT: "utah", AK: "alaska" };
  const banned = [...drinkRules.matchAll(/\b([A-Z]{2}): \{ happyHour: "banned"/g)].map((match) => match[1]);
  assert.deepEqual(banned.sort(), Object.keys(names).sort(), "the happy-hour ban states changed; update the handbook");
  for (const code of banned) assert.ok(text.includes(names[code]), `the drink rules omit ${names[code]}`);
  const eighteen = [...drinkRules.matchAll(/\b([A-Z]{2}): \{ drinkingAge: 18/g)].map((match) => match[1]).sort();
  assert.deepEqual(eighteen, ["AB", "MB", "QC"]);
  assert.ok(text.includes("18 in quebec, alberta and manitoba"));
  assert.ok(text.includes("21 in every us state"));
  assert.match(drinkRules, /noDiscountWording: true/);
  assert.ok(text.includes("half price") && text.includes("rabais"), "the Quebec wording rule should be explained");
});

test("the export articles state the cap the export route applies", () => {
  assert.match(exportRoute, /const MAX_ROWS = 2000;/);
  for (const id of ["exports", "getting-an-export"]) {
    assert.ok(searchTextFor(articles.find((entry) => entry.id === id)).includes("2,000 rows"), `${id} should state the row cap`);
  }
  assert.equal(articles.find((entry) => entry.id === "exports").permission, "export_data");
});

test("rejecting a suggestion is described with the reasons the server accepts", () => {
  const text = searchTextFor(articles.find((entry) => entry.id === "rejecting-suggestions"));
  for (const reason of SUGGESTION_REJECTION_REASONS) {
    if (reason.code === "other") continue;
    assert.ok(text.includes(reason.label.toLowerCase()), `the handbook omits the "${reason.label}" reason`);
  }
  assert.equal(MIN_CUSTOM_REASON_LENGTH, 20);
  assert.ok(text.includes("twenty characters"));
});

test("the owner-approval article covers every action that waits for an owner", () => {
  const text = searchTextFor(articles.find((entry) => entry.id === "owner-approvals"));
  const phrase = { bulk_lifecycle: "a whole market", delete_sponsorship: "deleting a sponsorship", affiliate_payout: "paying an affiliate", referral_correction: "correcting the referral code", setting: "operator switch" };
  assert.deepEqual([...OWNER_APPROVAL_ACTIONS].sort(), Object.keys(phrase).sort());
  for (const action of OWNER_APPROVAL_ACTIONS) assert.ok(text.includes(phrase[action]), `owner approvals should mention ${action}`);
  assert.match(adminRoute, /\(pending\?\.n \|\| 0\) >= 20/);
  assert.ok(text.includes("at most twenty requests"));
  assert.match(adminRoute, /DECISION_NOTE_REQUIRED/);
  assert.ok(text.includes("declining needs a note"));
});

test("closing and reopening reports is described the way the server enforces it", () => {
  for (const code of ["REOPEN_NOT_ALLOWED", "RESOLUTION_REQUIRED", "REOPEN_REASON_REQUIRED"]) assert.ok(adminRoute.includes(code));
  const reports = searchTextFor(articles.find((entry) => entry.id === "reports"));
  assert.ok(reports.includes("only a supervisor, an admin or an owner can do"));
  assert.ok(reports.includes("the resolution is required"));
  const reopening = articles.find((entry) => entry.id === "reopening-reports");
  assert.equal(reopening.permission, "reopen_reports");
  assert.ok(searchTextFor(reopening).includes("write the reason for reopening"));
});

test("nothing describes the behavior that was removed", () => {
  const everything = articles.map(searchTextFor).join(" ");
  assert.ok(!everything.includes("paused all markets"), "there is no all-markets pause any more");
  assert.ok(!/tick the drafts|per batch|batches/.test(everything), "drafts are reviewed one at a time");
  // A market pause is only offered for one city, with a reason and a typed phrase.
  const pause = searchTextFor(articles.find((entry) => entry.id === "pause-a-market"));
  assert.ok(pause.includes("only offered while the filter names a single city"));
  assert.ok(pause.includes("both are required"));
  assert.ok(searchTextFor(articles.find((entry) => entry.id === "roles")).includes("admin → roles & permissions"), "the presets grid lives in the Admin area");
});
