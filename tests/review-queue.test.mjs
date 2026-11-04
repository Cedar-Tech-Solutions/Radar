// The admin review queue (app/review-queue.ts): which deals belong in it, and the order it puts
// them in. The order is the whole feature - a queue that lists the right deals in the wrong order
// spends a reviewer's first hour on drafts nobody can see while a saved, stale deal stays wrong -
// so it is asserted case by case, and the SQL is run against the real schema built from
// drizzle/*.sql, so a renamed column or a retired status cannot quietly empty the queue.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REVIEW_QUEUE_SQL, buildReviewQueue, reviewReason, sourceKind } from "../app/review-queue.ts";
import { adminClientSource, adminSource } from "./source.mjs";

const row = (overrides) => ({
  id: "deal",
  restaurant: "Restaurant",
  title: "Happy hour",
  emoji: "🍺",
  city: "Ottawa",
  status: "live",
  verification_status: "needs_review",
  verified_at: "2026-09-01 12:00:00",
  created_at: "2026-09-01 12:00:00",
  source_url: "https://example.com/specials",
  website: "https://example.com/",
  saves: 0,
  clicks: 0,
  last_checked_at: null,
  covered: 1,
  ...overrides,
});

test("a source is the restaurant's own only on its own domain or a subdomain of it", () => {
  assert.equal(sourceKind("https://www.example.com/menu", "https://example.com/"), "own");
  assert.equal(sourceKind("https://menu.example.com/hh", "https://www.example.com"), "own");
  assert.equal(sourceKind("https://notexample.com/hh", "https://example.com"), "directory");
  assert.equal(sourceKind("https://www.yelp.com/biz/example", "https://example.com"), "directory");
  // No website on record: nothing can be called the restaurant's own.
  assert.equal(sourceKind("https://example.com/hh", null), "directory");
  assert.equal(sourceKind("", "https://example.com"), "none");
  assert.equal(sourceKind("not a url", "https://example.com"), "none");
});

test("a deal's reason follows its status and its check", () => {
  assert.equal(reviewReason({ status: "draft", verification_status: "verified" }), "draft");
  assert.equal(reviewReason({ status: "live", verification_status: "needs_review" }), "live_unchecked");
  assert.equal(reviewReason({ status: "live", verification_status: "verified" }), "live_stale");
  assert.equal(reviewReason({ status: "live", verification_status: "stale" }), "live_stale");
});

test("live deals come before drafts, and among them the ones people save and open", () => {
  const { items, counts } = buildReviewQueue([
    row({ id: "draft-own", status: "draft" }),
    row({ id: "quiet-unchecked" }),
    row({ id: "saved-stale", verification_status: "verified", saves: 4, last_checked_at: "2026-08-01 12:00:00" }),
    row({ id: "clicked-unchecked", clicks: 5 }),
  ]);
  // saved-stale: 4 saves x 3 = 12; clicked-unchecked: 5; quiet-unchecked: 0.
  assert.deepEqual(items.map((item) => item.id), ["saved-stale", "clicked-unchecked", "quiet-unchecked", "draft-own"]);
  assert.deepEqual(counts, { live_unchecked: 2, live_stale: 1, draft: 1 });
});

test("at equal attention a deal never checked goes ahead of one whose check aged, then the oldest claim", () => {
  const { items } = buildReviewQueue([
    row({ id: "stale-old", verification_status: "verified", last_checked_at: "2026-07-01 00:00:00" }),
    row({ id: "unchecked-new", created_at: "2026-09-20 00:00:00" }),
    row({ id: "unchecked-old", created_at: "2026-08-01 00:00:00" }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ["unchecked-old", "unchecked-new", "stale-old"]);
});

test("drafts in a tracked market come first, then those sourced on the restaurant's own site, then the oldest", () => {
  const { items } = buildReviewQueue([
    row({ id: "untracked-own", status: "draft", covered: 0 }),
    row({ id: "tracked-directory-old", status: "draft", source_url: "https://directory.example.org/x", created_at: "2026-08-01 00:00:00" }),
    row({ id: "tracked-own-new", status: "draft", created_at: "2026-09-30 00:00:00" }),
    row({ id: "tracked-own-old", status: "draft", created_at: "2026-09-01 00:00:00" }),
    row({ id: "tracked-none", status: "draft", source_url: null }),
  ]);
  assert.deepEqual(items.map((item) => item.id), ["tracked-own-old", "tracked-own-new", "tracked-directory-old", "tracked-none", "untracked-own"]);
});

test("an unchecked deal's verified_at is never read as a check; a verified one's is, when it has no event", () => {
  const { items } = buildReviewQueue([
    row({ id: "unchecked", verified_at: "2026-09-01 00:00:00" }),
    row({ id: "legacy-verified", verification_status: "verified", verified_at: "2026-06-01 00:00:00" }),
  ]);
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.equal(byId.unchecked.lastCheckedAt, null);
  assert.equal(byId["legacy-verified"].lastCheckedAt, "2026-06-01 00:00:00");
});

test("the limit applies per reason, so a filter still has rows while live deals fill the top", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row({ id: `live-${i}`, clicks: 10 - i })),
    ...Array.from({ length: 3 }, (_, i) => row({ id: `draft-${i}`, status: "draft", created_at: `2026-09-0${i + 1} 00:00:00` })),
  ];
  const { items, counts } = buildReviewQueue(rows, 2);
  assert.deepEqual(items.map((item) => item.id), ["live-0", "live-1", "draft-0", "draft-1"]);
  // The counts are the whole queue, not what was returned.
  assert.deepEqual(counts, { live_unchecked: 5, live_stale: 0, draft: 3 });
});

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

test("the queue's SQL reads the real schema and takes in exactly the deals that need someone", () => {
  const db = database();
  db.prepare("INSERT INTO restaurants(id,name,cuisine,website,country) VALUES('rq-r','RQ Bistro','Canadian','https://rq.example','CA')").run();
  db.prepare("INSERT INTO market_coverage(market,region,country,status) VALUES('RQ City','ON','CA','covered') ON CONFLICT(market) DO NOTHING").run();
  const deal = db.prepare(
    `INSERT INTO deals(id,restaurant,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url,active,status,verification_status,verified_at,restaurant_id,deleted_at,slug)
     VALUES(?,'RQ Bistro','Offer','Happy hour','Canadian','Daily 4-6 PM',?,'K1A','1 Main St','$5','🍺','https://rq.example/hh',?,?,?,?,'rq-r',?,?)`,
  );
  const ago = (days) => db.prepare(`SELECT datetime('now','-${days} days') t`).get().t;
  deal.run("rq-fresh", "RQ City", 1, "live", "verified", ago(3), null, "rq-fresh");
  deal.run("rq-stale", "RQ City", 1, "live", "verified", ago(45), null, "rq-stale");
  deal.run("rq-stored-stale", "RQ City", 1, "live", "stale", ago(10), null, "rq-stored-stale");
  deal.run("rq-unchecked", "Elsewhere", 1, "live", "needs_review", ago(1), null, "rq-unchecked");
  deal.run("rq-draft", "RQ City", 0, "draft", "needs_review", ago(1), null, "rq-draft");
  deal.run("rq-archived", "RQ City", 0, "archived", "needs_review", ago(90), null, "rq-archived");
  deal.run("rq-paused", "RQ City", 0, "paused", "verified", ago(90), null, "rq-paused");
  deal.run("rq-deleted", "RQ City", 0, "draft", "needs_review", ago(1), ago(1), "rq-deleted");
  db.prepare("INSERT INTO favorites(user_id,deal_id) VALUES('u1','rq-stale'),('u2','rq-stale')").run();
  db.prepare("INSERT INTO product_events(id,type,entity_id,created_at) VALUES('e1','deal_click','rq-unchecked',datetime('now','-2 days')),('e2','deal_click','rq-unchecked',datetime('now','-40 days')),('e3','search','rq-unchecked',datetime('now'))").run();
  db.prepare(`INSERT INTO verification_events(deal_id,status,method,source_url,verified_at) VALUES('rq-stale','verified','source_review','https://rq.example/hh','${ago(45)}')`).run();

  const rows = db.prepare(REVIEW_QUEUE_SQL).all().filter((r) => r.id.startsWith("rq-"));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["rq-draft", "rq-stale", "rq-stored-stale", "rq-unchecked"]);
  assert.equal(byId["rq-stale"].saves, 2);
  // Only deal_click events, and only the last 30 days of them.
  assert.equal(byId["rq-unchecked"].clicks, 1);
  assert.equal(byId["rq-stale"].last_checked_at, ago(45));
  assert.equal(byId["rq-stale"].website, "https://rq.example");
  assert.equal(Number(byId["rq-draft"].covered), 1);
  assert.equal(Number(byId["rq-unchecked"].covered), 0);

  const { items } = buildReviewQueue(rows);
  assert.deepEqual(items.map((item) => item.id), ["rq-stale", "rq-unchecked", "rq-stored-stale", "rq-draft"]);
  assert.equal(items[0].source, "own");
});

test("the workspace reads the server's ranked queue, not the loaded 500 rows", () => {
  const client = adminClientSource();
  const route = readFileSync(new URL("../app/api/admin/route.ts", import.meta.url), "utf8");
  assert.match(route, /const db = collectReads\(env\.DB\);/);
  assert.match(route, /db\.prepare\(REVIEW_QUEUE_SQL\)/);
  assert.match(route, /\(\) => buildReviewQueue\(reviewQueueRows\.results \|\| \[\]\)/);
  assert.match(route, /"reviewQueue":\$\{reviewQueueJson\}/);
  assert.match(client, /data\?\.reviewQueue\?\.items/);
  // The old client-side queue filtered data.deals, which stops at 500 rows and mixes in retired deals.
  assert.doesNotMatch(client, /const reviewQueue = useMemo/);
  // Quick verify records a check through the same action as the editor, gated the same way.
  const queue = client.slice(client.indexOf('className="quality-list review-list"'), client.indexOf('className="review-more"'));
  assert.match(queue, /action\(\{ action: "verify", id: item\.id \}\)/);
  assert.match(queue, /blocked=\{!canVerifyDeals \? [^}]* : !item\.sourceUrl \?/);
  assert.match(queue, /rel="noopener noreferrer"/);
  // "Open" deep-links the deal, so the inventory opens on it from a reload or a shared URL too.
  assert.match(queue, /openDeal\(item\.id, item\.title\)/);
  assert.match(client, /openTab\("deals", `\?deal=\$\{encodeURIComponent\(id\)\}`\)/);
});

test("the overview groups the queue by why each deal is in it, and says why on every row", () => {
  const overview = adminSource("tabs/OverviewTab.tsx");
  for (const reason of ["live_unchecked", "live_stale", "draft"]) assert.match(overview, new RegExp(`reason: "${reason}",\\s*title:`));
  assert.match(overview, /reviewItemReason\(item, now\)/);
  // Only roles that work on deals are sent the queue, so only they see the panel.
  assert.match(overview, /\{canWorkDeals && \(\s*<section className="portal-card quality-actions sw-ov-review"/);
});
