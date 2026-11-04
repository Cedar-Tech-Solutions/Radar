import { verifyToken } from "@clerk/backend";
import { env } from "cloudflare:workers";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_ENTRY_PERMISSION, ALL_PERMISSIONS, isWorkspaceRole, type Permission, type Role, roleMayHold, WORKSPACE_HOME } from "./permissions";

export type { Permission };
import { hasProAccess, isProPlan } from "./entitlement";
import { resolveReferralCode } from "./referral-code";

export type AppUser = {
  userId: string;
  clerkUserId: string;
  email: string;
  displayName: string;
  role: Role;
  permissions: Set<Permission>;
  plan: string;
  planStatus: string;
  /** When a renewal first failed, or null. Carried so the payment grace period can be judged
   *  wherever entitlement is - see app/entitlement.ts. */
  pastDueSince: string | null;
  /** When a paused subscription resumes, or null. Stripe keeps a paused subscription `active`,
   *  so entitlement cannot be read from the status alone. */
  pausedUntil: string | null;
};

// The pinned owner: the one account that is always restored to owner (preserveOwner, below) and
// whose role nobody can change, another owner included (the role guard in /api/admin).
//
// The check lives here, and only here, because this module cannot reach a browser: it reads the Worker
// env and request headers, so no client component can import it. It used to be duplicated as
// SUPER_OWNER_EMAIL in app/permissions.ts, which the admin client imports, and so the address
// shipped in a public JS chunk that every page's entry script names. The admin client now reads
// an isProtected flag the API computes per user row with isProtectedOwner().
//
// Matched on the address because that is the only thing about the owner the server holds; there
// is no configured Clerk or account id to key it to. Clerk verifies an address before it can sign
// in with it, which is what makes the address a sound key.
//
// The address itself is the OWNER_EMAIL var in wrangler.jsonc, not a literal here, so the
// application code names nobody and anyone running their own copy points it at their own account.
// Unset or blank means no account is pinned: nothing is promoted and every role stays editable,
// which fails closed (no one gains owner) rather than open.
function ownerEmail() {
  return (env.OWNER_EMAIL ?? "").trim().toLowerCase();
}

/** Whether this is the pinned owner's account, whose role no in-app action may change. Server-only. */
export function isProtectedOwner(email: string | null | undefined) {
  const owner = ownerEmail();
  return owner !== "" && typeof email === "string" && email.trim().toLowerCase() === owner;
}

async function permissionsForUser(userId: string, role: AppUser["role"]): Promise<Set<Permission>> {
  // "user" and the workspace roles have no admin permissions by definition, so they are resolved
  // here rather than read back from role_permissions. For the workspace roles that is the whole
  // guarantee: a creator or restaurant account cannot be given a way into /admin by any data change,
  // only by changing the role itself.
  if (role === "user" || isWorkspaceRole(role)) return new Set();
  // Owner is a superset by definition, and app/permissions.ts has always said so — but it was
  // still being read out of role_permissions like any other preset, so a bad migration or a
  // direct DB edit that dropped those rows would have locked every owner out of the workspace
  // with no in-app way back in. The API already refuses to edit the owner preset; this makes the
  // guarantee structural rather than a rule the data has to keep agreeing with, and saves a
  // query on every owner request.
  if (role === "owner") return new Set(ALL_PERMISSIONS);
  // Read from the table, then filtered against the role-locked permissions (exports and the
  // developer tools, app/permissions.ts). A row granting one of those to any other role - written
  // through the grid, a custom set, a migration or by hand - is ignored here, so it grants nothing.
  const rows = role === "custom"
    ? await env.DB.prepare("SELECT permission FROM user_permissions WHERE user_id=?").bind(userId).all<{ permission: Permission }>()
    : await env.DB.prepare("SELECT permission FROM role_permissions WHERE role=?").bind(role).all<{ permission: Permission }>();
  return new Set((rows.results || []).map((row) => row.permission).filter((permission) => roleMayHold(role, permission)));
}

// The creator handle parked by app/CreatorLink.tsx, resolved against a real active creator before
// it is allowed anywhere near the users row. The cookie is reader-supplied, so an unknown or
// paused handle is simply dropped rather than stored — attribution should never be able to name
// someone who is not a creator.
//
// A request carrying Global Privacy Control (Sec-GPC: 1) is never attributed, even with the cookie
// present: CreatorLink.tsx stops setting it for such a browser, and this covers a cookie parked
// before the reader turned the signal on.
//
// A code the reader typed on the sign-up page (app/api/referral-code) comes first, and is honoured
// even with GPC on: it is the reader naming a creator themselves, not a cookie a link parked. It is
// checked against the creators table again here, since a cookie is only ever a hint.
async function referringCreator(cookieStore: Awaited<ReturnType<typeof cookies>>): Promise<{ handle: string | null; campaign: string | null; source: "signup_code" | "link" | null }> {
  // The name is REFERRAL_CODE_COOKIE in app/referral-code.ts, spelled out so tests/route-params.test.mjs
  // can see which cookies this file reads.
  const typed = cookieStore.get("radar_referral_code")?.value;
  if (typed) {
    const lookup = await resolveReferralCode(typed, null);
    if (lookup.ok) return { handle: lookup.handle, campaign: null, source: "signup_code" };
  }
  if ((await headers()).get("sec-gpc") === "1") return { handle: null, campaign: null, source: null };
  const handle = (cookieStore.get("radar_creator")?.value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(handle)) return { handle: null, campaign: null, source: null };
  const row = await env.DB.prepare("SELECT handle FROM creator_profiles WHERE handle=? AND status='active'")
    .bind(handle).first<{ handle: string }>();
  if (!row?.handle) return { handle: null, campaign: null, source: null };
  // Only meaningful alongside a handle that resolved, so it is read inside this branch: a
  // campaign label with no creator behind it is not attribution, it is a stray cookie.
  const label = (cookieStore.get("radar_creator_campaign")?.value || "").trim().toLowerCase();
  return { handle: row.handle, campaign: /^[a-z0-9][a-z0-9-]{1,47}$/.test(label) ? label : null, source: "link" };
}

async function mappedProfile(subject: string) {
  return env.DB.prepare("SELECT u.id,u.email,u.name,u.role,u.status,u.plan,u.plan_status,u.past_due_since,u.paused_until FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='clerk' AND i.subject=?")
    .bind(subject).first<{ id:string;email:string;name:string;role:AppUser["role"];status:string;plan:string;plan_status:string;past_due_since:string|null;paused_until:string|null }>();
}

async function preserveOwner(profile: { id:string;email:string;role:AppUser["role"] }) {
  if (!isProtectedOwner(profile.email)) return profile.role;
  const migrated = await env.DB.prepare("SELECT id FROM audit_log WHERE action='owner_identity_migrated' AND target_id=? LIMIT 1").bind(profile.id).first();
  if (!migrated) {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET role='owner' WHERE id=?").bind(profile.id),
      env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES(?,'owner','owner_identity_migrated','user',?,'{\"source\":\"configured_owner_email\"}')").bind(profile.id,profile.id),
    ]);
    return "owner" as const;
  }
  return profile.role;
}

// Origins allowed to mint a session token for this instance.
//
// This is an allowlist of who may speak for Radar, so an entry outlives its usefulness badly. It
// used to carry the predecessor project's preview host on chatgpt.site,
// which is no longer wanted and no longer ours. That matters more than an unused line usually
// would: it was a subdomain on a shared host, and a name nobody is holding any more is a name
// somebody else can take — at which point the allowlist would still be vouching for it.
//
// Add an origin here only while it is actively serving Radar, and take it out when it stops.
export const AUTHORIZED_PARTIES = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://radar.cheap",
  // The affiliate portal. A different origin to the browser, so Clerk stamps its own name into
  // `azp` and a token minted there is refused here without this line — which reads, from the
  // portal, as being signed out on a page that had just shown a signed-in name. Same Worker and
  // same Clerk instance; only the hostname differs.
  "https://affiliate.radar.cheap",
  "http://affiliate.localhost:3000",
];

/** The `azp` of a Clerk JWT, or null when the token has none or cannot be read. */
export function authorizedPartyOf(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const azp = (JSON.parse(json) as { azp?: unknown }).azp;
    return typeof azp === "string" && azp ? azp : null;
  } catch {
    return null;
  }
}

// Which authorized-party rule applies to this token, or null to refuse it outright.
//
// Clerk fills `azp` from the browser's Origin. A native app has no origin, so Clerk mints its
// tokens without the claim at all — and @clerk/backend's assertAuthorizedPartiesClaim rejects a
// *missing* azp just as hard as a wrong one whenever authorizedParties is set. Passing the list
// unconditionally therefore made every authenticated request from the phone app 401, which looked
// like being signed out on a screen that had just shown a signed-in name.
//
// So the claim is enforced only when the token actually carries one. Reading it before
// verification is safe: it decides which rule to apply, never whether the token is genuine —
// verifyToken still checks the signature either way, and azp cannot be stripped from a real
// browser token without invalidating it.
//
// An azp-less token is still only accepted from the Authorization header. A cookie is the one
// thing a browser attaches cross-site on its own, so a cookie that skipped the origin check is
// exactly the case this claim exists to catch; Clerk has said such cookies will be rejected
// outright in a future version, and this gets there first.
export function verificationPolicy(
  token: string,
  presentedAs: "header" | "cookie",
): { authorizedParties?: string[] } | null {
  const azp = authorizedPartyOf(token);
  if (azp) return { authorizedParties: AUTHORIZED_PARTIES };
  return presentedAs === "header" ? {} : null;
}

export async function getAppUser(): Promise<AppUser | null> {
  const requestHeaders = await headers();
  const cookieStore = await cookies();
  const bearer = /^Bearer\s+(\S+)/i.exec(requestHeaders.get("authorization") || "")?.[1];
  const token = bearer || cookieStore.get("__session")?.value;
  if (!token) return null;
  const runtime = env as unknown as Record<string, string>;
  if (!runtime.CLERK_SECRET_KEY) return null;
  const policy = verificationPolicy(token, bearer ? "header" : "cookie");
  if (!policy) return null;
  let session: { sub: string };
  try {
    session = (await verifyToken(token, {
      secretKey: runtime.CLERK_SECRET_KEY,
      ...policy,
    })) as { sub: string };
  } catch {
    return null;
  }
  const existing = await mappedProfile(session.sub);
  if (existing) {
    if (existing.status !== "active") return null;
    const role = await preserveOwner(existing);
    return { userId:existing.id,clerkUserId:session.sub,email:existing.email,displayName:existing.name || existing.email,role,permissions:await permissionsForUser(existing.id,role),plan:existing.plan,planStatus:existing.plan_status,pastDueSince:existing.past_due_since,pausedUntil:existing.paused_until };
  }
  const response = await fetch(
    `https://api.clerk.com/v1/users/${session.sub}`,
    {
      headers: { Authorization: `Bearer ${runtime.CLERK_SECRET_KEY}` },
    },
  );
  if (!response.ok) return null;
  const clerk = (await response.json()) as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    primary_email_address_id: string | null;
    email_addresses: Array<{
      id: string;
      email_address: string;
      verification?: { status?: string };
    }>;
  };
  const primary = clerk.email_addresses.find(
    (entry) => entry.id === clerk.primary_email_address_id,
  );
  const verified =
    primary?.verification?.status === "verified" ? primary : null;
  if (!verified) return null;

  const email = verified.email_address.trim().toLowerCase();
  const name =
    [clerk.first_name, clerk.last_name].filter(Boolean).join(" ") || email;

  let profile = await env.DB.prepare(
      "SELECT id,role,status,plan,plan_status,past_due_since,paused_until FROM users WHERE lower(email)=?",
    )
      .bind(email)
      .first<{ id: string; role: string; status: string; plan: string; plan_status: string; past_due_since: string | null; paused_until: string | null }>();
  if (!profile) {
    const appUserId = `user:${crypto.randomUUID()}`;
    // Only ever written here, on the row's first insert. An existing account never picks up a
    // referral from a later visit, so credit cannot be reassigned by re-clicking a link.
    const referral = await referringCreator(cookieStore);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,email,name,role,referred_by,referred_campaign) VALUES(?,?,?,'user',?,?)").bind(appUserId,email,name,referral.handle,referral.campaign),
      env.DB.prepare("INSERT INTO auth_identities(provider,subject,user_id,verified_email) VALUES('clerk',?,?,?)").bind(session.sub,appUserId,email),
      env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES(?,'user','identity_attached','user',?,?)").bind(appUserId,appUserId,JSON.stringify({provider:"clerk",newAccount:true})),
      // Who gets paid on this account's subscription is worth a trail of its own, whichever way
      // it arrived: a link, or a code typed on the sign-up page.
      ...(referral.handle
        ? [env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES(?,'user','referral_code_set','user',?,?)").bind(appUserId,appUserId,JSON.stringify({handle:referral.handle,campaign:referral.campaign,source:referral.source}))]
        : []),
    ]);
    profile = { id: appUserId, role: "user", status: "active", plan: "free", plan_status: "inactive", past_due_since: null, paused_until: null };
  } else {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO auth_identities(provider,subject,user_id,verified_email) VALUES('clerk',?,?,?)").bind(session.sub,profile.id,email),
      env.DB.prepare("UPDATE users SET name=?,email=? WHERE id=?").bind(name,email,profile.id),
      env.DB.prepare("INSERT INTO audit_log(actor_id,actor_role,action,target_type,target_id,details) VALUES(?,?,?,?,?,?)").bind(profile.id,profile.role,"identity_attached","user",profile.id,JSON.stringify({provider:"clerk",matchedExisting:true})),
    ]);
  }
  // Deliberately not re-reading the row we just wrote (the original code did, via
  // mappedProfile(session.sub)) — D1 doesn't guarantee a read immediately after a batch write
  // sees that write, and on a first-ever sign-in this re-read raced its own insert often enough
  // to redirect-loop a freshly attached user straight back to /sign-in. Build the result from
  // what was just written instead, since nothing here needs a round trip to confirm.
  if (profile.status !== "active") return null;
  const role = await preserveOwner({ id:profile.id,email,role:profile.role as AppUser["role"] });
  return { userId:profile.id,clerkUserId:session.sub,email,displayName:name || email,role,permissions:await permissionsForUser(profile.id,role),plan:profile.plan,planStatus:profile.plan_status,pastDueSince:profile.past_due_since,pausedUntil:profile.paused_until };
}

// A page under app/[locale] passes its own sign-in page, localizedPath("/sign-in", locale), and a
// `returnTo` with its locale in it. Without them GET /fr/dashboard answered /sign-in?redirect_url=
// %2Fdashboard, which the middleware sends to the English sign-in page when there is no locale
// cookie, and which returns the reader to the dashboard in whatever language that cookie names.
// The English-only workspaces (/admin, /creator, /portal) pass neither, as before.
export async function requireAppUser(returnTo: string, signInPath = "/sign-in") {
  const user = await getAppUser();
  if (!user)
    redirect(
      `${safeReturnTo(signInPath)}?redirect_url=${encodeURIComponent(safeReturnTo(returnTo))}`,
    );
  return user;
}

// Whether this person can open the admin workspace at all. Deliberately the same check the admin
// API's GET makes: it used to be `permissions.size > 0`, so someone holding a single write
// permission without read_admin — reachable through a custom permission set — could open the
// workspace shell and then have every panel in it fail with a 403. Now they are redirected, which
// is the truth.
export function canAdminister(user: AppUser) {
  return user.permissions.has(ADMIN_ENTRY_PERMISSION);
}

// The workspace this account calls home, if it has one of its own. Drives the link in the
// dashboard and header, and where a workspace account is sent when it lands on /admin. Returning
// a path here grants nothing — each workspace re-checks its own conditions on entry.
export function workspaceHome(user: AppUser) {
  return isWorkspaceRole(user.role) ? WORKSPACE_HOME[user.role] : null;
}

// Pro features: a Pro plan, or a staff role (STAFF_PRO_ROLES in app/entitlement.ts). Every feature
// gate asks this one.
export function isPro(user: AppUser) {
  return hasProAccess(user.plan, user.planStatus, user.pastDueSince, new Date(), user.pausedUntil, user.role);
}

// The plan itself, whoever is paying for it. For the paywall, which must still sell Pro to a member
// of staff who wants to test buying it, and must never tell them they have a subscription they do
// not.
export function hasPaidPro(user: AppUser) {
  return isProPlan(user.plan, user.planStatus, user.pastDueSince, new Date(), user.pausedUntil);
}

export function hasPermission(user: AppUser, permission: Permission) {
  return user.permissions.has(permission);
}

function safeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    // Checked after resolving too: "/.//evil.example" resolves to "//evil.example".
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("//") || path.startsWith("/\\") ? "/" : path;
  } catch {
    return "/";
  }
}
