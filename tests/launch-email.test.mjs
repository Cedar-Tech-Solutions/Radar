import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { code } from "./source.mjs";

// The launch broadcast, and the fact that makes it different from every other job in the folder:
// it cannot be taken back.
//
// A digest that goes out wrong is followed by a correct one next week. A launch announcement sent
// to the wrong list, before the app exists, or twice, is simply in people's inboxes. So the tests
// here are not about the message rendering — they are about the four things that have to be true
// before any message leaves, and each of them is a thing a plausible future edit would remove.

const job = code(await readFile(new URL("../app/api/jobs/launch-email/route.ts", import.meta.url), "utf8"));
const email = code(await readFile(new URL("../app/email.ts", import.meta.url), "utf8"));
const unsubscribe = code(await readFile(new URL("../app/api/email/unsubscribe/route.ts", import.meta.url), "utf8"));
const worker = code(await readFile(new URL("../worker/index.ts", import.meta.url), "utf8"));

test("nothing sends unless it is explicitly asked to", () => {
  // The default has to be the safe one. A mistyped command should show you the list, not mail it.
  assert.match(job, /const send = url\.searchParams\.get\("send"\) === "true"/);
  const guard = job.indexOf("if (!send)");
  const firstSend = job.indexOf("sendEmail(");
  assert.ok(guard > 0, "the dry-run branch is gone");
  assert.ok(guard < firstSend, "the dry run no longer returns before the send loop");
  // And a dry run must not write anything, or "nothing happened" stops being true.
  const dryRunBranch = job.slice(guard, job.indexOf("INSERT OR IGNORE INTO email_campaigns"));
  assert.ok(!/INSERT INTO|UPDATE /.test(dryRunBranch), "the dry run writes to the database");
});

test("it refuses to run without a real App Store link", () => {
  // The likeliest moment to run this is just before the app is actually approved, when the link
  // does not exist yet. A launch email whose only button 404s is worse than no launch email.
  //
  // The check moved into app/app-release.ts when /launch started needing the same answer, so this
  // asserts the job consults it and bails. What the check itself accepts is covered by
  // tests/launch-gate.test.mjs, against that module.
  assert.match(job, /import \{ appStoreListingUrl \} from "\.\.\/\.\.\/\.\.\/app-release"/);
  assert.match(job, /const appStoreUrl = await appStoreListingUrl\(\)/);
  assert.match(job, /if \(!appStoreUrl\) \{/);
  const check = job.indexOf("APP_STORE_URL_MISSING");
  const dryRun = job.indexOf("if (!send)");
  assert.ok(check > 0 && check < dryRun, "the URL check runs after the dry-run branch, so a dry run lies about readiness");
});

test("only the people who asked about the app are mailed", () => {
  // Homepage leads consented to hear about nearby deals. That is a different permission, and
  // mailing them about an app launch is exactly what CASL is about.
  assert.match(email, /export const WAITLIST_SOURCES = \["ios-waitlist"\]/);
  assert.match(job, /l\.source IN \(\$\{placeholders\}\)/);
  assert.ok(!/source\s*=\s*'homepage'/.test(job), "the job reaches into the homepage list");
});

test("a second run resumes instead of repeating", () => {
  // Idempotency is per recipient, not per run: a partial failure has to be finishable without
  // re-mailing anyone who already got it.
  assert.match(job, /NOT EXISTS\(SELECT 1 FROM email_deliveries d[\s\S]{0,140}status='sent'\)/);
  // The delivery row is written before the send, so a Worker that dies mid-request leaves a
  // 'queued' row that retries — rather than a send with no record, which would re-mail.
  const insert = job.indexOf("INSERT INTO email_deliveries");
  const send = job.indexOf("await sendEmail(");
  assert.ok(insert > 0 && insert < send, "the delivery row is written after the send, so a crash re-mails");
});

test("an unsubscribed address is never reached", () => {
  // Twice, on purpose. The job excludes suppressions in SQL, and the admission check does it
  // again immediately before the message leaves — because a later refactor that reroutes the
  // query must not be able to turn an unsubscribe into a decoration.
  assert.match(job, /NOT EXISTS\(SELECT 1 FROM email_suppressions s WHERE lower\(s\.email\)=lower\(l\.email\)\)/);
  assert.match(email, /admittedToWaitlist[\s\S]{0,600}NOT EXISTS\(SELECT 1 FROM email_suppressions/);
});

test("the unsubscribe link in this email actually works", () => {
  // A lead has no users row. The original route looked the token's id up in `users` and 404ed on
  // anything else, so without this branch every unsubscribe link in the launch email would be
  // decorative — on a message sent under CASL, worse than having no link.
  assert.match(email, /export const LEAD_TOKEN_PREFIX = "lead:"/);
  assert.match(unsubscribe, /userId\.startsWith\(LEAD_TOKEN_PREFIX\)/);
  assert.match(unsubscribe, /FROM email_leads WHERE id=\? AND lower\(email\)=\?/);
  assert.match(unsubscribe, /INSERT OR IGNORE INTO email_suppressions\(email,reason\) VALUES\(\?,'user_unsubscribe'\)/);
  // The lead branch must return before falling through to the users lookup that would 404.
  const branch = unsubscribe.indexOf("LEAD_TOKEN_PREFIX");
  const userLookup = unsubscribe.indexOf("SELECT id FROM users");
  assert.ok(branch < userLookup, "the lead branch runs after the users lookup has already failed");
});

test("waitlist consent is not quietly widened into deal-mail consent", () => {
  // The one small edit that would have made this work is adding leads to admittedToPilot. It
  // would also make every future sendEmail call treat a waitlist address as a consenting
  // subscriber, leaving the shape of a SELECT in another file as the only thing between them and
  // a weekly digest.
  const pilot = email.slice(email.indexOf("export async function admittedToPilot"), email.indexOf("export async function canDeliverTo"));
  assert.ok(!/email_leads/.test(pilot), "admittedToPilot now admits waitlist leads");
  // The audience defaults to the stricter check, so no existing caller is moved onto the looser one.
  assert.match(email, /admittedFor\(input\.to,input\.audience \|\| "pilot"\)/);
  // The global rails still apply to every audience.
  assert.match(email, /if \(!pilotGatesOpen\(\) \|\| !\(await admittedFor/);
});

test("the launch email is not on a schedule", () => {
  // Every other job in the folder is self-invoked hourly by the worker. This one is a single
  // irreversible broadcast; a cron entry would mean a deploy could fire it.
  // The Worker names every API route once, to answer an address no route has (API_ROUTES); the
  // cron is what must not name this one.
  const cron = worker.slice(worker.indexOf("async scheduled("));
  assert.ok(cron.length > 1000, "expected the scheduled handler");
  assert.ok(!/launch-email/.test(cron), "the launch email has been wired into the cron");
});

test("the message says why it arrived and how to stop it", () => {
  // CASL: identification and a working unsubscribe are what make a commercial message lawful,
  // and they have to be in the message rather than in a policy page nobody opens.
  assert.match(email, /You're getting this one message because you asked to be told when the Radar app launched/);
  assert.match(email, /buildLaunchEmail[\s\S]{0,4000}unsubscribeUrl/);
  // And it must not imply a subscription it is not offering.
  const template = email.slice(email.indexOf("export function buildLaunchEmail"), email.indexOf("export function localParts"));
  assert.ok(!/preferencesUrl/.test(template), "the launch email links to preferences that do not exist for a lead");
});
