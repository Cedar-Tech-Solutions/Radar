import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// app/auth.ts is a server module: it imports the Workers env, next/headers and @clerk/backend at
// the top level, none of which exist here. The two functions under test are pure, so the module is
// loaded with those imports stubbed out rather than reimplemented — the same substitution
// tests/geocode-address.test.mjs makes, and for the same reason: the thing exercised has to be the
// thing that ships.
const source = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");

const { authorizedPartyOf, verificationPolicy, AUTHORIZED_PARTIES } = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(
      source
        .replace(/^import .*(cloudflare:workers|next\/headers|next\/navigation|@clerk\/backend).*$/gm, "")
        .replace(/^import \{ ADMIN_ENTRY_PERMISSION.*$/gm, "")
        // isPro() is not what this file tests, and a data: URL module cannot resolve a
        // relative import. Stubbed rather than stripped, so the function it feeds still parses.
        .replace(/^import \{ hasProAccess, isProPlan \}.*$/gm, "const isProPlan = () => false; const hasProAccess = () => false;")
        .replace(/^import \{ resolveReferralCode \}.*$/gm, "const resolveReferralCode = async () => ({ ok: false });")
        .replace(/^const env = .*$/gm, ""),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
  ).toString("base64")}`
);

/** A JWT-shaped string. Only the payload is ever read, so the signature is a placeholder. */
function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.signature-not-checked-here`;
}

test("a browser token's azp is read back", () => {
  assert.equal(authorizedPartyOf(jwt({ sub: "user_1", azp: "https://radar.cheap" })), "https://radar.cheap");
});

test("a native token has no azp", () => {
  // The whole bug in one assertion: Clerk fills azp from the Origin header, and a phone app sends
  // none, so the claim is absent rather than wrong.
  assert.equal(authorizedPartyOf(jwt({ sub: "user_1" })), null);
});

test("an unreadable token yields no azp rather than throwing", () => {
  assert.equal(authorizedPartyOf("not-a-jwt"), null);
  assert.equal(authorizedPartyOf(""), null);
  assert.equal(authorizedPartyOf("a.!!!not-base64!!!.c"), null);
  assert.equal(authorizedPartyOf(jwt({ sub: "user_1", azp: 42 })), null, "a non-string azp is not an origin");
});

test("a token that carries an azp still has it enforced", () => {
  // The protection this claim exists for is not weakened for browsers, on either path.
  for (const via of ["cookie", "header"]) {
    assert.deepEqual(verificationPolicy(jwt({ azp: "https://radar.cheap" }), via), {
      authorizedParties: AUTHORIZED_PARTIES,
    });
    assert.deepEqual(
      verificationPolicy(jwt({ azp: "https://evil.example" }), via),
      { authorizedParties: AUTHORIZED_PARTIES },
      "a wrong azp is passed to Clerk to reject, not quietly skipped",
    );
  }
});

test("the mobile app's azp-less bearer token is accepted without the claim", () => {
  assert.deepEqual(verificationPolicy(jwt({ sub: "user_1" }), "header"), {});
});

test("an azp-less cookie is refused outright", () => {
  // A cookie is the one credential a browser attaches cross-site by itself, so a cookie that
  // skipped the origin check is exactly what azp is for. Nothing legitimate sends one.
  assert.equal(verificationPolicy(jwt({ sub: "user_1" }), "cookie"), null);
});

test("radar.cheap is among the authorized parties", () => {
  assert.ok(AUTHORIZED_PARTIES.includes("https://radar.cheap"));
});

// The list is pinned, not just spot-checked, because the risk here is an origin that should not be
// on it rather than one that is missing. A stale entry is silent: nothing fails, nothing logs, and
// the allowlist simply keeps vouching for a host that may have changed hands. One did —
// the predecessor project's preview host on chatgpt.site, on a shared domain where
// an abandoned name can be claimed by somebody else. Adding an origin should mean editing this
// test and saying why.
test("nothing but the intended origins can mint a session token", () => {
  assert.deepEqual([...AUTHORIZED_PARTIES].sort(), [
    "http://127.0.0.1:3000",
    "http://affiliate.localhost:3000",
    "http://localhost:3000",
    "https://affiliate.radar.cheap",
    "https://radar.cheap",
  ]);
});

// Why affiliate.radar.cheap is on the list, written here because the test above demands it.
//
// It is the affiliate portal: the same Worker, the same app and the same Clerk instance, served
// under its own name by a rewrite in worker/index.ts. A different hostname is a different origin
// to the browser, so Clerk stamps "https://affiliate.radar.cheap" into `azp` for a token minted
// there, and without this entry every authenticated request from the portal would be refused —
// which reads, to an affiliate, as being signed out on a page that had just shown their name.
//
// It is ours and it stays ours: a subdomain of a domain Radar holds, not a name on a shared host
// that can be claimed by somebody else when it lapses. That is the distinction the pinned list
// exists to enforce, and it is the reason the predecessor project's origin had to come off.

// Localhost is here for development and is not a hole in production: a token minted by a page on
// someone else's machine is still a token Clerk has to have signed for this instance.
//
// `affiliate.localhost` is the same allowance. Every browser resolves *.localhost to the loopback
// address without touching DNS (RFC 6761) and treats it as a secure context, which is what makes
// it usable as a local stand-in for the affiliate subdomain — so it is loopback in every sense
// that matters here, despite not being spelled "localhost".
test("the only non-https parties are loopback", () => {
  const insecure = AUTHORIZED_PARTIES.filter((origin) => !origin.startsWith("https://"));
  assert.deepEqual(insecure.sort(), ["http://127.0.0.1:3000", "http://affiliate.localhost:3000", "http://localhost:3000"]);
  for (const origin of insecure) {
    const host = new URL(origin).hostname;
    assert.ok(host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost"), `${origin} is not loopback`);
  }
});
