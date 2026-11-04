import { env } from "cloudflare:workers";

// A referral code is a creator's handle, typed in by the reader instead of arriving on a ?c= link.
//
// There is deliberately no second code system: the handle is already the key every attributed
// visit, sign-up and commission is stamped with (users.referred_by, creator_commissions.handle),
// staff-assigned and unique (creator_profiles), so a typed code lands in exactly the same column a
// tracked link does and the Stripe webhook pays it the same way. Creators already have one string
// to share; a code they could not also put in a URL would be a second thing to keep in step.
//
// The rules a typed code is held to, all enforced on the server:
//   - it names an active creator, and never the account entering it;
//   - it can be added at sign-up, or from the dashboard within REFERRAL_WINDOW_DAYS of the account
//     being created, and only while the account has no referral yet;
//   - once set, the reader can never change or remove it. Only staff can correct one, through the
//     admin `referral_correction` action, which needs the finance permission and an owner's
//     approval, and is audit-logged with the reason.

export const REFERRAL_WINDOW_DAYS = 7;

/** The same alphabet as a creator handle (app/CreatorLink.tsx, the admin creator_profile action). */
const HANDLE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** The httpOnly cookie a code typed on the sign-up page waits in until the account is created. */
export const REFERRAL_CODE_COOKIE = "radar_referral_code";
/** As long as the dashboard window, so a sign-up finished days later still carries it. */
export const REFERRAL_CODE_COOKIE_MAX_AGE = REFERRAL_WINDOW_DAYS * 24 * 60 * 60;

/**
 * A code as typed, made comparable with a handle: trimmed, lowercased, a leading "@" or a pasted
 * "?c=" link reduced to the handle. Null when what is left could not be a handle at all.
 */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let code = value.trim().toLowerCase();
  if (code.length > 300) return null;
  const fromLink = /[?&]c=([^&#\s]+)/.exec(code);
  if (fromLink) code = fromLink[1];
  code = code.replace(/^@/, "");
  return HANDLE.test(code) ? code : null;
}

/** When an account created at `createdAt` (D1's UTC "YYYY-MM-DD HH:MM:SS") stops accepting a code. */
export function referralWindowEndsAt(createdAt: string): Date | null {
  const created = new Date(`${createdAt.trim().replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt.trim()) ? "" : "Z"}`);
  if (Number.isNaN(created.getTime())) return null;
  return new Date(created.getTime() + REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Whether the reader may still add a code themselves. Unknown dates are treated as closed. */
export function referralWindowOpen(createdAt: string, now = new Date()) {
  const ends = referralWindowEndsAt(createdAt);
  return ends !== null && now.getTime() < ends.getTime();
}

export type ReferralLookup =
  | { ok: true; handle: string; creatorUserId: string }
  | { ok: false; reason: "invalid" | "unknown" | "self" };

/**
 * The creator a code names, if it may be used by `userId` (null before the account exists).
 * An unknown handle and a paused one answer the same, so the check cannot be used to learn which
 * creators exist but are paused.
 */
export async function resolveReferralCode(value: unknown, userId: string | null): Promise<ReferralLookup> {
  const code = normalizeReferralCode(value);
  if (!code) return { ok: false, reason: "invalid" };
  const creator = await env.DB.prepare("SELECT user_id,handle FROM creator_profiles WHERE handle=? AND status='active'")
    .bind(code).first<{ user_id: string; handle: string }>();
  if (!creator) return { ok: false, reason: "unknown" };
  if (userId && creator.user_id === userId) return { ok: false, reason: "self" };
  return { ok: true, handle: creator.handle, creatorUserId: creator.user_id };
}
