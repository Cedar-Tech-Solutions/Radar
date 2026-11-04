import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { adminClientSource, code } from "./source.mjs";

// The pinned owner's address stays on the server.
//
// It used to be exported from app/permissions.ts, which the admin client imports, so it shipped in
// a public JS chunk that every page's entry script names. The admin client now draws the lock from
// an isProtected flag /api/admin computes per user row. The address itself is the OWNER_EMAIL var
// in wrangler.jsonc, read by app/auth.ts from the Worker env, so no application source names it.
//
// The address is read from wrangler.jsonc rather than written here, so this file does not publish
// it either, and no assertion message below prints it.

const authSource = readFileSync(new URL("../app/auth.ts", import.meta.url), "utf8");
const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const declared = wranglerSource.match(/^\s*"OWNER_EMAIL": "([^"]*)",?$/m);
assert.ok(declared, "wrangler.jsonc no longer declares the OWNER_EMAIL var the way this test reads it");
// Blank in the public copy of the code (scripts/export-public.mjs), where nobody is pinned; the
// address checks below then use a stand-in, and the leak checks have nothing to look for.
const CONFIGURED = declared[1].trim().toLowerCase();
const OWNER = CONFIGURED || "owner@example.test";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
function files(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) out.push(...files(path, keep));
    else if (keep(name)) out.push(path);
  }
  return out;
}
const relative = (path) => path.slice(root.length + 1).replace(/\\/g, "/");

test("no application source names the owner's address", { skip: !CONFIGURED && "no owner configured" }, () => {
  const sources = [
    ...files(`${root}/app`, (name) => /\.(ts|tsx|js|mjs|json|css)$/.test(name)),
    ...files(`${root}/messages`, (name) => name.endsWith(".json")),
  ];
  const holders = sources.filter((path) => readFileSync(path, "utf8").toLowerCase().includes(OWNER)).map(relative);
  assert.deepEqual(holders, []);
});

test("no client component imports app/auth.ts", () => {
  // A "use client" module and everything it imports is bundled for the browser. app/auth.ts reads
  // the Worker env and request headers, so importing it from one would not build anyway, but the
  // day that changes is the day the address ships again.
  const clients = files(`${root}/app`, (name) => /\.(ts|tsx)$/.test(name))
    .filter((path) => /^\s*["']use client["']/.test(readFileSync(path, "utf8")));
  assert.ok(clients.length > 10, "expected to find the client components");
  for (const path of clients) {
    assert.doesNotMatch(code(readFileSync(path, "utf8")), /from\s+["'](\.\.?\/)+auth["']/, `${relative(path)} imports app/auth.ts`);
  }
});

test("permissions.ts, which the admin client imports, names nobody", () => {
  const permissions = readFileSync(new URL("../app/permissions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(permissions, /SUPER_OWNER_EMAIL/);
  assert.doesNotMatch(code(permissions), /[\w.+-]+@[\w-]+\.[\w.]+/, "an address in permissions.ts ships to every browser");
});

test("the admin API marks the pinned owner's row, and the client draws the lock from that", () => {
  const route = code(readFileSync(new URL("../app/api/admin/route.ts", import.meta.url), "utf8"));
  assert.match(route, /users: \(users\.results as [^)]*\)\.map\(\(row\) => \(\{ \.\.\.row, isProtected: isProtectedOwner\(row\.email\) \}\)\)/);
  // The server-side guard is what actually stops the change; the flag only draws the lock.
  assert.match(route, /if \(isProtectedOwner\(targetUser\?\.email\)\)\s*return apiError\(409,"SUPER_OWNER_PROTECTED"/);

  const client = code(adminClientSource());
  assert.doesNotMatch(client, /SUPER_OWNER_EMAIL|OWNER_EMAIL/);
  // GatedButton's `blocked` carries both the unavailable state and its spoken reason.
  assert.equal((client.match(/u\.isProtected/g) || []).length, 2, "the blocked state with its reason, and the label");
});

// Loads app/auth.ts with its Worker-only imports stripped, as tests/auth-authorized-parties.test.mjs
// does, and the Worker env replaced by a plain object the caller controls.
async function loadAuth(runtimeEnv) {
  globalThis.__ownerTestEnv = runtimeEnv;
  return import(
    `data:text/javascript;base64,${Buffer.from(
      "const env = globalThis.__ownerTestEnv;\n" + ts.transpileModule(
        authSource
          .replace(/^import .*(cloudflare:workers|next\/headers|next\/navigation|@clerk\/backend).*$/gm, "")
          .replace(/^import \{ ADMIN_ENTRY_PERMISSION.*$/gm, "")
          .replace(/^import \{ hasProAccess, isProPlan \}.*$/gm, "const isProPlan = () => false; const hasProAccess = () => false;")
          .replace(/^import \{ resolveReferralCode \}.*$/gm, "const resolveReferralCode = async () => ({ ok: false });"),
        { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
      ).outputText,
    ).toString("base64")}#${Math.random()}`
  );
}

test("isProtectedOwner matches the configured owner's address in any case, and nobody else", async () => {
  const { isProtectedOwner } = await loadAuth({ OWNER_EMAIL: OWNER });
  assert.equal(isProtectedOwner(OWNER), true);
  assert.equal(isProtectedOwner(OWNER.toUpperCase()), true);
  assert.equal(isProtectedOwner(` ${OWNER} `), true);
  assert.equal(isProtectedOwner(`x${OWNER}`), false);
  assert.equal(isProtectedOwner("someone@example.test"), false);
  assert.equal(isProtectedOwner(null), false);
  assert.equal(isProtectedOwner(undefined), false);
});

test("with OWNER_EMAIL unset or blank, nobody is the pinned owner", async () => {
  for (const runtimeEnv of [{}, { OWNER_EMAIL: "" }, { OWNER_EMAIL: "   " }]) {
    const { isProtectedOwner } = await loadAuth(runtimeEnv);
    assert.equal(isProtectedOwner(OWNER), false);
    assert.equal(isProtectedOwner(""), false);
    assert.equal(isProtectedOwner("   "), false);
  }
});

test("the built client bundle does not contain the owner's address", { skip: !CONFIGURED && "no owner configured" }, () => {
  // What the audit found: the public chunk served at /_next/static/chunks/AdminClient-*.js. Every
  // file the asset layer can serve is checked, not only that one.
  const client = `${root}/dist/client`;
  assert.ok(existsSync(client), "dist/client is missing; run npm run build first");
  const served = files(client, (name) => /\.(js|mjs|css|json|html|txt|map)$/.test(name));
  assert.ok(served.some((path) => /AdminClient-[\w-]+\.js$/.test(path)), "expected the admin client chunk in dist/client");
  const leaking = served.filter((path) => readFileSync(path, "utf8").toLowerCase().includes(OWNER)).map(relative);
  assert.deepEqual(leaking, [], "these public files contain the owner's address");
});
