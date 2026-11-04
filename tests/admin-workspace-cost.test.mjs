// What one load of the staff workspace (GET /api/admin) reads.
//
// It used to read deal_schedules, deal_locations and deal_items whole on every load, every save
// (the client reloads after each) and every keystroke of the deal search. deal_locations still
// holds one row per branch behind the US chains, thousands of them, and parsing those took more CPU
// than a request is allowed, so staff got the runtime's error page. These pin the three reads to
// the deals on the page, keep chain-wide deals' branch rows out of the answer, and keep the deal
// search from running every other workspace read. The side queries run against the real schema
// built from drizzle/*.sql, so a renamed column fails here rather than in production.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const route = readFileSync(new URL("../app/api/admin/route.ts", import.meta.url), "utf8");
const getHandler = route.slice(route.indexOf("export async function GET("), route.indexOf("export async function POST("));
const readAdminDeals = route.slice(route.indexOf("async function readAdminDeals("), route.indexOf("export async function GET("));

function sideQuery(table) {
  const match = readAdminDeals.match(new RegExp(`"(SELECT [^"]*FROM ${table}[^"]*)"`));
  assert.ok(match, `expected readAdminDeals to read ${table}`);
  return match[1];
}

test("every side table is read for the deals on the page, not whole", () => {
  for (const table of ["deal_schedules", "deal_locations", "deal_items"]) {
    assert.match(sideQuery(table), /deal_id IN \(SELECT value FROM json_each\(\?\)\)/, `${table} is scoped to the page`);
    assert.doesNotMatch(getHandler, new RegExp(`FROM ${table} ORDER BY`), `GET no longer reads ${table} whole`);
  }
  assert.doesNotMatch(getHandler, /FROM deal_locations dl JOIN restaurant_locations l ON l\.id=dl\.location_id ORDER BY/);
});

test("chain-wide deals carry no branch rows into the workspace", () => {
  assert.match(readAdminDeals, /location_scope !== "brand" && deal\.location_scope !== "national"/);
  assert.match(readAdminDeals, /\.bind\(branchIds\)/, "deal_locations is read for the per-branch deals only");
});

test("the deal search answers with the deal list alone, before the rest of the workspace is read", () => {
  const early = getHandler.indexOf("if (dealConditions.length) return Response.json({ deals: await readAdminDeals(");
  assert.ok(early > 0, "expected the search to return early");
  assert.ok(early < getHandler.indexOf("await Promise.all(["), "and before the workspace reads");
});

test("reads the client never used are gone", () => {
  assert.doesNotMatch(getHandler, /FROM restaurant_locations ORDER BY city,address/);
  assert.doesNotMatch(getHandler, /FROM verification_events ORDER BY verified_at DESC LIMIT/);
  assert.doesNotMatch(getHandler, /FROM email_deliveries GROUP BY status/);
});

test("the side queries return only the requested deals' rows on the real schema", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  db.exec("INSERT INTO restaurants(id,name,cuisine,slug) VALUES('r1','Chain','Burgers','chain')");
  for (const n of [1, 2, 3]) {
    db.exec(`INSERT INTO restaurant_locations(id,restaurant_id,address,city,postal_prefix,timezone,slug) VALUES('l${n}','r1','${n} Main St','Ottawa','K1A','America/Toronto','chain-${n}')`);
  }
  for (const id of ["shown", "other"]) {
    db.exec(`INSERT INTO deals(id,slug,restaurant_id,location_id,restaurant,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url) VALUES('${id}','${id}','r1','l1','Chain','Deal','Food','Burgers','Mon 3-6 PM','Ottawa','K1A','1 Main St','$9','🍔','https://example.com')`);
    db.exec(`INSERT INTO deal_schedules(deal_id,display_text,timezone,days,start_time,end_time) VALUES('${id}','Mon 3-6 PM','America/Toronto','["mon"]','15:00','18:00')`);
    db.exec(`INSERT INTO deal_items(deal_id,name,discounted_price,sort_order) VALUES('${id}','Wings','$9',0)`);
  }
  for (const location of ["l1", "l2", "l3"]) {
    db.exec(`INSERT INTO deal_locations(deal_id,location_id,eligibility) VALUES('shown','${location}','confirmed'),('other','${location}','confirmed')`);
  }
  const page = JSON.stringify(["shown"]);
  for (const table of ["deal_schedules", "deal_locations", "deal_items"]) {
    const rows = db.prepare(sideQuery(table)).all(page);
    assert.ok(rows.length > 0, `${table} returns the page's rows`);
    assert.ok(rows.every((row) => row.deal_id === "shown"), `${table} returns nothing for a deal not on the page`);
    assert.equal(db.prepare(sideQuery(table)).all("[]").length, 0, `${table} with no deals reads nothing`);
  }
  assert.equal(db.prepare(sideQuery("deal_locations")).all(page).length, 3);
});

// The kept parts (workspaceParts in the route): the heaviest lists, kept per isolate as the strings
// they were sent, under the change counters of the tables each is built from.
const partsCache = route.slice(route.indexOf("const PART_MAX_AGE_MS"), route.indexOf("export async function GET("));
const postHandler = route.slice(route.indexOf("export async function POST("));

function workspaceParts() {
  const table = partsCache.slice(partsCache.indexOf("const WORKSPACE_PARTS = {"), partsCache.indexOf("} as const"));
  const parts = new Map();
  for (const match of table.matchAll(/^\s+(\w+): \{ tables: \[([^\]]*)\]/gm)) {
    parts.set(match[1], [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
  }
  assert.ok(parts.size >= 7, `expected the workspace's parts, got ${[...parts.keys()].join(", ")}`);
  return parts;
}

test("a workspace load takes every heavy list from the kept parts", () => {
  const parts = workspaceParts();
  for (const name of ["deals", "drinkRuleAlerts", "draftReview", "reviewQueue", "restaurants", "staffReminders", "coverageTree"]) {
    assert.ok(parts.has(name), `${name} is a kept part`);
    assert.match(getHandler, new RegExp(`wanted\\("${name}"`), `${name} is read only when its kept copy is out of date`);
    assert.match(getHandler, new RegExp(`part\\("${name}"`), `${name} is sent from its kept copy`);
  }
  assert.match(getHandler, /`\{"deals":\$\{dealsJson\},"drinkRuleAlerts":\$\{drinkRuleAlertsJson\},"draftReview":\$\{draftReviewJson\},"reviewQueue":\$\{reviewQueueJson\},"restaurants":\$\{restaurantsJson\},"staffReminders":\$\{staffRemindersJson\},"coverageTree":\$\{coverageTreeJson\},\$\{rest\.slice\(1\)\}`/);
});

test("the counters are read before the parts, so a copy is never older than its key", () => {
  const counters = getHandler.indexOf("await readChangeCounters(db)");
  assert.ok(counters > 0 && counters < getHandler.indexOf("await Promise.all(["), "readChangeCounters runs first, on its own");
  assert.match(partsCache, /kept\.counters === key && now - kept\.readAt < WORKSPACE_PARTS\[name\]\.maxAgeMs/, "reused only under the same counters, and never past the max age");
  assert.match(partsCache, /if \(n === undefined\) return null;/, "a table with no counter keeps nothing");
});

// Every read goes through app/d1-reads.ts, which sends the statements issued together as one
// batch: a load used to be sixty-odd D1 statements, each a subrequest of the fifty a Worker on the
// free plan may make in one invocation.
test("the workspace reads D1 through the batching collector", () => {
  assert.match(getHandler, /const db = collectReads\(env\.DB\);/);
  const loadOnly = getHandler.slice(0, getHandler.indexOf("async function handleHasHistory("));
  assert.doesNotMatch(loadOnly, /env\.DB\.prepare\(/, "no read goes out on its own");
  for (const helper of ["async function buildCreatorRoster(", "async function buildGrowthMetrics(", "async function readAdminDeals("]) {
    const body = route.slice(route.indexOf(helper), route.indexOf("\n}\n", route.indexOf(helper)));
    assert.doesNotMatch(body, /env\.DB\.prepare\(/, `${helper} reads through the collector it is handed`);
  }
});

function freshSchema() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

// What makes the counters the truth: a trigger on every write to every table a part reads. A write
// path a counter does not see - the sponsored flag and a status change leave updated_at alone,
// which is why the old fingerprint read the audit log - would leave a kept part stale for its max
// age. An insert, an update and a delete each move the table's counter on the real schema.
test("every table a part is built from is counted on every write", () => {
  const db = freshSchema();
  const counter = (table) => db.prepare("SELECT n FROM data_changes WHERE name=?").get(table)?.n;
  const seed = {
    restaurants: () => db.exec("INSERT INTO restaurants(id,name,cuisine,slug) VALUES('r1','Chain','Burgers','chain')"),
    restaurant_locations: () => db.exec("INSERT INTO restaurant_locations(id,restaurant_id,address,city,postal_prefix,timezone,slug) VALUES('l1','r1','1 Main St','Ottawa','K1A','America/Toronto','chain-1')"),
    deals: () => db.exec("INSERT INTO deals(id,slug,restaurant_id,location_id,restaurant,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url) VALUES('d1','d1','r1','l1','Chain','Deal','Food','Burgers','Mon 3-6 PM','Ottawa','K1A','1 Main St','$9','🍔','https://example.com')"),
    deal_locations: () => db.exec("INSERT INTO deal_locations(deal_id,location_id,eligibility) VALUES('d1','l1','confirmed')"),
    deal_schedules: () => db.exec("INSERT INTO deal_schedules(deal_id,display_text,timezone,days,start_time,end_time) VALUES('d1','Mon 3-6 PM','America/Toronto','[\"mon\"]','15:00','18:00')"),
    deal_items: () => db.exec("INSERT INTO deal_items(deal_id,name,discounted_price,sort_order) VALUES('d1','Wings','$9',0)"),
    search_terms: () => db.exec("INSERT INTO search_terms(entity_type,entity_id,term,weight,source) VALUES('deal','d1','wings',1,'curated')"),
    verification_events: () => db.exec("INSERT INTO verification_events(deal_id,status,method,source_url,verified_by) VALUES('d1','verified','source','https://example.com','u')"),
    staff_reminders: () => db.exec("INSERT INTO staff_reminders(id,kind,deal_id,basis,details) VALUES('s1','new_draft','d1','research','{}')"),
    market_coverage: () => db.exec("INSERT INTO market_coverage(market,region,country,status,minimum_offers) VALUES('Testville','ON','CA','covered',3)"),
    favorites: () => db.exec("INSERT INTO favorites(user_id,deal_id) VALUES('u1','d1')"),
  };
  const touch = {
    restaurants: () => db.exec("UPDATE restaurants SET name='Chain!' WHERE id='r1'"),
    restaurant_locations: () => db.exec("UPDATE restaurant_locations SET city='Gatineau' WHERE id='l1'"),
    // The writes the old fingerprint could not see: a status change, a verification, the sponsored flag.
    deals: () => { db.exec("UPDATE deals SET status='paused',active=0 WHERE id='d1'"); db.exec("UPDATE deals SET sponsored=1 WHERE id='d1'"); },
    deal_locations: () => db.exec("UPDATE deal_locations SET eligibility='excluded' WHERE deal_id='d1'"),
    deal_schedules: () => db.exec("UPDATE deal_schedules SET end_time='19:00' WHERE deal_id='d1'"),
    deal_items: () => db.exec("UPDATE deal_items SET name='Wings!' WHERE deal_id='d1'"),
    search_terms: () => db.exec("UPDATE search_terms SET weight=2 WHERE entity_id='d1'"),
    verification_events: () => db.exec("UPDATE verification_events SET notes='x' WHERE deal_id='d1'"),
    staff_reminders: () => db.exec("UPDATE staff_reminders SET status='done' WHERE id='s1'"),
    market_coverage: () => db.exec("UPDATE market_coverage SET status='limited' WHERE market='Testville'"),
    favorites: () => {},
  };
  const remove = {
    favorites: () => db.exec("DELETE FROM favorites WHERE deal_id='d1'"),
    staff_reminders: () => db.exec("DELETE FROM staff_reminders WHERE id='s1'"),
    verification_events: () => db.exec("DELETE FROM verification_events WHERE deal_id='d1'"),
    deal_items: () => db.exec("DELETE FROM deal_items WHERE deal_id='d1'"),
    search_terms: () => db.exec("DELETE FROM search_terms WHERE entity_id='d1'"),
    deal_schedules: () => db.exec("DELETE FROM deal_schedules WHERE deal_id='d1'"),
    deal_locations: () => db.exec("DELETE FROM deal_locations WHERE deal_id='d1'"),
    market_coverage: () => db.exec("DELETE FROM market_coverage WHERE market='Testville'"),
    deals: () => db.exec("DELETE FROM deals WHERE id='d1'"),
    restaurant_locations: () => db.exec("DELETE FROM restaurant_locations WHERE id='l1'"),
    restaurants: () => db.exec("DELETE FROM restaurants WHERE id='r1'"),
  };
  const tables = new Set([...workspaceParts().values()].flat());
  for (const table of tables) assert.ok(table in seed, `this test knows how to write ${table}`);
  const moved = (table, write, what) => {
    const before = counter(table);
    assert.ok(Number.isInteger(before), `${table} has a counter`);
    write();
    assert.ok(counter(table) > before, `${what} ${table} moves its counter`);
  };
  for (const table of Object.keys(seed)) moved(table, seed[table], "an insert into");
  for (const table of Object.keys(touch)) if (table !== "favorites") moved(table, touch[table], "an update to");
  for (const table of Object.keys(remove)) moved(table, remove[table], "a delete from");
});

test("a workspace action moves a counter, and the reload that follows rebuilds only what it touched", () => {
  assert.doesNotMatch(postHandler, /forgetAdminCatalog\(\)/, "nothing is dropped blind before a write any more");
  const parts = workspaceParts();
  // A reminder marked done is a staff_reminders write: the reminders and the draft review (which
  // carries each draft's research note) are rebuilt; the inventory is not.
  const feeds = (table) => [...parts].filter(([, tables]) => tables.includes(table)).map(([name]) => name).sort();
  assert.deepEqual(feeds("staff_reminders"), ["draftReview", "staffReminders"]);
  assert.deepEqual(feeds("favorites"), ["reviewQueue"]);
  assert.ok(!parts.get("reviewQueue").includes("product_events"), "clicks never wait on a counter; the queue is refreshed by time");
  assert.match(partsCache, /reviewQueue: \{ tables: \[[^\]]*\], maxAgeMs: REVIEW_QUEUE_MAX_AGE_MS \}/);
});
