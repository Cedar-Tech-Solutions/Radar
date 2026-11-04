// The shapes the staff workspace reads from /api/admin and sends back to it. Shared by the shell
// (AdminClient.tsx), the deal editor and every tab under tabs/.
import type { ReviewQueue } from "../../review-queue";
import type { DrinkRuleAlert } from "../../drink-rules";
import type { DraftReviewRow } from "../../draft-review";
import type { StaffReminder } from "../../staff-reminders";
import type { AdminDealChangeRequest } from "./RestaurantEditsQueue";

export interface AdminDeal {
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
  // The restaurant's, not the deal's. It is edited here because this editor is where restaurants
  // are created - see the Dining field below.
  service_style: string | null;
  emoji: string;
  source_url: string;
  sponsored: number;
  active: number;
  verified_at: string;
  status: string;
  publish_at: string | null;
  expires_at: string | null;
  terms: string | null;
  restrictions: string | null;
  internal_notes: string | null;
  verification_status: string;
  curated_keywords: string | null;
  restaurant_keywords?: string | null;
  schedules: number;
  confirmed_locations: number;
  full_postal: string | null;
  /** The offer's branch's province or state and country, for the place filters. Null for a brand-wide or national offer with no branch. */
  location_region?: string | null;
  location_country?: string | null;
  schedule_days: string | null;
  schedule_start: string | null;
  schedule_end: string | null;
  schedule_windows?: { days: string[]; start_time: string; end_time: string }[];
  restaurant_id: string | null;
  locations?: { id: string; address: string; city: string; postal_prefix: string; full_postal: string | null; eligibility: string }[];
  items?: { id: number; name: string; original_price: string | null; discounted_price: string }[];
}

export interface AdminSuggestion {
  id: number;
  restaurant: string;
  deal: string;
  postal: string;
  schedule: string;
  email: string;
  status: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  hidden?: number;
  home_postal: string | null;
  alerts_enabled: number;
  alert_days: string;
  alert_time: string;
  plan: string;
  plan_status: string;
  // Already selected by GET /api/admin; typed here for the Users tab's detail panel and filters.
  language?: string | null;
  timezone?: string | null;
  country?: string | null;
  created_at?: string;
  /** The creator handle this account is credited to (a link or a typed referral code), if any. */
  referred_by?: string | null;
  /** The pinned owner, whose role nobody can change. Computed by /api/admin; see isProtectedOwner in app/auth.ts. */
  isProtected?: boolean;
}

export interface AdminRestaurant {
  id: string;
  name: string;
  website: string | null;
  photo_url: string | null;
}

export interface AdminRestaurantManager {
  id: string;
  restaurant_id: string;
  invited_email: string;
  status: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
}

export interface AdminFeedback {
  id: number;
  /** bug | confusing | incorrect_deal | feature (app/api/feedback/route.ts). */
  type: string;
  message: string;
  status: string;
  priority?: string;
  market: string | null;
  email: string | null;
  page?: string | null;
  deal_id?: string | null;
  deal_title?: string | null;
  deal_restaurant?: string | null;
  resolution?: string | null;
  resolved_at?: string | null;
  /** Name of the staff member who resolved it; null for items resolved before drizzle/0072. */
  resolved_by_name?: string | null;
  created_at: string;
}

export interface AdminReport {
  id: number;
  category: string;
  notes: string | null;
  status: string;
  priority?: string;
  deal_id: string;
  location_id: string | null;
  source_url: string | null;
  resolution?: string | null;
  resolved_at?: string | null;
  /** Name of the staff member who closed it; null for reports closed before drizzle/0072. */
  resolved_by_name?: string | null;
  // The questioned deal, joined by the server. Null when the deal has since been deleted.
  deal_title?: string | null;
  deal_restaurant?: string | null;
  deal_status?: string | null;
  location_scope?: string | null;
  // The reported branch, else the deal's own; no city/region/postal for a brand-wide or national deal.
  city?: string | null;
  region?: string | null;
  country?: string | null;
  postal?: string | null;
  created_at: string;
}

export interface AdminAuditEvent {
  id: number;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  details: string | null;
  request_id: string | null;
  before_values: string | null;
  after_values: string | null;
  created_at: string;
}

export interface AdminMarketCoverage {
  id: string;
  market: string;
  status: string;
  active_deals: number;
  unique_restaurants: number;
  stale_percent: number;
  zero_result_searches: number;
  // The market_coverage row's own columns, which the server spreads into each row.
  region?: string;
  country?: string;
  minimum_offers?: number;
  notes?: string | null;
}

export interface AdminCampaignVisit {
  source: string | null;
  campaign: string | null;
  market: string | null;
  hits: number;
  first_seen: string;
  last_seen: string;
}

export interface AdminSponsorship {
  id: string;
  deal_id: string;
  restaurant_id: string;
  market: string;
  status: string;
  starts_at: string;
  ends_at: string;
  impression_limit: number | null;
  impressions: number;
  clicks: number;
  frequency_cap: number;
  contract_reference: string | null;
  invoice_reference: string | null;
  approved_by: string | null;
}

export interface AdminConsent {
  user_id: string;
  email: string;
  status: string;
}

export interface AdminSuppression {
  email: string;
  reason: string;
}

// One person queued for the email pilot. The server returns these already ordered by join
// time, so the array index is their place in line.
export interface AdminWaitlistEntry {
  id: number;
  user_id: string;
  email: string;
  name: string | null;
  language: string;
  created_at: string;
}

export interface AdminCreatorProfile {
  user_id: string;
  handle: string;
  display_name: string | null;
  status: string;
  commission_rate_bps?: number;
}

export interface AdminCreatorApplication {
  id: number;
  user_id: string;
  email: string;
  requested_handle: string;
  channel_url: string;
  audience: string | null;
  pitch: string | null;
  status: string;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface AdminCreatorRosterRow {
  user_id: string;
  handle: string;
  display_name: string | null;
  status: string;
  commission_rate_bps: number;
  visits: number;
  visits30: number;
  signups: number;
  money: Array<{ currency: string; invoices: number; owed: number; paid: number }>;
  campaigns: Array<{ campaign: string; visits: number; subscriptions: number; earned: number; currency: string | null }>;
  /** What this creator has put their name on, with the line they wrote for each. */
  picks: Array<{
    deal_id: string;
    note: string | null;
    position: number;
    created_at: string;
    restaurant: string | null;
    title: string | null;
    live: boolean;
  }>;
}

export interface AdminCreatorCommission {
  id: number;
  handle: string;
  invoice_id: string;
  gross_amount: number;
  currency: string;
  rate_bps: number;
  commission_amount: number;
  status: string;
  created_at: string;
  paid_at: string | null;
  /** Set once a payout has claimed this row, which is what puts it beyond hand-editing. */
  payout_id: number | null;
  approved_at: string | null;
  rejection_reason: string | null;
}

export interface AdminCreatorPayout {
  id: number;
  handle: string;
  stripe_account_id: string;
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  amount: number;
  currency: string;
  status: string;
  commission_count: number;
  failure_reason: string | null;
  initiated_by: string | null;
  created_at: string;
  paid_at: string | null;
}

/** What one affiliate is owed in one currency, and whether Stripe will take it. */
export interface AdminAffiliateBalance {
  handle: string;
  currency: string;
  available: number;
  holding: number;
  paid: number;
  payouts_enabled: number | null;
  requirements_due: number | null;
  has_account: number | null;
}

export interface AdminData {
  currentUser: { id: string; role: string; name: string; email: string; permissions: string[] };
  deals: AdminDeal[];
  // Ranked across the whole catalog by the server (app/review-queue.ts), not derived from `deals`.
  reviewQueue?: ReviewQueue;
  // Deals to renew or confirm, opened daily at noon Eastern (app/staff-reminders.ts).
  staffReminders?: StaffReminder[];
  draftReview?: DraftReviewRow[];
  // Live drink deals that break the advertising rules where they run (app/drink-rules.ts).
  drinkRuleAlerts?: DrinkRuleAlert[];
  suggestions: AdminSuggestion[];
  users: AdminUser[];
  feedback: AdminFeedback[];
  audit: AdminAuditEvent[];
  restaurants: AdminRestaurant[];
  restaurantManagers?: AdminRestaurantManager[];
  // Restaurant managers' edits waiting for review; empty without create_deals.
  dealChangeRequests?: AdminDealChangeRequest[];
  creatorProfiles?: AdminCreatorProfile[];
  creatorApplications?: AdminCreatorApplication[];
  creatorCommissions?: AdminCreatorCommission[];
  creatorPayouts?: AdminCreatorPayout[];
  affiliateBalances?: AdminAffiliateBalance[];
  creatorRoster?: AdminCreatorRosterRow[];
  reports?: AdminReport[];
  coverage?: AdminMarketCoverage[];
  /** Live and draft deals by country, province or state, city and postal area (brand-wide and national offers excluded). */
  coverageTree?: AdminCoverageNode[];
  /** Requests for an owner's authorization: all of them for an owner, your own otherwise. */
  approvals?: AdminOwnerApproval[];
  /** Everyone who can open the workspace. Email only for those who manage accounts. */
  staffDirectory?: AdminStaffMember[];
  campaignVisits?: AdminCampaignVisit[];
  sponsorships?: AdminSponsorship[];
  consents?: AdminConsent[];
  suppressions?: AdminSuppression[];
  waitlist?: AdminWaitlistEntry[];
  rolePermissions?: { role: string; permission: string }[];
  userPermissions?: { user_id: string; permission: string }[];
  // Counted across the whole catalog by the server, not derived from `deals` — that list is
  // capped at 500 rows.
  dealTotals?: {
    total: number; live: number; draft: number; scheduled: number; paused: number;
    expired: number; archived: number; unverified: number; stale: number; expiring: number;
  };
  // Which services are configured reaches the developer role only; everyone else who runs the
  // mailing list gets deliveryReady alone.
  integrations?: {
    mapbox?: boolean;
    emailPilot?: boolean;
    resend?: boolean;
    deliveryReady?: boolean;
    deliveryReadiness?: { pilotEnabled: boolean; killSwitchClear: boolean; providerConfigured: boolean; signingConfigured: boolean };
  };
  trends?: {
    signups: { day: string; count: number }[];
    deals: { day: string; count: number }[];
    visits: { day: string; count: number }[];
    dealFeedback: { helpful: number; not_helpful: number };
  };
  // Counted across the whole users/favorites/leads tables by the server, not derived from the
  // capped lists above — same reasoning as dealTotals.
  growth?: {
    users: { total: number; pro_paying: number; pro_not_paying: number; pro_trialing: number; pro_past_due: number; pro_canceled: number };
    // Saves trend, most-saved deals and lead counts are read for a date range by the Growth section
    // itself (GET /api/admin/growth; GrowthData in tabs/GrowthTab.tsx).
    favorites: { total: number };
    engagement: { saved_locations: number; digest_subscribers: number };
    /** city '' is a brand-wide or national offer, or a deal with no city recorded - never a city. */
    topCities: { city: string; region: string | null; country: string | null; count: number }[];
    topRestaurants: { restaurant: string; count: number }[];
  };
  /** Operator switches and their current state. Readable by anyone who can open the workspace. */
  settings?: Record<string, boolean>;
  settingDefinitions?: { key: string; label: string }[];
  // The money figures, for manage_finance only (null otherwise); rendered by FinancePanels.tsx.
  // Deal, search and visit figures are read by the Growth section from GET /api/admin/growth.
  // See buildGrowthMetrics in app/api/admin/route.ts.
  metrics?: {
    revenue: {
      byCurrency: { currency: string; invoices: number; total: number; last30: number }[];
      trend: { day: string; currency: string; amount: number; invoices: number }[];
    };
    subscriptions: {
      totals: { started: number; canceled: number; started30: number; canceled30: number };
      started: { day: string; count: number }[];
      canceled: { day: string; count: number }[];
    };
    affiliate: {
      totals: { creators: number; active_creators: number; pending_applications: number; referred_users: number; referred_pro: number; campaigns: number };
      commissions: { currency: string; invoices: number; pending: number; paid: number; voided: number; gross: number }[];
    };
    churn: {
      reasons: { reason: string; total: number; while_failing: number; last_seen: string }[];
      notes: { reason: string; detail: string; created_at: string }[];
    };
    grants: { id: number; user_id: string; email: string; reason: string; expires_at: string | null; created_at: string }[];
    lifecycle: {
      totals: { paused: number; trialing: number; trials_started: number; in_grace: number; winbacks_sent: number };
      saveOffers: { reason: string; offer: string; offered: number; accepted: number }[];
    };
  };
}

export interface InviteResult {
  id: string;
  email: string;
  link: string;
  delivered: boolean;
}

export interface BulkDialogState {
  city: string;
  status: string;
}

export interface AdminActionPayload {
  action: string;
  id?: string | number;
  status?: string;
  notes?: string;
  sponsored?: boolean;
  enabled?: boolean;
  resolution?: string;
  role?: string;
  reason?: string;
  photoUrl?: string;
  city?: string;
  confirmation?: string;
  /** The confirmation step was shown and accepted; the owner-approval actions refuse without it. */
  confirmed?: boolean;
  /** A suggestion rejection's standard reason (SUGGESTION_REJECTION_REASONS). */
  reasonCode?: string;
  hidden?: boolean;
  deal?: Record<string, unknown>;
  locationId?: string;
  allLocations?: boolean;
  permission?: string;
  granted?: boolean;
  permissions?: string[];
  expiresAt?: string;
  email?: string;
  currency?: string;
  key?: string;
  dealId?: string;
  market?: string;
  startsAt?: string;
  endsAt?: string;
  impressionLimit?: string;
  frequencyCap?: string;
  contractReference?: string;
  invoiceReference?: string;
  handle?: string;
  displayName?: string;
  decision?: string;
  commissionRateBps?: number;
}

export interface ActionErrorBody {
  error?: { message?: string; fields?: Record<string, string> } | string;
}

// An action that cannot be undone, held until the operator confirms it.
//
// Separate from the bulk-lifecycle dialog above, which asks the operator to type a phrase.
// That weight is right for pausing a whole market and wrong for deleting one row: a dialog
// that is tedious to clear teaches people to clear it without reading. This one is a plain
// question with the thing being destroyed named in it.
export type ConfirmDialogState = {
  /** The line over the title. Defaults to "Cannot be undone"; a switch that can be flipped back says otherwise. */
  kicker?: string;
  title: string;
  body: string;
  confirmLabel: string;
  /** Matches the `busy` key the underlying action sets, so the button can disable itself. */
  busyKey: string;
  run: () => Promise<unknown> | unknown;
};

export interface AdminCoverageNode {
  country: string;
  region: string;
  city: string;
  postal_area: string;
  deals: number;
  live: number;
  drafts: number;
  restaurants: number;
  stale: number;
}

export interface AdminOwnerApproval {
  id: string;
  action: string;
  summary: string;
  requested_by: string;
  requested_role: string;
  requester_name: string | null;
  requester_email: string | null;
  reason: string | null;
  status: "pending" | "approved" | "declined" | "canceled" | "failed";
  decided_by: string | null;
  decider_name: string | null;
  decision_note: string | null;
  decided_at: string | null;
  result: string | null;
  created_at: string;
}

export interface AdminStaffMember {
  id: string;
  name: string | null;
  role: string;
  email?: string;
  created_at: string;
}
