import { env } from "cloudflare:workers";
import { getAppUser, isPro } from "../../auth";
import { deleteAccount } from "../../account-deletion";
import { apiError, cleanText, normalizedPostal, rateLimit, readJson, requireSameOrigin, validPostal } from "../../api-utils";
import { buildDigestEmail, canDeliverTo, SAMPLE_DIGEST_DEALS, sendEmail, signEmailAction, signUnsubscribe } from "../../email";
import { ACCENTS, isAccentKey } from "../../theme-accents";
import { displayCity, resolvePostal, type GeocodeGuard } from "../../postal";
import { deliveryReason } from "../../delivery-history";
import { allowedRadii, DEFAULT_AREA_RADIUS_KM } from "../../radius";
import { alertSchedule, FREE_AREA_LIMIT, historyRows } from "../../plan-limits";
import { dealPageVisibility, publicDealPredicate } from "../../deal-lifecycle";
import { billingFor } from "../../apple-entitlement";
import { stripeOwnsStatus } from "../../plan-resolution";
import { canonicalTimezone, DEFAULT_TIMEZONE } from "../../timezones";
import { REFERRAL_WINDOW_DAYS, referralWindowEndsAt, referralWindowOpen, resolveReferralCode } from "../../referral-code";

// The languages Radar writes in, which are the locales the site ships. The account picker used to
// offer two of the three, and the coercion below turned anything that was not French into English
// — so a Spanish-speaking reader could browse the site in Spanish and had no way to say so here.
// Anything unrecognised still falls back rather than being refused: a bad language on a profile
// save should not cost somebody the rest of their profile.
const WRITING_LANGUAGES = ["en", "fr", "es"];
const writingLanguage = (value: unknown) => (WRITING_LANGUAGES.includes(String(value)) ? String(value) : "en");

interface DeliveryRow {
  id: string;
  status: string;
  sent_at: string | null;
  created_at: string;
  error_code: string | null;
  opened: number;
}

// A saved deal as the dashboard lists it. `page` is what the deal's own page is now
// (dealPageVisibility): 'public' and 'retired' pages exist and are linked, a 'hidden' one does not.
// `live` is public and not past its own end date, which is what "still listed" means to a reader.
interface SavedDealRow {
  id: string;
  slug: string | null;
  restaurant: string;
  title: string;
  city: string;
  region: string | null;
  cuisine: string;
  emoji: string;
  canonical_restaurant_id: string | null;
  page: "public" | "retired" | "hidden";
  live: number;
  saved_at: string;
}

interface ConsentRow {
  status: string;
  consented_at: string | null;
  revoked_at: string | null;
  policy_version: string;
}

interface UserActionBody {
  action?: unknown;
  dealId?: unknown;
  saved?: unknown;
  postal?: unknown;
  days?: unknown;
  time?: unknown;
  enabled?: unknown;
  language?: unknown;
  radius?: unknown;
  label?: unknown;
  id?: unknown;
  active?: unknown;
  name?: unknown;
  country?: unknown;
  distanceUnit?: unknown;
  confirm?: unknown;
  timezone?: unknown;
  restaurantId?: unknown;
  theme?: unknown;
  accentColor?: unknown;
  code?: unknown;
}

interface SavedLocationRow {
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

async function consentFor(userId: string) {
  return env.DB.prepare("SELECT status,consented_at,revoked_at,policy_version FROM email_consents WHERE user_id=? ORDER BY id DESC LIMIT 1").bind(userId).first<ConsentRow>();
}

// Deliberately no queue position is exposed to the person waiting. Staff work the list in the
// order people joined, but places can be skipped (a suppressed address, a bounced invite), so
// telling someone they are "number 3" would promise an order of admission that is not
// guaranteed. The admin workspace still sees the full ordered queue.

export async function GET() {
  const user = await getAppUser();
  if (!user) return apiError(401,"AUTH_REQUIRED","Sign in required.");
  const pro = isPro(user);
  const [profile,favs,savedDeals,locations,savedRestaurants,excludedRestaurants,preferences,consent,deliveries,comingSoonMarkets] = await Promise.all([
    env.DB.prepare("SELECT id,email,name,role,home_postal,status,language,timezone,country,distance_unit,theme,accent_color,plan,plan_status,past_due_since,paused_until,created_at,stripe_subscription_id,referred_by FROM users WHERE id=?").bind(user.userId)
      .first<Record<string, unknown> & { plan_status: string | null; past_due_since: string | null; paused_until: string | null; stripe_subscription_id: string | null; referred_by: string | null; created_at: string }>(),
    // A save of a duplicate that was since folded into another deal (drizzle/0056) is a save of the
    // deal it was folded into: every screen compares these ids with deal ids, and the dashboard's
    // Saved list dropped such a save without a word. One id per deal, for a reader who saved both.
    env.DB.prepare("SELECT DISTINCT COALESCE(a.canonical_deal_id,f.deal_id) deal_id FROM favorites f LEFT JOIN deal_aliases a ON a.alias_id=f.deal_id WHERE f.user_id=?").bind(user.userId).all<{ deal_id: string }>(),
    // The saved deals themselves, read here rather than matched in the browser against the first 50
    // deals of the recommended feed. That match was the dashboard's only source for them, so a deal
    // saved outside those 50 (another city, a quieter week) was missing from Saved without a word,
    // and one that had ended simply vanished. Every saved deal now comes back, ended ones marked,
    // newest save first. 300 is far beyond any real shortlist and keeps the read bounded.
    env.DB.prepare(`SELECT d.id,d.slug,COALESCE(r.name,d.restaurant) restaurant,d.title,d.city,l.region,d.cuisine,d.emoji,r.id canonical_restaurant_id,
        ${dealPageVisibility} page,
        CASE WHEN ${publicDealPredicate} AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now')) THEN 1 ELSE 0 END live,
        MAX(f.created_at) saved_at
      FROM favorites f LEFT JOIN deal_aliases a ON a.alias_id=f.deal_id JOIN deals d ON d.id=COALESCE(a.canonical_deal_id,f.deal_id)
      LEFT JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN restaurant_locations l ON l.id=d.location_id
      WHERE f.user_id=? GROUP BY d.id ORDER BY saved_at DESC LIMIT 300`).bind(user.userId).all<SavedDealRow>(),
    env.DB.prepare("SELECT * FROM saved_locations WHERE user_id=? ORDER BY is_default DESC,sort_order,created_at").bind(user.userId).all(),
    env.DB.prepare("SELECT * FROM saved_restaurants WHERE user_id=? ORDER BY created_at DESC").bind(user.userId).all(),
    env.DB.prepare("SELECT er.restaurant_id,r.name,r.cuisine FROM excluded_restaurants er JOIN restaurants r ON r.id=er.restaurant_id WHERE er.user_id=? ORDER BY r.name").bind(user.userId).all<{ restaurant_id: string; name: string; cuisine: string }>(),
    env.DB.prepare("SELECT * FROM notification_preferences WHERE user_id=? ORDER BY id").bind(user.userId).all(),
    consentFor(user.userId),
    // Free plans keep the original 20-row window (unchanged from before Pro existed); Pro sees
    // a much larger — not literally unbounded — history, matching the export route's own cap.
    // `opened` comes from the provider's own open/click webhooks, which are best-effort by
    // nature — an image-blocking client never reports one. It is shown as a positive signal only,
    // never as "not opened", because the absence of an event is not evidence of anything.
    env.DB.prepare(`SELECT d.id,d.status,d.sent_at,d.created_at,d.error_code,EXISTS(SELECT 1 FROM email_events e WHERE e.delivery_id=d.id AND e.type IN ('email.opened','email.clicked')) opened FROM email_deliveries d WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT ${historyRows(pro)}`).bind(user.userId).all<DeliveryRow>(),
    env.DB.prepare("SELECT market,region,country FROM market_coverage WHERE status='researching' ORDER BY market").all(),
  ]);
  if (!profile) return apiError(404,"PROFILE_NOT_FOUND","Your profile could not be loaded.");
  // Who is paying for Pro, so the app's subscription screen can offer to manage the right thing —
  // Apple's page for an App Store subscription — instead of selling Pro to somebody who has it.
  // Asked only of an account that is on Pro; anybody else is billed by nobody.
  const billing = pro ? await billingFor(user.userId) : null;
  // Whether the website's billing controls have anything to act on: a Stripe subscription that is
  // not over (app/billing-controls.ts). A different question from `billing`, which is who pays right
  // now. A paused subscription pays nothing and is still there to resume, and somebody paying Apple
  // as well is billed to Apple and still needs a way to cancel the web one. The id stays here.
  const { stripe_subscription_id: subscriptionId, referred_by: referredBy, ...shown } = profile;
  const web_subscription = stripeOwnsStatus({ subscriptionId, status: profile.plan_status, pastDueSince: profile.past_due_since, pausedUntil: profile.paused_until });
  // The reader's own referral code, and whether they can still add one (app/referral-code.ts).
  // The creator's handle is the only thing shown: it is what the reader typed or clicked through.
  const referral = { code: referredBy, can_add: !referredBy && referralWindowOpen(profile.created_at), window_ends_at: referralWindowEndsAt(profile.created_at)?.toISOString() ?? null };
  return Response.json({ profile:{ ...shown, billing, web_subscription, referral },favorites:favs.results.map((row) => row.deal_id),savedDeals:savedDeals.results.map(({ live, ...deal }) => ({ ...deal, live:!!live })),locations:locations.results,savedRestaurants:savedRestaurants.results,excludedRestaurants:excludedRestaurants.results,notificationPreferences:preferences.results,consent:consent || { status:"none" },deliveries:deliveries.results.map((row) => ({
    id:row.id,
    status:row.status,
    sent_at:row.sent_at,
    created_at:row.created_at,
    opened:!!row.opened,
    // The raw provider error never leaves the server. It is kept in the row (and in the Pro CSV
    // export, where exactness is the point) but the dashboard gets a bucket it can translate.
    reason:deliveryReason(row.error_code),
  })),comingSoonMarkets:comingSoonMarkets.results });
}

// Adding a tracked area already costs a signed-in session and passes the plan cap, so this bound
// exists only so a scripted loop cannot turn area creation into a geocoder amplifier. Keyed per
// user rather than per IP, since the account is what is doing the creating.
function areaGeocodeGuard(userId: string): GeocodeGuard {
  return async () => rateLimit(`geocode-area:${userId}`, 10, 60);
}

export async function POST(request: Request) {
  const user = await getAppUser();
  if (!user) return apiError(401,"AUTH_REQUIRED","Sign in required.");
  if (!(await requireSameOrigin(request))) return apiError(403,"INVALID_ORIGIN","This request could not be verified.");
  let body:UserActionBody;
  try { body = await readJson<UserActionBody>(request); }
  catch (cause) { return apiError(cause instanceof Error && cause.message === "PAYLOAD_TOO_LARGE" ? 413 : 400,"INVALID_REQUEST","The request body is invalid."); }
  if (body.action === "favorite") {
    const dealId = cleanText(body.dealId,120);
    const deal = await env.DB.prepare(`SELECT d.id,${dealPageVisibility} page FROM deals d WHERE d.id=? OR d.id=(SELECT canonical_deal_id FROM deal_aliases WHERE alias_id=?)`).bind(dealId,dealId).first<{id:string;page:string}>();
    if (!deal) return apiError(404,"DEAL_NOT_FOUND","That deal is no longer available.");
    // Only a deal a reader could have seen can be saved: the Saved list above reads back the title,
    // restaurant and city of whatever is saved, so a draft's id would otherwise read out a deal
    // nobody has published. Unsaving is always allowed.
    if (body.saved && deal.page === "hidden") return apiError(404,"DEAL_NOT_FOUND","That deal is no longer available.");
    if (body.saved) await env.DB.prepare("INSERT OR IGNORE INTO favorites(user_id,deal_id) VALUES(?,?)").bind(user.userId,deal.id).run();
    // Unsaving takes a save made under a folded duplicate's old id with it, which the list above
    // reports as this deal: left behind, the heart would fill again on the next load.
    else await env.DB.prepare("DELETE FROM favorites WHERE user_id=? AND (deal_id=? OR deal_id IN (SELECT alias_id FROM deal_aliases WHERE canonical_deal_id=?))").bind(user.userId,deal.id,deal.id).run();
  } else if (body.action === "preferences") {
    const postal = normalizedPostal(body.postal);
    const requestedDays = Array.from(new Set((Array.isArray(body.days) ? body.days : []).map(String).filter((day:string) => /^[0-6]$/.test(day))));
    const requestedTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || "")) ? String(body.time) : null;
    // Free plans get one email a week, not daily/custom day control — enforced here, not just
    // hidden in the UI, since the UI is a courtesy and this endpoint is the actual boundary. The
    // digest job applies the same rule again at send time (app/plan-limits.ts).
    const { days, time } = alertSchedule(isPro(user), requestedDays.map(Number), requestedTime);
    // The roundup covers the default tracked area when there is one (the digest job's own rule), so
    // the dashboard no longer asks for a postal code it would ignore. Without an active area the
    // home postal is still what places the roundup, and is still required.
    const hasArea = !postal && !!(await env.DB.prepare("SELECT 1 FROM saved_locations WHERE user_id=? AND active=1 LIMIT 1").bind(user.userId).first());
    if (!hasArea && !validPostal(postal)) return apiError(422,"INVALID_POSTAL","Enter a complete Canadian postal code or US ZIP code.",{postal:"Invalid postal or ZIP code"});
    if (body.enabled && !days.length) return apiError(422,"DELIVERY_DAYS_REQUIRED","Choose at least one delivery day.",{days:"Choose at least one day"});
    const consent = await consentFor(user.userId);
    if (body.enabled && consent?.status !== "confirmed") return apiError(409,"CONSENT_REQUIRED","Confirm your email subscription before enabling delivery.");
    const preference = await env.DB.prepare("SELECT id FROM notification_preferences WHERE user_id=? AND saved_location_id IS NULL LIMIT 1").bind(user.userId).first<{id:number}>();
    // The digest job decides who to mail by comparing the current hour in this timezone against
    // the delivery time chosen below, so it has to be the timezone the person actually set on
    // their profile. Hardcoding Eastern here sent everyone west of Toronto their 8am roundup at
    // 5am local.
    const profileTimezone = (await env.DB.prepare("SELECT timezone FROM users WHERE id=?").bind(user.userId).first<{timezone:string|null}>())?.timezone || "America/Toronto";
    const statements = [env.DB.prepare("UPDATE users SET home_postal=COALESCE(?,home_postal),alerts_enabled=?,alert_days=?,alert_time=? WHERE id=?").bind(hasArea ? null : postal,body.enabled ? 1 : 0,days.join(","),time,user.userId)];
    statements.push(preference
      ? env.DB.prepare("UPDATE notification_preferences SET days=?,delivery_time=?,timezone=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(JSON.stringify(days),time,profileTimezone,body.enabled ? 1 : 0,preference.id)
      : env.DB.prepare("INSERT INTO notification_preferences(user_id,frequency,days,delivery_time,timezone,enabled) VALUES(?,'selected_days',?,?,?,?)").bind(user.userId,JSON.stringify(days),time,profileTimezone,body.enabled ? 1 : 0));
    await env.DB.batch(statements);
  } else if (body.action === "request_email_consent") {
    const runtime = env as unknown as Record<string,string>;
    // Joining twice must not create a second row: the waitlist is ordered by when someone
    // joined, so a duplicate would both move them down the queue and let one person hold two
    // places in it.
    const existing = await consentFor(user.userId);
    if (existing && existing.status !== "revoked") {
      return Response.json({
        ok: true,
        status: existing.status,
        message: existing.status === "waitlisted"
          ? "You are already on the pilot waitlist."
          : existing.status === "confirmed"
            ? "Your deal alerts are already confirmed."
            : "Check your email to confirm — your request is already in.",
      });
    }
    const status = (await canDeliverTo(user.email)) ? "pending" : "waitlisted";
    await env.DB.prepare("INSERT INTO email_consents(user_id,email,status,source,policy_version,language) VALUES(?,?,?,?,?,?)").bind(user.userId,user.email,status,"dashboard","2026-08-20",writingLanguage(body.language)).run();
    if (status === "pending") {
      const token = await signEmailAction("consent",user.userId,user.email),origin = runtime.PUBLIC_APP_URL || "https://radar.cheap",link = `${origin}/confirm-email?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(token)}`;
      try { await sendEmail({to:user.email,subject:"Confirm your Radar deal alerts",html:`<h1>Confirm your deal alerts</h1><p>Account creation did not subscribe you. Confirm only if you want Radar promotional deal roundups.</p><p><a href="${link}">Confirm deal alerts</a></p>`,text:`Confirm Radar deal alerts: ${link}`,tag:"consent-confirmation",metadata:{userId:user.userId}}); }
      catch { await env.DB.prepare("UPDATE email_consents SET status='waitlisted' WHERE user_id=? AND status='pending'").bind(user.userId).run(); return Response.json({ok:true,status:"waitlisted",message:"You are on the pilot waitlist. Confirmation delivery is not available yet."}); }
    }
    return Response.json({
      ok: true,
      status,
      message: status === "pending"
        ? "Check your email to confirm."
        : "You are on the controlled-pilot waitlist. No email will be sent yet.",
    });
  } else if (body.action === "revoke_email_consent") {
    // Stopping alert email from the dashboard does exactly what the unsubscribe link in every
    // roundup does (app/api/email/unsubscribe): the consent is withdrawn, delivery is switched off,
    // and the address is suppressed so no other sender picks it up. Confirming a new request later
    // lifts that suppression (app/api/email/confirm), so the way back in is the same as the first.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO email_suppressions(email,reason) VALUES(?,'user_unsubscribe')").bind(user.email.toLowerCase()),
      env.DB.prepare("UPDATE email_consents SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND status IN ('confirmed','pending','waitlisted')").bind(user.userId),
      env.DB.prepare("UPDATE notification_preferences SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(user.userId),
      env.DB.prepare("UPDATE users SET alerts_enabled=0 WHERE id=?").bind(user.userId),
    ]);
  } else if (body.action === "send_test_email") {
    const consent = await consentFor(user.userId);
    if (consent?.status !== "confirmed") return apiError(409,"CONSENT_REQUIRED","Confirmed email consent is required for a test message.");
    if (!(await canDeliverTo(user.email))) return apiError(409,"PILOT_RESTRICTED","Test delivery is restricted to the enabled pilot allowlist.");
    // One test send per user per hour — a repeatable button that's free to mash would otherwise
    // let anyone with an account draw unlimited real Resend sends against this address.
    if (!(await rateLimit(`test-email:${user.userId}`,1,60))) return apiError(429,"RATE_LIMITED","You can request one test email per hour. Try again later.");
    const runtime = env as unknown as Record<string,string>,deliveryId = crypto.randomUUID(),origin = runtime.PUBLIC_APP_URL || "https://radar.cheap";
    // Uses fixed sample deals rather than the requester's real live deals — a repeatable,
    // rate-limited "test" button is still a way to draw the current live board on demand, and the
    // deal content itself carries no information worth harvesting once it's fixed sample data.
    // This is purely a rendering/delivery check, so real deal data was never necessary for it.
    const unsubscribeToken = await signUnsubscribe(user.userId,user.email);
    const unsubscribeUrl = `${origin}/unsubscribe?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(unsubscribeToken)}`;
    const { html, text } = buildDigestEmail({
      recipientName: user.displayName,
      city: null,
      origin,
      unsubscribeUrl,
      preferencesUrl: `${origin}/dashboard/alerts`,
      deals: SAMPLE_DIGEST_DEALS.map((deal) => ({...deal,url:`${origin}/en`})),
    });
    await env.DB.prepare("INSERT INTO email_deliveries(id,user_id,email,status) VALUES(?,?,?,'queued')").bind(deliveryId,user.userId,user.email).run();
    try { const sent = await sendEmail({to:user.email,subject:"Your Radar deal roundup (test)",html,text,tag:"deal-digest-test",unsubscribeUrl,metadata:{deliveryId,userId:user.userId}}); await env.DB.prepare("UPDATE email_deliveries SET provider_message_id=?,status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=?").bind(sent.id,deliveryId).run(); }
    catch (cause) { await env.DB.prepare("UPDATE email_deliveries SET status='failed',error_code=? WHERE id=?").bind(cause instanceof Error ? cause.message : "UNKNOWN",deliveryId).run(); return apiError(502,"EMAIL_PROVIDER_ERROR","The test message could not be delivered."); }
    return Response.json({ok:true,message:"Test email sent."});
  } else if (body.action === "location") {
    const postal = normalizedPostal(body.postal), label = cleanText(body.label,40);
    const radii = allowedRadii(isPro(user));
    const radius = radii.includes(Number(body.radius)) ? Number(body.radius) : DEFAULT_AREA_RADIUS_KM;
    if (!label) return apiError(422,"LABEL_REQUIRED","Add a label for this area.",{label:"Required"});
    if (!validPostal(postal)) return apiError(422,"INVALID_POSTAL","Enter a complete Canadian postal code or US ZIP code.",{postal:"Invalid postal or ZIP code"});
    const duplicate = await env.DB.prepare("SELECT id FROM saved_locations WHERE user_id=? AND upper(replace(postal,' ',''))=?").bind(user.userId,postal).first();
    if (duplicate) return apiError(409,"DUPLICATE_AREA","That area is already being tracked.");
    const count = await env.DB.prepare("SELECT COUNT(*) count FROM saved_locations WHERE user_id=?").bind(user.userId).first<{count:number}>();
    if ((count?.count || 0) >= FREE_AREA_LIMIT && !isPro(user)) return apiError(402,"PRO_REQUIRED","Free plans track 1 area. Upgrade to Radar Pro for unlimited tracked areas.");
    // Resolve the area to coordinates so alerts can match by distance rather than by the
    // 3-character postal prefix. The lat/lng/city/region/country/timezone columns have existed on
    // this table since it was created and nothing had ever written them.
    //
    // Never block the save on it: geocoding is an external call, and an area with no coordinates
    // still works everywhere (search falls back to its own resolution, alerts fall back to the
    // postal prefix). /api/jobs/geocode repairs the nulls later. Same graceful-degradation
    // shape as app/geocode.ts itself.
    const place = await resolvePostal(postal, areaGeocodeGuard(user.userId)).catch(() => null);
    await env.DB.prepare("INSERT INTO saved_locations(user_id,label,postal,radius,is_default,sort_order,latitude,longitude,city,region,country,timezone) VALUES(?,?,?,?,?,?,?,?,?,?,COALESCE(?,'CA'),COALESCE(?,'America/Toronto'))")
      .bind(user.userId,label,postal,radius,(count?.count || 0) === 0 ? 1 : 0,count?.count || 0,place?.latitude ?? null,place?.longitude ?? null,displayCity(place?.city),place?.region ?? null,place?.country ?? null,place?.timezone ?? null).run();
  } else if (body.action === "update_location") {
    const id = Number(body.id), pro = isPro(user);
    const area = Number.isInteger(id) ? await env.DB.prepare("SELECT id,label,radius,active FROM saved_locations WHERE id=? AND user_id=?").bind(id,user.userId).first<{ id:number; label:string; radius:number; active:number }>() : null;
    if (!area) return apiError(404,"AREA_NOT_FOUND","That tracked area was not found.");
    // Each field is optional and only what is sent changes. The dashboard used to send all three to
    // pause an area, so an area saved at 50 km (once 75 or 100) while on Pro could not be paused, resumed or
    // renamed once the plan lapsed: its own radius failed the Free check. A radius is only checked
    // against the plan when it is being changed.
    const label = body.label === undefined ? area.label : cleanText(body.label,40);
    const radius = body.radius === undefined || Number(body.radius) === area.radius ? area.radius : Number(body.radius);
    const active = body.active === undefined ? area.active === 1 : body.active !== false;
    // Its own code rather than INVALID_LOCATION, which /api/deals sends for a malformed postal code:
    // the dashboard words each code once, and this one is about the area's label and radius.
    if (!label || (radius !== area.radius && !allowedRadii(pro).includes(radius))) return apiError(422,"INVALID_AREA","Review the tracked-area fields.");
    // Free plans have one area working at a time. An account that left Pro keeps the areas it made
    // and can rename, pause or remove any of them, but can only switch one back on by pausing the
    // other first (or by making it the default, below).
    if (!pro && active && !area.active) {
      const working = await env.DB.prepare("SELECT COUNT(*) count FROM saved_locations WHERE user_id=? AND active=1 AND id<>?").bind(user.userId,id).first<{count:number}>();
      if ((working?.count || 0) >= FREE_AREA_LIMIT) return apiError(402,"AREA_LIMIT_ACTIVE","Free plans keep 1 area active. Pause the other area first, or upgrade to Radar Pro.");
    }
    await env.DB.prepare("UPDATE saved_locations SET label=?,radius=?,active=? WHERE id=? AND user_id=?").bind(label,radius,active ? 1 : 0,id,user.userId).run();
  } else if (body.action === "set_default_location") {
    const id = Number(body.id);
    const target = await env.DB.prepare("SELECT id FROM saved_locations WHERE id=? AND user_id=?").bind(id,user.userId).first();
    if (!target) return apiError(404,"AREA_NOT_FOUND","That tracked area was not found.");
    // On Free, making an area the default also makes it the one working area: the others are paused
    // rather than left running past the plan's limit. On Pro the others are left as they are.
    await env.DB.batch([
      env.DB.prepare(isPro(user) ? "UPDATE saved_locations SET is_default=0 WHERE user_id=?" : "UPDATE saved_locations SET is_default=0,active=0 WHERE user_id=?").bind(user.userId),
      env.DB.prepare("UPDATE saved_locations SET is_default=1,active=1 WHERE id=? AND user_id=?").bind(id,user.userId),
    ]);
  } else if (body.action === "remove_location") {
    const location = await env.DB.prepare("SELECT * FROM saved_locations WHERE user_id=? AND id=?").bind(user.userId,Number(body.id)).first<SavedLocationRow>();
    if (!location) return apiError(404,"AREA_NOT_FOUND","That tracked area was not found.");
    await env.DB.prepare("DELETE FROM saved_locations WHERE user_id=? AND id=?").bind(user.userId,location.id).run();
    return Response.json({ ok:true,removed:location });
  } else if (body.action === "profile") {
    const name = cleanText(body.name,80), language = writingLanguage(body.language);
    const country = body.country === "US" ? "US" : "CA", distanceUnit = body.distanceUnit === "mi" ? "mi" : "km";
    // Only a zone the runtime accepts is stored. The digest job formats the hour in it for every
    // recipient, and an unknown one ("Toronto", "Eastern", a typo) throws there, inside somebody
    // else's run, instead of here where the person who typed it can fix it. Leaving it out still
    // means Toronto, as it always has.
    const suppliedTimezone = cleanText(body.timezone,80);
    const timezone = suppliedTimezone ? canonicalTimezone(suppliedTimezone) : DEFAULT_TIMEZONE;
    if (!name) return apiError(422,"NAME_REQUIRED","Enter your display name.",{name:"Required"});
    if (!timezone) return apiError(422,"INVALID_TIMEZONE","Choose a timezone from the list, such as America/Toronto.",{timezone:"Unknown timezone"});
    // Carry the timezone through to any existing alert preference too, otherwise someone who
    // moves provinces keeps getting their roundup on their old clock until they happen to
    // re-save the alerts form.
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET name=?,language=?,country=?,distance_unit=?,timezone=? WHERE id=?").bind(name,language,country,distanceUnit,timezone,user.userId),
      env.DB.prepare("UPDATE notification_preferences SET timezone=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").bind(timezone,user.userId),
    ]);
  } else if (body.action === "theme") {
    const theme = body.theme === "light" || body.theme === "dark" || body.theme === "system" ? body.theme : "system";
    // A Pro-only accent can't be set on a free account, even via a hand-crafted request — the
    // accent-picker UI already routes free users to Upgrade instead of picking one, this is the
    // actual boundary.
    const accentColor = isAccentKey(body.accentColor) && !(ACCENTS[body.accentColor].pro && !isPro(user)) ? body.accentColor : "coral";
    await env.DB.prepare("UPDATE users SET theme=?,accent_color=? WHERE id=?").bind(theme,accentColor,user.userId).run();
  } else if (body.action === "referral_code") {
    // Adding a referral code after sign-up. Every rule is decided here, not on the page: one code
    // per account, only within the window, never changed or removed by the reader once set.
    if (!(await rateLimit(`referral-code-user:${user.userId}`,10,60))) return apiError(429,"RATE_LIMITED","Too many attempts. Try again later.");
    const account = await env.DB.prepare("SELECT referred_by,created_at FROM users WHERE id=?").bind(user.userId).first<{ referred_by: string | null; created_at: string }>();
    if (!account) return apiError(404,"PROFILE_NOT_FOUND","Your profile could not be loaded.");
    if (account.referred_by) return apiError(409,"REFERRAL_LOCKED","This account already has a referral code, and it cannot be changed.");
    if (!referralWindowOpen(account.created_at)) return apiError(409,"REFERRAL_WINDOW_CLOSED",`Referral codes can only be added in the first ${REFERRAL_WINDOW_DAYS} days after creating an account.`);
    const lookup = await resolveReferralCode(body.code,user.userId);
    if (!lookup.ok) return lookup.reason === "self"
      ? apiError(422,"REFERRAL_SELF","You can't use your own referral code.",{code:"Your own code"})
      : apiError(404,"REFERRAL_CODE_NOT_FOUND","That referral code was not found.",{code:"Not found"});
    // The conditions are repeated in the write itself, so two tabs racing each other (or the
    // window closing between the read and the write) cannot set a second code over the first.
    const written = await env.DB.prepare("UPDATE users SET referred_by=?,referred_campaign=NULL WHERE id=? AND referred_by IS NULL AND datetime(created_at)>datetime('now',?)")
      .bind(lookup.handle,user.userId,`-${REFERRAL_WINDOW_DAYS} days`).run();
    if (!written.meta.changes) return apiError(409,"REFERRAL_LOCKED","This account already has a referral code, and it cannot be changed.");
    await env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES(?,?,'referral_code_set','user',?,?)")
      .bind(user.userId,user.role,user.userId,JSON.stringify({handle:lookup.handle,source:"dashboard"})).run();
    return Response.json({ ok:true,code:lookup.handle });
  } else if (body.action === "exclude_restaurant") {
    const restaurantId = cleanText(body.restaurantId,140);
    if (!restaurantId) return apiError(422,"RESTAURANT_REQUIRED","Choose a restaurant to exclude.");
    const restaurant = await env.DB.prepare("SELECT id FROM restaurants WHERE id=?").bind(restaurantId).first<{id:string}>();
    if (!restaurant) return apiError(404,"RESTAURANT_NOT_FOUND","That restaurant could not be found.");
    await env.DB.prepare("INSERT OR IGNORE INTO excluded_restaurants(user_id,restaurant_id) VALUES(?,?)").bind(user.userId,restaurantId).run();
  } else if (body.action === "include_restaurant") {
    const restaurantId = cleanText(body.restaurantId,140);
    await env.DB.prepare("DELETE FROM excluded_restaurants WHERE user_id=? AND restaurant_id=?").bind(user.userId,restaurantId).run();
  } else if (body.action === "delete_account") {
    // App Review 5.1.1(v) requires this to be doable in the app. The typed confirmation is not
    // ceremony: this is the one action here that cannot be undone by repeating it, and it is
    // reachable by anything holding a session token, so it should not be one malformed client
    // away from firing.
    if (body.confirm !== "DELETE") return apiError(422,"CONFIRM_REQUIRED","Type DELETE to confirm.",{confirm:"Required"});
    const failure = await deleteAccount(user);
    if (failure) return apiError(502,failure.code,failure.message);
    return Response.json({ ok:true,deleted:true });
  } else return apiError(400,"UNKNOWN_ACTION","That account action is not supported.");
  return Response.json({ ok:true });
}
