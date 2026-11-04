import { apiError, clientKey, rateLimit, readJson, requireSameOrigin } from "../../api-utils";
import { REFERRAL_CODE_COOKIE, REFERRAL_CODE_COOKIE_MAX_AGE, resolveReferralCode } from "../../referral-code";

// The sign-up page's referral code box. Checking a code here does two things: tells the reader
// straight away whether it is a real creator code (rather than after the account exists, when a
// typo would cost them the referral), and parks the checked handle in an httpOnly cookie that
// app/auth.ts reads once, at the moment the account row is created. auth.ts checks it again
// there, so this cookie is a convenience and never the authority.
//
// No account is needed, because nobody on the sign-up page has one yet. It is rate limited per
// client, which is what keeps it from being a cheap way to list creator handles (they are public
// anyway: every creator's handle is in the link they share).

function cookie(value: string, maxAge: number, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${REFERRAL_CODE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export async function POST(request: Request) {
  if (!(await requireSameOrigin(request))) return apiError(403,"INVALID_ORIGIN","This request could not be verified.");
  if (!(await rateLimit(await clientKey("referral-code"),20,10))) return apiError(429,"RATE_LIMITED","Too many attempts. Try again in a few minutes.");
  let body: { code?: unknown };
  try { body = await readJson<{ code?: unknown }>(request,2_000); } catch { return apiError(400,"INVALID_REQUEST","The request body is invalid."); }
  const lookup = await resolveReferralCode(body.code,null);
  if (!lookup.ok) {
    const response = apiError(lookup.reason === "invalid" ? 422 : 404,"REFERRAL_CODE_NOT_FOUND","That referral code was not found.",{code:"Not found"});
    // A wrong code replaces a right one typed earlier, so what is in the box is what is applied.
    response.headers.append("set-cookie",cookie("",0,request));
    return response;
  }
  const response = Response.json({ ok:true, code:lookup.handle });
  response.headers.append("set-cookie",cookie(lookup.handle,REFERRAL_CODE_COOKIE_MAX_AGE,request));
  return response;
}

/** The reader cleared the box: forget the code. */
export async function DELETE(request: Request) {
  if (!(await requireSameOrigin(request))) return apiError(403,"INVALID_ORIGIN","This request could not be verified.");
  const response = Response.json({ ok:true });
  response.headers.append("set-cookie",cookie("",0,request));
  return response;
}
