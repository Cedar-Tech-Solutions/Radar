import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { code } from "./source.mjs";

// Who pays for Radar Pro, and what the account's plan is because of it.
//
// Pro is paid for on the web through Stripe, in the app through Apple, or granted by an admin, and
// users.plan_status is both Stripe's word for the web subscription and what every reader checks to
// decide whether an account is Pro. The bugs this pins: an App Store subscription that expired
// never took Pro away, because the "active" written for Apple was read back as a live Stripe
// subscription; a web cancellation took Pro from somebody still paying Apple; and an admin grant
// set plan='pro' beside the "inactive" every free account starts with, so it granted nothing.

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) => `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

// app/entitlement.ts imports nothing, and app/plan-resolution.ts imports only it, so both really
// run: the one import is pointed at the transpiled entitlement module.
const entitlementUrl = asModule(transpile(await readFile(new URL("../app/entitlement.ts", import.meta.url), "utf8")));
const resolutionSource = await readFile(new URL("../app/plan-resolution.ts", import.meta.url), "utf8");
const linked = transpile(resolutionSource).replace(/from\s+["']\.\/entitlement["']/, `from "${entitlementUrl}"`);
assert.ok(linked.includes(entitlementUrl), "app/plan-resolution.ts no longer imports ./entitlement the way this test links it");
const { decidePlan, stripeOwnsStatus, paidForPredicate } = await import(asModule(linked));

// A grant's whole life also runs for real, further down: the shipped resolvePlan and billing job,
// against a SQLite database made from drizzle/*.sql. Neither loads without these two stand-ins.
const WORKERS = `data:text/javascript,${encodeURIComponent("export const env = globalThis.__PLAN_TEST_ENV__;\n")}`;
const NEXT_HEADERS = `data:text/javascript,${encodeURIComponent("export const headers = async () => new Headers();\n")}`;
globalThis.__PLAN_TEST_ENV__ = { BILLING_JOB_SECRET: "test-secret" };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: WORKERS, shortCircuit: true };
    if (specifier === "next/headers") return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { resolvePlan, billingFor } = await import("../app/apple-entitlement.ts");
const { POST: billingJobPost } = await import("../app/api/jobs/billing/route.ts");
const { isProPlan } = await import("../app/entitlement.ts");

const webhook = code(await readFile(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8"));
const billingJob = code(await readFile(new URL("../app/api/jobs/billing/route.ts", import.meta.url), "utf8"));
const appleEntitlement = code(await readFile(new URL("../app/apple-entitlement.ts", import.meta.url), "utf8"));
const userRoute = code(await readFile(new URL("../app/api/user/route.ts", import.meta.url), "utf8"));
const adminRoute = code(await readFile(new URL("../app/api/admin/route.ts", import.meta.url), "utf8"));

const DAY = 86_400_000;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const NOW = new Date("2026-10-01T12:00:00Z");

const noStripe = { subscriptionId: null, status: "inactive", pastDueSince: null, pausedUntil: null };
const stripe = (status, extra = {}) => ({ subscriptionId: "sub_1", status, pastDueSince: null, pausedUntil: null, ...extra });
const APPLE = { status: "active" };
const decide = (input) => decidePlan({ granted: false, apple: null, now: NOW, ...input });

// ── The two bugs ──────────────────────────────────────────────────────────────────────────────

test("an App Store subscription that ends takes Pro with it", () => {
  // The "active" written while Apple was paying is left in plan_status. With no Stripe
  // subscription behind it, it is nobody's word, and it must not be read as a live web one.
  const lapsed = decide({ stripe: { ...noStripe, status: "active" } });
  assert.equal(lapsed.plan, "free");
  assert.equal(lapsed.status, "inactive", "the leftover active should be retired, or readers still see Pro");
  assert.equal(lapsed.billing, null);
});

test("a web cancellation does not take Pro from somebody paying Apple", () => {
  const decision = decide({ stripe: stripe("canceled"), apple: APPLE });
  assert.equal(decision.plan, "pro");
  assert.equal(decision.status, "active", "Apple should own the column once Stripe's subscription is over");
  assert.equal(decision.forgetSubscription, true, "the finished subscription's id should be forgotten");
  assert.equal(decision.billing, "apple");
});

// ── Who owns plan_status ──────────────────────────────────────────────────────────────────────

test("plan_status is Stripe's while its subscription is running, and nobody's once it is over", () => {
  assert.equal(stripeOwnsStatus(stripe("active")), true);
  assert.equal(stripeOwnsStatus(stripe("past_due")), true);
  assert.equal(stripeOwnsStatus(stripe("unpaid")), true);
  assert.equal(stripeOwnsStatus(stripe("canceled")), false);
  assert.equal(stripeOwnsStatus(stripe("incomplete_expired")), false);
  assert.equal(stripeOwnsStatus({ ...noStripe, status: "active" }), false, "an id is what makes it Stripe's");
});

test("Apple never writes over a web subscription that is still running", () => {
  for (const status of ["active", "trialing", "past_due", "unpaid"]) {
    const decision = decide({ stripe: stripe(status, { pastDueSince: stamp(NOW.getTime() - DAY) }), apple: APPLE });
    assert.equal(decision.plan, "pro", `${status} beside Apple should be Pro`);
    assert.equal(decision.status, null, `${status} is Stripe's word and should be left alone`);
    assert.equal(decision.forgetSubscription, false);
  }
});

test("an App Store subscription alone is Pro, and says so where readers look", () => {
  const decision = decide({ stripe: noStripe, apple: APPLE });
  assert.deepEqual(decision, { plan: "pro", status: "active", forgetSubscription: false, billing: "apple" });
  assert.equal(decide({ stripe: noStripe, apple: { status: "grace_period" } }).plan, "pro");
});

// ── Web customers see no difference ───────────────────────────────────────────────────────────

test("a web subscription alone decides the plan exactly as the webhook always has", () => {
  // Stripe-only accounts are nearly all of them. Nothing about their plan may change.
  assert.deepEqual(decide({ stripe: stripe("active") }), { plan: "pro", status: null, forgetSubscription: false, billing: "stripe" });
  assert.equal(decide({ stripe: stripe("trialing") }).plan, "pro");
  // A decline keeps Pro through the grace window...
  assert.equal(decide({ stripe: stripe("past_due", { pastDueSince: stamp(NOW.getTime() - DAY) }) }).plan, "pro");
  // ...and a paused subscription stays plan='pro' with the pause itself denying access, as before.
  const paused = decide({ stripe: stripe("active", { pausedUntil: stamp(NOW.getTime() + 10 * DAY) }) });
  assert.equal(paused.plan, "pro");
  assert.equal(paused.billing, null, "a paused subscription is not paying");
  for (const status of ["unpaid", "incomplete"]) assert.equal(decide({ stripe: stripe(status) }).plan, "free");
  const canceled = decide({ stripe: stripe("canceled") });
  assert.equal(canceled.plan, "free");
  assert.equal(canceled.status, null, "canceled is what the win-back job looks for; it stays");
});

test("both paying is billed to Apple, and either one ending leaves the other", () => {
  assert.equal(decide({ stripe: stripe("active"), apple: APPLE }).billing, "apple");
  const appleEnded = decide({ stripe: stripe("active") });
  assert.equal(appleEnded.plan, "pro");
  assert.equal(appleEnded.billing, "stripe");
});

// ── Grants ────────────────────────────────────────────────────────────────────────────────────

test("an admin grant alone is Pro, and says so where readers look", () => {
  // A free account's status is "inactive". Leaving it there is how a grant used to be recorded and
  // grant nothing: every reader checks the status beside the plan.
  assert.deepEqual(decide({ stripe: noStripe, granted: true }), { plan: "pro", status: "active", forgetSubscription: false, billing: null });
});

test("a grant never writes over a web subscription that is still running", () => {
  for (const status of ["active", "trialing", "past_due", "unpaid"]) {
    const decision = decide({ stripe: stripe(status, { pastDueSince: stamp(NOW.getTime() - DAY) }), granted: true });
    assert.equal(decision.plan, "pro", `${status} beside a grant should be Pro`);
    assert.equal(decision.status, null, `${status} is Stripe's word and should be left alone`);
    assert.equal(decision.forgetSubscription, false);
  }
});

test("an admin grant survives either subscription ending", () => {
  // The web subscription is over: the column is the grant's now, and the finished id is forgotten
  // so the "active" written for the grant can never be read as Stripe's.
  assert.deepEqual(decide({ stripe: stripe("canceled"), granted: true }), { plan: "pro", status: "active", forgetSubscription: true, billing: null });
  // The App Store one is over: the "active" it left behind is the grant's to keep.
  assert.deepEqual(decide({ stripe: { ...noStripe, status: "active" }, granted: true }), { plan: "pro", status: "active", forgetSubscription: false, billing: null });
});

test("a grant is not a subscription: nobody is billed for it", () => {
  assert.equal(decide({ stripe: noStripe, granted: true }).billing, null);
  assert.equal(decide({ stripe: stripe("active"), granted: true }).billing, "stripe");
  assert.equal(decide({ stripe: noStripe, apple: APPLE, granted: true }).billing, "apple");
});

// ── Everything goes through it ────────────────────────────────────────────────────────────────

test("the webhook recomputes the plan instead of taking it from the event", () => {
  const updated = webhook.slice(webhook.indexOf('event.type === "customer.subscription.updated"'), webhook.indexOf('event.type === "customer.subscription.deleted"'));
  const deleted = webhook.slice(webhook.indexOf('event.type === "customer.subscription.deleted"'), webhook.indexOf('event.type === "account.updated"'));
  for (const [name, branch] of [["updated", updated], ["deleted", deleted]]) {
    assert.match(branch, /await resolvePlan\(resolvedUserId\)/, `subscription.${name} does not resolve the plan`);
    assert.match(branch, /\$\{CURRENT_SUBSCRIPTION\}/, `subscription.${name} can be applied by an event about an old subscription`);
  }
  // The id is what makes plan_status Stripe's, so the live subscription writes it.
  assert.match(updated, /stripe_subscription_id=COALESCE\(\?,stripe_subscription_id\)/);
  assert.match(webhook, /const CURRENT_SUBSCRIPTION = "\(stripe_subscription_id IS NULL OR stripe_subscription_id=\? OR plan_status IN \('canceled','incomplete_expired'\)\)"/);
});

test("the grace job leaves an App Store subscriber on Pro", () => {
  const block = billingJob.slice(billingJob.indexOf("async function cancelExpiredGrace"), billingJob.indexOf("async function resumeFinishedPauses"));
  const cancel = block.indexOf("UPDATE users SET plan='free'");
  const resolve = block.indexOf("await resolvePlan(user.id)");
  assert.ok(cancel !== -1 && resolve !== -1, "the grace job no longer cancels locally and then resolves the plan");
  assert.ok(cancel < resolve, "the plan should be resolved after the local cancel, not before or instead of it");
});

test("the Apple paths and the account endpoint use the same decision", () => {
  assert.match(appleEntitlement, /const decision = decidePlan\(inputs\);/);
  assert.match(appleEntitlement, /if \(decision\.forgetSubscription\) sets\.push\("stripe_subscription_id=NULL"\)/);
  assert.match(appleEntitlement, /expires_at IS NULL OR expires_at >= date\('now'\)/);
  assert.match(userRoute, /const billing = pro \? await billingFor\(user\.userId\) : null;/);
  // The website's billing controls ask the ownership rule itself whether there is a web
  // subscription to act on, and the subscription's id never leaves the server.
  assert.match(userRoute, /const \{ stripe_subscription_id: subscriptionId, referred_by: referredBy, \.\.\.shown \} = profile;/);
  assert.match(userRoute, /const web_subscription = stripeOwnsStatus\(\{ subscriptionId, status: profile\.plan_status,/);
  assert.match(userRoute, /profile:\{ \.\.\.shown, billing, web_subscription, referral \}/);
});

test("an admin grant or revoke resolves the plan instead of writing it", () => {
  const action = adminRoute.slice(adminRoute.indexOf('b.action === "plan_grant"'), adminRoute.indexOf('b.action === "creator_pick"'));
  const insert = action.indexOf("INSERT INTO plan_grants");
  const revoke = action.indexOf("UPDATE plan_grants SET revoked_at");
  const resolve = action.indexOf("await resolvePlan(target.id)");
  assert.ok(insert !== -1 && revoke !== -1 && resolve !== -1, "the plan_grant action no longer writes the grant and then resolves the plan");
  assert.ok(resolve > insert && resolve > revoke, "the plan should be resolved after the grant is written or closed, not before");
  assert.doesNotMatch(action, /UPDATE users SET/, "users.plan and plan_status are resolvePlan's to write, from every source at once");
});

test("the billing job ends lapsed grants through the same decision", () => {
  const block = billingJob.slice(billingJob.indexOf("async function endLapsedGrants"), billingJob.indexOf("async function sendWinbacks"));
  assert.match(block, /await resolvePlan\(user\.id\)/);
  assert.doesNotMatch(block, /UPDATE users SET/, "the job only finds the candidates; resolvePlan decides");
  assert.match(billingJob, /\["grants", \(\) => endLapsedGrants\(\)\]/);
});

// ── A grant's whole life, for real ────────────────────────────────────────────────────────────
//
// The shipped resolvePlan and billing job against the real schema. The dates are relative to
// today, because date('now') is SQLite's own clock; a day either side survives a run that crosses
// midnight.

/** D1's API over node:sqlite, as tests/national-chains.test.mjs has it. */
function d1(db) {
  const statement = (sql, binds) => ({
    bind: (...args) => statement(sql, args),
    first: async () => { const row = db.prepare(sql).get(...binds); return row === undefined ? null : { ...row }; },
    all: async () => ({ results: db.prepare(sql).all(...binds).map((row) => ({ ...row })), success: true, meta: {} }),
    run: async () => { const info = db.prepare(sql).run(...binds); return { results: [], success: true, meta: { changes: Number(info.changes ?? 0) } }; },
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => Promise.all(list.map((entry) => entry.all())) };
}

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  globalThis.__PLAN_TEST_ENV__.DB = d1(db);
  return db;
}

const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

function account(db, id, columns = {}) {
  const names = ["id", "email", ...Object.keys(columns)];
  db.prepare(`INSERT INTO users (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(id, `${id}@example.test`, ...Object.values(columns));
}

function grant(db, userId, expiresAt) {
  db.prepare("INSERT INTO plan_grants (user_id,granted_by,reason,expires_at) VALUES (?,'admin','A comped month',?)").run(userId, expiresAt);
}

function stored(db, id) {
  return { ...db.prepare("SELECT plan,plan_status,stripe_subscription_id,past_due_since,paused_until FROM users WHERE id=?").get(id) };
}

/** What the session, the dashboard and the phone all ask, of the columns left behind. */
function readsAsPro(db, id) {
  const row = stored(db, id);
  return isProPlan(row.plan, row.plan_status, row.past_due_since, new Date(), row.paused_until);
}

/** One hourly run, as the worker's cron makes it; returns what the grants step did. */
async function hourly() {
  const response = await billingJobPost(new Request("https://radar.cheap/api/jobs/billing", {
    method: "POST",
    headers: { authorization: "Bearer test-secret" },
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.grants && !result.grants.error, `the grants step failed: ${JSON.stringify(result.grants)}`);
  return result.grants.resolved;
}

test("a grant is Pro everywhere readers look, and ends on its date", async () => {
  const db = database();
  account(db, "comped");
  grant(db, "comped", day(1));
  await resolvePlan("comped");
  assert.equal(readsAsPro(db, "comped"), true, "a live grant should pass the check every reader makes");
  assert.equal(await billingFor("comped"), null, "nobody is billed for a grant");
  assert.equal(await hourly(), 0, "a live grant is none of the job's business");

  db.prepare("UPDATE plan_grants SET expires_at=? WHERE user_id='comped'").run(day(-1));
  assert.equal(await hourly(), 1);
  assert.deepEqual(stored(db, "comped"), { plan: "free", plan_status: "inactive", stripe_subscription_id: null, past_due_since: null, paused_until: null });
  assert.equal(readsAsPro(db, "comped"), false);
  assert.equal(await hourly(), 0, "a resolved account should drop out of the job, or it is written every hour");
});

test("a grant with no end date lasts until it is revoked", async () => {
  const db = database();
  account(db, "forever");
  grant(db, "forever", null);
  await resolvePlan("forever");
  assert.equal(readsAsPro(db, "forever"), true);
  assert.equal(await hourly(), 0);

  db.prepare("UPDATE plan_grants SET revoked_at=CURRENT_TIMESTAMP WHERE user_id='forever'").run();
  await resolvePlan("forever");
  assert.equal(readsAsPro(db, "forever"), false);
});

test("a lapsed grant leaves Pro that something else still pays for", async () => {
  const db = database();
  account(db, "web", { plan: "pro", plan_status: "active", stripe_subscription_id: "sub_web" });
  account(db, "apple", { plan: "pro", plan_status: "active" });
  db.prepare("INSERT INTO apple_subscriptions (original_transaction_id,user_id,product_id,status,environment) VALUES ('tx_apple','apple','radar.pro.monthly','active','Production')").run();
  account(db, "regranted", { plan: "pro", plan_status: "active" });
  grant(db, "regranted", day(30));
  for (const id of ["web", "apple", "regranted"]) grant(db, id, day(-1));

  assert.equal(await hourly(), 0);
  for (const id of ["web", "apple", "regranted"]) assert.equal(readsAsPro(db, id), true, `${id} should still be Pro`);
});

test("a lapsed grant beside an unpaid web subscription hands the plan back to Stripe", async () => {
  // The grant held plan='pro' over Stripe's unpaid. With the grant gone the subscription decides
  // again, and its status stays exactly as Stripe wrote it.
  const db = database();
  account(db, "unpaid", { plan: "pro", plan_status: "unpaid", stripe_subscription_id: "sub_unpaid" });
  grant(db, "unpaid", day(-1));
  assert.equal(await hourly(), 1);
  assert.deepEqual(stored(db, "unpaid"), { plan: "free", plan_status: "unpaid", stripe_subscription_id: "sub_unpaid", past_due_since: null, paused_until: null });
  assert.equal(await hourly(), 0);
});

test("a grant after a finished web subscription takes the column and forgets the old id", async () => {
  const db = database();
  account(db, "returning", { plan: "free", plan_status: "canceled", stripe_subscription_id: "sub_old" });
  grant(db, "returning", day(10));
  await resolvePlan("returning");
  assert.deepEqual(stored(db, "returning"), { plan: "pro", plan_status: "active", stripe_subscription_id: null, past_due_since: null, paused_until: null });
  assert.equal(readsAsPro(db, "returning"), true);
});

// ── Who counts as paying ──────────────────────────────────────────────────────────────────────

test("only Pro that somebody pays for counts as paying", async () => {
  // The counts that mean money (the Growth tab, referred subscribers, a creator's or an
  // affiliate's conversions) put paidForPredicate beside plan='pro' and an entitled status. Every
  // account here reaches its columns the way production does, through resolvePlan.
  const db = database();
  account(db, "web", { stripe_subscription_id: "sub_web", plan_status: "active" });
  account(db, "trial", { stripe_subscription_id: "sub_trial", plan_status: "trialing" });
  account(db, "comped-web", { stripe_subscription_id: "sub_comped", plan_status: "active" });
  for (const id of ["apple", "review", "lapsed-apple", "comped", "free"]) account(db, id);
  const appStore = db.prepare("INSERT INTO apple_subscriptions (original_transaction_id,user_id,product_id,status,environment) VALUES (?,?,'radar.pro.monthly',?,?)");
  appStore.run("tx_apple", "apple", "active", "Production");
  // App Review's purchase, made in Apple's sandbox: Pro, and nobody paid for it.
  appStore.run("tx_review", "review", "active", "Sandbox");
  appStore.run("tx_lapsed", "lapsed-apple", "expired", "Production");
  grant(db, "comped", null);
  grant(db, "comped-web", null);
  for (const { id } of db.prepare("SELECT id FROM users").all()) await resolvePlan(id);

  const who = (where) => db.prepare(`SELECT id FROM users WHERE ${where} ORDER BY id`).all().map((row) => row.id);
  assert.deepEqual(who(`plan='pro' AND plan_status IN ('active','trialing') AND ${paidForPredicate}`), ["apple", "comped-web", "trial", "web"]);
  assert.deepEqual(who(`plan='pro' AND plan_status='active' AND NOT ${paidForPredicate}`), ["comped", "review"]);
  // Not paying is not the same as not Pro: both still have everything Pro opens.
  for (const id of ["comped", "review"]) assert.equal(readsAsPro(db, id), true, `${id} should still be Pro`);
});
