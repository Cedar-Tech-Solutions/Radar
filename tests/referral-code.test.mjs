// Referral codes typed by the reader: on the sign-up page, or from the dashboard within 7 days of
// creating the account. A code is a creator's handle and lands in users.referred_by, the same
// column a ?c= link writes and the Stripe webhook pays from. Once set, only staff can change it,
// through an owner-approved, audited correction. These run the real handlers, as a browser console
// would, because every one of these rules has to hold without the page.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { freshDatabase, harness, post } from "./route-harness.mjs";

const { normalizeReferralCode, referralWindowOpen, referralWindowEndsAt, REFERRAL_WINDOW_DAYS } = await import("../app/referral-code.ts");
const { POST: codePost, DELETE: codeDelete } = await import("../app/api/referral-code/route.ts");
const { GET: userGet, POST: userPost } = await import("../app/api/user/route.ts");
const { POST: adminPost } = await import("../app/api/admin/route.ts");

const USER = "https://radar.cheap/api/user";
const act = async (body) => { const response = await userPost(post(USER, body)); return { status: response.status, body: await response.json() }; };
const admin = async (body) => { const response = await adminPost(post("https://radar.cheap/api/admin", body)); return { status: response.status, body: await response.json() }; };
const staff = (userId, role, permissions) => ({ userId, email: `${userId}@example.test`, role, displayName: userId, permissions: new Set(["read_admin", ...permissions]) });
const OWNER = staff("owner", "owner", ["manage_users", "manage_finance"]);
const FINANCE = staff("fin", "finance_manager", ["manage_finance"]);
const SUPPORT = staff("sup", "supervisor", ["manage_users"]);

function seed(db, { createdDaysAgo = 1, referredBy = null } = {}) {
  db.prepare("INSERT INTO users (id,email,role,created_at,referred_by) VALUES ('me','me@example.test','user',datetime('now',?),?)").run(`-${createdDaysAgo} days`, referredBy);
  for (const [id, handle, status] of [["maya-user", "maya", "active"], ["sam-user", "sam", "active"], ["old-user", "oldie", "paused"]]) {
    db.prepare("INSERT INTO users (id,email,role) VALUES (?,?,'creator')").run(id, `${id}@example.test`);
    db.prepare("INSERT INTO creator_profiles (user_id,handle,status) VALUES (?,?,?)").run(id, handle, status);
  }
  harness.user = { userId: "me", email: "me@example.test", role: "user", pro: false };
}
const referredBy = (db, id = "me") => db.prepare("SELECT referred_by FROM users WHERE id=?").get(id).referred_by;
const audits = (db, action) => db.prepare("SELECT actor_id,details FROM audit_log WHERE action=? ORDER BY id").all(action).map((row) => ({ ...row, details: JSON.parse(row.details) }));

// ── The code itself ─────────────────────────────────────────────────────────────────────────────

test("a code is read the way a handle is written, and pasted links and @handles still work", () => {
  assert.equal(normalizeReferralCode("  Maya "), "maya");
  assert.equal(normalizeReferralCode("@maya"), "maya");
  assert.equal(normalizeReferralCode("https://radar.cheap/?c=maya&camp=reel"), "maya");
  assert.equal(normalizeReferralCode("m"), null);
  assert.equal(normalizeReferralCode("maya'; DROP TABLE users"), null);
  assert.equal(normalizeReferralCode(42), null);
  assert.equal(normalizeReferralCode(""), null);
});

test("the dashboard window is 7 days from the account's own creation time, in UTC", () => {
  assert.equal(REFERRAL_WINDOW_DAYS, 7);
  const created = "2026-11-01 12:00:00";
  assert.equal(referralWindowEndsAt(created).toISOString(), "2026-11-08T12:00:00.000Z");
  assert.equal(referralWindowOpen(created, new Date("2026-11-08T11:59:59Z")), true);
  assert.equal(referralWindowOpen(created, new Date("2026-11-08T12:00:00Z")), false);
  // An unreadable date is a closed window, never an open-ended one.
  assert.equal(referralWindowOpen("not a date"), false);
});

// ── Sign-up page ────────────────────────────────────────────────────────────────────────────────

test("the sign-up check parks only a real, active creator's handle, in an httpOnly cookie", async () => {
  const db = freshDatabase();
  seed(db);
  const ok = await codePost(post("https://radar.cheap/api/referral-code", { code: "MAYA" }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, code: "maya" });
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /^radar_referral_code=maya;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=604800/);

  // Unknown and paused answer the same way, and clear whatever was parked before.
  for (const code of ["nobody", "oldie"]) {
    const missing = await codePost(post("https://radar.cheap/api/referral-code", { code }));
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("set-cookie"), /^radar_referral_code=; .*Max-Age=0/);
  }
  assert.equal((await codePost(post("https://radar.cheap/api/referral-code", { code: "maya" }, { origin: "https://evil.example" }))).status, 403);
  const cleared = await codeDelete(new Request("https://radar.cheap/api/referral-code", { method: "DELETE", headers: { origin: "https://radar.cheap" } }));
  assert.match(cleared.headers.get("set-cookie"), /Max-Age=0/);
});

test("account creation reads the typed code first, re-checks it, and audits whichever referral it stamps", async () => {
  // app/auth.ts cannot run here (it verifies a real Clerk session), so its order is pinned on the
  // source: the typed cookie is resolved against creator_profiles again, before the link cookie and
  // the GPC opt-out that only applies to links.
  const auth = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  const fn = auth.slice(auth.indexOf("async function referringCreator"), auth.indexOf("async function mappedProfile"));
  assert.ok(fn.indexOf('"radar_referral_code"') < fn.indexOf("sec-gpc"), "the typed code must be read before the GPC check");
  const { REFERRAL_CODE_COOKIE } = await import("../app/referral-code.ts");
  assert.equal(REFERRAL_CODE_COOKIE, "radar_referral_code", "auth.ts spells the cookie name out; keep the two in step");
  assert.match(fn, /resolveReferralCode\(typed, null\)/);
  assert.match(auth, /'referral_code_set','user'/);
  // Still only on the first insert of the row.
  const insert = auth.slice(auth.indexOf("if (!profile) {"), auth.indexOf("} else {", auth.indexOf("if (!profile) {")));
  assert.match(insert, /referringCreator\(cookieStore\)/);
});

// ── Dashboard ───────────────────────────────────────────────────────────────────────────────────

test("within 7 days the reader can add one code, once, and it is audited", async () => {
  const db = freshDatabase();
  seed(db, { createdDaysAgo: 3 });
  const before = (await (await userGet()).json()).profile.referral;
  assert.equal(before.code, null);
  assert.equal(before.can_add, true);
  assert.ok(before.window_ends_at);

  const added = await act({ action: "referral_code", code: "@Maya" });
  assert.equal(added.status, 200);
  assert.equal(referredBy(db), "maya");
  const [entry] = audits(db, "referral_code_set");
  assert.equal(entry.actor_id, "me");
  assert.deepEqual(entry.details, { handle: "maya", source: "dashboard" });

  const after = (await (await userGet()).json()).profile.referral;
  assert.deepEqual({ code: after.code, can_add: after.can_add }, { code: "maya", can_add: false });
  // The raw column is not passed through beside it.
  assert.equal((await (await userGet()).json()).profile.referred_by, undefined);

  // Never changed, never removed, by the reader.
  for (const code of ["sam", "maya", ""]) {
    const again = await act({ action: "referral_code", code });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "REFERRAL_LOCKED");
  }
  assert.equal(referredBy(db), "maya");
  assert.equal(audits(db, "referral_code_set").length, 1);
});

test("an account that arrived through a link is already locked", async () => {
  const db = freshDatabase();
  seed(db, { createdDaysAgo: 1, referredBy: "sam" });
  assert.equal((await act({ action: "referral_code", code: "maya" })).body.error.code, "REFERRAL_LOCKED");
  assert.equal(referredBy(db), "sam");
});

test("after 7 days the window is closed, on the server", async () => {
  const db = freshDatabase();
  seed(db, { createdDaysAgo: 8 });
  const late = await act({ action: "referral_code", code: "maya" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "REFERRAL_WINDOW_CLOSED");
  assert.equal(referredBy(db), null);
  assert.equal((await (await userGet()).json()).profile.referral.can_add, false);
});

test("unknown, paused and own codes are refused and change nothing", async () => {
  const db = freshDatabase();
  seed(db);
  assert.equal((await act({ action: "referral_code", code: "nobody" })).body.error.code, "REFERRAL_CODE_NOT_FOUND");
  assert.equal((await act({ action: "referral_code", code: "oldie" })).body.error.code, "REFERRAL_CODE_NOT_FOUND");
  assert.equal((await act({ action: "referral_code", code: "x" })).body.error.code, "REFERRAL_CODE_NOT_FOUND");
  harness.user = { userId: "maya-user", email: "maya-user@example.test", role: "creator", pro: false };
  db.prepare("UPDATE users SET created_at=datetime('now') WHERE id='maya-user'").run();
  assert.equal((await act({ action: "referral_code", code: "maya" })).body.error.code, "REFERRAL_SELF");
  assert.equal(referredBy(db), null);
  assert.equal(referredBy(db, "maya-user"), null);
});

// ── Staff correction ────────────────────────────────────────────────────────────────────────────

test("staff can correct a referral only with finance access, a reason and an owner's approval", async () => {
  const db = freshDatabase();
  seed(db, { referredBy: "maya" });

  harness.user = SUPPORT;
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "sam", reason: "typo", confirmed: true })).status, 403);

  harness.user = FINANCE;
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "sam", reason: "typo" })).status, 409, "needs the confirmation");
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "sam", confirmed: true })).status, 422, "needs a reason");
  const asked = await admin({ action: "referral_correction", id: "me", handle: "sam", reason: "Reader typed the wrong code", confirmed: true });
  assert.equal(asked.status, 202);
  assert.equal(referredBy(db), "maya", "nothing changes until an owner approves");

  harness.user = OWNER;
  const decided = await admin({ action: "decide_owner_approval", id: asked.body.id, decision: "approve", confirmed: true });
  assert.equal(decided.status, 200);
  assert.equal(referredBy(db), "sam");
  const [entry] = audits(db, "referral_correction");
  assert.equal(entry.details.previousHandle, "maya");
  assert.equal(entry.details.newHandle, "sam");

  // An owner's own correction runs at once; unknown handles are refused; empty clears it.
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "oldie", reason: "x", confirmed: true })).status, 404);
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "sam", reason: "x", confirmed: true })).status, 409);
  assert.equal((await admin({ action: "referral_correction", id: "me", handle: "", reason: "Family account", confirmed: true })).status, 200);
  assert.equal(referredBy(db), null);
});
