// What a staff workspace load costs, held to the Worker's budget.
//
// The workspace was the first route to answer with error 1102 (fixed in PR #41) and the first to
// come back to it: sixty-odd D1 statements on a load, each its own subrequest against the free
// plan's fifty, and every heavy list rebuilt from the whole catalogue on each. Now it reads through
// the collector in app/d1-reads.ts, which sends what a load issues at once as one batch, and keeps
// each heavy list serialised per isolate until a counter in data_changes says its tables moved
// (workspaceParts in app/api/admin/route.ts). This test loads the workspace as an owner against a
// SQLite copy of the migrated catalogue and counts both: the subrequests a load makes, and the CPU
// a load that reuses its parts costs. The figures and the ceilings are read the way
// tests/cpu-budget.test.mjs reads its own.
import assert from "node:assert/strict";
import test from "node:test";
import { freshDatabase, harness } from "./route-harness.mjs";

const db = freshDatabase();
const PERMISSIONS = ["read_admin", "manage_users", "manage_email", "moderate_suggestions", "moderate_feedback", "manage_sponsorships", "create_deals", "publish_deals", "verify_deals", "view_analytics", "manage_finance", "manage_campaigns", "developer_tools", "manage_settings", "manage_restaurants", "export_data"];
harness.user = { userId: "owner-1", role: "owner", email: "owner@example.test", permissions: new Set(PERMISSIONS), pro: true };

// D1 as the Worker counts it: a statement sent on its own is a subrequest, a batch is one however
// many it carries. SQLite's own time is kept out of the CPU figure, as D1's would be.
const real = harness.env.DB;
let statements = 0, subrequests = 0, inBatch = false, sqlMs = 0;
const timed = async (run) => { const before = process.cpuUsage(); try { return await run(); } finally { const used = process.cpuUsage(before); sqlMs += (used.user + used.system) / 1000; } };
const counted = (statement) => ({
  bind: (...values) => counted(statement.bind(...values)),
  all: () => { if (!inBatch) subrequests++; return timed(() => statement.all()); },
  first: (...args) => { if (!inBatch) subrequests++; return timed(() => statement.first(...args)); },
  run: () => { if (!inBatch) subrequests++; return timed(() => statement.run()); },
});
harness.env.DB = {
  prepare: (sql) => { statements++; return counted(real.prepare(sql)); },
  batch: async (list) => { subrequests++; inBatch = true; try { return await real.batch(list); } finally { inBatch = false; } },
};

const route = await import("../app/api/admin/route.ts");

async function load() {
  statements = 0; subrequests = 0; sqlMs = 0;
  const before = process.cpuUsage();
  const response = await route.GET(new Request("https://radar.cheap/api/admin", { headers: { host: "radar.cheap" } }));
  const body = await response.text();
  const used = process.cpuUsage(before);
  assert.equal(response.status, 200, body.slice(0, 200));
  return { statements, subrequests, ms: (used.user + used.system) / 1000 - sqlMs, body };
}

const live = db.prepare("SELECT COUNT(*) n FROM deals WHERE status='live' AND active=1 AND deleted_at IS NULL").get().n;
assert.ok(live >= 1000, `expected the migrated catalogue, got ${live} live deals`);

test("a workspace load fits in the subrequest budget, built or reused", async () => {
  const built = await load();
  const parsed = JSON.parse(built.body);
  assert.ok(parsed.deals.length >= 400 && parsed.restaurants.length >= 100, `the owner's load carries the catalogue: ${parsed.deals.length} deals, ${parsed.restaurants.length} restaurants`);
  // 62 before the collector, every statement its own round trip. The counters, the parts that
  // are built, and the per-reader reads - each moment's statements as one batch.
  assert.ok(built.subrequests <= 12, `a load that builds every part made ${built.subrequests} subrequests (${built.statements} statements), over the 12 allowed (see tests/cpu-budget-admin.test.mjs)`);
  const reused = await load();
  assert.ok(reused.subrequests <= 8, `a load that reuses every part made ${reused.subrequests} subrequests (${reused.statements} statements), over the 8 allowed`);
  assert.equal(reused.body, built.body, "a load with nothing changed answers the same");
});

test("a workspace load that reuses its parts is cheap, and one after a write builds only what moved", async () => {
  const runs = [];
  for (let i = 0; i < 8; i++) runs.push((await load()).ms);
  const least = Math.min(...runs.slice(3));
  if (process.env.CPU_BUDGET_LOG) console.error(`a reused workspace load: ${least.toFixed(1)} ms (runs ${runs.map((ms) => ms.toFixed(1)).join(" ")})`);
  // ~20 ms here when the ceiling was set, most of it the harness copying rows; 120-400 ms before.
  within("a workspace load that reuses every part", least, 60);

  db.prepare("UPDATE staff_reminders SET status='done' WHERE id=(SELECT id FROM staff_reminders LIMIT 1)").run();
  const afterReminder = await load();
  if (process.env.CPU_BUDGET_LOG) console.error(`after a reminder: ${afterReminder.ms.toFixed(1)} ms, ${afterReminder.subrequests} subrequests`);
  assert.ok(afterReminder.subrequests <= 8, `a load after a reminder made ${afterReminder.subrequests} subrequests`);
  within("a workspace load after a reminder is done", afterReminder.ms, 60);

  const edited = JSON.parse(afterReminder.body).deals[3].id;
  db.prepare("UPDATE deals SET title = title || '!' WHERE id = ?").run(edited);
  const afterEdit = await load();
  if (process.env.CPU_BUDGET_LOG) console.error(`after a deal edit: ${afterEdit.ms.toFixed(1)} ms, ${afterEdit.subrequests} subrequests`);
  assert.ok(JSON.parse(afterEdit.body).deals.find((deal) => deal.id === edited)?.title.endsWith("!"), "the edit is in the next load");
  assert.ok(afterEdit.subrequests <= 12, `a load after a deal edit made ${afterEdit.subrequests} subrequests`);
  // ~55 ms here when the ceiling was set: the deal list (the newest 500) and its alerts rebuilt.
  within("a workspace load after a deal edit", afterEdit.ms, 150);
});

function within(name, ms, ceiling) {
  assert.ok(ms <= ceiling, `${name}: ${ms.toFixed(1)} ms of CPU, over the ${ceiling} ms ceiling (see tests/cpu-budget-admin.test.mjs)`);
}
