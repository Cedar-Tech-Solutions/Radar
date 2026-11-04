import { env } from "cloudflare:workers";
import { canAdminister, getAppUser, hasPermission, isProtectedOwner, type AppUser, type Permission } from "../../auth";
import { apiError, cleanText, normalizedPostal, readJson, requireSameOrigin, validHttpUrl, validPostal } from "../../api-utils";
import { buildCreatorDecisionEmail, escapeHtml, pilotGatesOpen, pilotReadiness, sendEmail, signEmailAction } from "../../email";
import { ACTION_PERMISSIONS, ALL_PERMISSIONS, ALL_ROLES, ASSIGNABLE_ROLES, FIXED_PERMISSION_ROLES, formatRole, isWorkspaceRole, needsOwnerApproval, roleMayHold } from "../../permissions";
import { canonicalCity, fallbackForPostal, geocodePostal } from "../../geocode";
import { resolvePlan } from "../../apple-entitlement";
import { paidForPredicate } from "../../plan-resolution";
import { SETTINGS, isSettingKey, readSettings, writeSetting } from "../../settings";
import { isKnownCuisine } from "../../cuisines";
import { slugify } from "../../slug";
import { narrowPriceTier } from "../../price-tiers";
import { classifyServiceStyle, dealCopyForServiceStyle, type ServiceStyle } from "../../service-style";
import { requestPayout } from "../../affiliate-payouts";
import { normalizeReferralCode, resolveReferralCode } from "../../referral-code";
import { resolveRejectionReason } from "../../suggestion-review";
import { REVIEW_QUEUE_SQL, buildReviewQueue, type ReviewQueueRow } from "../../review-queue";
import { collectReads, type CollectedReads } from "../../d1-reads";
import { CLEAR_STAFF_REMINDERS_SQL, OPEN_STAFF_REMINDERS_SQL, type StaffReminder } from "../../staff-reminders";
import {
  DRAFT_ARCHIVE_SQL, DRAFT_AUDIT_SQL, DRAFT_BATCH_READ_SQL, DRAFT_CONFIRM_LOCATIONS_SQL, DRAFT_INSERT_SCHEDULES_SQL,
  DRAFT_PUBLISH_SQL, DRAFT_REVIEW_SQL, DRAFT_VERIFY_EVENTS_SQL, MAX_DRAFT_BATCH, parseDraftBatchItems, planDraftPublish,
  type DraftBatchRow, type DraftReviewRow,
} from "../../draft-review";
import {
  DRINK_RULE_DEAL_SQL, DRINK_RULE_LIVE_SQL, blockingDrinkIssues, buildDrinkRuleAlerts, describeDrinkIssues, drinkIssuesForRow,
  type DrinkRuleDeal, type DrinkRuleRow,
} from "../../drink-rules";

interface AdminDealRow {
  id: string;
  restaurant: string;
  title: string;
  category: string;
  cuisine: string;
  schedule: string;
  city: string;
  postal_prefix: string;
  address: string;
  price: string;
  price_tier: number | null;
  emoji: string;
  source_url: string;
  sponsored: number;
  active: number;
  verified_at: string;
  restaurant_id: string | null;
  location_id: string | null;
  status: string;
  publish_at: string | null;
  expires_at: string | null;
  terms: string | null;
  restrictions: string | null;
  internal_notes: string | null;
  verification_status: string;
  deleted_at: string | null;
  slug: string | null;
  description: string | null;
  locale: string;
  discount_percent: number | null;
  savings_cents: number | null;
  updated_at: string;
  /** 'brand' or 'national' for a chain-wide offer (drizzle/0049, 0050), whose deal_locations rows
   * nothing reads; NULL for a deal decided branch by branch. */
  location_scope: string | null;
  canonical_restaurant: string | null;
  // The restaurant's service_style, not the deal's - the deal editor shows and edits it
  // because that editor is where restaurants get created. See save_deal below.
  service_style: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  verification_count: number;
  curated_keywords: string | null;
  /** The restaurant's own search terms (entity_type 'restaurant'), which search adds to every deal
   * of the restaurant. Shown read-only: the deal editor saves only the deal's own. */
  restaurant_keywords: string | null;
  schedules: number;
  confirmed_locations: number;
  full_postal: string | null;
  schedule_days: string | null;
  schedule_start: string | null;
  schedule_end: string | null;
  schedule_windows?: { days: string[]; start_time: string; end_time: string }[];
  locations?: { id: string; address: string; city: string; postal_prefix: string; full_postal: string | null; eligibility: string }[];
  items?: { id: number; name: string; original_price: string | null; discounted_price: string }[];
}

interface MarketCoverageRow {
  market: string;
  region: string;
  country: string;
  status: string;
  minimum_offers: number;
  notes: string | null;
  updated_at: string;
}

// Exact catalog-wide counts for the overview, independent of the deal list's row limit.
interface DealTotals {
  total: number;
  live: number;
  draft: number;
  scheduled: number;
  paused: number;
  expired: number;
  archived: number;
  unverified: number;
  stale: number;
  expiring: number;
}

// Exact user/subscription counts for the Growth tab, independent of the users list's row limit.
interface UserTotals {
  total: number;
  pro_paying: number;
  pro_not_paying: number;
  pro_trialing: number;
  pro_past_due: number;
  pro_canceled: number;
}

interface DealActionInput {
  id?: unknown;
  restaurant?: unknown;
  title?: unknown;
  category?: unknown;
  cuisine?: unknown;
  schedule?: unknown;
  city?: unknown;
  postal_prefix?: unknown;
  address?: unknown;
  price?: unknown;
  price_tier?: unknown;
  service_style?: unknown;
  emoji?: unknown;
  source_url?: unknown;
  sponsored?: unknown;
  status?: unknown;
  publish_at?: unknown;
  expires_at?: unknown;
  terms?: unknown;
  restrictions?: unknown;
  internal_notes?: unknown;
  restaurant_id?: unknown;
  location_id?: unknown;
  slug?: unknown;
  curated_keywords?: unknown;
  keywords?: unknown;
  locale?: unknown;
  days?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  schedule_windows?: unknown;
  locations?: unknown;
  items?: unknown;
}

/**
 * Tells an applicant what was decided, and never gets in the way of the decision.
 *
 * Returns a warning string instead of throwing, because every reason this can fail — the kill
 * switch is on, Resend is not configured, the address bounced — is a reason to tell the reviewer
 * "approved, but they were not emailed" rather than to undo an approval that is already correct
 * in the database. Saying so by hand is a fallback that always works; a rolled-back role change
 * is not.
 */
async function notifyCreatorDecision(input: { email: string; approved: boolean; handle: string; reason: string | null; rateBps: number; origin: string }) {
  const { email, approved, handle, reason, rateBps, origin } = input;
  try {
    const message = buildCreatorDecisionEmail({
      approved,
      handle,
      link: `${origin}/?c=${handle}`,
      // A trailing ".00" reads as a rounding artefact on a rate someone is paid from; whole
      // percentages are the normal case and should look like one.
      ratePercent: (rateBps / 100).toFixed(rateBps % 100 ? 2 : 0),
      reason,
      workspaceUrl: `${origin}/creator`,
    });
    await sendEmail({
      to: email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tag: "creator_decision",
      metadata: { decision: approved ? "approved" : "rejected" },
      audience: "transactional",
    });
    return null;
  } catch {
    return `The decision was saved, but the notification email could not be sent to ${email}.`;
  }
}

/**
 * One row per creator, with everything needed to answer "how is this person doing" in one place.
 *
 * Deliberately not folded into the big Promise.all above. That array is matched to its
 * destructuring by position and nothing checks the pairing — which has already gone wrong once —
 * so five more entries in it is five more chances to silently hand the wrong rows to the wrong
 * name. These run on their own, only for someone who can see the tab.
 *
 * Grouped in SQL rather than per creator, so product_events is scanned once instead of once per
 * handle. The money stays split by currency for the same reason it is everywhere else: Radar Pro
 * is sold in several and a single total across them would be a number that is wrong in all of them.
 */
async function buildCreatorRoster(db: CollectedReads) {
  const [profiles, visits, signups, money, campaigns, picks] = await Promise.all([
    db.prepare("SELECT user_id,handle,display_name,status,commission_rate_bps FROM creator_profiles ORDER BY handle")
      .all<{ user_id: string; handle: string; display_name: string | null; status: string; commission_rate_bps: number }>(),
    db.prepare(
      `SELECT json_extract(properties,'$.creator') handle,COUNT(*) visits,
              COALESCE(SUM(created_at>=datetime('now','-30 days')),0) visits30
         FROM product_events
        WHERE type='campaign_visit' AND json_extract(properties,'$.creator') IS NOT NULL
        GROUP BY handle`,
    ).all<{ handle: string; visits: number; visits30: number }>(),
    db.prepare("SELECT referred_by handle,COUNT(*) signups FROM users WHERE referred_by IS NOT NULL GROUP BY referred_by")
      .all<{ handle: string; signups: number }>(),
    db.prepare(
      `SELECT handle,currency,COUNT(*) invoices,
              COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END),0) owed,
              COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) paid
         FROM creator_commissions GROUP BY handle,currency`,
    ).all<{ handle: string; currency: string; invoices: number; owed: number; paid: number }>(),
    // The per-video breakdown. Visits and subscriptions for one label have to come from two
    // different tables, so they are unioned into one shape here rather than joined — a campaign
    // that brought visits and no subscribers still has to appear, and so does the reverse.
    db.prepare(
      `SELECT handle,campaign,SUM(visits) visits,SUM(subscriptions) subscriptions,SUM(earned) earned,MAX(currency) currency FROM (
         SELECT json_extract(properties,'$.creator') handle,json_extract(properties,'$.creatorCampaign') campaign,
                COUNT(*) visits,0 subscriptions,0 earned,NULL currency
           FROM product_events
          WHERE type='campaign_visit' AND json_extract(properties,'$.creatorCampaign') IS NOT NULL
          GROUP BY handle,campaign
         UNION ALL
         SELECT handle,campaign,0 visits,COUNT(*) subscriptions,
                COALESCE(SUM(CASE WHEN status<>'void' THEN commission_amount ELSE 0 END),0) earned,currency
           FROM creator_commissions WHERE campaign IS NOT NULL GROUP BY handle,campaign,currency
       ) GROUP BY handle,campaign ORDER BY visits DESC`,
    ).all<{ handle: string; campaign: string; visits: number; subscriptions: number; earned: number; currency: string | null }>(),
    // Every pick with the creator's own line, because a note is third-party copy published under
    // Radar's name on a page Radar serves. Staff need to be able to read what is out there
    // without going creator by creator, and to take one down. LEFT JOIN so a pick pointing at a
    // pulled deal still appears here - that is precisely the row somebody may want to remove.
    db.prepare(
      `SELECT p.handle,p.deal_id,p.note,p.position,p.created_at,d.restaurant,d.title,d.status,d.active,d.deleted_at
         FROM creator_picks p LEFT JOIN deals d ON d.id=p.deal_id
        ORDER BY p.handle,p.position`,
    ).all<{ handle: string; deal_id: string; note: string | null; position: number; created_at: string; restaurant: string | null; title: string | null; status: string | null; active: number | null; deleted_at: string | null }>(),
  ]);

  const visitsBy = new Map((visits.results || []).map((row) => [row.handle, row]));
  const signupsBy = new Map((signups.results || []).map((row) => [row.handle, row.signups]));
  const moneyBy = new Map<string, Array<{ currency: string; invoices: number; owed: number; paid: number }>>();
  for (const row of money.results || []) {
    const list = moneyBy.get(row.handle) || [];
    list.push({ currency: row.currency, invoices: row.invoices, owed: row.owed, paid: row.paid });
    moneyBy.set(row.handle, list);
  }
  const picksBy = new Map<string, Array<Record<string, unknown>>>();
  for (const row of picks.results || []) {
    const list = picksBy.get(row.handle) || [];
    list.push({ ...row, live: row.deleted_at === null && row.status === "live" && Number(row.active) === 1 });
    picksBy.set(row.handle, list);
  }
  const campaignsBy = new Map<string, Array<{ campaign: string; visits: number; subscriptions: number; earned: number; currency: string | null }>>();
  for (const row of campaigns.results || []) {
    const list = campaignsBy.get(row.handle) || [];
    list.push({ campaign: row.campaign, visits: row.visits, subscriptions: row.subscriptions, earned: row.earned, currency: row.currency });
    campaignsBy.set(row.handle, list);
  }

  return (profiles.results || []).map((profile) => ({
    ...profile,
    visits: visitsBy.get(profile.handle)?.visits || 0,
    visits30: visitsBy.get(profile.handle)?.visits30 || 0,
    signups: signupsBy.get(profile.handle) || 0,
    money: moneyBy.get(profile.handle) || [],
    campaigns: campaignsBy.get(profile.handle) || [],
    picks: picksBy.get(profile.handle) || [],
  }));
}

/**
 * The money figures: revenue, subscriber movement, the affiliate ledger, cancellations, retention
 * and comps. Rendered by the finance panels (app/(operator)/admin/FinancePanels.tsx) and read only
 * for manage_finance.
 *
 * The anonymous product figures that used to share this builder - deal views and offers, quiet
 * inventory, search demand, page views - moved to GET /api/admin/growth, which reads them for the
 * 7, 30 or 90 days the Growth section asks for, when it is opened, instead of on every workspace
 * load for every role.
 *
 * Kept out of the big positional Promise.all in GET for the same reason buildCreatorRoster is -
 * that array is matched to its destructuring by position, nothing checks the pairing, and it has
 * already handed the wrong rows to the wrong name once.
 *
 * `canSeeMoney` is still checked here although the caller only asks with manage_finance: the
 * gate sits beside the queries it protects, so a new call site cannot leak them by forgetting.
 *
 * Every money figure stays split by currency. Radar Pro is sold in several and a single total
 * across them is a number that is wrong in all of them.
 */
async function buildGrowthMetrics(db: CollectedReads, canSeeMoney: boolean) {
  const money = <T,>(run: () => Promise<{ results: T[] }>) => (canSeeMoney ? run() : Promise.resolve({ results: [] as T[] }));
  const [
    revenue,
    revenueTrend,
    subscriptionTrend,
    subscriptionTotals,
    affiliate,
    commissionTotals,
    churnReasons,
    churnNotes,
    activeGrants,
    saveOffers,
    lifecycleTotals,
  ] = await Promise.all([
    // Money actually collected, from the invoice_paid events the Stripe webhook writes. Not
    // derived from a headcount: the users table cannot tell a monthly subscriber from an annual
    // one, so any figure built from it would be wrong for every yearly plan.
    money(() => db.prepare(
      `SELECT json_extract(properties,'$.currency') currency,COUNT(*) invoices,
              COALESCE(SUM(json_extract(properties,'$.amount')),0) total,
              COALESCE(SUM(CASE WHEN created_at>=datetime('now','-30 days') THEN json_extract(properties,'$.amount') ELSE 0 END),0) last30
         FROM product_events WHERE type='invoice_paid' GROUP BY currency ORDER BY total DESC`,
    ).all<{ currency: string; invoices: number; total: number; last30: number }>()),
    // `invoices` is what the finance panel charts (one line per day, any currency); without it
    // the "Invoices paid" sparkline summed undefined and drew nothing.
    money(() => db.prepare(
      `SELECT date(created_at) day,json_extract(properties,'$.currency') currency,
              COALESCE(SUM(json_extract(properties,'$.amount')),0) amount,COUNT(*) invoices
         FROM product_events WHERE type='invoice_paid' AND created_at>=datetime('now','-30 days')
        GROUP BY day,currency ORDER BY day`,
    ).all<{ day: string; currency: string; amount: number; invoices: number }>()),
    money(() => db.prepare(
      `SELECT type,date(created_at) day,COUNT(*) count
         FROM product_events
        WHERE type IN ('subscription_started','subscription_canceled') AND created_at>=datetime('now','-30 days')
        GROUP BY type,day ORDER BY day`,
    ).all<{ type: string; day: string; count: number }>()),
    money(() => db.prepare(
      `SELECT COALESCE(SUM(type='subscription_started'),0) started,
              COALESCE(SUM(type='subscription_canceled'),0) canceled,
              COALESCE(SUM(type='subscription_started' AND created_at>=datetime('now','-30 days')),0) started30,
              COALESCE(SUM(type='subscription_canceled' AND created_at>=datetime('now','-30 days')),0) canceled30
         FROM product_events WHERE type IN ('subscription_started','subscription_canceled')`,
    ).all<{ started: number; canceled: number; started30: number; canceled30: number }>()),
    // The affiliate program in one row. referred_pro is the number that matters: signups a
    // creator brought are interesting, signups that went on to pay are the deal working. A comp
    // is not one of those, so it asks who is paying (paidForPredicate) and not only who has Pro.
    money(() => db.prepare(
      `SELECT (SELECT COUNT(*) FROM creator_profiles) creators,
              (SELECT COUNT(*) FROM creator_profiles WHERE status='active') active_creators,
              (SELECT COUNT(*) FROM creator_applications WHERE status='pending') pending_applications,
              (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL) referred_users,
              (SELECT COUNT(*) FROM users WHERE referred_by IS NOT NULL AND plan='pro' AND plan_status IN ('active','trialing') AND ${paidForPredicate}) referred_pro,
              (SELECT COUNT(DISTINCT json_extract(properties,'$.creatorCampaign')) FROM product_events
                WHERE type='campaign_visit' AND json_extract(properties,'$.creatorCampaign') IS NOT NULL) campaigns`,
    ).all<{ creators: number; active_creators: number; pending_applications: number; referred_users: number; referred_pro: number; campaigns: number }>()),
    // Program-wide payables, as a total rather than the per-handle split the roster already
    // carries. `gross` is what those invoices were worth to Radar, so the two can be read against
    // each other - what the program cost, next to what it brought in.
    money(() => db.prepare(
      `SELECT currency,COUNT(*) invoices,
              COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END),0) pending,
              COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END),0) paid,
              COALESCE(SUM(CASE WHEN status='void' THEN commission_amount ELSE 0 END),0) voided,
              COALESCE(SUM(CASE WHEN status<>'void' THEN gross_amount ELSE 0 END),0) gross
         FROM creator_commissions GROUP BY currency`,
    ).all<{ currency: string; invoices: number; pending: number; paid: number; voided: number; gross: number }>()),
    // Why people said they were leaving. `while_failing` separates the answers given by somebody
    // whose card had already been declined: those are usually a billing problem wearing a
    // cancellation's clothes, and counting them as "too expensive" would point at the wrong fix.
    money(() => db.prepare(
      `SELECT reason,COUNT(*) total,
              COALESCE(SUM(plan_status='past_due'),0) while_failing,
              MAX(created_at) last_seen
         FROM cancellation_reasons GROUP BY reason ORDER BY total DESC`,
    ).all<{ reason: string; total: number; while_failing: number; last_seen: string }>()),
    // The free-text half, most recent first. Read by a person, never grouped.
    money(() => db.prepare(
      `SELECT reason,detail,created_at FROM cancellation_reasons
        WHERE detail IS NOT NULL AND detail<>'' ORDER BY created_at DESC LIMIT 20`,
    ).all<{ reason: string; detail: string; created_at: string }>()),
    // Comped accounts, so "who has Pro without paying for it" has an answer on the same screen.
    // Only grants still in force: one past its date gives nothing (the billing job has taken the
    // Pro back), and it stays unrevoked, since nobody revoked it.
    money(() => db.prepare(
      `SELECT g.id,g.user_id,u.email,g.reason,g.expires_at,g.created_at
         FROM plan_grants g JOIN users u ON u.id=g.user_id
        WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at >= date('now'))
        ORDER BY g.created_at DESC LIMIT 25`,
    ).all<{ id: number; user_id: string; email: string; reason: string; expires_at: string | null; created_at: string }>()),
    // Did the offer work? Grouped by reason and offer, because the answer differs by both: a pause
    // offered to somebody who said "taking a break" is a very different proposition from the same
    // pause offered to somebody who said "too expensive".
    money(() => db.prepare(
      `SELECT reason,offer,COUNT(*) offered,COALESCE(SUM(accepted),0) accepted
         FROM save_offers GROUP BY reason,offer ORDER BY offered DESC`,
    ).all<{ reason: string; offer: string; offered: number; accepted: number }>()),
    // The state of the book right now: who is paused, who is on trial, who is inside their payment
    // grace period. Three numbers that are each a different kind of "not currently paying".
    money(() => db.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE paused_until IS NOT NULL AND paused_until > datetime('now')) paused,
              (SELECT COUNT(*) FROM users WHERE plan_status='trialing') trialing,
              (SELECT COUNT(*) FROM users WHERE trial_used=1) trials_started,
              (SELECT COUNT(*) FROM users WHERE plan_status='past_due') in_grace,
              (SELECT COUNT(*) FROM users WHERE winback_sent_at IS NOT NULL) winbacks_sent`,
    ).all<{ paused: number; trialing: number; trials_started: number; in_grace: number; winbacks_sent: number }>()),
  ]);

  const subscriptionRows = subscriptionTrend.results || [];
  return {
    revenue: {
      byCurrency: revenue.results || [],
      trend: revenueTrend.results || [],
    },
    subscriptions: {
      totals: subscriptionTotals.results?.[0] || { started: 0, canceled: 0, started30: 0, canceled30: 0 },
      started: subscriptionRows.filter((row) => row.type === "subscription_started").map(({ day, count }) => ({ day, count })),
      canceled: subscriptionRows.filter((row) => row.type === "subscription_canceled").map(({ day, count }) => ({ day, count })),
    },
    affiliate: {
      totals: affiliate.results?.[0] || { creators: 0, active_creators: 0, pending_applications: 0, referred_users: 0, referred_pro: 0, campaigns: 0 },
      commissions: commissionTotals.results || [],
    },
    churn: {
      reasons: churnReasons.results || [],
      notes: churnNotes.results || [],
    },
    grants: activeGrants.results || [],
    lifecycle: {
      totals: lifecycleTotals.results?.[0] || { paused: 0, trialing: 0, trials_started: 0, in_grace: 0, winbacks_sent: 0 },
      saveOffers: saveOffers.results || [],
    },
  };
}

type ScheduleWindowInput = { days: string[]; start_time: string; end_time: string };
// A deal can have more than one time window in a day ("3-6 PM & 9 PM-close") — deal_schedules
// has always supported multiple rows per deal, but save_deal used to only ever manage one.
// schedule_windows (a real array) is the current contract; a lone days/start_time/end_time
// triple is kept as a fallback so nothing sending the old shape breaks mid-rollout.
function parseScheduleWindows(d: DealActionInput): ScheduleWindowInput[] {
  if (Array.isArray(d.schedule_windows) && d.schedule_windows.length) {
    return d.schedule_windows
      .map((w) => {
        const row = w as { days?: unknown; start_time?: unknown; end_time?: unknown };
        const days = (Array.isArray(row.days) ? row.days : []).filter((day): day is string => typeof day === "string" && (DAY_ORDER as readonly string[]).includes(day));
        return { days, start_time: cleanText(row.start_time,5), end_time: cleanText(row.end_time,5) };
      })
      .filter((w) => w.days.length && w.start_time && w.end_time);
  }
  const days = (Array.isArray(d.days) ? d.days : []).filter((day): day is string => typeof day === "string" && (DAY_ORDER as readonly string[]).includes(day));
  const start_time = cleanText(d.start_time,5);
  const end_time = cleanText(d.end_time,5);
  return days.length && start_time && end_time ? [{ days, start_time, end_time }] : [];
}

type LocationInput = { id: string; address: string; city: string; postal: string };
// A deal can now have more than one location (chains, or any restaurant with multiple
// branches offering the same deal) — `locations` is the current contract; a lone
// address/city/postal_prefix/location_id on the deal itself is kept as a fallback so a
// caller that hasn't been updated to send the new array (e.g. a quick-action row button
// resending an already-loaded deal) still saves its single location exactly as before.
//
// The city goes through canonicalCity because the editor's city box is free text, and a city
// copied off a restaurant's own site arrives as "Austin, TX" about as readily as "Austin". The
// province or state is not lost by stripping it: it is geocoded from the postal code a few lines
// down and stored in the location's own `region` column, which is where every reader looks for it.
// Left in the city string it does not read as extra detail, it reads as a different city — one
// more chip on the filters and one more place in the app's picker. See 0033.
function parseLocationInputs(d: DealActionInput): LocationInput[] {
  if (Array.isArray(d.locations) && d.locations.length) {
    return d.locations
      .map((entry) => {
        const row = entry as { id?: unknown; address?: unknown; city?: unknown; postal?: unknown };
        return { id: cleanText(row.id,140), address: cleanText(row.address,240), city: canonicalCity(cleanText(row.city,100)), postal: cleanText(row.postal,20) };
      })
      .filter((row) => row.address && row.city && row.postal);
  }
  return [{ id: cleanText(d.location_id,140), address: cleanText(d.address,240), city: canonicalCity(cleanText(d.city,100)), postal: cleanText(d.postal_prefix,20) }];
}

type ItemInput = { name: string; original_price: string; discounted_price: string };
// The line items making up a deal ("Nachos: was $14, now $9") — optional and unbounded, unlike
// locations/schedule windows there's no legacy singular fallback to support since this is a new
// field. A row needs a name and the discounted price to mean anything; the original price is
// optional (staff may not always know or want to show a "was" price).
function parseDealItems(d: DealActionInput): ItemInput[] {
  if (!Array.isArray(d.items)) return [];
  return d.items
    .map((entry) => {
      const row = entry as { name?: unknown; original_price?: unknown; discounted_price?: unknown };
      return { name: cleanText(row.name,120), original_price: cleanText(row.original_price,40), discounted_price: cleanText(row.discounted_price,40) };
    })
    .filter((row) => row.name && row.discounted_price)
    .slice(0,50);
}

// 1 ($) through 3 ($$$); anything else (blank string from the "Not set" option, garbage,
// out-of-range) clears the tier rather than erroring — staff can always leave it unrated.
// Narrowed rather than rejected, so re-saving a deal that still carries one of the old four/five
// values keeps a tier instead of silently dropping to "Not set". See app/price-tiers.ts.
function parsePriceTier(value: unknown): number | null {
  return narrowPriceTier(Number(value));
}

// The Dining field, which edits the restaurant rather than the deal. Three-way on purpose:
//
//   "quick" / "sit_down"  set that value
//   "none"                clear it back to NULL - "nobody has decided", which is a real state
//                         and the one the public filter reads as "matches neither"
//   anything else         leave the stored value alone
//
// That last case is the one that matters. The field is absent from payloads the deal editor did
// not build - the inventory row's one-click Publish resends a stored deal row, and older clients
// send nothing at all - so treating a missing field as "clear it" would quietly unclassify a
// restaurant every time someone published one of its deals.
function parseServiceStyle(value: unknown): ServiceStyle | null | undefined {
  if (value === "quick" || value === "sit_down") return value;
  return value === "none" ? null : undefined;
}

interface DealChangeRow {
  id: string;
  deal_id: string;
  restaurant_id: string;
  title: string;
  price: string;
  schedule: string;
  description: string | null;
  terms: string | null;
  status: string;
  deal_restaurant_id: string | null;
  current_schedule: string | null;
}

interface AdminActionBody {
  action?: unknown;
  id?: unknown;
  hidden?: unknown;
  sponsored?: unknown;
  deal?: DealActionInput;
  status?: unknown;
  city?: unknown;
  confirmation?: unknown;
  role?: unknown;
  reason?: unknown;
  enabled?: unknown;
  notes?: unknown;
  resolution?: unknown;
  restaurantId?: unknown;
  locationId?: unknown;
  allLocations?: unknown;
  email?: unknown;
  photoUrl?: unknown;
  permission?: unknown;
  granted?: unknown;
  expiresAt?: unknown;
  key?: unknown;
  permissions?: unknown;
  dealId?: unknown;
  market?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  impressionLimit?: unknown;
  frequencyCap?: unknown;
  contractReference?: unknown;
  invoiceReference?: unknown;
  handle?: unknown;
  displayName?: unknown;
  decision?: unknown;
  commissionRateBps?: unknown;
  currency?: unknown;
  items?: unknown;
  /** Set by the confirmation dialog on an owner-approval action. */
  confirmed?: unknown;
  /** On an approved request being run: the owner_approvals row it came from. */
  approvalId?: unknown;
  /** A predefined rejection reason code (suggestions). */
  reasonCode?: unknown;
}

interface WaitlistEntry {
  id: number;
  user_id: string;
  email: string;
  language: string;
}

interface DealReadinessRow {
  location_id: string | null;
  source_url: string | null;
  schedules: number;
  verified: number;
  confirmed_locations: number;
}

interface SuggestionRow {
  id: number;
  restaurant: string;
  deal: string;
  postal: string;
  schedule: string;
  email: string;
  user_id: string | null;
  restaurant_website: string | null;
  address: string | null;
  title: string | null;
  description: string | null;
  price: string | null;
  eligible_days: string;
  start_time: string | null;
  end_time: string | null;
  starts_at: string | null;
  expires_at: string | null;
  restrictions: string | null;
  source: string | null;
  relationship: string | null;
  reference: string | null;
  rejection_reason: string | null;
  assigned_to: string | null;
  priority: string;
  updated_at: string;
  status: string;
  created_at: string;
}

const DAY_ORDER = ["mon","tue","wed","thu","fri","sat","sun"] as const;
const DAY_LABELS: Record<string,string> = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
function formatTimeLabel(time: string) {
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr), m = Number(mStr || 0);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { label: m ? `${h12}:${String(m).padStart(2,"0")}` : String(h12), period };
}
function formatTimeRange(start: string, end: string) {
  const s = formatTimeLabel(start), e = formatTimeLabel(end);
  return s.period === e.period ? `${s.label}\u2013${e.label} ${e.period}` : `${s.label} ${s.period}\u2013${e.label} ${e.period}`;
}
function formatScheduleText(days: string[], startTime: string, endTime: string) {
  const ordered = DAY_ORDER.filter((day) => days.includes(day));
  const groups: string[][] = [];
  for (const day of ordered) {
    const last = groups[groups.length - 1];
    const lastDay = last?.[last.length - 1];
    if (last && lastDay && DAY_ORDER.indexOf(lastDay as typeof DAY_ORDER[number]) === DAY_ORDER.indexOf(day) - 1) last.push(day);
    else groups.push([day]);
  }
  const dayText = groups
    .map((group) => group.length > 2 ? `${DAY_LABELS[group[0]]}\u2013${DAY_LABELS[group[group.length - 1]]}` : group.map((day) => DAY_LABELS[day]).join(", "))
    .join(", ");
  return `${dayText} ${formatTimeRange(startTime, endTime)}`;
}
// Skips a read entirely for a role that cannot open the screen it feeds. Returns the same
// { results } shape either way so the destructuring below stays uniform, and keeps the data
// (user emails, the audit trail, consent records) out of the response for roles with no use for it.
function gated<T>(allowed: boolean, run: () => Promise<{ results: T[] }>): Promise<{ results: T[] }> {
  return allowed ? run() : Promise.resolve({ results: [] });
}

// The statuses the admin sponsorship picker offers. Anything else was stored as written, and a row in
// a status nothing reads is a sponsorship that silently neither runs nor shows as stopped.
const SPONSORSHIP_STATUSES: readonly string[] = ["draft", "active", "paused", "ended"];

// Keeps the pre-existing `deals.sponsored` flag (which drives the public "Sponsored" badge and
// sort boost — see app/api/deals/route.ts) in sync with whatever the sponsorships table actually
// says, so the two never disagree: a deal reads as sponsored exactly when it has a currently
// `active` sponsorship row, regardless of which of create/update/delete just touched that row.
/**
 * The drink-advertising rules a deal breaks where it runs (app/drink-rules.ts), with any copy about
 * to replace its own laid over it. Empty for a deal that no longer exists.
 */
async function drinkIssuesForDeal(dealId: string, changes: Partial<DrinkRuleDeal> = {}) {
  const row = await env.DB.prepare(DRINK_RULE_DEAL_SQL).bind(dealId).first<DrinkRuleRow>();
  return row ? drinkIssuesForRow(row, changes) : [];
}

async function syncDealSponsoredFlag(dealId: string) {
  await env.DB.prepare(
    "UPDATE deals SET sponsored=(CASE WHEN EXISTS(SELECT 1 FROM sponsorships WHERE deal_id=? AND status='active') THEN 1 ELSE 0 END) WHERE id=?",
  ).bind(dealId,dealId).run();
}

// The deal list the workspace edits from, with each deal's schedule windows, offer locations and
// priced items attached.
//
// The three side tables are read for the deals on this page only. They used to be read whole and
// matched up afterwards, and deal_locations is the one table in D1 that is not small: a national
// chain's deal can carry a row for every branch, and those rows stayed when the deals became 'brand'
// and then 'national' (drizzle/0049, 0050). Every workspace load, every save (the client reloads
// after each one) and every keystroke of the deal search parsed all of them, and a national deal on
// the page carried thousands of branches into the response. Megabytes of rows is more than the
// platform's per-request CPU limit allows, and the workspace failed with it.
//
// A 'brand' or 'national' deal gets no location rows at all. Nothing reads them - the public API
// skips them (app/api/deals/route.ts) and the deal page lists a brand's branches from the brand -
// and the editor's per-address list is no way to look at ten thousand branches. Its editor falls
// back to the deal's own address, the same as a deal saved before deal_locations existed.
async function readAdminDeals(db: CollectedReads, where: string, bindings: string[]): Promise<AdminDealRow[]> {
  const { results: rows } = await db.prepare(
    `SELECT d.*,r.name canonical_restaurant,r.service_style,l.timezone,l.latitude,l.longitude,l.full_postal,l.region location_region,COALESCE(l.country,r.country) location_country,(SELECT COUNT(*) FROM verification_events v WHERE v.deal_id=d.id) verification_count,(SELECT group_concat(term,', ') FROM search_terms st WHERE st.entity_type='deal' AND st.entity_id=d.id AND st.source='curated') curated_keywords,(SELECT group_concat(term,', ') FROM search_terms st WHERE st.entity_type='restaurant' AND st.entity_id=d.restaurant_id) restaurant_keywords,(SELECT COUNT(*) FROM deal_schedules s WHERE s.deal_id=d.id) schedules,(SELECT COUNT(*) FROM deal_locations dl WHERE dl.deal_id=d.id AND dl.eligibility='confirmed') confirmed_locations,(SELECT s.days FROM deal_schedules s WHERE s.deal_id=d.id ORDER BY s.id LIMIT 1) schedule_days,(SELECT s.start_time FROM deal_schedules s WHERE s.deal_id=d.id ORDER BY s.id LIMIT 1) schedule_start,(SELECT s.end_time FROM deal_schedules s WHERE s.deal_id=d.id ORDER BY s.id LIMIT 1) schedule_end FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id WHERE d.deleted_at IS NULL${where} ORDER BY d.sponsored DESC,d.city,d.restaurant LIMIT 500`,
  ).bind(...bindings).all<AdminDealRow>();
  if (!rows.length) return rows;
  // One bound JSON array rather than a placeholder per id: D1 allows 100 bound parameters, and the
  // page holds up to 500 deals.
  const pageIds = JSON.stringify(rows.map((deal) => deal.id));
  const branchIds = JSON.stringify(rows.filter((deal) => deal.location_scope !== "brand" && deal.location_scope !== "national").map((deal) => deal.id));
  const [windowRows, locationRows, itemRows] = await Promise.all([
    db.prepare(
      "SELECT deal_id,days,start_time,end_time FROM deal_schedules WHERE deal_id IN (SELECT value FROM json_each(?)) ORDER BY deal_id,id",
    ).bind(pageIds).all<{ deal_id: string; days: string; start_time: string; end_time: string }>(),
    db.prepare(
      "SELECT dl.deal_id,l.id,l.address,l.city,l.postal_prefix,l.full_postal,dl.eligibility FROM deal_locations dl JOIN restaurant_locations l ON l.id=dl.location_id WHERE dl.deal_id IN (SELECT value FROM json_each(?)) ORDER BY dl.deal_id,dl.id",
    ).bind(branchIds).all<{ deal_id: string; id: string; address: string; city: string; postal_prefix: string; full_postal: string | null; eligibility: string }>(),
    db.prepare(
      "SELECT deal_id,id,name,original_price,discounted_price FROM deal_items WHERE deal_id IN (SELECT value FROM json_each(?)) ORDER BY deal_id,sort_order",
    ).bind(pageIds).all<{ deal_id: string; id: number; name: string; original_price: string | null; discounted_price: string }>(),
  ]);
  const windowsByDeal = new Map<string, NonNullable<AdminDealRow["schedule_windows"]>>();
  for (const row of windowRows.results) {
    let days: string[] = [];
    try { days = JSON.parse(row.days || "[]"); } catch { days = []; }
    const list = windowsByDeal.get(row.deal_id) || [];
    list.push({ days, start_time: row.start_time, end_time: row.end_time });
    windowsByDeal.set(row.deal_id, list);
  }
  const locationsByDeal = new Map<string, NonNullable<AdminDealRow["locations"]>>();
  for (const row of locationRows.results) {
    const list = locationsByDeal.get(row.deal_id) || [];
    list.push({ id: row.id, address: row.address, city: row.city, postal_prefix: row.postal_prefix, full_postal: row.full_postal, eligibility: row.eligibility });
    locationsByDeal.set(row.deal_id, list);
  }
  const itemsByDeal = new Map<string, NonNullable<AdminDealRow["items"]>>();
  for (const row of itemRows.results) {
    const list = itemsByDeal.get(row.deal_id) || [];
    list.push({ id: row.id, name: row.name, original_price: row.original_price, discounted_price: row.discounted_price });
    itemsByDeal.set(row.deal_id, list);
  }
  for (const deal of rows) {
    deal.schedule_windows = windowsByDeal.get(deal.id) || [];
    deal.locations = locationsByDeal.get(deal.id) || [];
    deal.items = itemsByDeal.get(deal.id) || [];
  }
  return rows;
}

// The workspace's heaviest lists, kept by this isolate between requests, each already serialised.
//
// The deal inventory (up to 500 rows with their windows, locations and items), the draft review,
// the restaurants, the open reminders, the review queue and the coverage tree are the same for
// every staff member who may see them, and together they are nearly all of a workspace load -
// 1.85 MB of the 1.9 MB a load sent, measured locally - and over a hundred milliseconds of CPU to
// read out of D1 and serialise again: on every load, and on the reload after every action, for
// lists that mostly had not changed. The deal list alone used to be kept, under a fingerprint of
// MAX(updated_at) over its tables and the audit log's last row, which every action moves: the
// reload after each one rebuilt the whole inventory.
//
// Each isolate now keeps the last answer for each part, as the string it sent, under the change
// counters of the tables the part is built from: data_changes, one counter per table, moved by a
// trigger on every write (drizzle/0049, 0140). A load reads the counters - one small row set,
// before anything else - and reuses every part whose tables have not moved. An action rebuilds the
// parts its tables feed and no other: a reminder marked done rebuilds the reminders, not the
// inventory.
//
// The counters are read before the parts, never after: a write landing between the two leaves
// rows newer than their counters, which costs one extra read on the next load, where the other
// order could keep an edit out of the workspace. PART_MAX_AGE_MS is the backstop for a write the
// counters do not see - a table with no trigger, which no part reads (tests/admin-workspace-cost
// .test.mjs holds each part's tables to the migrations), or a hand edit through a path that has
// one. The review queue's click counts come from product_events, which clicks move constantly and
// which no part may wait on, so that part is refreshed by time alone (REVIEW_QUEUE_MAX_AGE_MS).
// Kept in memory only, never in a shared cache: the inventory holds internal notes, and the isolate
// is the one place it cannot leak from. What the viewer may see is decided per request, after.
const PART_MAX_AGE_MS = 5 * 60_000;
const REVIEW_QUEUE_MAX_AGE_MS = 60_000;
const WORKSPACE_PARTS = {
  deals: { tables: ["deals", "restaurants", "restaurant_locations", "deal_locations", "deal_items", "verification_events", "deal_schedules", "search_terms"], maxAgeMs: PART_MAX_AGE_MS },
  drinkRuleAlerts: { tables: ["deals", "restaurants", "restaurant_locations", "deal_locations", "deal_schedules"], maxAgeMs: PART_MAX_AGE_MS },
  draftReview: { tables: ["deals", "restaurants", "restaurant_locations", "deal_locations", "deal_schedules", "staff_reminders", "market_coverage"], maxAgeMs: PART_MAX_AGE_MS },
  reviewQueue: { tables: ["deals", "restaurants", "favorites", "verification_events", "market_coverage"], maxAgeMs: REVIEW_QUEUE_MAX_AGE_MS },
  restaurants: { tables: ["restaurants"], maxAgeMs: PART_MAX_AGE_MS },
  staffReminders: { tables: ["staff_reminders", "deals"], maxAgeMs: PART_MAX_AGE_MS },
  coverageTree: { tables: ["deals", "restaurants", "restaurant_locations"], maxAgeMs: PART_MAX_AGE_MS },
} as const satisfies Record<string, { tables: readonly string[]; maxAgeMs: number }>;
type WorkspacePart = keyof typeof WORKSPACE_PARTS;
const keptParts = new Map<WorkspacePart, { counters: string; readAt: number; json: string }>();

async function readChangeCounters(db: CollectedReads): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT name,n FROM data_changes").all<{ name: string; n: number }>();
  return new Map(results.map((row) => [row.name, Number(row.n)]));
}

/** The kept parts a load may reuse under these counters, and how to keep the ones it rebuilds. */
function workspaceParts(counters: Map<string, number>, now: number) {
  const keyOf = (name: WorkspacePart): string | null => {
    const key: string[] = [];
    for (const table of WORKSPACE_PARTS[name].tables) {
      const n = counters.get(table);
      // A table with no counter cannot say when it changed, and a part built from it is not kept.
      if (n === undefined) return null;
      key.push(`${table}=${n}`);
    }
    return key.join(".");
  };
  return {
    reuse(name: WorkspacePart): string | null {
      const kept = keptParts.get(name);
      const key = keyOf(name);
      return kept && key !== null && kept.counters === key && now - kept.readAt < WORKSPACE_PARTS[name].maxAgeMs ? kept.json : null;
    },
    keep(name: WorkspacePart, json: string): string {
      const key = keyOf(name);
      if (key !== null) keptParts.set(name, { counters: key, readAt: now, json });
      return json;
    },
  };
}

export async function GET(request: Request) {
  const signedIn = await getAppUser();
  if (!signedIn) return apiError(401,"AUTH_REQUIRED","Sign in required.");
  if (!hasPermission(signedIn,"read_admin")) return apiError(403,"ADMIN_REQUIRED","Administrative access required.");
  const current = signedIn;
  const isOwner = current.role === "owner";
  // Audit access is gated on role tier, not the manage_users permission — a "custom" role can be
  // handed manage_users without being owner/admin, and the audit trail is sensitive enough that
  // it shouldn't follow along with that grant.
  const isAdminPlus = isOwner || current.role === "admin";
  const canManageUsers = hasPermission(current, "manage_users");
  const canManageEmail = hasPermission(current, "manage_email");
  const canModerateSuggestions = hasPermission(current, "moderate_suggestions");
  const canModerateFeedback = hasPermission(current, "moderate_feedback");
  const canManageSponsorships = hasPermission(current, "manage_sponsorships");
  const canCreateDeals = hasPermission(current, "create_deals");
  // Who sees what, by job rather than by tab (docs/ROLES.md). Each read below is gated on the
  // narrowest of these that covers it, so a role's payload carries only what its tabs render.
  const canWorkDeals = canCreateDeals || hasPermission(current, "publish_deals") || hasPermission(current, "verify_deals");
  const canViewAnalytics = hasPermission(current, "view_analytics");
  const canManageFinance = hasPermission(current, "manage_finance");
  const canSeeCampaigns = hasPermission(current, "manage_campaigns") || canViewAnalytics || canManageFinance;
  const canUseDeveloperTools = hasPermission(current, "developer_tools");
  // Engagement and leaderboards are anonymous counts: analytics readers see them, and so does
  // whoever manages accounts, who could always see them.
  const canSeeEngagement = canViewAnalytics || canManageUsers;
  // Optional deal-inventory search/filter params. The default deals query below always caps at
  // LIMIT 500 sorted by sponsored/city/restaurant, so a restaurant sitting past that cutoff is
  // invisible to plain client-side filtering of the loaded page — these let the admin workspace
  // ask the full table for a specific keyword/status/city/cuisine instead of only what happened
  // to load.
  // Every read below goes out in a handful of batches rather than a statement each: see
  // app/d1-reads.ts, and the fifty-subrequest limit it exists for.
  const db = collectReads(env.DB);
  const searchParams = new URL(request.url).searchParams;
  const dealQ = searchParams.get("deal_q")?.trim() || "";
  const dealStatus = searchParams.get("deal_status")?.trim() || "";
  const dealCity = searchParams.get("deal_city")?.trim() || "";
  const dealCuisine = searchParams.get("deal_cuisine")?.trim() || "";
  // Geography beyond the city: province/state, country and postal area, read from the deal's own
  // branch (restaurant_locations), so "Ontario" finds every Ontario city without a list of them.
  const dealRegion = searchParams.get("deal_region")?.trim().slice(0, 40) || "";
  const dealCountry = searchParams.get("deal_country")?.trim().toUpperCase().slice(0, 2) || "";
  const dealPostal = searchParams.get("deal_postal")?.replace(/\s+/g, "").toUpperCase().slice(0, 10) || "";
  const dealConditions: string[] = [];
  const dealBindings: string[] = [];
  if (dealQ) {
    // A deal's own terms and its restaurant's: public search reads both (buildBases in
    // app/api/deals/route.ts), so a staff member asking why "rotisserie" finds a St-Hubert offer
    // finds the same offers here.
    dealConditions.push(
      "(d.id = ? OR d.restaurant LIKE ? OR d.title LIKE ? OR d.cuisine LIKE ? OR d.address LIKE ? OR EXISTS (SELECT 1 FROM search_terms st WHERE ((st.entity_type='deal' AND st.entity_id=d.id) OR (st.entity_type='restaurant' AND st.entity_id=d.restaurant_id)) AND st.term LIKE ?))",
    );
    const like = `%${dealQ}%`;
    // The exact id first, so a deep link (/admin/deals?deal=<id>) finds a deal past the loaded page.
    dealBindings.push(dealQ, like, like, like, like, like);
  }
  if (dealStatus) { dealConditions.push("d.status = ?"); dealBindings.push(dealStatus); }
  if (dealCity) { dealConditions.push("d.city = ?"); dealBindings.push(dealCity); }
  if (dealCuisine) { dealConditions.push("d.cuisine = ?"); dealBindings.push(dealCuisine); }
  if (dealRegion) { dealConditions.push("l.region = ?"); dealBindings.push(dealRegion); }
  if (dealCountry) { dealConditions.push("COALESCE(l.country, r.country) = ?"); dealBindings.push(dealCountry); }
  if (dealPostal) { dealConditions.push("(REPLACE(UPPER(COALESCE(l.full_postal,'')),' ','') LIKE ? OR UPPER(COALESCE(l.postal_prefix,'')) LIKE ?)"); dealBindings.push(`${dealPostal}%`, `${dealPostal.slice(0, 3)}%`); }
  const dealWhere = dealConditions.length ? ` AND ${dealConditions.join(" AND ")}` : "";
  // The deal search asks for the deal list and reads nothing else from the answer, so that is all
  // it gets: it runs on every pause in typing, and used to run all forty-odd workspace reads each
  // time to throw everything but the deals away.
  if (dealConditions.length) return Response.json({ deals: await readAdminDeals(db, dealWhere, dealBindings) });
  // Which of the kept parts this load may reuse (workspaceParts). The counters are read on their
  // own, ahead of everything they vouch for.
  const now = Date.now();
  const parts = workspaceParts(await readChangeCounters(db), now);
  const wanted = (name: WorkspacePart, allowed: boolean) => allowed && parts.reuse(name) === null;
  const none = <T,>(): Promise<{ results: T[] }> => Promise.resolve({ results: [] as T[] });
  const [
    deals,
    drinkRuleRows,
    suggestions,
    users,
    feedback,
    audit,
    restaurants,
    reports,
    coverage,
    consents,
    suppressions,
    waitlist,
    sponsorships,
    restaurantManagers,
    campaignVisits,
    rolePermissions,
    // Order here is positional against the Promise.all below and nothing checks it — these three
    // used to read creatorProfiles/userPermissions the other way round, so the custom-permission
    // picker was being handed creator rows and the creator list was being handed permission rows.
    creatorProfiles,
    creatorApplications,
    creatorCommissions,
    creatorPayouts,
    affiliateBalances,
    userPermissions,
    dealTotals,
    signupTrend,
    dealTrend,
    visitTrend,
    dealFeedback,
    userTotals,
    favoritesTotal,
    engagementTotals,
    cityLeaderboard,
    restaurantLeaderboard,
    dealChangeRequests,
  ] = await Promise.all([
    // The inventory and the drink-rule check over every live deal (app/drink-rules.ts: deals
    // published before a rule existed, or whose branches moved, are found there), read only when
    // the kept copies are out of date.
    wanted("deals", true) ? readAdminDeals(db, "", []) : Promise.resolve(null),
    wanted("drinkRuleAlerts", true) ? db.prepare(DRINK_RULE_LIVE_SQL).all<DrinkRuleRow & { city: string; emoji: string }>() : none<DrinkRuleRow & { city: string; emoji: string }>(),
    gated(canModerateSuggestions, () => db.prepare("SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 250").all()),
    // Hidden accounts are filtered in SQL, not in the client, so a hidden row never reaches a
    // browser that is not allowed to see it. The gate is the owner/admin role rather than a
    // permission: a custom role can be granted manage_users, and the whole point of hiding an
    // account is that holding that permission is not by itself enough to see it.
    gated(canManageUsers || canManageEmail, () => db.prepare(
      `SELECT id,email,name,role,status,hidden,home_postal,alerts_enabled,alert_days,alert_time,language,timezone,country,distance_unit,plan,plan_status,created_at,referred_by FROM users${isAdminPlus ? "" : " WHERE hidden=0"} ORDER BY created_at DESC LIMIT 500`,
    ).all()),
    // Open and reviewing first, so a pile of resolved items can never push live work past the
    // limit. The deal title is for feedback sent from a deal's page; the resolver's name is who to
    // ask about a resolved item.
    gated(canModerateFeedback, () => db.prepare(
      `SELECT f.id,f.type,f.message,f.status,f.priority,f.market,f.email,f.page,f.deal_id,f.resolution,f.resolved_at,f.created_at,
              d.title deal_title,d.restaurant deal_restaurant,u.name resolved_by_name
       FROM feedback f LEFT JOIN deals d ON d.id=f.deal_id LEFT JOIN users u ON u.id=f.resolved_by
       ORDER BY CASE f.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,f.created_at DESC LIMIT 100`,
    ).all()),
    // The Audit log tab pages through GET /api/admin/audit; nothing in the workspace payload
    // reads the log any more, so it is not sent with every load.
    Promise.resolve({ results: [] as Record<string, unknown>[] }),
    wanted("restaurants", true) ? db.prepare("SELECT * FROM restaurants ORDER BY name LIMIT 500").all() : none(),
    // Each report with the deal it questions and where that is: the reported branch when the reader
    // named one, else the deal's own branch. A brand-wide or national deal with no branch named has
    // no single place, so it gets none rather than its representative branch's city. Open and
    // reviewing come first so completed reports never push live ones past the limit.
    gated(canModerateFeedback, () => db.prepare(
      `SELECT r.id,r.category,r.notes,r.status,r.priority,r.deal_id,r.location_id,r.source_url,r.resolution,r.resolved_at,r.created_at,
              d.title deal_title,d.restaurant deal_restaurant,d.status deal_status,d.location_scope,
              CASE WHEN r.location_id IS NULL AND d.location_scope IN ('brand','national') THEN NULL ELSE COALESCE(l.city,d.city) END city,
              CASE WHEN r.location_id IS NULL AND d.location_scope IN ('brand','national') THEN NULL ELSE l.region END region,
              COALESCE(l.country,rs.country) country,
              CASE WHEN r.location_id IS NULL AND d.location_scope IN ('brand','national') THEN NULL ELSE l.full_postal END postal,
              u.name resolved_by_name
       FROM reports r
       LEFT JOIN deals d ON d.id=r.deal_id
       LEFT JOIN restaurant_locations l ON l.id=COALESCE(r.location_id,d.location_id)
       LEFT JOIN restaurants rs ON rs.id=d.restaurant_id
       LEFT JOIN users u ON u.id=r.resolved_by
       ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,CASE r.priority WHEN 'high' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100`,
    ).all()),
    db.prepare("SELECT * FROM market_coverage ORDER BY country,region,market").all<MarketCoverageRow>(),
    gated(canManageEmail, () => db.prepare("SELECT user_id,email,status,consented_at,revoked_at,policy_version,created_at FROM email_consents ORDER BY created_at DESC LIMIT 250").all()),
    gated(canManageEmail, () => db.prepare("SELECT email,reason,created_at FROM email_suppressions ORDER BY created_at DESC LIMIT 250").all()),
    // The pilot waitlist, oldest request first. created_at is when they actually joined; the
    // autoincrement id breaks ties for two requests landing in the same second. Every place
    // this queue is ordered uses the same pair so the position staff see and the position the
    // person is told on their dashboard can never disagree.
    // Only someone whose *latest* row is 'waitlisted' is actually waiting. Accounts that
    // joined before duplicate requests were deduped can still carry an older waitlisted row
    // underneath a later pending/confirmed one, and those are not waiting for anything — this
    // matches how consentFor() reads a person's current status.
    gated(canManageEmail, () => db.prepare(
      `SELECT c.id,c.user_id,c.email,c.language,c.created_at,u.name
       FROM email_consents c LEFT JOIN users u ON u.id=c.user_id
       WHERE c.status='waitlisted'
         AND c.id=(SELECT id FROM email_consents WHERE user_id=c.user_id ORDER BY id DESC LIMIT 1)
       ORDER BY c.created_at,c.id LIMIT 250`,
    ).all<{id:number;user_id:string;email:string;language:string;created_at:string;name:string|null}>()),
    gated(canManageSponsorships, () => db.prepare("SELECT * FROM sponsorships ORDER BY starts_at DESC LIMIT 100").all()),
    gated(canManageUsers, () => db.prepare(
      "SELECT m.*,u.email user_email,u.name user_name FROM restaurant_managers m LEFT JOIN users u ON u.id=m.user_id WHERE m.status<>'revoked' ORDER BY m.created_at DESC LIMIT 250",
    ).all()),
    gated(canSeeCampaigns, () => db.prepare(
      "SELECT json_extract(properties,'$.source') source,json_extract(properties,'$.campaign') campaign,market,COUNT(*) hits,MIN(created_at) first_seen,MAX(created_at) last_seen FROM product_events WHERE type='campaign_visit' GROUP BY source,campaign,market ORDER BY hits DESC LIMIT 200",
    ).all()),
    // The Roles & permissions grid is read by owners and admins (Admin tab) and edited by the
    // owner alone (set_role_permission).
    gated(isAdminPlus, () => db.prepare("SELECT role,permission FROM role_permissions").all<{role:string;permission:string}>()),
    // Sits behind the same gate as the user list itself: it is a per-account attribute, useless
    // without the row it belongs to, and never larger than the number of creator accounts.
    gated(canManageUsers || canManageFinance, () => db.prepare("SELECT user_id,handle,display_name,status,commission_rate_bps FROM creator_profiles ORDER BY handle").all<{user_id:string;handle:string;display_name:string|null;status:string;commission_rate_bps:number}>()),
    // Pending first, then the recently decided ones, so the queue reads as work and the rest as
    // history without needing two round trips.
    gated(canManageFinance, () => db.prepare(
      `SELECT id,user_id,email,requested_handle,channel_url,audience,pitch,status,rejection_reason,created_at,reviewed_at
         FROM creator_applications ORDER BY (status='pending') DESC,created_at DESC LIMIT 200`,
    ).all<Record<string,unknown>>()),
    // The payables queue. Undecided first for the same reason. `payout_id` rides along because
    // it is what decides whether a row can still be touched by hand: one a payout is carrying is
    // not staff's to move.
    gated(canManageFinance, () => db.prepare(
      `SELECT id,handle,invoice_id,gross_amount,currency,rate_bps,commission_amount,status,created_at,paid_at,
              payout_id,approved_at,rejection_reason
         FROM creator_commissions ORDER BY (status='pending') DESC,created_at DESC LIMIT 200`,
    ).all<Record<string,unknown>>()),
    // Money that has actually left, with the Stripe object behind each row. Newest first: this
    // is a record to check, not a queue to work through — the only thing anyone acts on here is
    // a failure, and those are recent by definition.
    gated(canManageFinance, () => db.prepare(
      `SELECT id,handle,stripe_account_id,stripe_transfer_id,stripe_payout_id,amount,currency,status,
              commission_count,failure_reason,initiated_by,created_at,paid_at
         FROM creator_payouts ORDER BY created_at DESC LIMIT 200`,
    ).all<Record<string,unknown>>()),
    // What each affiliate is owed and whether they can be paid it, in one row per currency. The
    // console's payout button needs both halves: an amount, and Stripe's answer about the
    // account it would go to.
    gated(canManageFinance, () => db.prepare(
      `SELECT c.handle,c.currency,
              COALESCE(SUM(CASE WHEN c.status='approved' AND c.payout_id IS NULL THEN c.commission_amount ELSE 0 END),0) available,
              COALESCE(SUM(CASE WHEN c.status='pending' THEN c.commission_amount ELSE 0 END),0) holding,
              COALESCE(SUM(CASE WHEN c.status='paid' THEN c.commission_amount ELSE 0 END),0) paid,
              MAX(p.payouts_enabled) payouts_enabled,MAX(p.requirements_due) requirements_due,
              MAX(CASE WHEN p.stripe_account_id IS NULL THEN 0 ELSE 1 END) has_account
         FROM creator_commissions c LEFT JOIN creator_profiles p ON p.handle=c.handle
        GROUP BY c.handle,c.currency HAVING available>0 OR holding>0 ORDER BY available DESC`,
    ).all<Record<string,unknown>>()),
    gated(isAdminPlus, () => db.prepare("SELECT user_id,permission FROM user_permissions").all<{user_id:string;permission:string}>()),
    // Counted in SQL rather than over `deals.results`, because that list stops at 500 rows —
    // once the catalog outgrows a single page every overview figure would quietly start
    // under-reporting. Every lifecycle status is tallied so the six figures add up to `total`
    // instead of leaving paused and archived deals uncounted, and "stale" uses the same rule
    // the public API applies (only a *verified* deal goes stale; an unverified one is simply
    // unverified, and is already counted as such).
    db.prepare(
      `SELECT COUNT(*) total,
        COALESCE(SUM(status='live'),0) live,
        COALESCE(SUM(status='draft'),0) draft,
        COALESCE(SUM(status='scheduled'),0) scheduled,
        COALESCE(SUM(status='paused'),0) paused,
        COALESCE(SUM(status='expired'),0) expired,
        COALESCE(SUM(status='archived'),0) archived,
        COALESCE(SUM(verification_status<>'verified'),0) unverified,
        COALESCE(SUM(verification_status='stale' OR (verification_status='verified' AND julianday('now')-julianday(verified_at)>30)),0) stale,
        COALESCE(SUM(expires_at IS NOT NULL AND datetime(expires_at)>datetime('now') AND datetime(expires_at)<datetime('now','+7 days')),0) expiring
       FROM deals WHERE deleted_at IS NULL`,
    ).first<DealTotals>(),
    // 30-day trend lines for the Overview tab's sparkline cards. One row per day that actually
    // had activity (not a zero-filled 30-row series) — the client fills the gaps, since that's
    // simpler than teaching SQLite to generate a calendar of dates it has no native support for.
    gated(canManageUsers || canViewAnalytics, () => db.prepare("SELECT date(created_at) day,COUNT(*) count FROM users WHERE created_at>=datetime('now','-30 days') GROUP BY day ORDER BY day").all<{day:string;count:number}>()),
    db.prepare("SELECT date(created_at) day,COUNT(*) count FROM deals WHERE created_at>=datetime('now','-30 days') AND deleted_at IS NULL GROUP BY day ORDER BY day").all<{day:string;count:number}>(),
    gated(canViewAnalytics, () => db.prepare("SELECT date(created_at) day,COUNT(*) count FROM product_events WHERE created_at>=datetime('now','-30 days') GROUP BY day ORDER BY day").all<{day:string;count:number}>()),
    db.prepare("SELECT COALESCE(SUM(json_extract(properties,'$.helpful')=1),0) helpful,COALESCE(SUM(json_extract(properties,'$.helpful')=0),0) not_helpful FROM product_events WHERE type='deal_feedback'").first<{helpful:number;not_helpful:number}>(),
    // Growth tab: subscription mix, counted in SQL for the same reason as dealTotals above — the
    // users list itself is capped at 500 rows. Deliberately excludes users.alerts_enabled: that
    // column is a legacy single-postal toggle (set by app/api/user/route.ts, cleared by
    // app/api/email/unsubscribe/route.ts) that the digest job never actually reads — only
    // notification_preferences.enabled drives real sends (see app/api/jobs/digests/route.ts).
    // Surfacing alerts_enabled here would silently overstate how many people receive anything.
    // Active Pro is split by whether anybody pays for it (paidForPredicate). A comp, or App
    // Review's sandbox purchase, is real Pro and is nobody's subscription, so it has a number of its
    // own instead of passing for a customer. Headcounts, not money, so the Growth section's readers
    // (view_analytics) see them too; what anybody paid is in the finance metrics below.
    gated(canManageUsers || canManageFinance || canViewAnalytics, () => db.prepare(
      `SELECT COUNT(*) total,
        COALESCE(SUM(plan='pro' AND plan_status='active' AND ${paidForPredicate}),0) pro_paying,
        COALESCE(SUM(plan='pro' AND plan_status='active' AND NOT ${paidForPredicate}),0) pro_not_paying,
        COALESCE(SUM(plan='pro' AND plan_status='trialing'),0) pro_trialing,
        COALESCE(SUM(plan_status='past_due'),0) pro_past_due,
        COALESCE(SUM(plan_status='canceled'),0) pro_canceled
       FROM users`,
    ).all<UserTotals>()),
    gated(canSeeEngagement, () => db.prepare("SELECT COUNT(*) total FROM favorites").all<{total:number}>()),
    // The 30-day saves trend and the most-saved list moved to GET /api/admin/growth, which reads
    // them for the range the Growth section asks for (7, 30 or 90 days) instead of on every load.
    // DISTINCT user_id: a person can have several enabled notification_preferences rows (one per
    // saved location, each a separate scheduled send — see the digests job's own query, which
    // intentionally does NOT dedupe for that reason). This figure answers a different question,
    // "how many people are subscribed", so counting rows here would overstate the audience size
    // for anyone with more than one saved location's alerts turned on.
    gated(canSeeEngagement, () => db.prepare(
      `SELECT (SELECT COUNT(*) FROM saved_locations WHERE active=1) saved_locations,
              (SELECT COUNT(DISTINCT user_id) FROM notification_preferences WHERE enabled=1) digest_subscribers`,
    ).all<{saved_locations:number;digest_subscribers:number}>()),
    // Lead counts moved to GET /api/admin/growth ("Launch signals"), read when the section opens.
    // Top cities/restaurants by live deal count, computed in SQL over the full table rather than
    // client-side over the capped 500-row deal list — the catalog (117+ deals in production as
    // of this writing) is well under that cap today, but this is exactly the number this tab
    // exists to watch grow, so deriving it from a page of results would go quietly wrong the
    // moment it doesn't.
    //
    // A brand-wide or national offer has no single place, and a deal with a blank city has none
    // recorded: both are counted under city '' (the client says "No city recorded" or names the
    // scope) rather than presented as a city. Grouped with the branch's province/state and country
    // so two cities sharing a name stay apart and the row can open the inventory filtered to it.
    gated(canSeeEngagement, () => db.prepare(
      `SELECT CASE WHEN d.location_scope IN ('brand','national') OR TRIM(COALESCE(d.city,''))='' THEN '' ELSE d.city END city,
              CASE WHEN d.location_scope IN ('brand','national') THEN NULL ELSE l.region END region,
              CASE WHEN d.location_scope IN ('brand','national') THEN NULL ELSE COALESCE(l.country,r.country) END country,
              COUNT(*) count
         FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id
        WHERE d.status='live' AND d.active=1 AND d.deleted_at IS NULL
        GROUP BY 1,2,3 ORDER BY count DESC LIMIT 12`,
    ).all<{city:string;region:string|null;country:string|null;count:number}>()),
    gated(canSeeEngagement, () => db.prepare(
      "SELECT restaurant,COUNT(*) count FROM deals WHERE status='live' AND active=1 AND deleted_at IS NULL GROUP BY restaurant ORDER BY count DESC LIMIT 10",
    ).all<{restaurant:string;count:number}>()),
    // Restaurant managers' edits waiting for staff, oldest first, each beside what the deal says
    // now: the reviewer judges the change against the live listing, and `previous` (the deal when
    // the edit was made) shows whether staff changed it in the meantime. Approving one writes deal
    // content, so it is read for the same grant that can.
    gated(canCreateDeals, () => db.prepare(
      `SELECT c.id,c.deal_id,c.restaurant_id,c.title,c.price,c.schedule,c.description,c.terms,c.previous,c.created_at,
              d.title current_title,d.price current_price,d.schedule current_schedule,d.description current_description,d.terms current_terms,
              d.status deal_status,d.city,r.name restaurant_name,u.email requester_email,u.name requester_name
         FROM deal_change_requests c
         JOIN deals d ON d.id=c.deal_id AND d.deleted_at IS NULL
         LEFT JOIN restaurants r ON r.id=c.restaurant_id
         LEFT JOIN users u ON u.id=c.requested_by
        WHERE c.status='pending'
        ORDER BY c.created_at,c.id LIMIT 100`,
    ).all()),
  ]);
  const [emptySearchMarkets, marketCounts] = await Promise.all([db.prepare(
    `SELECT market,COUNT(*) searches FROM product_events
      WHERE type='search' AND market IS NOT NULL AND json_extract(properties,'$.matches')=0
        AND created_at>=datetime('now','-90 days')
      GROUP BY market`,
  ).all<{ market: string; searches: number }>(),
    // Each launch market's counts over the whole catalog, not the 500 loaded deals, so they do
    // not quietly undercount once the catalog outgrows one page.
    db.prepare(
      `SELECT m.market,COUNT(d.id) total,
              COALESCE(SUM(d.status='live' AND d.active=1),0) active_deals,
              COUNT(DISTINCT COALESCE(d.restaurant_id,d.restaurant)) unique_restaurants,
              COALESCE(SUM(d.verification_status='stale' OR (d.verification_status='verified' AND julianday('now')-julianday(d.verified_at)>30)),0) stale
         FROM market_coverage m
         LEFT JOIN deals d ON d.deleted_at IS NULL AND (d.city=m.market OR (m.market='Ottawa–Gatineau' AND d.city IN ('Ottawa','Gatineau')))
        GROUP BY m.market`,
    ).all<{ market: string; total: number; active_deals: number; unique_restaurants: number; stale: number }>(),
  ]);
  // Searches in this market that came back with nothing. The field has been on every coverage row
  // since the table was added and has been hard-coded to 0 the whole time, because until searches
  // were recorded there was no honest way to fill it. A market whose deal count looks healthy and
  // whose empty-search count is climbing is one where the catalog has the wrong deals, not too
  // few - which is a different problem with a different fix, and was invisible before.
  const emptySearchesByMarket = new Map((emptySearchMarkets.results || []).map((row) => [row.market, row.searches]));
  const countsByMarket = new Map((marketCounts.results || []).map((row) => [row.market, row]));
  const coverageRows = coverage.results.map((market) => {
    const counts = countsByMarket.get(market.market);
    const total = counts?.total || 0;
    return {...market,id:market.market,active_deals:counts?.active_deals || 0,unique_restaurants:counts?.unique_restaurants || 0,stale_percent:total ? Math.round((counts?.stale || 0) / total * 100) : 0,zero_result_searches:emptySearchesByMarket.get(market.market) || 0};
  });
  // Their own queries, run outside the positional Promise.all above — see buildCreatorRoster for
  // why. The roster is gated whole because every column in it is either a person or their money;
  // the metrics block gates itself, since its deal and search halves are anonymous.
  const [creatorRoster, metrics, settings, reviewQueueRows, staffReminders, draftReview, approvals, staffDirectory, coverageTree] = await Promise.all([
    canManageFinance ? buildCreatorRoster(db) : Promise.resolve([]),
    canManageFinance ? buildGrowthMetrics(db, canManageFinance) : Promise.resolve(null),
    // Read for anyone who can open the workspace, written only by manage_users. A switch whose
    // state is invisible to half the staff is one somebody flips twice.
    readSettings(),
    // What to check next, read across the whole catalog rather than the 500 rows above, and ranked
    // in app/review-queue.ts. Anonymous counts only: no favorite or click names its user here.
    gated(wanted("reviewQueue", canWorkDeals), () => db.prepare(REVIEW_QUEUE_SQL).all<ReviewQueueRow>()),
    // Deals to renew or confirm, opened daily by the Worker's cron (app/staff-reminders.ts). Read for
    // everyone in the workspace; marking one done is verify_deals'.
    gated(wanted("staffReminders", canWorkDeals), () => db.prepare(OPEN_STAFF_REMINDERS_SQL).all<StaffReminder>()),
    // Every draft with the source note it was written from, for the draft review screen
    // (app/draft-review.ts). Internal notes are already in the deal list above for the same readers.
    gated(wanted("draftReview", canWorkDeals), () => db.prepare(DRAFT_REVIEW_SQL).all<DraftReviewRow>()),
    // Requests for an owner's authorization: the owner sees every pending one and the recent
    // decisions; anyone else sees only their own.
    db.prepare(
      `SELECT a.id,a.action,a.summary,a.requested_by,a.requested_role,a.reason,a.status,a.decided_by,a.decision_note,a.decided_at,a.result,a.created_at,
              u.name requester_name,u.email requester_email,d.name decider_name
         FROM owner_approvals a LEFT JOIN users u ON u.id=a.requested_by LEFT JOIN users d ON d.id=a.decided_by
        ${isOwner ? "" : "WHERE a.requested_by=?"}
        ORDER BY (a.status='pending') DESC,a.created_at DESC LIMIT 100`,
    ).bind(...(isOwner ? [] : [current.userId])).all<Record<string, unknown>>(),
    // The staff directory: everyone who can open this workspace, with their role. Names and roles
    // only - addresses are for the people who manage accounts (the Users tab).
    db.prepare(
      `SELECT id,name,role,${canManageUsers ? "email," : ""}created_at FROM users
        WHERE status='active' AND hidden=0 AND role NOT IN ('user','creator','restaurant')
        ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'supervisor' THEN 2 ELSE 3 END,name LIMIT 300`,
    ).all<Record<string, unknown>>(),
    // Market coverage as a hierarchy: country, province or state, city, postal area (the first
    // three characters of a Canadian code, the first three digits of a US ZIP). Read from each
    // deal's own branch, so a chain's brand-wide or national offer - which has no single place -
    // is counted separately instead of being filed under whichever branch happens to be primary.
    gated(wanted("coverageTree", canWorkDeals || canViewAnalytics), () => db.prepare(
      `SELECT COALESCE(l.country,r.country,'') country,COALESCE(l.region,'') region,d.city city,
              UPPER(SUBSTR(REPLACE(COALESCE(l.full_postal,l.postal_prefix,''),' ',''),1,3)) postal_area,
              COUNT(*) deals,
              COALESCE(SUM(d.status='live' AND d.active=1),0) live,
              COALESCE(SUM(d.status='draft'),0) drafts,
              COUNT(DISTINCT COALESCE(d.restaurant_id,d.restaurant)) restaurants,
              COALESCE(SUM(d.verification_status='stale' OR (d.verification_status='verified' AND julianday('now')-julianday(d.verified_at)>30)),0) stale
         FROM deals d LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id
        WHERE d.deleted_at IS NULL AND COALESCE(d.location_scope,'') NOT IN ('brand','national')
          AND d.status IN ('live','draft','scheduled','paused')
        GROUP BY 1,2,3,4 ORDER BY 1,2,3,4 LIMIT 2000`,
    ).all<{ country: string; region: string; city: string; postal_area: string; deals: number; live: number; drafts: number; restaurants: number; stale: number }>()),
  ]);
  // The kept parts go in as strings - the one this load read and serialised, or the one kept from
  // an earlier load (workspaceParts) - and the rest is serialised around them: their keys are left
  // out below and spliced in front. A viewer who may not see a part gets its empty shape.
  const part = (name: WorkspacePart, allowed: boolean, empty: unknown, build: () => unknown): string =>
    !allowed ? JSON.stringify(empty) : parts.reuse(name) ?? parts.keep(name, JSON.stringify(build()));
  const dealsJson = part("deals", true, [], () => deals || []);
  const drinkRuleAlertsJson = part("drinkRuleAlerts", true, [], () => buildDrinkRuleAlerts(drinkRuleRows.results || []));
  const draftReviewJson = part("draftReview", canWorkDeals, [], () => draftReview.results || []);
  const reviewQueueJson = part("reviewQueue", canWorkDeals, buildReviewQueue([]), () => buildReviewQueue(reviewQueueRows.results || []));
  const restaurantsJson = part("restaurants", true, [], () => restaurants.results || []);
  const staffRemindersJson = part("staffReminders", canWorkDeals, [], () => staffReminders.results || []);
  const coverageTreeJson = part("coverageTree", canWorkDeals || canViewAnalytics, [], () => coverageTree.results || []);
  const rest = JSON.stringify({
    currentUser: { id: current.userId, role: current.role, name: current.displayName, email: current.email, permissions: Array.from(current.permissions) },
    dealTotals,
    approvals: approvals.results || [],
    staffDirectory: staffDirectory.results || [],
    suggestions: suggestions.results,
    // Whether each account's role is pinned, decided here rather than by the client comparing
    // addresses, so the owner's address never has to be in the browser bundle to draw the lock.
    users: (users.results as { email?: string | null }[]).map((row) => ({ ...row, isProtected: isProtectedOwner(row.email) })),
    feedback: feedback.results,
    audit: audit.results,
    reports: reports.results,
    coverage: coverageRows,
    consents: consents.results,
    suppressions: suppressions.results,
    waitlist: waitlist.results,
    sponsorships: sponsorships.results,
    restaurantManagers: restaurantManagers.results,
    dealChangeRequests: dealChangeRequests.results,
    campaignVisits: campaignVisits.results,
    rolePermissions: rolePermissions.results,
    userPermissions: userPermissions.results,
    creatorProfiles: creatorProfiles.results,
    creatorApplications: creatorApplications.results,
    creatorCommissions: creatorCommissions.results,
    creatorPayouts: creatorPayouts.results,
    affiliateBalances: affiliateBalances.results,
    creatorRoster,
    metrics,
    settings,
    // The labels and defaults live beside the switches in app/settings.ts, so the workspace renders
    // whatever is defined there without a matching edit here.
    settingDefinitions: Object.entries(SETTINGS).map(([key, definition]) => ({ key, label: definition.label })),
    trends: {
      signups: signupTrend.results,
      deals: dealTrend.results,
      visits: visitTrend.results,
      dealFeedback: dealFeedback || { helpful: 0, not_helpful: 0 },
    },
    growth: {
      users: userTotals.results[0] || { total: 0, pro_paying: 0, pro_not_paying: 0, pro_trialing: 0, pro_past_due: 0, pro_canceled: 0 },
      favorites: {
        total: favoritesTotal.results[0]?.total || 0,
      },
      engagement: engagementTotals.results[0] || { saved_locations: 0, digest_subscribers: 0 },
      topCities: cityLeaderboard.results,
      topRestaurants: restaurantLeaderboard.results,
    },
    // Which services are configured is the developer's business (Developer tab). Whoever runs the
    // mailing list still needs to know whether an invitation can go out right now, so that one
    // yes/no travels without the list of what is missing.
    integrations: canUseDeveloperTools
      ? {
          mapbox: Boolean((env as unknown as Record<string,string>).MAPBOX_ACCESS_TOKEN),
          emailPilot: (env as unknown as Record<string,string>).EMAIL_PILOT_ENABLED === "true",
          resend: Boolean((env as unknown as Record<string,string>).RESEND_API_KEY),
          deliveryReady: pilotGatesOpen(),
          deliveryReadiness: pilotReadiness(),
        }
      : { deliveryReady: canManageEmail ? pilotGatesOpen() : false },
  });
  return new Response(`{"deals":${dealsJson},"drinkRuleAlerts":${drinkRuleAlertsJson},"draftReview":${draftReviewJson},"reviewQueue":${reviewQueueJson},"restaurants":${restaurantsJson},"staffReminders":${staffRemindersJson},"coverageTree":${coverageTreeJson},${rest.slice(1)}`, {
    headers: { "content-type": "application/json" },
  });
}
/**
 * Whether a creator handle already carries money or attribution: commissions accrued under it, or
 * accounts that signed up through it. Commissions and referrals are keyed by handle, so such a
 * handle can never move to another account or be given to a new one - whoever ended up holding it
 * would collect the earlier creator's unpaid commissions and every future one from their referrals.
 */
async function handleHasHistory(handle: string) {
  const row = await env.DB.prepare(
    "SELECT EXISTS(SELECT 1 FROM creator_commissions WHERE handle=?) OR EXISTS(SELECT 1 FROM users WHERE referred_by=?) AS used",
  ).bind(handle,handle).first<{ used: number }>();
  return Boolean(row?.used);
}

export async function POST(request: Request) {
  const signedIn = await getAppUser();
  if (!signedIn) return apiError(401,"AUTH_REQUIRED","Sign in required.");
  if (!canAdminister(signedIn)) return apiError(403,"ADMIN_REQUIRED","Administrative access required.");
  if (!(await requireSameOrigin(request))) return apiError(403,"INVALID_ORIGIN","This request could not be verified.");
  // No copy to forget before the writes: the reload that follows every action reads the change
  // counters its writes move, and rebuilds the parts built from those tables (workspaceParts).
  const current = signedIn;
  let b:AdminActionBody;
  try { b = await readJson<AdminActionBody>(request,64_000); } catch { return apiError(400,"INVALID_REQUEST","The administrative request is invalid."); }
  // Set only by approve_owner_approval when it runs a stored request. From a client it would let an
  // audit row claim an owner approved something no owner saw.
  b = { ...b, approvalId: undefined };
  const needed = ACTION_PERMISSIONS[String(b.action)];
  if (!needed || !hasPermission(current,needed)) return apiError(403,"PERMISSION_DENIED","Your role does not allow this action.");
  const origin = new URL(request.url).origin;
  // Destructive and high-risk actions (OWNER_APPROVAL_ACTIONS). Holding the permission lets
  // somebody ask; only an owner can make it happen. Both paths need the confirmation the dialog
  // sets, so nothing here fires from a stray request.
  if (needsOwnerApproval(String(b.action))) {
    if (b.confirmed !== true) return apiError(409,"CONFIRMATION_REQUIRED","Confirm this action before it can run.");
    if (current.role !== "owner") return requestOwnerApproval(current,b);
  }
  return performAction(current,b,origin);
}

/** Stores a request for an owner-approval action and tells the caller it is waiting. */
async function requestOwnerApproval(current: AppUser, b: AdminActionBody) {
  // Checked now as well as when it runs, so a request that could never succeed is refused while
  // the person asking is still looking at it, not days later in an owner's queue.
  const precheck = await precheckOwnerApproval(b);
  if (precheck) return precheck;
  const id = `approval-${crypto.randomUUID()}`;
  const reason = cleanText(b.reason,500) || null;
  const summary = await describeOwnerApproval(b);
  const pending = await env.DB.prepare("SELECT COUNT(*) n FROM owner_approvals WHERE requested_by=? AND status='pending'").bind(current.userId).first<{ n: number }>();
  if ((pending?.n || 0) >= 20) return apiError(429,"TOO_MANY_PENDING","You already have 20 requests waiting for an owner. Withdraw some first.");
  // The body as asked, minus the confirmation flag: the owner confirms again when approving.
  const payload = JSON.stringify({ ...b, confirmed: undefined, approvalId: undefined });
  if (payload.length > 8_000) return apiError(422,"REQUEST_TOO_LARGE","This request is too large to hold for approval.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owner_approvals(id,action,payload,summary,requested_by,requested_role,reason) VALUES(?,?,?,?,?,?,?)")
      .bind(id,String(b.action),payload,summary,current.userId,current.role,reason),
    env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,request_id,reason,details) VALUES(?,?,?,?,?,?,?,?)")
      .bind(current.userId,current.role,"owner_approval_requested","owner_approval",id,crypto.randomUUID(),reason,JSON.stringify({ requestedAction: String(b.action), summary }).slice(0,1500)),
  ]);
  return Response.json({ ok: true, pending: true, id, warning: "Sent to an owner for approval. It runs when an owner approves it." }, { status: 202 });
}

/** The refusals an owner-approval action would hit anyway, checked before it is queued. */
// A switch rather than `b.action === ...` tests: the handlers' own order in performAction is what
// several tests slice the source by, and these helpers must not read as a second copy of them.
async function precheckOwnerApproval(b: AdminActionBody): Promise<Response | null> {
  switch (b.action) {
    case "bulk_lifecycle":
      return bulkLifecycleInputError(b);
    case "delete_sponsorship": {
      const existing = await env.DB.prepare("SELECT id FROM sponsorships WHERE id=?").bind(b.id).first();
      return existing ? null : apiError(404,"SPONSORSHIP_NOT_FOUND","That sponsorship could not be found.");
    }
    case "setting":
      return isSettingKey(b.key) ? null : apiError(422,"INVALID_SETTING","Unknown setting.");
    case "referral_correction":
      return cleanText(b.reason,500) ? null : apiError(422,"REASON_REQUIRED","Record a reason for this correction.",{reason:"Required"});
    case "affiliate_payout": {
      const handle = cleanText(b.handle,32).toLowerCase();
      const currency = cleanText(b.currency,3).toLowerCase();
      if (!handle) return apiError(422,"INVALID_HANDLE","Choose an affiliate to pay.");
      if (!/^[a-z]{3}$/.test(currency)) return apiError(422,"INVALID_CURRENCY","Choose a currency to pay in.");
      return null;
    }
    default:
      return null;
  }
}

/** The one sentence an owner reads before deciding. Built from the records, not from the client. */
async function describeOwnerApproval(b: AdminActionBody): Promise<string> {
  switch (b.action) {
    case "bulk_lifecycle":
      return `Set every deal in ${String(b.city)} to ${String(b.status)}`;
    case "delete_sponsorship": {
      const row = await env.DB.prepare("SELECT s.market,d.restaurant,d.title FROM sponsorships s LEFT JOIN deals d ON d.id=s.deal_id WHERE s.id=?").bind(b.id)
        .first<{ market: string; restaurant: string | null; title: string | null }>();
      return `Delete the sponsorship for ${row?.restaurant || "a deal"}${row?.title ? ` — ${row.title}` : ""} in ${row?.market || "its market"}, with its click history`;
    }
    case "affiliate_payout": {
      const handle = cleanText(b.handle,32).toLowerCase(), currency = cleanText(b.currency,3).toLowerCase();
      const owed = await env.DB.prepare("SELECT COALESCE(SUM(commission_amount),0) amount FROM creator_commissions WHERE handle=? AND currency=? AND status='approved' AND payout_id IS NULL")
        .bind(handle,currency).first<{ amount: number }>();
      return `Pay ${handle} what they are owed in ${currency.toUpperCase()} (${((owed?.amount || 0) / 100).toFixed(2)} at the time of asking) through Stripe`;
    }
    case "referral_correction": {
      const target = await env.DB.prepare("SELECT email,referred_by FROM users WHERE id=?").bind(b.id).first<{ email: string; referred_by: string | null }>();
      const handle = normalizeReferralCode(b.handle);
      return `Change the referral code on ${target?.email || "an account"} from ${target?.referred_by || "none"} to ${handle || "none"}`;
    }
    case "setting": {
      const definition = isSettingKey(b.key) ? SETTINGS[b.key] : null;
      return `${b.granted === false ? "Turn off" : "Turn on"} “${definition?.label || String(b.key)}”`;
    }
    default:
      return String(b.action);
  }
}

// Where a single-market bulk change is refused before it is queued or run: there is no way to
// touch the whole platform at once, and the market has to be one that has deals.
async function bulkLifecycleInputError(b: AdminActionBody): Promise<Response | null> {
  const city = cleanText(b.city,100);
  const status = String(b.status);
  if (!["paused", "archived", "draft"].includes(status)) return apiError(422,"INVALID_BULK_STATUS","Invalid bulk status.");
  if (!city || city === "All cities") return apiError(422,"MARKET_REQUIRED","Choose one market. Radar has no control that changes every deal at once.");
  const expected = `${status.toUpperCase()} ${city}`;
  if (String(b.confirmation || "") !== expected) return apiError(409,"CONFIRMATION_REQUIRED",`Type ${expected} to confirm this bulk action.`);
  const present = await env.DB.prepare("SELECT COUNT(*) n FROM deals WHERE city=? AND deleted_at IS NULL").bind(city).first<{ n: number }>();
  if (!present?.n) return apiError(404,"MARKET_NOT_FOUND","No deals are listed in that market.");
  return null;
}

async function performAction(current: AppUser, b: AdminActionBody, origin: string): Promise<Response> {
  let targetType = "unknown",
    targetId = String(b.id || "none"),
    warning: string | null = null;
  // Extra fields worth recording per action, on top of the generic snapshot below — the audit
  // log used to only ever store {action,status,city,enabled}, which is blank for most action
  // types (a role change didn't say what role or whose account; a deal save didn't say which
  // restaurant). Branches that have something more specific and human-readable than the raw
  // request body can add it here.
  const auditDetails: Record<string, unknown> = {};
  if (b.action === "sponsorship") {
    targetType = "deal";
    await env.DB.prepare("UPDATE deals SET sponsored=? WHERE id=?")
      .bind(b.sponsored ? 1 : 0, b.id)
      .run();
  } else if (b.action === "create_sponsorship") {
    targetType = "sponsorship";
    const dealId = String(b.dealId || "");
    const market = String(b.market || "");
    const startsAt = String(b.startsAt || "");
    const endsAt = String(b.endsAt || "");
    const fieldErrors: Record<string,string> = {};
    if (!dealId) fieldErrors.dealId = "Required";
    if (!market) fieldErrors.market = "Required";
    if (!startsAt) fieldErrors.startsAt = "Required";
    if (!endsAt) fieldErrors.endsAt = "Required";
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) fieldErrors.endsAt = "Must be after the start date";
    if (Object.keys(fieldErrors).length) return apiError(422,"INVALID_SPONSORSHIP","Complete all required sponsorship fields.",fieldErrors);
    const deal = await env.DB.prepare("SELECT restaurant_id FROM deals WHERE id=? AND deleted_at IS NULL").bind(dealId).first<{restaurant_id:string|null}>();
    if (!deal) return apiError(404,"DEAL_NOT_FOUND","That deal could not be found.");
    if (!deal.restaurant_id) return apiError(422,"DEAL_NEEDS_RESTAURANT","Link this deal to a restaurant before sponsoring it.");
    if (b.status !== undefined && !SPONSORSHIP_STATUSES.includes(String(b.status))) return apiError(422,"INVALID_SPONSORSHIP_STATUS","Invalid sponsorship status.");
    const id = `sponsorship-${crypto.randomUUID()}`;
    targetId = id;
    auditDetails.dealId = dealId;
    auditDetails.market = market;
    await env.DB.prepare(
      `INSERT INTO sponsorships(id,deal_id,restaurant_id,market,status,starts_at,ends_at,impression_limit,frequency_cap,contract_reference,invoice_reference,approved_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,dealId,deal.restaurant_id,market,
      String(b.status || "draft"),startsAt,endsAt,
      b.impressionLimit ? Number(b.impressionLimit) : null,
      b.frequencyCap ? Number(b.frequencyCap) : 1,
      cleanText(b.contractReference,200) || null,
      cleanText(b.invoiceReference,200) || null,
      b.status === "active" ? current.userId : null,
    ).run();
    await syncDealSponsoredFlag(dealId);
  } else if (b.action === "update_sponsorship") {
    targetType = "sponsorship";
    const existing = await env.DB.prepare("SELECT deal_id FROM sponsorships WHERE id=?").bind(b.id).first<{deal_id:string}>();
    if (!existing) return apiError(404,"SPONSORSHIP_NOT_FOUND","That sponsorship could not be found.");
    if (b.status && !SPONSORSHIP_STATUSES.includes(String(b.status))) return apiError(422,"INVALID_SPONSORSHIP_STATUS","Invalid sponsorship status.");
    const startsAt = b.startsAt ? String(b.startsAt) : null;
    const endsAt = b.endsAt ? String(b.endsAt) : null;
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return apiError(422,"INVALID_SPONSORSHIP","The end date must be after the start date.",{endsAt:"Must be after the start date"});
    auditDetails.market = b.market;
    await env.DB.prepare(
      `UPDATE sponsorships SET
        market=COALESCE(?,market),
        status=COALESCE(?,status),
        starts_at=COALESCE(?,starts_at),
        ends_at=COALESCE(?,ends_at),
        impression_limit=CASE WHEN ?=1 THEN ? ELSE impression_limit END,
        frequency_cap=COALESCE(?,frequency_cap),
        contract_reference=CASE WHEN ?=1 THEN ? ELSE contract_reference END,
        invoice_reference=CASE WHEN ?=1 THEN ? ELSE invoice_reference END,
        approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END,
        updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    ).bind(
      b.market ? String(b.market) : null,
      b.status ? String(b.status) : null,
      startsAt,endsAt,
      // A field left out of the request keeps its value; one sent empty clears it. A status-only
      // change used to wipe the contract, invoice and impression cap because all three were
      // written as sent.
      b.impressionLimit === undefined ? 0 : 1, b.impressionLimit ? Number(b.impressionLimit) : null,
      b.frequencyCap ? Number(b.frequencyCap) : null,
      b.contractReference === undefined ? 0 : 1, cleanText(b.contractReference,200) || null,
      b.invoiceReference === undefined ? 0 : 1, cleanText(b.invoiceReference,200) || null,
      b.status ? String(b.status) : "",current.userId,
      b.id,
    ).run();
    await syncDealSponsoredFlag(existing.deal_id);
  } else if (b.action === "delete_sponsorship") {
    targetType = "sponsorship";
    const existing = await env.DB.prepare("SELECT deal_id FROM sponsorships WHERE id=?").bind(b.id).first<{deal_id:string}>();
    if (!existing) return apiError(404,"SPONSORSHIP_NOT_FOUND","That sponsorship could not be found.");
    await env.DB.prepare("DELETE FROM sponsorships WHERE id=?").bind(b.id).run();
    await syncDealSponsoredFlag(existing.deal_id);
  } else if (b.action === "save_deal") {
    targetType = "deal";
    const d:DealActionInput = b.deal || {};
    const id = String(d.id || `deal-${crypto.randomUUID()}`);
    targetId = id;
    auditDetails.restaurant = d.restaurant;
    auditDetails.title = d.title;
    auditDetails.status = d.status;
    // Paid placement is manage_sponsorships' to give. save_deal needs only create_deals, so the
    // flag rides along from the editor only for someone who could sponsor the deal anyway; for
    // anyone else a new deal starts unsponsored and an edit leaves the flag as it was.
    const canSponsor = hasPermission(current, "manage_sponsorships");
    // city/address/postal are validated separately below via locationInputs — a deal can now
    // carry several locations, so the deal's own top-level city/address fields (kept only for
    // backward-compatible single-location callers) aren't a reliable presence check any more.
    const required = ([
      "restaurant",
      "title",
      "category",
      "cuisine",
      "price",
      "emoji",
    ] as const).filter((k) => !String(d[k] || "").trim());
    if (required.length) return apiError(422,"INVALID_DEAL","Complete all required deal fields.",Object.fromEntries(required.map((key) => [key,"Required"])));
    // Presence was just checked above; this is the *format* check that was missing — an empty
    // cuisine/emoji was rejected already, but anything non-empty was accepted as-is regardless
    // of status, which is how freeform typing (before the dropdown/picker existed) let data
    // drift. The dropdown always sends a CUISINES value, or the admin's own freeform "Other"
    // text — either is fine; only an implausibly long string (arbitrary pasted text, not a
    // cuisine name) is rejected. The emoji field is capped by Unicode code point, not UTF-16
    // length, so a multi-codepoint ZWJ sequence (e.g. a family emoji) still fits.
    const cuisineValue = String(d.cuisine || "").trim();
    if (cuisineValue.length > 60 && !isKnownCuisine(cuisineValue))
      return apiError(422,"INVALID_CUISINE","Enter a shorter cuisine name.",{cuisine:"Too long"});
    const emojiValue = String(d.emoji || "").trim();
    if ([...emojiValue].length > 8)
      return apiError(422,"INVALID_EMOJI","Choose a single emoji for the card icon.",{emoji:"Too long"});
    if (d.source_url && !validHttpUrl(d.source_url)) return apiError(422,"INVALID_SOURCE","Enter a valid source URL.",{source_url:"Invalid URL"});
    const locationInputs = parseLocationInputs(d);
    if (!locationInputs.length) return apiError(422,"INVALID_DEAL","At least one location (address, city, postal/ZIP) is required.",{location:"Required"});
    const rawWindows = Array.isArray(d.schedule_windows) && d.schedule_windows.length ? d.schedule_windows.length : (Array.isArray(d.days) ? d.days : []).length ? 1 : 0;
    const scheduleWindows = parseScheduleWindows(d);
    // A window can be dropped by parseScheduleWindows for being malformed (missing days, or
    // start>=end) — checking the parsed count against the raw count catches that case, not
    // just "nothing was submitted at all".
    if (!scheduleWindows.length || scheduleWindows.length !== rawWindows || scheduleWindows.some((w) => w.start_time >= w.end_time))
      return apiError(422,"INVALID_SCHEDULE","Select at least one day and a valid time range for every schedule window.",{schedule:"Select at least one day and a valid time range for every schedule window"});
    const scheduleText = scheduleWindows.map((w) => formatScheduleText(w.days,w.start_time,w.end_time)).join(" & ");
    const dealItems = parseDealItems(d);
    const requestedStatus = [
      "draft",
      "scheduled",
      "live",
      "paused",
      "expired",
      "archived",
    ].includes(String(d.status))
      ? d.status
      : "draft";
    const existingDeal = await env.DB.prepare(
      "SELECT status FROM deals WHERE id=?",
    )
      .bind(id)
      .first<{ status: string }>();
    const status =
      requestedStatus === "live" && existingDeal?.status !== "live"
        ? "draft"
        : requestedStatus;
    if (status === "scheduled" && !d.publish_at)
      return apiError(422,"PUBLICATION_TIME_REQUIRED","Choose a publication time for a scheduled deal.",{publish_at:"Required for scheduled deals"});
    // What the staff member chose in the Dining field, if anything. `undefined` means the field
    // was not on this payload at all, which is not the same as "unclassified" - see
    // parseServiceStyle.
    const chosenServiceStyle = parseServiceStyle(d.service_style);
    let restaurantId = cleanText(d.restaurant_id,140);
    if (!restaurantId) restaurantId = (await env.DB.prepare("SELECT id FROM restaurants WHERE lower(name)=lower(?) LIMIT 1").bind(d.restaurant).first<{id:string}>())?.id || "";
    if (!restaurantId) {
      restaurantId = `restaurant:${crypto.randomUUID()}`;
      // A new restaurant is classified here rather than left for someone to notice later. Until
      // this, `service_style` was filled only by scripts/classify-service-style.mjs run by hand,
      // so anything added in between appeared under neither half of the public Fast food /
      // Sit-down filter - invisible to a filter it should have been in from its first save.
      //
      // The same rule the script runs, on the evidence available at this moment: the name, the
      // cuisine, and the one deal being saved. That is less than the script gets (it reads a
      // restaurant's whole live catalog) but it is the same six passes, and the script re-runs
      // over everything anyway. A staff choice wins outright.
      const classified = chosenServiceStyle !== undefined ? chosenServiceStyle : classifyServiceStyle({
        name: String(d.restaurant || ""),
        cuisine: String(d.cuisine || ""),
        dealCopy: dealCopyForServiceStyle(d),
        publishesHappyHour: String(d.category || "").toLowerCase() === "happy hour",
      }).style;
      await env.DB.prepare("INSERT INTO restaurants(id,name,slug,website,cuisine,is_chain,service_style) VALUES(?,?,?,?,?,?,?)")
        .bind(restaurantId,cleanText(d.restaurant,120),`${slugify(String(d.restaurant))}-${restaurantId.slice(-6)}`,d.source_url || null,cleanText(d.cuisine,80),0,classified).run();
    } else if (chosenServiceStyle !== undefined) {
      // An existing restaurant is only ever changed by an explicit choice, never reclassified
      // behind the staff member's back on a save about something else. `IS NOT` is SQLite's
      // null-safe comparison, so a save that does not actually change the value writes nothing -
      // and therefore does not move restaurants.updated_at, which the public snapshot's revision
      // fingerprint is built from.
      await env.DB.prepare("UPDATE restaurants SET service_style=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND service_style IS NOT ?")
        .bind(chosenServiceStyle,restaurantId,chosenServiceStyle).run();
    }
    // Preserve a location's confirmed eligibility (and when it was verified) across a re-save
    // instead of resetting it back to needs_review — eligibility only ever advances via the
    // verify action, and a re-save (delete-then-reinsert below, same pattern as
    // deal_schedules/search_terms) shouldn't undo that just because an unrelated field changed.
    const priorLocations = new Map(
      (await env.DB.prepare("SELECT location_id,eligibility,verified_at FROM deal_locations WHERE deal_id=?").bind(id).all<{location_id:string;eligibility:string;verified_at:string|null}>())
        .results.map((row) => [row.location_id, row] as const),
    );
    const resolvedLocations: { locationId: string; eligibility: string; verifiedAt: string | null }[] = [];
    let primary: { locationId: string; address: string; city: string; postalPrefix3: string; timezone: string } | null = null;
    for (const entry of locationInputs) {
      const typedPostal = normalizedPostal(entry.postal);
      let normalizedFullPostal = typedPostal;
      if (!validPostal(normalizedFullPostal)) {
        // Quick actions (e.g. the inventory row's one-click Publish) resend an already-derived
        // 3-char postal_prefix rather than a full code — fall back to the location's own stored
        // full_postal instead of rejecting a save that isn't actually trying to change the address.
        const existingLocation = entry.id
          ? await env.DB.prepare("SELECT full_postal FROM restaurant_locations WHERE id=?").bind(entry.id).first<{full_postal:string|null}>()
          : null;
        if (existingLocation?.full_postal && validPostal(existingLocation.full_postal)) normalizedFullPostal = existingLocation.full_postal;
        else return apiError(422,"INVALID_POSTAL","Enter a valid postal or ZIP code for every location.",{postal_prefix:"Enter a valid postal or ZIP code"});
      }
      const postalPrefix3 = normalizedFullPostal.slice(0,3);
      const isCanadianPostal = /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(normalizedFullPostal);
      const inferredCountry = isCanadianPostal ? "CA" : "US";
      // Real geocoding instead of a handful of hardcoded city centroids: resolves any postal
      // code (not just the 6 cities this used to know about), reusing the exact same
      // Mapbox-then-Zippopotam pipeline the public search path uses. A miss doesn't block the
      // save — a draft still needs to be saveable — it surfaces as a non-blocking `warning` on
      // the response instead of silently defaulting to the wrong place on the map.
      const geocoded = await geocodePostal(normalizedFullPostal, isCanadianPostal);
      const geoFallback = geocoded ? null : fallbackForPostal(normalizedFullPostal);
      const geoLatitude = geocoded?.latitude ?? geoFallback?.latitude ?? null;
      const geoLongitude = geocoded?.longitude ?? geoFallback?.longitude ?? null;
      const geoRegion = geocoded?.region || geoFallback?.region || "";
      const geoCountry = geocoded?.country || geoFallback?.country || inferredCountry;
      const geoTimezone = geocoded?.timezone || geoFallback?.timezone || "America/Toronto";
      if (geoLatitude === null) warning = "We couldn't confirm an address's location from its postal code — double-check the postal code and address before publishing.";
      let locationId = entry.id;
      if (!locationId) locationId = (await env.DB.prepare("SELECT id FROM restaurant_locations WHERE restaurant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) LIMIT 1").bind(restaurantId,entry.address,entry.city).first<{id:string}>())?.id || "";
      if (!locationId) {
        locationId = `location:${crypto.randomUUID()}`;
        await env.DB.prepare("INSERT INTO restaurant_locations(id,restaurant_id,address,city,region,country,postal_prefix,full_postal,latitude,longitude,timezone,slug,official_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(locationId,restaurantId,entry.address,entry.city,geoRegion,geoCountry,postalPrefix3,normalizedFullPostal,geoLatitude,geoLongitude,geoTimezone,`${slugify(String(d.restaurant))}-${slugify(entry.city)}-${locationId.slice(-6)}`,d.source_url || null).run();
      } else {
        // Also refresh address/city/coordinates/region/timezone on an existing location, not just
        // the postal text — this used to leave address and city untouched, so retyping a deal's
        // address in the editor updated deals.address (what the admin list shows) but never the
        // linked restaurant_locations row, which is what the public deal page's "Restaurant
        // location" card and the map pin actually read — the address looked saved but the real
        // location record silently stayed frozen at whatever it was first created with.
        await env.DB.prepare("UPDATE restaurant_locations SET address=?,city=?,postal_prefix=?,full_postal=?,region=COALESCE(NULLIF(?,''),region),country=COALESCE(NULLIF(?,''),country),latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),timezone=COALESCE(NULLIF(?,''),timezone),updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(entry.address,entry.city,postalPrefix3,normalizedFullPostal,geoRegion,geoCountry,geoLatitude,geoLongitude,geoTimezone,locationId).run();
      }
      if (resolvedLocations.some((loc) => loc.locationId === locationId)) continue;
      const prior = priorLocations.get(locationId);
      const eligibility = prior?.eligibility === "confirmed" ? "confirmed" : "needs_review";
      resolvedLocations.push({ locationId, eligibility, verifiedAt: eligibility === "confirmed" ? prior!.verified_at : null });
      if (!primary) primary = { locationId, address: entry.address, city: entry.city, postalPrefix3, timezone: geoTimezone };
    }
    const { locationId, address: primaryAddress, city: primaryCity, postalPrefix3, timezone: scheduleTimezone } = primary!;
    auditDetails.city = primaryCity;
    auditDetails.locationCount = resolvedLocations.length;
    // created_at is set only in the INSERT column list (a literal, not a bound placeholder) and
    // deliberately left out of the ON CONFLICT SET clause — an edit to an existing deal must never
    // move its original "date added" forward, unlike verified_at which does advance on re-checks.
    await env.DB.prepare(`INSERT INTO deals(id,slug,restaurant_id,location_id,restaurant,title,category,cuisine,schedule,city,postal_prefix,address,price,price_tier,emoji,source_url,sponsored,active,status,publish_at,expires_at,terms,restrictions,internal_notes,verification_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET restaurant_id=excluded.restaurant_id,location_id=excluded.location_id,restaurant=excluded.restaurant,title=excluded.title,category=excluded.category,cuisine=excluded.cuisine,schedule=excluded.schedule,city=excluded.city,postal_prefix=excluded.postal_prefix,address=excluded.address,price=excluded.price,price_tier=excluded.price_tier,emoji=excluded.emoji,source_url=excluded.source_url,sponsored=CASE WHEN ? THEN excluded.sponsored ELSE deals.sponsored END,status=excluded.status,publish_at=excluded.publish_at,expires_at=excluded.expires_at,terms=excluded.terms,restrictions=excluded.restrictions,internal_notes=excluded.internal_notes,active=excluded.active,updated_at=CURRENT_TIMESTAMP`)
      .bind(id,d.slug || id,restaurantId,locationId,cleanText(d.restaurant,120),cleanText(d.title,180),cleanText(d.category,80),cleanText(d.cuisine,80),scheduleText,primaryCity,postalPrefix3,primaryAddress,cleanText(d.price,120),parsePriceTier(d.price_tier),cleanText(d.emoji,8),d.source_url || "",canSponsor && d.sponsored ? 1 : 0,status === "live" ? 1 : 0,status,d.publish_at || null,d.expires_at || null,cleanText(d.terms,2000) || null,cleanText(d.restrictions,1500) || null,cleanText(d.internal_notes,2000) || null,"needs_review",canSponsor ? 1 : 0).run();
    const curatedKeywords = Array.from(new Set(cleanText(d.curated_keywords || d.keywords,1000).split(",").map((term) => term.trim().toLowerCase()).filter((term) => term.length > 1))).slice(0,30);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deal_locations WHERE deal_id=?").bind(id),
      // Every location is deleted and reinserted wholesale rather than diffed by id — the set
      // comes from the editor as a complete replacement each save, exactly like the schedule
      // windows and curated keywords below; confirmed eligibility was already carried forward
      // into resolvedLocations above.
      ...resolvedLocations.map((loc) => env.DB.prepare("INSERT INTO deal_locations(deal_id,location_id,eligibility,source_url,verified_at) VALUES(?,?,?,?,?)").bind(id,loc.locationId,loc.eligibility,d.source_url || null,loc.verifiedAt)),
      env.DB.prepare("DELETE FROM search_terms WHERE entity_type='deal' AND entity_id=? AND source='generated'").bind(id),
      env.DB.prepare("DELETE FROM search_terms WHERE entity_type='deal' AND entity_id=? AND source='curated'").bind(id),
      ...[[d.restaurant,100],[d.title,80],[d.cuisine,40],[d.category,35]].map(([term,weight]) => env.DB.prepare("INSERT OR IGNORE INTO search_terms(entity_type,entity_id,term,weight,source,locale) VALUES('deal',?,?,?,'generated','en')").bind(id,String(term).toLowerCase(),weight)),
      ...curatedKeywords.map((term) => env.DB.prepare("INSERT INTO search_terms(entity_type,entity_id,term,weight,source,locale) VALUES('deal',?,?,25,'curated',?) ON CONFLICT(entity_type,entity_id,term,locale) DO UPDATE SET source='curated',weight=25").bind(id,term,d.locale === "fr" ? "fr" : "en")),
      // Every window is deleted and reinserted wholesale rather than diffed by id — this deal's
      // whole set of windows is small (almost always 1-3) and comes from the editor as a
      // complete replacement each save, exactly like curated_keywords above.
      env.DB.prepare("DELETE FROM deal_schedules WHERE deal_id=?").bind(id),
      ...scheduleWindows.map((w) => env.DB.prepare("INSERT INTO deal_schedules(deal_id,display_text,days,start_time,end_time,timezone) VALUES(?,?,?,?,?,?)").bind(id,formatScheduleText(w.days,w.start_time,w.end_time),JSON.stringify(w.days),w.start_time,w.end_time,scheduleTimezone)),
      // Same wholesale delete/reinsert as locations and schedule windows above — items have no
      // eligibility/verification state to preserve across a re-save, so no prior-lookup is needed.
      env.DB.prepare("DELETE FROM deal_items WHERE deal_id=?").bind(id),
      ...dealItems.map((item,index) => env.DB.prepare("INSERT INTO deal_items(deal_id,name,original_price,discounted_price,sort_order) VALUES(?,?,?,?,?)").bind(id,item.name,item.original_price || null,item.discounted_price,index)),
    ]);
    // The drink-advertising rules, read once the branches (and so the provinces and states) are
    // saved. A draft keeps saving with the problems listed; a live deal edited into breaking one
    // comes off the site until it is fixed, since publishing it is what the rule forbids.
    const drinkIssues = await drinkIssuesForDeal(id);
    if (drinkIssues.length) {
      const drinkBlocks = blockingDrinkIssues(drinkIssues);
      if (drinkBlocks.length && status === "live") {
        await env.DB.prepare("UPDATE deals SET status='draft',active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='live'").bind(id).run();
        auditDetails.status = "draft";
        auditDetails.drinkRules = drinkBlocks.map((issue) => issue.code);
      }
      const prefix = drinkBlocks.length && status === "live" ? "Moved back to draft: " : drinkBlocks.length ? "Can't publish until fixed: " : "Check before publishing: ";
      warning = [warning, prefix + describeDrinkIssues(drinkBlocks.length ? drinkBlocks : drinkIssues)].filter(Boolean).join(" ");
    }
  } else if (b.action === "backfill_locations") {
    // One-off cleanup, not a normal editing action: a batch of deals (mostly scraped drafts)
    // was inserted straight into `deals` without ever going through save_deal, so they carry a
    // real address/city/postal_prefix on the row itself but have no restaurant_id/location_id
    // and no deal_locations row at all — the admin locations editor has nothing to show them,
    // and they can never pass the "confirmed location" gate to go live. This finds every such
    // deal and runs it through the same restaurant/location lookup-or-create + geocode logic
    // save_deal uses, using only the deal's own already-stored fields — it never touches
    // status, schedule, or any other field. Safe to run more than once: already-linked deals
    // are excluded by the WHERE clause, so a repeat run is a no-op.
    targetType = "system";
    targetId = "backfill_locations";
    const orphans = await env.DB.prepare(
      "SELECT id,restaurant,address,city,postal_prefix,source_url,cuisine,category,title,price,description,terms,restrictions FROM deals WHERE deleted_at IS NULL AND (restaurant_id IS NULL OR location_id IS NULL)",
    ).all<{ id: string; restaurant: string; address: string; city: string; postal_prefix: string; source_url: string; cuisine: string; category: string; title: string; price: string; description: string | null; terms: string | null; restrictions: string | null }>();
    let fixed = 0;
    const failed: { id: string; error: string }[] = [];
    for (const orphan of orphans.results) {
      try {
        let restaurantId = (await env.DB.prepare("SELECT id FROM restaurants WHERE lower(name)=lower(?) LIMIT 1").bind(orphan.restaurant).first<{ id: string }>())?.id || "";
        if (!restaurantId) {
          restaurantId = `restaurant:${crypto.randomUUID()}`;
          // Classified on the way in for the same reason save_deal does it above: a restaurant
          // this action creates would otherwise sit outside both halves of the public Fast food /
          // Sit-down filter until someone ran the script. The orphan's own cuisine is used rather
          // than the empty string this used to store, since the row has one.
          const classified = classifyServiceStyle({
            name: orphan.restaurant,
            cuisine: orphan.cuisine,
            dealCopy: dealCopyForServiceStyle(orphan),
            publishesHappyHour: String(orphan.category || "").toLowerCase() === "happy hour",
          }).style;
          await env.DB.prepare("INSERT INTO restaurants(id,name,slug,website,cuisine,is_chain,service_style) VALUES(?,?,?,?,?,0,?)")
            .bind(restaurantId, cleanText(orphan.restaurant,120), `${slugify(orphan.restaurant)}-${restaurantId.slice(-6)}`, orphan.source_url || null, cleanText(orphan.cuisine,80), classified).run();
        }
        let locationId = (await env.DB.prepare("SELECT id FROM restaurant_locations WHERE restaurant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) LIMIT 1").bind(restaurantId,orphan.address,orphan.city).first<{ id: string }>())?.id || "";
        if (!locationId) {
          const typedPostal = normalizedPostal(orphan.postal_prefix);
          const isCanadianPostal = /^[A-Z]\d[A-Z]/.test(typedPostal);
          const geocoded = validPostal(typedPostal) ? await geocodePostal(typedPostal, isCanadianPostal) : null;
          const geoFallback = geocoded ? null : fallbackForPostal(typedPostal);
          locationId = `location:${crypto.randomUUID()}`;
          await env.DB.prepare("INSERT INTO restaurant_locations(id,restaurant_id,address,city,region,country,postal_prefix,full_postal,latitude,longitude,timezone,slug,official_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(
              locationId,restaurantId,cleanText(orphan.address,240),cleanText(orphan.city,100),
              geocoded?.region || geoFallback?.region || "",geocoded?.country || geoFallback?.country || (isCanadianPostal ? "CA" : "US"),
              orphan.postal_prefix,validPostal(typedPostal) ? typedPostal : null,
              geocoded?.latitude ?? geoFallback?.latitude ?? null,geocoded?.longitude ?? geoFallback?.longitude ?? null,
              geocoded?.timezone || geoFallback?.timezone || "America/Toronto",
              `${slugify(orphan.restaurant)}-${slugify(orphan.city)}-${locationId.slice(-6)}`,orphan.source_url || null,
            ).run();
        }
        await env.DB.batch([
          env.DB.prepare("UPDATE deals SET restaurant_id=?,location_id=? WHERE id=?").bind(restaurantId,locationId,orphan.id),
          env.DB.prepare("INSERT INTO deal_locations(deal_id,location_id,eligibility,source_url) VALUES(?,?,'needs_review',?) ON CONFLICT(deal_id,location_id) DO NOTHING").bind(orphan.id,locationId,orphan.source_url || null),
        ]);
        fixed++;
      } catch (e) {
        failed.push({ id: orphan.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    auditDetails.fixed = fixed;
    auditDetails.failed = failed.length;
    return Response.json({ ok: true, id: "backfill_locations", warning: null, fixed, failed });
  } else if (b.action === "lifecycle") {
    targetType = "deal";
    const status = String(b.status);
    if (
      !["draft", "scheduled", "live", "paused", "expired", "archived"].includes(
        status,
      )
    )
      return apiError(422,"INVALID_LIFECYCLE","Invalid lifecycle status.");
    if (status === "live") {
      const ready = await env.DB.prepare(
        "SELECT d.location_id,d.source_url,(SELECT COUNT(*) FROM deal_schedules s WHERE s.deal_id=d.id) schedules,(SELECT COUNT(*) FROM verification_events v WHERE v.deal_id=d.id AND v.status='verified') verified,(SELECT COUNT(*) FROM deal_locations dl WHERE dl.deal_id=d.id AND dl.eligibility='confirmed') confirmed_locations FROM deals d WHERE d.id=?",
      )
        .bind(b.id)
        .first<DealReadinessRow>();
      const fields: Record<string, string> = {};
      if (!ready?.location_id) fields.location = "Restaurant location required";
      if (!ready?.confirmed_locations) fields.location = "At least one confirmed offer location is required";
      if (!ready?.source_url) fields.source_url = "Source URL required";
      if (!ready?.schedules) fields.schedule = "Eligible schedule required";
      if (!ready?.verified) fields.verification = "Verification required";
      // A drink deal that breaks the advertising rules where it runs never goes live, whoever
      // verified it. Each issue says what to change in the copy.
      const drinkBlocks = blockingDrinkIssues(await drinkIssuesForDeal(String(b.id)));
      if (drinkBlocks.length) fields.drink_rules = describeDrinkIssues(drinkBlocks);
      if (Object.keys(fields).length)
        return apiError(422,"DEAL_NOT_READY","This deal is not ready to publish.",fields);
    }
    await env.DB.prepare("UPDATE deals SET status=?,active=? WHERE id=?")
      .bind(status, status === "live" ? 1 : 0, b.id)
      .run();
  } else if (b.action === "verify") {
    targetType = "deal";
    const deal = await env.DB.prepare(
      "SELECT d.source_url,(SELECT COUNT(*) FROM deal_locations dl WHERE dl.deal_id=d.id) locations FROM deals d WHERE d.id=?",
    )
      .bind(b.id)
      .first<{ source_url: string; locations: number }>();
    if (!deal?.source_url)
      return apiError(422,"SOURCE_REQUIRED","Add a source URL before verification.");
    // Three shapes, one statement:
    //   - an explicit locationId confirms just that one, for the per-location control;
    //   - allLocations confirms every offer location on the deal in the same batch, so a
    //     multi-location deal takes one click instead of one per address;
    //   - neither falls back to the deal's primary location, which is what every caller that
    //     predates this sent, and what the deal-list row action still sends.
    // allLocations is the caller saying "the source covers all of these", so it stays opt-in and
    // the button that sends it names the count — confirming eight addresses off a page that only
    // lists three is the one failure mode this must not make easy.
    const verifyLocationId = cleanText(b.locationId,140) || null;
    const confirmEveryLocation = !verifyLocationId && b.allLocations === true;
    auditDetails.locationId = verifyLocationId;
    auditDetails.confirmedLocations = confirmEveryLocation ? Number(deal.locations || 0) : 1;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO verification_events(deal_id,status,method,source_url,verified_by,notes) VALUES(?,'verified','source_review',?,?,?)",
      ).bind(
        b.id,
        deal.source_url,
        current.userId,
        String(b.notes || "").slice(0, 500),
      ),
      env.DB.prepare(
        "UPDATE deals SET verification_status='verified',verified_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(b.id),
      env.DB.prepare("UPDATE deal_locations SET eligibility='confirmed',source_url=?,verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE deal_id=? AND (?=1 OR location_id=COALESCE(?,(SELECT location_id FROM deals WHERE id=?)))").bind(deal.source_url,b.id,confirmEveryLocation ? 1 : 0,verifyLocationId,b.id),
    ]);
  } else if (b.action === "bulk_lifecycle") {
    // Every deal in ONE named market, behind an owner (OWNER_APPROVAL_ACTIONS). There used to be an
    // "All cities" form of this that paused the whole platform in one click; it is gone, and the
    // input check refuses it rather than treating it as a market.
    targetType = "market";
    const invalid = await bulkLifecycleInputError(b);
    if (invalid) return invalid;
    targetId = cleanText(b.city,100);
    const status = String(b.status);
    const changed = await env.DB.prepare("UPDATE deals SET status=?,active=0,updated_at=CURRENT_TIMESTAMP WHERE city=? AND deleted_at IS NULL AND status<>?")
      .bind(status, targetId, status)
      .run();
    auditDetails.changed = changed.meta?.changes ?? null;
  } else if (b.action === "publish_drafts" || b.action === "archive_drafts") {
    // The draft review screen's batch decisions (app/draft-review.ts). Publishing is verifying and
    // going live at once, so it needs both grants; the table holds publish_deals and this checks
    // the other. Each deal gets the audit rows its single actions would have written, under one
    // request id, and the response returns here rather than adding a row for the batch as a whole.
    const publishing = b.action === "publish_drafts";
    if (publishing && !hasPermission(current,"verify_deals")) return apiError(403,"PERMISSION_DENIED","Publishing drafts also verifies them, which your role does not allow.");
    const items = parseDraftBatchItems(b.items);
    if (!items) return apiError(422,"INVALID_DRAFT_BATCH",`Choose between 1 and ${MAX_DRAFT_BATCH} drafts.`);
    // One draft per decision. Approving or archiving drafts in batches made it easy to publish
    // something nobody had actually read; the review screen now works through them one at a time,
    // and the server holds to that whatever a client sends.
    if (items.length !== 1) return apiError(422,"ONE_DRAFT_AT_A_TIME","Review drafts one at a time.");
    const reason = cleanText(b.reason,500) || null;
    if (!publishing && !reason) return apiError(422,"ARCHIVE_REASON_REQUIRED","Say why this draft is being archived.",{reason:"Required"});
    const requestId = crypto.randomUUID();
    const audit = (ids: string[], action: string, status: string | null, confirmedLocations: number | null) =>
      env.DB.prepare(DRAFT_AUDIT_SQL).bind(current.userId,current.role,action,requestId,reason,ids.length,status,confirmedLocations,JSON.stringify(ids));
    if (!publishing) {
      const ids = items.map((item) => item.id);
      const [, archived] = await env.DB.batch([
        audit(ids,"lifecycle","archived",null),
        env.DB.prepare(DRAFT_ARCHIVE_SQL).bind(JSON.stringify(ids)),
        env.DB.prepare(CLEAR_STAFF_REMINDERS_SQL),
      ]);
      const count = archived.results?.length || 0;
      return Response.json({ ok: true, id: requestId, done: count, skipped: [], warning: count < ids.length ? `${ids.length - count} were no longer drafts and were left alone.` : null });
    }
    const read = await env.DB.prepare(DRAFT_BATCH_READ_SQL).bind(JSON.stringify(items.map((item) => item.id))).all<DraftBatchRow>();
    const plan = planDraftPublish(items, read.results || []);
    if (!plan.publish.length) return Response.json({ ok: true, id: requestId, done: 0, skipped: plan.skipped, warning: "None of these could be published." });
    const ids = plan.publish.map((entry) => entry.id);
    const windows = plan.publish.flatMap((entry) => entry.windows.map((w) => ({
      deal: entry.id, display: formatScheduleText(w.days,w.start,w.end), days: JSON.stringify(w.days), start: w.start, end: w.end, timezone: entry.timezone,
    })));
    const writes = [
      audit(ids,"verify",null,1),
      audit(ids,"lifecycle","live",null),
      ...(windows.length ? [env.DB.prepare(DRAFT_INSERT_SCHEDULES_SQL).bind(JSON.stringify(windows))] : []),
      env.DB.prepare(DRAFT_VERIFY_EVENTS_SQL).bind(current.userId,cleanText(b.notes,500) || "Verified in draft review",JSON.stringify(ids)),
      env.DB.prepare(DRAFT_CONFIRM_LOCATIONS_SQL).bind(JSON.stringify(ids)),
      env.DB.prepare(DRAFT_PUBLISH_SQL).bind(JSON.stringify(ids)),
      env.DB.prepare(CLEAR_STAFF_REMINDERS_SQL),
    ];
    const results = await env.DB.batch(writes);
    const count = results[writes.length - 2].results?.length || 0;
    return Response.json({
      ok: true, id: requestId, done: count, skipped: plan.skipped,
      warning: count < ids.length ? `${ids.length - count} stopped being drafts while you worked and were left alone.` : null,
    });
  } else if (b.action === "convert_suggestion") {
    targetType = "suggestion";
    const s = await env.DB.prepare("SELECT * FROM suggestions WHERE id=?")
      .bind(b.id)
      .first<SuggestionRow>();
    if (!s) return apiError(404,"SUGGESTION_NOT_FOUND","Suggestion not found.");
    if (s.status === "withdrawn") return apiError(409,"SUGGESTION_WITHDRAWN","The submitter withdrew this suggestion.");
    const id = `suggestion-${b.id}`;
    targetId = id;
    auditDetails.restaurant = s.restaurant;
    auditDetails.suggestionId = s.id;
    auditDetails.previousStatus = s.status;
    auditDetails.submitter = s.user_id ? "account" : "public";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO deals(id,restaurant,title,category,cuisine,schedule,city,postal_prefix,address,price,emoji,source_url,active,status,verification_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,'draft','needs_review')",
    )
      .bind(
        id,
        s.restaurant,
        s.deal,
        "Food deal",
        "Uncategorized",
        s.schedule,
        "Needs assignment",
        String(s.postal).replace(/\s/g, "").slice(0, 3).toUpperCase(),
        "Needs assignment",
        "Add pricing",
        "🍽️",
        "",
      )
      .run();
    const existingSchedule = await env.DB.prepare("SELECT id FROM deal_schedules WHERE deal_id=? ORDER BY id LIMIT 1").bind(id).first<{id:number}>();
    if (!existingSchedule) await env.DB.prepare("INSERT INTO deal_schedules(deal_id,display_text,timezone) VALUES(?,?,?)").bind(id,cleanText(s.schedule,180),"America/Toronto").run();
    await env.DB.prepare("UPDATE suggestions SET status='approved' WHERE id=?")
      .bind(b.id)
      .run();
  } else if (b.action === "suggestion") {
    targetType = "suggestion";
    const status = String(b.status);
    if (!["approved", "rejected", "pending"].includes(status))
      return apiError(422,"INVALID_SUGGESTION_STATUS","Invalid suggestion status.");
    const existing = await env.DB.prepare("SELECT id,status,restaurant,user_id FROM suggestions WHERE id=?").bind(b.id)
      .first<{ id: number; status: string; restaurant: string; user_id: string | null }>();
    if (!existing) return apiError(404,"SUGGESTION_NOT_FOUND","Suggestion not found.");
    if (existing.status === "withdrawn") return apiError(409,"SUGGESTION_WITHDRAWN","The submitter withdrew this suggestion.");
    // A rejection always carries a reason the submitter can read (creators see it in their
    // workspace), either one of the standard ones or a written explanation that says something.
    let rejectionReason: string | null = null;
    if (status === "rejected") {
      const decided = resolveRejectionReason(b.reasonCode, b.reason);
      if (!decided.ok) return apiError(422,"REJECTION_REASON_REQUIRED",decided.message,{reason:decided.message});
      rejectionReason = decided.text;
      auditDetails.reasonCode = decided.code;
    }
    auditDetails.restaurant = existing.restaurant;
    auditDetails.previousStatus = existing.status;
    auditDetails.submitter = existing.user_id ? "account" : "public";
    await env.DB.prepare("UPDATE suggestions SET status=?,rejection_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(status, rejectionReason, b.id)
      .run();
  } else if (b.action === "user") {
    targetType = "user";
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(String(b.role))) return apiError(422,"INVALID_ROLE","Invalid role.");
    // Read before deciding who may make this change: whether an owner is required depends on the
    // role being left as well as the one being taken.
    const targetBeforeChange = await env.DB.prepare("SELECT email,role FROM users WHERE id=?").bind(b.id).first<{ email: string; role: string }>();
    // Owner-only is about privilege escalation, so it applies to roles that can reach the admin
    // workspace — not to the workspace roles, which resolve to zero admin permissions in code and
    // therefore cannot be a step toward anything. Onboarding a creator or a restaurant is
    // day-to-day staff work and should not need an owner in the room. Moving someone *out* of a
    // workspace role is the same class of change, so it is allowed on the same terms; promoting
    // them to anything with admin reach is not.
    //
    // Both ends have to be outside the admin workspace. Checking only the role being taken let any
    // manage_users holder strip an admin, or an owner other than the pinned one, by "onboarding"
    // them as a restaurant account - and then, the account now holding a workspace role, move them
    // on to plain user. Taking admin reach away is as much an owner's call as granting it.
    const targetRoleIsWorkspace = isWorkspaceRole(String(b.role));
    const currentRole = String(targetBeforeChange?.role || "user");
    const currentRoleIsStaffManaged = isWorkspaceRole(currentRole) || currentRole === "user";
    const staffAssignable = currentRoleIsStaffManaged && (targetRoleIsWorkspace || (String(b.role) === "user" && isWorkspaceRole(currentRole)));
    if (current.role !== "owner" && !staffAssignable)
      return apiError(403,"OWNER_REQUIRED","Owner access is required for role changes other than creator and restaurant accounts.");
    if (!cleanText(b.reason,500)) return apiError(422,"ROLE_REASON_REQUIRED","Record a reason for this role change.",{reason:"Required"});
    if (b.id === current.userId && b.role !== "owner")
      return apiError(409,"SELF_DEMOTION_BLOCKED","You cannot remove your own owner access.");
    const targetUser = targetBeforeChange;
    if (isProtectedOwner(targetUser?.email))
      return apiError(409,"SUPER_OWNER_PROTECTED","This account's role is permanently protected and cannot be changed by anyone, including other owners.");
    if (b.role !== "owner") {
      const owners = await env.DB.prepare(
        "SELECT COUNT(*) count FROM users WHERE role='owner'",
      ).first<{ count: number }>();
      if (targetUser?.role === "owner" && (owners?.count || 0) <= 1)
        return apiError(409,"LAST_OWNER_BLOCKED","Radar must always have at least one owner.");
    }
    auditDetails.targetEmail = targetUser?.email;
    auditDetails.previousRole = targetUser?.role;
    auditDetails.newRole = b.role;
    // Any non-custom role change drops previously-set custom permissions (spread contributes
    // nothing when the array is empty, so this also covers the plain preset-role path).
    // A custom set cannot carry the developer-only permissions (ROLE_LOCKED_PERMISSIONS).
    const customPermissions = b.role === "custom"
      ? Array.from(new Set((Array.isArray(b.permissions) ? b.permissions : []).filter((p): p is Permission => ALL_PERMISSIONS.includes(p as Permission) && roleMayHold("custom", p as Permission))))
      : [];
    if (b.role === "custom") auditDetails.permissions = customPermissions;
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role, b.id),
      env.DB.prepare("DELETE FROM user_permissions WHERE user_id=?").bind(b.id),
      ...customPermissions.map((permission) => env.DB.prepare("INSERT INTO user_permissions(user_id,permission) VALUES(?,?)").bind(b.id, permission)),
    ]);
  } else if (b.action === "user_visibility") {
    targetType = "user";
    // Role-gated on top of manage_users, and deliberately so: hiding an account is only
    // meaningful if holding manage_users does not by itself let you see or change it. Owner and
    // admin are the two roles that see hidden accounts, so they are the two that can set the flag.
    if (current.role !== "owner" && current.role !== "admin")
      return apiError(403,"ADMIN_REQUIRED","Owner or admin access is required to change account visibility.");
    const targetUser = await env.DB.prepare("SELECT email,hidden FROM users WHERE id=?").bind(b.id).first<{ email: string; hidden: number }>();
    if (!targetUser) return apiError(404,"USER_NOT_FOUND","That account could not be found.");
    // Hiding yourself would take you out of your own list with no obvious way to put yourself
    // back — the row you would click is the row that just disappeared.
    if (b.id === current.userId) return apiError(409,"SELF_HIDE_BLOCKED","You cannot hide your own account.");
    const hidden = b.hidden ? 1 : 0;
    auditDetails.targetEmail = targetUser.email;
    auditDetails.hidden = Boolean(hidden);
    await env.DB.prepare("UPDATE users SET hidden=? WHERE id=?").bind(hidden, b.id).run();
  } else if (b.action === "referral_correction") {
    // Correcting the referral on an account: the one way a referral code changes after it is set.
    //
    // Readers can never change or remove their own (app/referral-code.ts), and that permanence is
    // what a creator relies on. Staff can, because a wrong code does happen: a typo that landed on
    // a real handle, a creator's own family account, a code applied by mistake. It moves who is paid
    // on that account's future invoices, so it is a finance decision that also needs an owner
    // (OWNER_APPROVAL_ACTIONS), always with a reason, and the old and new code go in the audit log.
    // Commissions already accrued stay with whoever earned them; refunds and voids have their own
    // path (creator_commission). An empty handle clears the referral.
    targetType = "user";
    targetId = String(b.id || "");
    const reason = cleanText(b.reason,500);
    if (!reason) return apiError(422,"REASON_REQUIRED","Record a reason for this correction.",{reason:"Required"});
    const target = await env.DB.prepare("SELECT id,email,referred_by FROM users WHERE id=?").bind(targetId).first<{ id: string; email: string; referred_by: string | null }>();
    if (!target) return apiError(404,"USER_NOT_FOUND","That account could not be found.");
    const requested = cleanText(b.handle,300);
    let handle: string | null = null;
    if (requested) {
      const lookup = await resolveReferralCode(requested,target.id);
      if (!lookup.ok) return lookup.reason === "self"
        ? apiError(422,"REFERRAL_SELF","A creator cannot be credited for their own account.",{handle:"Own account"})
        : apiError(404,"REFERRAL_CODE_NOT_FOUND","No active creator has that handle.",{handle:"Not found"});
      handle = lookup.handle;
    }
    if (handle === target.referred_by) return apiError(409,"REFERRAL_UNCHANGED","That is already this account's referral code.");
    auditDetails.email = target.email;
    auditDetails.previousHandle = target.referred_by;
    auditDetails.newHandle = handle;
    // The campaign belonged to the old link, so it goes with it.
    await env.DB.prepare("UPDATE users SET referred_by=?,referred_campaign=NULL WHERE id=?").bind(handle,target.id).run();
  } else if (b.action === "subscriber") {
    targetType = "subscriber";
    if (b.enabled) {
      const eligible = await env.DB.prepare("SELECT c.id FROM email_consents c JOIN users u ON u.id=c.user_id LEFT JOIN email_suppressions s ON lower(s.email)=lower(u.email) WHERE c.user_id=? AND c.status='confirmed' AND s.email IS NULL ORDER BY c.id DESC LIMIT 1").bind(b.id).first();
      if (!eligible) return apiError(409,"CONSENT_OR_SUPPRESSION_BLOCK","This subscriber has no confirmed consent or is suppressed.");
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET alerts_enabled=? WHERE id=?").bind(b.enabled ? 1 : 0,b.id),
      env.DB.prepare("UPDATE notification_preferences SET enabled=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(b.enabled ? 1 : 0,b.id),
    ]);
  } else if (b.action === "accept_waitlist") {
    targetType = "waitlist";
    // Accepting means inviting, and an invitation has to be deliverable. Check the global
    // rails before touching the row so the queue is never disturbed by a doomed attempt.
    if (!pilotGatesOpen()) return apiError(409,"DELIVERY_DISABLED","Email delivery is switched off, so invitations cannot be sent yet.");
    // Accept whoever the caller named, or — when no id is given — simply the next person in
    // line, using the same created_at,id ordering the queue is displayed in.
    // `latest` keeps a stale waitlisted row sitting under a later pending/confirmed one from
    // being accepted — that person is not waiting, and promoting the old row would downgrade
    // an existing confirmation back to pending.
    const latest = "c.id=(SELECT id FROM email_consents WHERE user_id=c.user_id ORDER BY id DESC LIMIT 1)";
    const entry = b.id
      ? await env.DB.prepare(`SELECT c.id,c.user_id,c.email,c.language FROM email_consents c WHERE c.id=? AND c.status='waitlisted' AND ${latest}`).bind(Number(b.id)).first<WaitlistEntry>()
      : await env.DB.prepare(`SELECT c.id,c.user_id,c.email,c.language FROM email_consents c WHERE c.status='waitlisted' AND ${latest} ORDER BY c.created_at,c.id LIMIT 1`).first<WaitlistEntry>();
    if (!entry) return apiError(404,"WAITLIST_ENTRY_NOT_FOUND","That person is no longer waiting to be accepted.");
    targetId = entry.user_id;
    const suppressed = await env.DB.prepare("SELECT 1 ok FROM email_suppressions WHERE lower(email)=?").bind(entry.email.toLowerCase()).first();
    if (suppressed) return apiError(409,"SUPPRESSED_ADDRESS","That address is suppressed and cannot be accepted into the pilot.");
    // Accepting admits them to the pilot; it does not consent on their behalf. They move to
    // 'pending' and still have to confirm from their own inbox before anything is delivered.
    await env.DB.prepare("UPDATE email_consents SET status='pending' WHERE id=?").bind(entry.id).run();
    const runtime = env as unknown as Record<string,string>;
    const token = await signEmailAction("consent",entry.user_id,entry.email),
      origin = runtime.PUBLIC_APP_URL || "https://radar.cheap",
      link = `${origin}/confirm-email?email=${encodeURIComponent(entry.email)}&token=${encodeURIComponent(token)}`;
    try {
      await sendEmail({to:entry.email,subject:"You're in — confirm your Radar deal alerts",html:`<h1>A place opened up.</h1><p>You asked to join the Radar deal alerts pilot and a place is now available. Confirm below to start receiving your roundups — nothing is sent until you do.</p><p><a href="${link}">Confirm deal alerts</a></p>`,text:`A place opened up in the Radar deal alerts pilot. Confirm to start receiving roundups: ${link}`,tag:"waitlist-accepted",metadata:{userId:entry.user_id}});
    } catch {
      // Put them back at their original place in the queue rather than silently leaving a
      // 'pending' row that never got its confirmation link.
      await env.DB.prepare("UPDATE email_consents SET status='waitlisted' WHERE id=?").bind(entry.id).run();
      return apiError(502,"EMAIL_PROVIDER_ERROR","The invitation could not be delivered, so they are still on the waitlist.");
    }
  } else if (b.action === "feedback") {
    // The same rules as an accuracy report, below: resolving records what was done, and a resolved
    // item is a decision that only a supervisor or above can reopen, saying why.
    targetType = "feedback";
    const status = String(b.status);
    if (!["open", "reviewing", "resolved"].includes(status))
      return apiError(422,"INVALID_FEEDBACK_STATUS","Invalid feedback status.");
    const existing = await env.DB.prepare("SELECT status,resolved_at FROM feedback WHERE id=?").bind(b.id).first<{ status: string; resolved_at: string | null }>();
    if (!existing) return apiError(404,"FEEDBACK_NOT_FOUND","That feedback could not be found.");
    const completed = existing.status === "resolved";
    if (completed && !hasPermission(current,"reopen_reports"))
      return apiError(403,"REOPEN_NOT_ALLOWED","This feedback is resolved. Only a supervisor or above can reopen it.");
    if (existing.status === status) return apiError(409,"NO_CHANGE",`This feedback is already ${status}.`);
    const resolution = cleanText(b.resolution,1000);
    if (status === "resolved" && !resolution)
      return apiError(422,"RESOLUTION_REQUIRED","Say what was done about this feedback before resolving it.",{resolution:"Required"});
    if (completed && !cleanText(b.reason,500))
      return apiError(422,"REOPEN_REASON_REQUIRED","Say why this feedback is being reopened.",{reason:"Required"});
    auditDetails.previousStatus = existing.status;
    if (completed) { auditDetails.reopened = true; auditDetails.completedAt = existing.resolved_at; }
    if (status === "resolved") auditDetails.completed = true;
    // Reopening keeps the old resolution text for whoever picks it up next; resolving again replaces it.
    await env.DB.prepare("UPDATE feedback SET status=?,resolution=COALESCE(?,resolution),resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END,resolved_by=CASE WHEN ?='resolved' THEN ? ELSE NULL END WHERE id=?")
      .bind(status,resolution || null,status,status,current.userId,b.id)
      .run();
  } else if (b.action === "report") {
    targetType = "report";
    const status = String(b.status);
    if (!["open","reviewing","resolved","rejected"].includes(status)) return apiError(422,"INVALID_REPORT_STATUS","Invalid report status.");
    const existing = await env.DB.prepare("SELECT status,deal_id,resolved_at FROM reports WHERE id=?").bind(b.id)
      .first<{ status: string; deal_id: string; resolved_at: string | null }>();
    if (!existing) return apiError(404,"REPORT_NOT_FOUND","That report could not be found.");
    // ONCE COMPLETED, A REPORT STAYS COMPLETED. Resolved and rejected are decisions somebody
    // recorded; changing one - back to open, or from resolved to rejected - is reopening it, which
    // only a supervisor or above may do. Checked here, on the server, whatever the screen shows.
    const completed = existing.status === "resolved" || existing.status === "rejected";
    if (completed && !hasPermission(current,"reopen_reports"))
      return apiError(403,"REOPEN_NOT_ALLOWED","This report is completed. Only a supervisor or above can reopen it.");
    if (existing.status === status) return apiError(409,"NO_CHANGE",`This report is already ${status}.`);
    const resolution = cleanText(b.resolution,1000);
    if ((status === "resolved" || status === "rejected") && !resolution)
      return apiError(422,"RESOLUTION_REQUIRED","Record what you found before closing the report.",{resolution:"Required"});
    if (completed && !cleanText(b.reason,500))
      return apiError(422,"REOPEN_REASON_REQUIRED","Say why this report is being reopened.",{reason:"Required"});
    auditDetails.dealId = existing.deal_id;
    auditDetails.previousStatus = existing.status;
    if (completed) { auditDetails.reopened = true; auditDetails.completedAt = existing.resolved_at; }
    if (status === "resolved" || status === "rejected") auditDetails.completed = true;
    // Closing a report, either way, takes its deal out of review: no longer "Re-checking", no longer
    // ranked down (app/accuracy-reports.ts). Both are decisions, so both are dated.
    // resolved_by is who closed it, shown to staff who cannot reopen it (drizzle/0072). Reopening
    // keeps the earlier resolution on the row, so whoever picks it up sees what was found before.
    await env.DB.prepare("UPDATE reports SET status=?,resolution=COALESCE(?,resolution),resolved_at=CASE WHEN ? IN ('resolved','rejected') THEN CURRENT_TIMESTAMP ELSE NULL END,resolved_by=CASE WHEN ? IN ('resolved','rejected') THEN ? ELSE NULL END WHERE id=?")
      .bind(status,resolution || null,status,status,current.userId,b.id).run();
  } else if (b.action === "resolve_staff_reminder") {
    // Somebody handled a reminder the deal itself cannot show: confirmed the end date really is the
    // end, or looked at a draft and is leaving it for now. Renewing, re-verifying or publishing the
    // deal clears its reminder without this (app/staff-reminders.ts). Conditional on still being
    // open, so two people closing it at once record one decision.
    targetType = "staff_reminder";
    const note = cleanText(b.notes,500);
    const reminder = await env.DB.prepare("SELECT kind,deal_id FROM staff_reminders WHERE id=?").bind(targetId).first<{kind:string;deal_id:string}>();
    if (!reminder) return apiError(404,"REMINDER_NOT_FOUND","That reminder no longer exists. Reload to see the latest.");
    const closed = await env.DB.prepare(
      "UPDATE staff_reminders SET status='done',resolution='confirmed',resolved_by=?,note=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'",
    ).bind(current.userId,note || null,targetId).run();
    if (!closed.meta?.changes) return apiError(409,"REMINDER_NOT_OPEN","This reminder was already handled. Reload to see the latest.");
    auditDetails.dealId = reminder.deal_id;
    auditDetails.kind = reminder.kind;
    auditDetails.note = note || null;
  } else if (b.action === "review_deal_change") {
    // A restaurant manager's edit (drizzle/0065), approved onto the deal or turned down with a
    // reason the manager reads in the portal. The request is claimed first, conditionally, so two
    // reviewers deciding the same edit cannot both apply it, or one apply what the other rejected.
    targetType = "deal_change_request";
    const decision = String(b.status);
    if (decision !== "approved" && decision !== "rejected") return apiError(422,"INVALID_REVIEW_STATUS","Approve or reject the change.");
    const note = cleanText(b.notes,500);
    if (decision === "rejected" && !note) return apiError(422,"REVIEW_NOTE_REQUIRED","Say why, so the restaurant knows what to fix.",{notes:"Required when rejecting"});
    const change = await env.DB.prepare(
      "SELECT c.*,d.restaurant_id deal_restaurant_id,d.schedule current_schedule FROM deal_change_requests c LEFT JOIN deals d ON d.id=c.deal_id AND d.deleted_at IS NULL WHERE c.id=?",
    ).bind(targetId).first<DealChangeRow>();
    if (!change || change.status !== "pending") return apiError(409,"CHANGE_NOT_PENDING","This change was already decided or replaced. Reload to see the latest.");
    if (decision === "approved" && change.deal_restaurant_id !== change.restaurant_id)
      return apiError(409,"DEAL_MOVED","This deal was deleted or moved to another restaurant since the change was made. Reject it instead.");
    if (decision === "approved") {
      // The restaurant's own wording is held to the same drink rules as staff's: approving it
      // would publish it on the live deal.
      const drinkBlocks = blockingDrinkIssues(await drinkIssuesForDeal(change.deal_id, {
        title: change.title, price: change.price, schedule: change.schedule, description: change.description, terms: change.terms,
      }));
      if (drinkBlocks.length)
        return apiError(422,"DRINK_RULES","This wording breaks a drink-advertising rule. Reject it with the reason so the restaurant can fix it.",{drink_rules:describeDrinkIssues(drinkBlocks)});
    }
    const claimed = await env.DB.prepare(
      "UPDATE deal_change_requests SET status=?,reviewed_by=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",
    ).bind(decision,current.userId,note || null,targetId).run();
    if (!claimed.meta?.changes) return apiError(409,"CHANGE_NOT_PENDING","This change was already decided or replaced. Reload to see the latest.");
    auditDetails.dealId = change.deal_id;
    auditDetails.decision = decision;
    auditDetails.note = note || null;
    if (decision === "approved") {
      // updated_at moves the data revision, which is what republishes /api/deals and queues the
      // translations again. verified_at is left alone: staff accepted the restaurant's wording,
      // they did not re-check the offer against its source.
      await env.DB.prepare(
        "UPDATE deals SET title=?,price=?,schedule=?,description=?,terms=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL",
      ).bind(change.title,change.price,change.schedule,change.description,change.terms,change.deal_id).run();
      if (change.schedule !== change.current_schedule)
        warning = "The schedule text changed. Check the deal's schedule windows match it, since those decide when it shows as available.";
    }
  } else if (b.action === "set_restaurant_photo") {
    targetType = "restaurant";
    targetId = String(b.id || "none");
    const restaurant = await env.DB.prepare("SELECT id FROM restaurants WHERE id=?").bind(b.id).first();
    if (!restaurant) return apiError(404,"RESTAURANT_NOT_FOUND","Restaurant not found.");
    const photoUrl = cleanText(b.photoUrl,600);
    if (photoUrl && !validHttpUrl(photoUrl)) return apiError(422,"INVALID_PHOTO_URL","Enter a valid image URL.",{photoUrl:"Invalid URL"});
    await env.DB.prepare("UPDATE restaurants SET photo_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(photoUrl || null,b.id).run();
  } else if (b.action === "invite_restaurant_manager") {
    targetType = "restaurant_manager";
    const restaurantId = String(b.restaurantId || "");
    const email = cleanText(b.email,200).toLowerCase();
    if (!restaurantId) return apiError(422,"RESTAURANT_REQUIRED","Choose a restaurant.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError(422,"INVALID_EMAIL","Enter a valid email address.",{email:"Invalid email"});
    const restaurant = await env.DB.prepare("SELECT id,name FROM restaurants WHERE id=?").bind(restaurantId).first<{id:string;name:string}>();
    if (!restaurant) return apiError(404,"RESTAURANT_NOT_FOUND","Restaurant not found.");
    const inviteId = `manager:${crypto.randomUUID()}`;
    targetId = inviteId;
    await env.DB.prepare("INSERT INTO restaurant_managers(id,restaurant_id,invited_email,status,invited_by) VALUES(?,?,?,'pending',?)")
      .bind(inviteId,restaurantId,email,current.userId).run();
    const runtime = env as unknown as Record<string,string>;
    const origin = runtime.PUBLIC_APP_URL || "https://radar.cheap";
    const token = await signEmailAction("restaurant_invite",inviteId,email);
    const link = `${origin}/portal-invite/${encodeURIComponent(inviteId)}?token=${encodeURIComponent(token)}`;
    let delivered = false;
    try {
      await sendEmail({to:email,subject:`You’ve been invited to manage ${restaurant.name} on Radar`,html:`<h1>Manage ${escapeHtml(restaurant.name)} on Radar</h1><p>You’ve been invited to manage this restaurant’s deals and photo on Radar.</p><p><a href="${link}">Accept invitation</a></p>`,text:`Accept your Radar restaurant-manager invitation: ${link}`,tag:"restaurant-manager-invite",metadata:{inviteId}});
      delivered = true;
    } catch { /* Pilot allowlist or provider issue — the admin still gets a copyable link below. */ }
    await env.DB.prepare(
      "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,request_id,reason,details) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(current.userId,current.role,"invite_restaurant_manager","restaurant_manager",inviteId,crypto.randomUUID(),cleanText(b.reason,500) || null,JSON.stringify({restaurantId,email,delivered})).run();
    return Response.json({ ok:true,invite:{id:inviteId,email,link,delivered} });
  } else if (b.action === "revoke_restaurant_manager") {
    targetType = "restaurant_manager";
    targetId = String(b.id || "none");
    await env.DB.prepare("UPDATE restaurant_managers SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.id).run();
  } else if (b.action === "creator_profile") {
    // The handle is the public half of a creator's tracked link and the key every attributed
    // visit and sign-up is stamped with, so it is staff-set and unique — a creator can neither
    // choose nor change their own. Clearing it removes the profile and with it the workspace,
    // while leaving every attributed row that already names the handle intact.
    targetType = "creator_profile";
    targetId = String(b.id || "");
    const targetUser = await env.DB.prepare("SELECT email,role FROM users WHERE id=?").bind(b.id).first<{ email: string; role: string }>();
    if (!targetUser) return apiError(404,"USER_NOT_FOUND","That account could not be found.");
    auditDetails.targetEmail = targetUser.email;
    const handle = cleanText(b.handle,32).toLowerCase();
    if (!handle) {
      await env.DB.prepare("DELETE FROM creator_profiles WHERE user_id=?").bind(b.id).run();
      auditDetails.handle = null;
    } else {
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(handle))
        return apiError(422,"INVALID_HANDLE","A handle is 2–32 characters: lowercase letters, numbers and hyphens, starting with a letter or number.",{handle:"Invalid handle"});
      if (targetUser.role !== "creator")
        return apiError(409,"NOT_A_CREATOR","Set this account's role to Creator before giving it a handle.");
      const taken = await env.DB.prepare("SELECT user_id FROM creator_profiles WHERE handle=? AND user_id<>?").bind(handle,b.id).first();
      if (taken) return apiError(409,"HANDLE_TAKEN","Another creator already uses that handle.",{handle:"Already taken"});
      const held = await env.DB.prepare("SELECT handle FROM creator_profiles WHERE user_id=?").bind(b.id).first<{ handle: string }>();
      if (held?.handle !== handle) {
        if (held && await handleHasHistory(held.handle))
          return apiError(409,"HANDLE_HAS_HISTORY","This creator already has referrals or commissions under their handle, so it cannot be changed.",{handle:"Cannot be changed"});
        if (await handleHasHistory(handle))
          return apiError(409,"HANDLE_HAS_HISTORY","That handle has earlier referrals or commissions and cannot be given to another account.",{handle:"Already used"});
      }
      const status = b.status === "paused" ? "paused" : "active";
      // The rate is the one field here that is worth money, so an edit that does not mention it
      // must leave it exactly as it was — a dialog saving a display-name change is not consent to
      // reset someone's commission to the default. Absent means unchanged, and only a real
      // number replaces it. Past commissions are unaffected either way: rate_bps is stamped on
      // each row when it accrues, so this only ever changes what is earned from here on.
      const existing = await env.DB.prepare("SELECT commission_rate_bps FROM creator_profiles WHERE user_id=?")
        .bind(b.id).first<{ commission_rate_bps: number }>();
      const requestedRate = Number(b.commissionRateBps);
      const rateBps = b.commissionRateBps === undefined || b.commissionRateBps === null || b.commissionRateBps === "" || !Number.isFinite(requestedRate)
        ? existing?.commission_rate_bps ?? 2000
        : Math.max(0, Math.min(10_000, Math.round(requestedRate)));
      // What a creator earns is a finance decision, like approving their application; managing
      // accounts is not enough to change it.
      if (rateBps !== (existing?.commission_rate_bps ?? 2000) && !hasPermission(current,"manage_finance"))
        return apiError(403,"PERMISSION_DENIED","Changing a commission rate needs the finance permission.",{commissionRateBps:"Finance only"});
      auditDetails.handle = handle;
      auditDetails.status = status;
      auditDetails.commissionRateBps = rateBps;
      await env.DB.prepare(
        `INSERT INTO creator_profiles(user_id,handle,display_name,status,notes,commission_rate_bps) VALUES(?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET handle=excluded.handle,display_name=excluded.display_name,status=excluded.status,notes=excluded.notes,commission_rate_bps=excluded.commission_rate_bps,updated_at=CURRENT_TIMESTAMP`,
      ).bind(b.id,handle,cleanText(b.displayName,120) || null,status,cleanText(b.notes,500) || null,rateBps).run();
    }
  } else if (b.action === "creator_application") {
    // Approval is the single step that turns an applicant into a creator: the role, the profile
    // and the handle all land together, because any two of the three without the third is a
    // half-made account someone has to finish by hand. The handle is taken from the reviewer's
    // input, defaulting to what was requested — approving is agreeing to a name, not inheriting
    // one, which is what keeps the staff-set guarantee true.
    targetType = "creator_application";
    targetId = String(b.id || "");
    const application = await env.DB.prepare(
      "SELECT id,user_id,email,requested_handle,status FROM creator_applications WHERE id=?",
    ).bind(b.id).first<{ id: number; user_id: string; email: string; requested_handle: string; status: string }>();
    if (!application) return apiError(404,"APPLICATION_NOT_FOUND","That application could not be found.");
    if (application.status !== "pending")
      return apiError(409,"APPLICATION_REVIEWED","This application has already been reviewed.");
    auditDetails.targetEmail = application.email;
    const decision = b.decision === "approve" ? "approve" : "reject";
    auditDetails.decision = decision;
    if (decision === "reject") {
      // The applicant is emailed this, so a rejection without one is refused rather than sent blank.
      const rejectionReason = cleanText(b.reason,500) || null;
      if (!rejectionReason) return apiError(422,"REASON_REQUIRED","Say why this application is being rejected. The applicant is sent the reason.",{reason:"Required"});
      await env.DB.prepare(
        "UPDATE creator_applications SET status='rejected',rejection_reason=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(rejectionReason,current.userId,b.id).run();
      warning = await notifyCreatorDecision({ email: application.email, approved: false, handle: application.requested_handle, reason: rejectionReason, rateBps: 0, origin });
    } else {
      const handle = (cleanText(b.handle,32) || application.requested_handle).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(handle))
        return apiError(422,"INVALID_HANDLE","A handle is 2–32 characters: lowercase letters, numbers and hyphens, starting with a letter or number.",{handle:"Invalid handle"});
      const taken = await env.DB.prepare("SELECT user_id FROM creator_profiles WHERE handle=? AND user_id<>?")
        .bind(handle,application.user_id).first();
      if (taken) return apiError(409,"HANDLE_TAKEN","Another creator already uses that handle.",{handle:"Already taken"});
      const held = await env.DB.prepare("SELECT handle FROM creator_profiles WHERE user_id=?").bind(application.user_id).first<{ handle: string }>();
      if (held?.handle !== handle && await handleHasHistory(handle))
        return apiError(409,"HANDLE_HAS_HISTORY","That handle has earlier referrals or commissions and cannot be given to another account.",{handle:"Already used"});
      // Refused rather than worked around. Promoting whatever role the account already has would
      // quietly take away a restaurant manager's portal or an admin's workspace; skipping the
      // promotion instead would leave a profile and a handle attached to someone who then cannot
      // open /creator at all, because that entry check wants the role too. Both are worse than
      // saying so, and the fix — change the role on purpose first — takes one click in this tab.
      const account = await env.DB.prepare("SELECT role FROM users WHERE id=?")
        .bind(application.user_id).first<{ role: string }>();
      if (!account) return apiError(404,"USER_NOT_FOUND","The account behind this application no longer exists.");
      if (account.role !== "user" && account.role !== "creator")
        return apiError(409,"ROLE_IN_USE",`This account is currently ${formatRole(account.role)}. Change its role to Creator first, so nothing it already has is taken away by an approval.`);
      const rateBps = Number.isFinite(Number(b.commissionRateBps)) ? Math.max(0,Math.min(10_000,Math.round(Number(b.commissionRateBps)))) : 2000;
      auditDetails.handle = handle;
      auditDetails.commissionRateBps = rateBps;
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET role='creator' WHERE id=? AND role='user'").bind(application.user_id),
        env.DB.prepare(
          `INSERT INTO creator_profiles(user_id,handle,status,commission_rate_bps) VALUES(?,?,'active',?)
           ON CONFLICT(user_id) DO UPDATE SET handle=excluded.handle,status='active',commission_rate_bps=excluded.commission_rate_bps,updated_at=CURRENT_TIMESTAMP`,
        ).bind(application.user_id,handle,rateBps),
        env.DB.prepare(
          "UPDATE creator_applications SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).bind(current.userId,b.id),
      ]);
      // After the batch, never inside it. The approval is the thing that has to hold; an email
      // that cannot be sent is worth a warning, not a rolled-back role change.
      warning = await notifyCreatorDecision({ email: application.email, approved: true, handle, reason: null, rateBps, origin });
    }
  } else if (b.action === "creator_commission") {
    // Deciding a commission. Rows are marked, never deleted: an affiliate who was shown a figure
    // has to be able to find it again, and a decided row explains itself where a missing one
    // cannot.
    //
    // 'paid' IS NOT IN THIS LIST, ON PURPOSE. It used to be, and it was a lie: a member of staff
    // clicked "Mark paid", the row said paid, and no money had moved anywhere. A commission
    // becomes paid in exactly one way now — a Stripe transfer for a payout that covers it
    // settles, and the webhook writes it (see app/affiliate-payouts.ts). What staff can do here
    // is decide whether a commission is owed at all:
    //
    //   approved  release the hold early, making it payable now
    //   rejected  refuse it, with a reason the affiliate can read
    //   void      the payment behind it came back
    //   pending   put it back into the hold
    targetType = "creator_commission";
    targetId = String(b.id || "");
    const status = String(b.status || "");
    if (!["pending","approved","void","rejected"].includes(status)) return apiError(422,"INVALID_COMMISSION_STATUS","Invalid commission status.");
    const reason = cleanText(b.reason,500);
    if (status === "rejected" && !reason) return apiError(422,"REASON_REQUIRED","Say why this commission is being refused.",{reason:"Required"});
    const commission = await env.DB.prepare("SELECT id,handle,commission_amount,currency,status,payout_id FROM creator_commissions WHERE id=?")
      .bind(b.id).first<{ id: number; handle: string; commission_amount: number; currency: string; status: string; payout_id: number | null }>();
    if (!commission) return apiError(404,"COMMISSION_NOT_FOUND","That commission could not be found.");
    // A commission a payout is already carrying is not staff's to move. Editing it here would
    // leave the payout's amount describing money that is no longer in it — reverse the payout
    // instead, which puts every commission in it back.
    if (commission.payout_id !== null) return apiError(409,"COMMISSION_IN_PAYOUT","This commission is part of a payout. Reverse the payout first.");
    if (commission.status === "paid") return apiError(409,"COMMISSION_ALREADY_PAID","This commission has already been paid out.");
    auditDetails.handle = commission.handle;
    auditDetails.amount = commission.commission_amount;
    auditDetails.currency = commission.currency;
    auditDetails.status = status;
    if (reason) auditDetails.reason = reason;
    await env.DB.prepare(
      `UPDATE creator_commissions
          SET status=?,
              rejection_reason=CASE WHEN ?='rejected' THEN ? ELSE NULL END,
              approved_at=CASE WHEN ?='approved' THEN COALESCE(approved_at,CURRENT_TIMESTAMP) ELSE NULL END
        WHERE id=? AND payout_id IS NULL AND status<>'paid'`,
    ).bind(status,status,reason || null,status,b.id).run();
  } else if (b.action === "affiliate_payout") {
    // Paying an affiliate, initiated by staff rather than by the affiliate themselves — for the
    // person who asks by email, or a balance somebody wants settled before a quarter closes.
    //
    // It is the same engine the portal's own button uses, deliberately: the payout row is
    // created first and its id is the Stripe idempotency key, the commissions are claimed by a
    // conditional UPDATE, the amount is read back from what was actually claimed, and only then
    // does Stripe get called. Nothing about the amount comes from this request — staff choose an
    // affiliate and a currency, and the ledger decides the rest. There is no field here that
    // could pay out more than is owed.
    targetType = "creator_payout";
    const handle = cleanText(b.handle,32).toLowerCase();
    const currency = cleanText(b.currency,3).toLowerCase();
    if (!handle) return apiError(422,"INVALID_HANDLE","Choose an affiliate to pay.");
    if (!/^[a-z]{3}$/.test(currency)) return apiError(422,"INVALID_CURRENCY","Choose a currency to pay in.");
    const affiliate = await env.DB.prepare("SELECT handle,status FROM creator_profiles WHERE handle=?")
      .bind(handle).first<{ handle: string; status: string }>();
    if (!affiliate) return apiError(404,"AFFILIATE_NOT_FOUND","That affiliate could not be found.");
    if (affiliate.status !== "active") return apiError(409,"AFFILIATE_INACTIVE","This affiliate account is not active.");
    const result = await requestPayout({ handle, currency, initiatedBy: current.userId });
    if (!result.ok) return apiError(409,result.blocker.toUpperCase(),result.message);
    targetId = String(result.payoutId);
    auditDetails.handle = handle;
    auditDetails.amount = result.amount;
    auditDetails.currency = result.currency;
    auditDetails.transferId = result.transferId;
  } else if (b.action === "set_role_permission") {
    targetType = "role_permission";
    // Owner-only, like every role change that reaches the admin workspace. manage_users alone used
    // to be enough, so a preset holding it could grant itself manage_sponsorships and the payout
    // actions, undoing the approve/pay split app/permissions.ts describes - or an admin could
    // revoke read_admin from the admin preset and lock every admin out.
    if (current.role !== "owner") return apiError(403,"OWNER_REQUIRED","Owner access is required to change role permissions.");
    const targetRole = String(b.role || "");
    const permission = String(b.permission || "") as Permission;
    // Rejects the workspace roles too: their permission set is decided in app/auth.ts, so a row
    // written here would be silently ignored and read as a grant that is not one.
    if (!(ALL_ROLES as readonly string[]).includes(targetRole) || FIXED_PERMISSION_ROLES.includes(targetRole)) return apiError(422,"INVALID_ROLE","Invalid role.");
    if (!ALL_PERMISSIONS.includes(permission)) return apiError(422,"INVALID_PERMISSION","Invalid permission.");
    const granted = !!b.granted;
    // Exports and the developer tools belong to the developer role alone (ROLE_LOCKED_PERMISSIONS).
    // app/auth.ts would ignore the row anyway; refusing it here keeps the grid from showing a grant
    // that is not one.
    if (granted && !roleMayHold(targetRole,permission)) return apiError(422,"ROLE_LOCKED_PERMISSION",`${permission} can only be held by the developer role.`);
    targetId = `${targetRole}:${permission}`;
    if (granted) await env.DB.prepare("INSERT OR IGNORE INTO role_permissions(role,permission) VALUES(?,?)").bind(targetRole,permission).run();
    else await env.DB.prepare("DELETE FROM role_permissions WHERE role=? AND permission=?").bind(targetRole,permission).run();
  } else if (b.action === "plan_grant") {
    // Giving somebody Pro without a Stripe subscription, or taking a grant back.
    //
    // Every support desk needs this and Radar had no way to do it at all: a customer owed a comped
    // month after a bad experience, a refund being sorted out where access should continue, an App
    // Review account that has to see the paid features. The alternative people reach for is editing
    // the database by hand, which leaves no record of who did it or why.
    //
    // A grant is a row, not just a flipped column. `users.plan` says somebody has Pro; only
    // plan_grants can answer "why does this account have Pro with no subscription behind it", and
    // that question always gets asked eventually.
    //
    // Writes neither users.plan nor plan_status itself. resolvePlan decides both from every source
    // at once - Stripe, Apple and the grants - so a grant is Pro wherever isProPlan is asked, and it
    // never writes into the status column while a Stripe subscription is using it
    // (app/plan-resolution.ts). Setting plan='pro' here and leaving the status alone is what this
    // used to do, and it granted nothing: a free account's status is "inactive", and Pro needs
    // "active".
    targetType = "user";
    targetId = String(b.id || "");
    const reason = cleanText(b.reason,500);
    if (!reason) return apiError(422,"GRANT_REASON_REQUIRED","Record a reason for this grant.",{reason:"Required"});
    // Addressed by id from a user row, or by email from the support screen - whoever is doing this
    // is usually reading a support message and has the address, not an internal id.
    const byEmail = cleanText(b.email,200).toLowerCase();
    if (!b.id && !byEmail) return apiError(422,"USER_REQUIRED","Name the account by id or email.",{email:"Required"});
    const target = b.id
      ? await env.DB.prepare("SELECT id,email FROM users WHERE id=?")
          .bind(b.id).first<{ id: string; email: string }>()
      : await env.DB.prepare("SELECT id,email FROM users WHERE lower(email)=?")
          .bind(byEmail).first<{ id: string; email: string }>();
    if (!target) return apiError(404,"USER_NOT_FOUND","That account could not be found.");
    targetId = target.id;
    const granting = b.granted !== false;
    auditDetails.email = target.email;
    auditDetails.granted = granting;
    if (granting) {
      // An expiry is optional, and when given it is a plain date the operator typed. Stored as-is:
      // the day it names is still covered, and resolvePlan and the billing job that ends lapsed
      // grants both compare it with date('now'), a UTC date in the same shape.
      const expiresAt = cleanText(b.expiresAt,30) || null;
      if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return apiError(422,"INVALID_EXPIRY","Use YYYY-MM-DD for the expiry date.",{expiresAt:"Use YYYY-MM-DD"});
      // A date already gone would record a grant that grants nothing.
      if (expiresAt && expiresAt < new Date().toISOString().slice(0,10)) return apiError(422,"INVALID_EXPIRY","That date has already passed.",{expiresAt:"Already passed"});
      auditDetails.expiresAt = expiresAt;
      await env.DB.prepare("INSERT INTO plan_grants(user_id,granted_by,reason,expires_at) VALUES(?,?,?,?)").bind(target.id,current.userId,reason,expiresAt).run();
    } else {
      // Revoking closes the grants, and the plan is then decided from what is left. A customer with
      // a real subscription as well as a comp keeps Pro; one with only the comp goes back to free.
      await env.DB.prepare("UPDATE plan_grants SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").bind(target.id).run();
    }
    await resolvePlan(target.id);
  } else if (b.action === "creator_pick") {
    // Staff can remove a pick; nobody can add or write one from here. A byline says a named
    // creator recommends this, and an admin tool that could put words next to somebody's name
    // would make every byline on the site deniable. Editing belongs to the creator alone -
    // app/api/creator/route.ts - and moderation is a removal.
    targetType = "creator_pick";
    targetId = `${String(b.handle || "")}:${String(b.dealId || "")}`;
    const removed = await env.DB.prepare("DELETE FROM creator_picks WHERE handle=? AND deal_id=?")
      .bind(String(b.handle || ""), String(b.dealId || "")).run();
    if (!removed.meta.changes) return apiError(404, "PICK_NOT_FOUND", "That pick could not be found.");
    auditDetails.handle = String(b.handle || "");
    auditDetails.dealId = String(b.dealId || "");
  } else if (b.action === "setting") {
    // An operator switch, flipped without a deploy. The key is checked against the allow-list in
    // app/settings.ts rather than trusted, so a typo is refused instead of quietly written to a row
    // nothing reads - which would look exactly like a switch that does not work.
    targetType = "setting";
    targetId = String(b.key || "");
    if (!isSettingKey(b.key)) return apiError(422,"INVALID_SETTING","Unknown setting.");
    const enabled = b.granted !== false;
    auditDetails.setting = String(b.key);
    auditDetails.enabled = enabled;
    await writeSetting(b.key, enabled, current.userId);
  } else if (b.action === "decide_owner_approval") {
    // An owner deciding a request somebody else made for an owner-approval action. Approving runs
    // the stored request exactly as it was asked, as the owner, through this same function - so it
    // meets every check the action has, and writes the action's own audit row naming the approval.
    // The row is claimed before anything runs, so two owners clicking at once run it once.
    targetType = "owner_approval";
    if (current.role !== "owner") return apiError(403,"OWNER_REQUIRED","Only an owner can decide an approval request.");
    const decision = String(b.decision);
    if (decision !== "approve" && decision !== "decline") return apiError(422,"INVALID_DECISION","Approve or decline the request.");
    const note = cleanText(b.notes,500) || null;
    if (decision === "decline" && !note) return apiError(422,"DECISION_NOTE_REQUIRED","Say why, so the person who asked knows.",{notes:"Required when declining"});
    const request = await env.DB.prepare("SELECT id,action,payload,summary,requested_by,status FROM owner_approvals WHERE id=?").bind(targetId)
      .first<{ id: string; action: string; payload: string; summary: string | null; requested_by: string; status: string }>();
    if (!request || request.status !== "pending") return apiError(409,"APPROVAL_NOT_PENDING","This request was already decided or withdrawn. Reload to see the latest.");
    if (b.confirmed !== true) return apiError(409,"CONFIRMATION_REQUIRED","Confirm this decision before it can run.");
    const claimed = await env.DB.prepare("UPDATE owner_approvals SET status=?,decided_by=?,decision_note=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
      .bind(decision === "approve" ? "approved" : "declined",current.userId,note,targetId).run();
    if (!claimed.meta?.changes) return apiError(409,"APPROVAL_NOT_PENDING","This request was already decided or withdrawn. Reload to see the latest.");
    auditDetails.decision = decision;
    auditDetails.requestedAction = request.action;
    auditDetails.requestedBy = request.requested_by;
    // What was asked, in the words the request was filed under, so the log can name it.
    if (request.summary) auditDetails.summary = request.summary;
    if (decision === "approve") {
      let stored: AdminActionBody;
      try { stored = JSON.parse(request.payload) as AdminActionBody; } catch { stored = {}; }
      // Only ever one of the actions that are meant to come through here, and only the one asked.
      if (String(stored.action) !== request.action || !needsOwnerApproval(request.action)) {
        await env.DB.prepare("UPDATE owner_approvals SET status='failed',result=? WHERE id=?").bind("The stored request was not an owner-approval action.",targetId).run();
        return apiError(422,"INVALID_APPROVAL","This request cannot be run.");
      }
      const outcome = await performAction(current,{ ...stored, confirmed: true, approvalId: request.id },origin);
      let message = "";
      try { const body = await outcome.clone().json() as { warning?: string | null; error?: { message?: string } }; message = body.error?.message || body.warning || ""; } catch { message = ""; }
      if (!outcome.ok) {
        await env.DB.prepare("UPDATE owner_approvals SET status='failed',result=? WHERE id=?").bind(message.slice(0,500) || `Failed (${outcome.status})`,targetId).run();
        auditDetails.failed = true;
        warning = `Approved, but it could not run: ${message || "the action was refused"}`;
      } else {
        await env.DB.prepare("UPDATE owner_approvals SET result=? WHERE id=?").bind(message.slice(0,500) || "Done",targetId).run();
        warning = message || null;
      }
    }
  } else if (b.action === "cancel_owner_approval") {
    // Withdrawing a request you made, while it is still waiting.
    targetType = "owner_approval";
    const withdrawn = await env.DB.prepare("UPDATE owner_approvals SET status='canceled',decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND requested_by=?")
      .bind(current.userId,targetId,current.userId).run();
    if (!withdrawn.meta?.changes) return apiError(409,"APPROVAL_NOT_PENDING","Only your own waiting requests can be withdrawn.");
  } else {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }
  await env.DB.prepare(
    "INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,request_id,reason,details) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      current.userId,
      current.role,
      String(b.action),
      targetType,
      targetId,
      crypto.randomUUID(),
      cleanText(b.reason,500) || null,
      JSON.stringify({
        status: b.status, city: b.city, sponsored: b.sponsored, enabled: b.enabled,
        role: b.role, permission: b.permission, granted: b.granted,
        email: b.email, restaurantId: b.restaurantId, resolution: b.resolution,
        approvalId: typeof b.approvalId === "string" ? b.approvalId : undefined,
        ...auditDetails,
      }).slice(0,1500),
    )
    .run();
  return Response.json({ ok: true, id: targetId, warning });
}
