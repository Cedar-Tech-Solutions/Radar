"use client";
// What every dashboard section shares: the account data /api/user answers with, the handle each
// section gets on it, and the small pieces more than one section draws (an empty state, a deal row,
// a plan upsell, a date). The shell (DashboardClient.tsx) owns loading, saving and the notice line;
// a section only reads `data` and asks the shell to save.
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, MapPin } from "lucide-react";
import ChromeLink from "../../ChromeLink";
import RadarScan from "../../RadarScan";
import { Link } from "../../../i18n/navigation";
import { dateFormatLocale } from "../../verification";
import type { DeliveryReason } from "../../delivery-history";
import type { Billing } from "../../plan-resolution";
import type { DiscountTerms } from "../../save-offers";

export interface PublicDeal {
  id: string;
  slug: string | null;
  restaurant: string;
  title: string;
  city: string;
  cuisine: string;
  emoji: string;
  canonical_restaurant_id: string | null;
}

/** A saved deal, as /api/user reads it from the deal itself rather than from a search. */
export interface SavedDeal extends PublicDeal {
  region: string | null;
  /** Whether the deal's own page still exists: 'hidden' has none, so it is not linked. */
  page: "public" | "retired" | "hidden";
  /** Public and not past its end date. */
  live: boolean;
  saved_at: string;
}

export interface ExcludedRestaurant {
  restaurant_id: string;
  name: string;
  cuisine: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  role: string;
  home_postal: string | null;
  status: string;
  language: string;
  timezone: string;
  country: string;
  distance_unit: string;
  theme: string;
  accent_color: string;
  past_due_since: string | null;
  paused_until: string | null;
  plan: string;
  plan_status: string;
  created_at: string;
  /** Who is paying for Pro right now: Apple, Stripe, or nobody (a comp, or not on Pro). */
  billing?: Billing;
  /** A Stripe subscription that is not over, which is what Stripe's controls act on. */
  web_subscription?: boolean;
  /** The account's referral code, and whether the reader can still add one (app/referral-code.ts). */
  referral?: { code: string | null; can_add: boolean; window_ends_at: string | null };
}

export interface SavedLocation {
  id: number;
  user_id: string;
  label: string;
  postal: string;
  radius: number;
  active: number;
  is_default: number;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  region: string | null;
  country: string;
  timezone: string;
  preferences: string;
  sort_order: number;
  created_at: string;
}

export interface NotificationPreference {
  id: number;
  user_id: string;
  saved_location_id: number | null;
  frequency: string;
  categories: string;
  days: string;
  delivery_time: string;
  timezone: string;
  quiet_hours: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface Consent {
  status: string;
  consented_at?: string | null;
  revoked_at?: string | null;
  policy_version?: string;
}

export interface EmailDelivery {
  id: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  opened: boolean;
  // A translatable bucket, not the provider's raw error — /api/user keeps that server-side.
  reason: DeliveryReason | null;
}

export interface ComingSoonMarket {
  market: string;
  region: string;
  country: string;
}

export interface DashboardData {
  profile: UserProfile;
  favorites: string[];
  savedDeals?: SavedDeal[];
  locations?: SavedLocation[];
  excludedRestaurants?: ExcludedRestaurant[];
  notificationPreferences?: NotificationPreference[];
  consent?: Consent;
  deliveries?: EmailDelivery[];
  comingSoonMarkets?: ComingSoonMarket[];
}

export interface MutatePayload {
  action: string;
  id?: string | number;
  dealId?: string;
  saved?: boolean;
  label?: FormDataEntryValue | string | null;
  postal?: FormDataEntryValue | null;
  radius?: number;
  active?: boolean;
  enabled?: boolean;
  days?: FormDataEntryValue[];
  time?: FormDataEntryValue | null;
  name?: FormDataEntryValue | null;
  language?: FormDataEntryValue | string | null;
  country?: FormDataEntryValue | null;
  distanceUnit?: FormDataEntryValue | null;
  timezone?: FormDataEntryValue | null;
  restaurantId?: string;
  theme?: string;
  accentColor?: string;
  code?: string;
}

// The server's own `message` is English and is not read: the notice is the caller's translated
// sentence, chosen from what the request did (and, for a consent request, from `status`).
export interface MutateResult {
  ok?: boolean;
  status?: string;
  removed?: SavedLocation;
}

/** What the shell hands every section: the account as loaded, and the one way to change it. */
export interface SectionProps {
  data: DashboardData;
  pro: boolean;
  /** The action in flight, so its button can say so. Empty when nothing is. */
  busy: string;
  /** Saves one action through /api/user and shows `message` (or the translated failure). */
  mutate: (payload: MutatePayload, message: string) => Promise<MutateResult | null>;
  /** Reads the account again after a change that moves more than one thing. */
  reload: () => Promise<void>;
  setNotice: (text: string) => void;
  /** To /pro, except where the iOS app may not sell it (app/app-context.ts). */
  upgrade: () => void;
}

// Every state an email_consents row can be in, plus the "none" /api/user sends when there is no
// row. A state added later still gets a word in the reader's language rather than the raw value.
const CONSENT_STATES = ["none","pending","waitlisted","confirmed","revoked"];
export function consentState(status:string|undefined) { const state = status || "none"; return CONSENT_STATES.includes(state) ? state : "unknown"; }

/** The days and hour alerts go out on, as the account saved them. */
export function alertDaysOf(pref: Partial<NotificationPreference>): string[] {
  return Array.isArray(pref.days) ? pref.days.map(String) : String(pref.days || "").replace(/[[\]"]/g,"").split(",").filter(Boolean);
}

/**
 * Where "near you" means: the area the user marked default, else their first active tracked area,
 * else the home postal they set on their profile. Null when the account has told us nothing about
 * where it is, in which case there is no local feed at all, rather than a national one relabeled
 * "near you".
 */
export function nearbyScope(data: DashboardData) {
  const areas = data.locations || [];
  const chosen = areas.find((area) => area.is_default && area.active) || areas.find((area) => area.active) || areas[0];
  if (chosen?.postal) return { postal:chosen.postal, radius:chosen.radius, label:chosen.label as string | null, areaId:chosen.id as number | null };
  if (data.profile?.home_postal) return { postal:data.profile.home_postal, radius:null as number | null, label:null as string | null, areaId:null as number | null };
  return null;
}

// Plan upsells get their own surface rather than reusing `.launch-note`, which the same screens
// use for operational notices (email-pilot waitlist, address confirmation). When a sales message
// and a system message look identical, users learn to dismiss both.
export function ProUpsell({icon:Icon,title,body,cta}:{icon:typeof MapPin;title:string;body:string;cta:string}) {
  return <div className="pro-upsell purchase-cta"><div className="pro-upsell-icon"><Icon/></div><div className="pro-upsell-body"><b>{title}</b><p>{body}</p></div><Link className="primary purchase-cta" href="/pro">{cta}</Link></div>;
}

// A ChromeLink, which puts the reader's locale in front of the path: a bare /deals/... is a redirect
// first, to whatever language the cookie says. A client-side navigation here, where every reader
// carries the session cookie (see DashboardClient).
export function DealLink({deal}:{deal:PublicDeal}) { return <ChromeLink href={`/deals/${encodeURIComponent(deal.slug || deal.id)}`}><span className="deal-emoji">{deal.emoji || "🍽️"}</span><div><b>{deal.restaurant}</b><p>{deal.title}</p><small>{deal.city} · {deal.cuisine}</small></div><ChevronRight/></ChromeLink>; }
export function DealList({deals,empty,saveHint}:{deals:PublicDeal[];empty:string;saveHint:string}) { return <div className="favorite-grid">{deals.map((deal) => <DealLink key={deal.id} deal={deal}/>)}{!deals.length && <Empty title={empty} message={saveHint}/>}</div>; }

// The animated radar mark instead of a small static heart: an empty panel is the state most
// users see first, and it was the single flattest thing on the page. `action` replaces the default
// "Find deals" link when the next step is somewhere else.
export function Empty({title,message,action}:{title:string;message:string;action?:React.ReactNode}) { const t = useTranslations("dashboard.overview"); return <div className="portal-empty"><span className="portal-empty-art"><RadarScan/></span><h3>{title}</h3><p>{message}</p>{action ?? <Link href="/">{t("findDeals")}</Link>}</div>; }

/** The always-present loading line inside a section that fetches its own data. */
export function SectionLoading() { const t = useTranslations("dashboard"); return <div className="portal-loading-body dash-section-loading"><RadarScan/><p>{t("loadingSection")}</p></div>; }

/** A YYYY-MM-DD (or D1 "YYYY-MM-DD HH:MM:SS") stamp as a long date in the reader's language, read as UTC so it never shifts a day. */
export function formatDay(locale: string, stamp: string) {
  const at = new Date(`${stamp.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return stamp.slice(0, 10);
  return at.toLocaleDateString(dateFormatLocale(locale), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** "25 %" or "3,00 $" in the reader's language. Stripe counts amounts in the currency's minor unit. */
export function formatDiscount(locale: string, discount: DiscountTerms) {
  const format = dateFormatLocale(locale);
  if (discount.percentOff !== null) return new Intl.NumberFormat(format, { style: "percent", maximumFractionDigits: 2 }).format(discount.percentOff / 100);
  const money = new Intl.NumberFormat(format, { style: "currency", currency: (discount.currency || "cad").toUpperCase() });
  return money.format((discount.amountOff ?? 0) / 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2));
}

// Roughly how long ago, in the reader's language, rather than a clinical timestamp. The exact
// moment is still one hover away — it goes in the title and in dateTime, so nothing is actually
// lost, it is just not the first thing shown.
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60_000], ["month", 30 * 24 * 60 * 60_000], ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000], ["hour", 60 * 60_000], ["minute", 60_000],
];
export function relativeTime(locale: string, iso: string) {
  const at = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return null;
  const elapsed = at.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= size) return { label: formatter.format(Math.round(elapsed / size), unit), exact: at.toLocaleString(dateFormatLocale(locale)), iso: at.toISOString() };
  }
  return { label: formatter.format(0, "minute"), exact: at.toLocaleString(dateFormatLocale(locale)), iso: at.toISOString() };
}

/** A relative time with the exact moment one hover away; "time not recorded" when there is none. */
export function When({ stamp }: { stamp: string | null | undefined }) {
  const locale = useLocale(), t = useTranslations("dashboard.history");
  const when = stamp ? relativeTime(locale, stamp) : null;
  return when ? <time dateTime={when.iso} title={when.exact}>{when.label}</time> : <time>{t("timeUnknown")}</time>;
}
