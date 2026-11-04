// SERVER_READ_PARAMS in worker/index.ts, held to the pages it describes.
//
// The Worker answers a page request whose query string carries only parameters the route's server
// render does not read with the page every signed-out reader of the bare address gets: the baked
// file, or the colo's copy. That is only honest while the table is true. A page that starts reading
// a parameter the table does not list would have one reader's render handed to everyone who arrives
// with a different value of it - so this reads the pages themselves, with the TypeScript parser, and
// fails when:
//
//  - a cacheable route's page (its default export, generateMetadata, generateViewport) declares
//    searchParams other than exactly the ones its entry lists, or reads the query in a way that is
//    not one named parameter at a time, or a layout or not-found page declares any;
//  - a cacheable page under app/[locale] is in neither the table nor the short list of pages left
//    out of it on purpose (which then refuse any query at all);
//  - anything reachable from app/[locale] calls useSearchParams, which would make the server's HTML
//    depend on the query string behind the table's back;
//  - anything reachable from app/[locale] reads a request header or cookie this file does not
//    account for - each read listed below says why it cannot make one reader's page differ from
//    another's.
//
// What the pages do with the parameters they are allowed is tests/deal-page-render.test.mjs's and
// tests/rendered-html.test.mjs's business; this is about which ones they can see.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCALE_TREE = path.join(ROOT, "app", "[locale]");
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");
const CODE = /\.(tsx?|jsx?|mjs)$/;

function sourceFile(file) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function codeFilesUnder(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...codeFilesUnder(full));
    else if (CODE.test(entry.name)) files.push(full);
  }
  return files;
}

// ── The Worker's tables, as written ──────────────────────────────────────────────────────────────

function workerTables() {
  const file = sourceFile(path.join(ROOT, "worker", "index.ts"));
  const init = {};
  walk(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) init[node.name.text] = node.initializer;
  });
  const strings = (array, what) => {
    assert.ok(array && ts.isArrayLiteralExpression(array), `${what}: expected an array literal`);
    return array.elements.map((element) => {
      assert.ok(ts.isStringLiteral(element), `${what}: expected string literals only`);
      return element.text;
    });
  };
  const constructed = (name, kind) => {
    const node = init[name];
    assert.ok(node && ts.isNewExpression(node) && node.expression.getText() === kind, `expected ${name} = new ${kind}(...) in worker/index.ts`);
    return node.arguments[0];
  };
  const pairs = constructed("SERVER_READ_PARAMS", "Map");
  assert.ok(ts.isArrayLiteralExpression(pairs));
  const serverReadParams = new Map(pairs.elements.map((pair) => {
    assert.ok(ts.isArrayLiteralExpression(pair) && pair.elements.length === 2 && ts.isStringLiteral(pair.elements[0]), "SERVER_READ_PARAMS: [route, [parameters]] pairs");
    return [pair.elements[0].text, strings(pair.elements[1], `SERVER_READ_PARAMS ${pair.elements[0].text}`)];
  }));
  return {
    serverReadParams,
    uncacheable: new Set(strings(constructed("UNCACHEABLE_SEGMENTS", "Set"), "UNCACHEABLE_SEGMENTS")),
    shells: new Set(strings(constructed("AUTH_SHELLS", "Set"), "AUTH_SHELLS")),
  };
}

// ── The pages ────────────────────────────────────────────────────────────────────────────────────

// Every page under app/[locale], with its route in the table's terms: the directories under the
// locale joined with "/", an optional catch-all at the end dropped (its bare form is its parent's
// address; anything below it is three segments deep, which the Worker never shares with a query).
// Personal exactly as pageLookup decides it: under an UNCACHEABLE_SEGMENTS segment, bar a bare
// AUTH_SHELLS page.
function pages() {
  const { uncacheable, shells } = workerTables();
  return codeFilesUnder(LOCALE_TREE)
    .filter((file) => /^page\.(tsx?|jsx?)$/.test(path.basename(file)))
    .map((file) => {
      const segments = path.relative(LOCALE_TREE, path.dirname(file)).split(path.sep).filter(Boolean);
      if (segments.length && /^\[\[\.\.\..+\]\]$/.test(segments[segments.length - 1])) segments.pop();
      const personal = segments.length > 0 && uncacheable.has(segments[0]) && !(segments.length === 1 && shells.has(segments[0]));
      return { file, route: segments.join("/"), personal };
    });
}

// The functions the framework hands a page's props to, by export name.
function frameworkFunctions(file) {
  const sf = sourceFile(file);
  const declared = new Map();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declared.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          declared.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const found = {};
  for (const statement of sf.statements) {
    const modifiers = (ts.canHaveModifiers(statement) && ts.getModifiers(statement)) || [];
    const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && exported) {
      if (isDefault) found.default = statement;
      else if (statement.name) found[statement.name.text] = statement;
    } else if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declared.has(declaration.name.text)) found[declaration.name.text] = declared.get(declaration.name.text);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression;
      if (ts.isIdentifier(expression) && declared.has(expression.text)) found.default = declared.get(expression.text);
      else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) found.default = expression;
      else assert.fail(`${rel(file)}: export the page as a function declared in the file, so its props can be read here`);
    }
  }
  return ["default", "generateMetadata", "generateViewport"].filter((name) => found[name]).map((name) => ({ name, fn: found[name] }));
}

// An expression's outermost wrapper that changes nothing about its value: parentheses, `as`, `!`.
function outer(node) {
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent))) current = current.parent;
  return current;
}

function insideType(node, stop) {
  for (let current = node.parent; current && current !== stop; current = current.parent) if (ts.isTypeNode(current)) return true;
  return false;
}

function bindsName(binding, name) {
  if (!binding) return false;
  if (ts.isIdentifier(binding)) return binding.text === name;
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, name));
  return false;
}

// Whether `node` opens a scope that declares `name` itself, so that a `name` inside it is a
// different variable: a block's own declarations, a function's parameters, a loop's or a catch's.
function declaresName(node, name) {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements.some((statement) => (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindsName(declaration.name, name)))
      || ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name));
  }
  if (ts.isFunctionLike(node)) return node.parameters.some((parameter) => bindsName(parameter.name, name)) || (ts.isFunctionExpression(node) && node.name?.text === name);
  if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    return node.initializer.declarations.some((declaration) => bindsName(declaration.name, name));
  }
  if (ts.isCatchClause(node)) return bindsName(node.variableDeclaration?.name, name);
  return false;
}

// The scope a declaration's name belongs to: the nearest block, function, loop or catch around it.
function scopeOf(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)
      || ts.isFunctionLike(current) || ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isCatchClause(current)) return current;
  }
  return node.getSourceFile();
}

// The places a name is used as a value inside `scope`: not where it is declared, not as a property
// name, not inside a type, and not inside a nested scope that declares a variable of the same name.
function references(scope, name) {
  const found = [];
  const visit = (node) => {
    if (node !== scope && declaresName(node, name)) return;
    check(node);
    ts.forEachChild(node, visit);
  };
  const check = (node) => {
    if (!ts.isIdentifier(node) || node.text !== name) return;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return;
    if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) return;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) return;
    if (ts.isJsxAttribute(parent) && parent.name === node) return;
    if (insideType(node, scope)) return;
    found.push(node);
  };
  visit(scope);
  return found;
}

// The query parameters a framework function declares and reads. `declared` comes from the type of
// its props (`searchParams: Promise<{ return?: string; ... }>`); `read` from what it does with
// `await searchParams`; `whole` lists every place the query object is used as a whole - handed on,
// spread, enumerated - where this cannot tell which parameters end up mattering.
function queryUse(file, name, fn) {
  const label = `${rel(file)} ${name}`;
  const result = { declared: [], read: new Set(), whole: [] };
  const [props] = fn.parameters;
  if (!props) return result;
  let binding = null;
  if (ts.isObjectBindingPattern(props.name)) {
    for (const element of props.name.elements) {
      assert.ok(!element.dotDotDotToken, `${label}: a rest element would carry searchParams along unread; destructure what is used`);
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key) && key.text === "searchParams") {
        assert.ok(ts.isIdentifier(element.name), `${label}: bind searchParams to a plain name`);
        binding = element.name.text;
      }
    }
  } else {
    assert.ok(ts.isIdentifier(props.name), `${label}: unexpected props parameter`);
    assert.ok(!references(fn, props.name.text).some((ref) => {
      const parent = outer(ref).parent;
      return !(ts.isPropertyAccessExpression(parent) && parent.name.text === "params");
    }), `${label}: destructure the props, so this test can see which of them the page reads`);
  }
  const type = props.type;
  if (type) {
    assert.ok(ts.isTypeLiteralNode(type), `${label}: declare the props' type inline, so the parameters it reads are named here`);
    const member = type.members.find((entry) => entry.name && ts.isIdentifier(entry.name) && entry.name.text === "searchParams");
    if (member) {
      const promise = member.type;
      assert.ok(promise && ts.isTypeReferenceNode(promise) && promise.typeName.getText() === "Promise" && promise.typeArguments?.length === 1, `${label}: type searchParams as Promise<{ name?: string; ... }>`);
      const literal = promise.typeArguments[0];
      assert.ok(ts.isTypeLiteralNode(literal), `${label}: name each parameter in searchParams' type; no Record, no index signature`);
      for (const entry of literal.members) {
        assert.ok(ts.isPropertySignature(entry) && entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)), `${label}: name each parameter in searchParams' type; no index signature`);
        result.declared.push(entry.name.text);
      }
    }
  }
  if (binding === null) return result;
  assert.ok(type, `${label}: searchParams is read, so its type has to say which parameters`);
  const readFrom = (expression) => {
    const value = outer(expression);
    const parent = value.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === value) return result.read.add(parent.name.text);
    if (ts.isElementAccessExpression(parent) && parent.expression === value && ts.isStringLiteralLike(parent.argumentExpression)) return result.read.add(parent.argumentExpression.text);
    if (ts.isVariableDeclaration(parent) && parent.initializer === value) {
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          if (element.dotDotDotToken) result.whole.push(element);
          else result.read.add((element.propertyName ?? element.name).text);
        }
        return undefined;
      }
      if (ts.isIdentifier(parent.name)) {
        for (const ref of references(scopeOf(parent), parent.name.text)) readFrom(ref);
        return undefined;
      }
    }
    result.whole.push(value);
    return undefined;
  };
  for (const ref of references(fn, binding)) {
    const awaited = outer(ref).parent;
    if (ts.isAwaitExpression(awaited)) readFrom(awaited);
    else result.whole.push(ref);
  }
  return result;
}

// Whole-query uses, by file, each with the reason it cannot leak one reader's page to another.
const WHOLE_QUERY_USES = {
  // The alias redirect: an old address of a listing folded into another forwards the query it came
  // with to the deal's own page. A redirect is never stored (isStorable takes a 200 or a 404) and an
  // alias's old address is not in the sitemap the prerender bakes from, so every request for one is
  // rendered as it came - campaign tags and all - and answered for itself alone.
  "app/[locale]/deals/[slug]/page.tsx": 1,
};

// Cacheable pages deliberately not in SERVER_READ_PARAMS. A route that is not in the table refuses
// any query at all - every request with one is rendered for its reader - so leaving one out is
// always safe; it is listed here so that it is a decision.
const LEFT_OUT = {
  // 404s until APP_STORE_URL is set, and is then a link to the App Store that nobody reaches with a
  // query string worth sharing a page for.
  launch: "launch",
  // The not-found page, for any path no other route claims. routeOf names such a path by its own
  // segment ("/en/foo" is "foo"), which no table entry describes; a bare one is still stored, as a
  // 404, for an hour.
  "[...rest]": "not-found",
};

test("SERVER_READ_PARAMS is exactly the searchParams each cacheable route's page declares", () => {
  const { serverReadParams } = workerTables();
  const all = pages();
  const routes = new Map(all.filter((page) => !page.personal).map((page) => [page.route, page]));
  for (const route of serverReadParams.keys()) {
    assert.ok(routes.has(route), `SERVER_READ_PARAMS has "${route}", which is no cacheable page under app/[locale]`);
  }
  for (const page of all) {
    if (page.personal) continue;
    const label = `${rel(page.file)} (route "${page.route}")`;
    const declared = new Set();
    for (const { name, fn } of frameworkFunctions(page.file)) {
      const use = queryUse(page.file, name, fn);
      use.declared.forEach((key) => declared.add(key));
      for (const key of use.read) assert.ok(use.declared.includes(key), `${label} ${name} reads ?${key} without declaring it`);
      assert.equal(use.whole.length, name === "default" ? WHOLE_QUERY_USES[rel(page.file)] ?? 0 : 0,
        `${label} ${name} uses the query as a whole (${use.whole.map((node) => node.getText().slice(0, 60)).join("; ")}); read each parameter by name, or account for it in WHOLE_QUERY_USES`);
    }
    if (serverReadParams.has(page.route)) {
      assert.deepEqual([...declared].sort(), [...serverReadParams.get(page.route)].sort(), `${label}: SERVER_READ_PARAMS must list exactly the parameters the page declares`);
    } else {
      assert.ok(page.route in LEFT_OUT, `${label} is cacheable but not in SERVER_READ_PARAMS: add it with the parameters its server render reads, or to LEFT_OUT here`);
    }
  }
  // The exceptions above still exist, so neither list goes stale.
  for (const file of Object.keys(WHOLE_QUERY_USES)) assert.ok(existsSync(path.join(ROOT, file)), file);
  for (const route of Object.keys(LEFT_OUT)) assert.ok(all.some((page) => page.route === route && !page.personal), `LEFT_OUT names "${route}", which is no cacheable page`);
});

// A layout is never handed searchParams by the framework, and neither is a not-found page; one that
// declared them anyway would be reading something the table above never sees.
test("no layout or not-found page under app/[locale] declares searchParams", () => {
  const files = codeFilesUnder(LOCALE_TREE).filter((file) => /^(layout|template|not-found|default|error|loading)\.(tsx?|jsx?)$/.test(path.basename(file)));
  assert.ok(files.some((file) => rel(file) === "app/[locale]/layout.tsx"), "expected the locale layout");
  for (const file of files) {
    for (const { name, fn } of frameworkFunctions(file)) {
      const use = queryUse(file, name, fn);
      assert.deepEqual(use.declared, [], `${rel(file)} ${name} declares searchParams`);
      assert.equal(use.whole.length + use.read.size, 0, `${rel(file)} ${name} reads searchParams`);
    }
  }
});

// ── Everything a page can reach ──────────────────────────────────────────────────────────────────

// The relative modules a file loads at runtime: imports (not `import type`), re-exports and dynamic
// import()s. Packages are not followed; the only one that matters here, next/headers, is looked
// for by name below.
function runtimeImports(file) {
  const sf = sourceFile(file);
  const specifiers = [];
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text);
  });
  // Without a bundler query such as "./globals.css?public", which names the same file.
  return specifiers.filter((specifier) => specifier.startsWith(".")).map((specifier) => {
    const base = path.resolve(path.dirname(file), specifier.replace(/\?.*$/, ""));
    const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((ext) => `${base}${ext}`), path.join(base, "index.ts"), path.join(base, "index.tsx")];
    const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(found, `${rel(file)}: cannot resolve ${specifier}`);
    return CODE.test(found) ? found : null;
  }).filter(Boolean);
}

function reachableFromLocaleTree() {
  const seen = new Set();
  const queue = codeFilesUnder(LOCALE_TREE);
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file));
  }
  return seen;
}

test("nothing a page under app/[locale] can reach calls useSearchParams", () => {
  const reachable = reachableFromLocaleTree();
  for (const expected of ["app/HomeClient.tsx", "app/SiteHeader.tsx", "app/auth.ts", "app/RootShell.tsx"]) {
    assert.ok([...reachable].some((file) => rel(file) === expected), `the walk should reach ${expected}`);
  }
  for (const file of reachable) {
    walk(sourceFile(file), (node) => {
      assert.ok(!(ts.isIdentifier(node) && node.text === "useSearchParams"),
        `${rel(file)} uses useSearchParams: the server's HTML would then depend on the query string, which SERVER_READ_PARAMS in worker/index.ts cannot see. Read it from window.location in an effect, or from the page's declared searchParams`);
    });
  }
});

// The request headers and cookies a render reads, by file, each with why it cannot make one
// signed-out reader's page differ from another's at the same address.
const REQUEST_READS = {
  // The host, for canonical and og: URLs. Part of every cache key (the request's origin), and the
  // prerender renders as radar.cheap.
  "app/siteMetadata.ts": ["headers:host"],
  // Set on every render by the Worker itself (renderPage), from the deployment's own variables.
  "app/[locale]/page.tsx": ["headers:x-turnstile-site-key"],
  "app/[locale]/for-creators/page.tsx": ["headers:x-turnstile-site-key"],
  "app/[locale]/for-restaurants/page.tsx": ["headers:x-turnstile-site-key"],
  // The country, for the currency. /pro is never baked, and the colo keeps it once per currency
  // bucket (cacheKeyFor in worker/index.ts; currencyBucket in app/pricing.ts).
  "app/[locale]/pro/page.tsx": ["headers:CF-IPCountry"],
  // Whether a session cookie is present. isSignedIn in worker/index.ts keeps every request carrying
  // one out of the bake and the colo cache.
  "app/RootShell.tsx": ["cookies:__session"],
  // A bearer token or the session cookie: isSignedIn again. The creator referral cookies are read
  // only once a token has verified, for a new account's referral - never for a request the Worker
  // shares. Sec-GPC is read in the same place, to drop that referral for a browser that opted out.
  "app/auth.ts": ["cookies:__session", "cookies:radar_creator", "cookies:radar_creator_campaign", "cookies:radar_referral_code", "headers:authorization", "headers:sec-gpc"],
  // Read by requireSameOrigin, clientKey and verifyTurnstile, which only API routes call; the pages
  // import this file for its postal-code validators (checked in the test below).
  "app/api-utils.ts": ["headers:cf-connecting-ip", "headers:host"],
};
const API_ONLY = { "app/api-utils.ts": ["requireSameOrigin", "clientKey", "verifyTurnstile"] };

// The headers() and cookies() reads in one file: `.get("name")` or `.has("name")` on the awaited
// store, directly, through a variable, or through a parameter of a function in the same file that
// the store is handed to. Any other use is "unaccounted", since this cannot tell what it reads.
function requestReads(file) {
  const sf = sourceFile(file);
  const kinds = new Map();
  const unaccounted = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "next/headers" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      unaccounted.push("next/headers imported other than by name");
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "headers" || imported === "cookies") kinds.set(element.name.text, imported);
      else if (!element.isTypeOnly) unaccounted.push(`next/headers ${imported}`);
    }
  }
  const reads = new Set();
  if (!kinds.size) return { reads, unaccounted };
  const functions = new Map();
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);
  });
  const use = (kind, expression, depth) => {
    const value = outer(expression);
    const parent = value.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === value && ["get", "has"].includes(parent.name.text)
      && ts.isCallExpression(parent.parent) && parent.parent.expression === parent && parent.parent.arguments[0] && ts.isStringLiteralLike(parent.parent.arguments[0])) {
      reads.add(`${kind}:${parent.parent.arguments[0].text}`);
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === value && ts.isIdentifier(parent.name)) {
      for (const ref of references(scopeOf(parent), parent.name.text)) use(kind, ref, depth);
      return;
    }
    if (ts.isCallExpression(parent) && parent.arguments.includes(value) && ts.isIdentifier(parent.expression) && functions.has(parent.expression.text) && depth < 3) {
      const fn = functions.get(parent.expression.text);
      const param = fn.parameters[parent.arguments.indexOf(value)];
      if (param && ts.isIdentifier(param.name)) {
        for (const ref of references(fn, param.name.text)) use(kind, ref, depth + 1);
        return;
      }
    }
    unaccounted.push(`${kind}() used as \`${parent.getText().slice(0, 80)}\``);
  };
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !kinds.has(node.expression.text)) return;
    const awaited = outer(node).parent;
    if (ts.isAwaitExpression(awaited)) use(kinds.get(node.expression.text), awaited, 0);
    else unaccounted.push(`${node.expression.text}() not awaited where it is called`);
  });
  return { reads, unaccounted };
}

test("every request header and cookie a page can read is accounted for", () => {
  const reachable = reachableFromLocaleTree();
  const found = {};
  for (const file of reachable) {
    const { reads, unaccounted } = requestReads(file);
    assert.deepEqual(unaccounted, [], `${rel(file)} reads the request in a way this test cannot follow`);
    if (reads.size) found[rel(file)] = [...reads].sort();
  }
  for (const [file, expected] of Object.entries(REQUEST_READS)) {
    assert.ok(file in found, `${file} is listed in REQUEST_READS but no page reaches a read in it any more; take it out`);
    assert.deepEqual(found[file], [...expected].sort(), `${file} reads ${JSON.stringify(found[file])}, but REQUEST_READS says ${JSON.stringify(expected)}`);
  }
  for (const [file, reads] of Object.entries(found)) {
    assert.ok(file in REQUEST_READS, `${file} reads ${reads.join(", ")} during a page render. If it can make one reader's page differ from another's, the Worker must key or refuse on it (pageLookup, cacheKeyFor in worker/index.ts); then add it to REQUEST_READS with the reason`);
  }

  // The reads REQUEST_READS excuses as API-only stay that way: no page imports the functions that
  // make them.
  const apiOnly = new Map(Object.entries(API_ONLY).map(([file, names]) => [path.join(ROOT, file), new Set(names)]));
  for (const file of reachable) {
    walk(sourceFile(file), (node) => {
      if (!ts.isImportDeclaration(node) || !node.moduleSpecifier.text.startsWith(".")) return;
      const base = path.resolve(path.dirname(file), node.moduleSpecifier.text);
      const target = [...apiOnly.keys()].find((candidate) => candidate === base || candidate === `${base}.ts`);
      const bindings = node.importClause?.namedBindings;
      if (!target) return;
      assert.ok(bindings && ts.isNamedImports(bindings), `${rel(file)} imports ${rel(target)} whole`);
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        assert.ok(!apiOnly.get(target).has(imported), `${rel(file)} imports ${imported} from ${rel(target)}, whose request reads REQUEST_READS excuses as API-only`);
      }
    });
  }
});

// ── The middleware in front of every page ────────────────────────────────────────────────────────

// proxy.ts is next-intl's middleware and nothing else, and it runs ahead of every page render. Its
// reads of the request are in the package, not in app/, so the walk above never sees them, and one
// of them did reach stored pages: it builds every page's Link alternates from X-Forwarded-Host and
// X-Forwarded-Proto when a request carries them, and a client can send both. So the headers it reads
// are listed here by name, read out of the package's own files (every file its middleware entry
// imports, in both builds the package ships), each with why it cannot make one reader's page differ
// from another's. A next-intl upgrade that starts reading another one fails here.
const MIDDLEWARE_READS = {
  // The request's origin, which is part of every cache key; and the prerender renders as radar.cheap.
  host: "origin",
  // Deleted from every request before it is rendered (FORWARDED_HEADERS, renderPage).
  "x-forwarded-host": "stripped",
  "x-forwarded-port": "stripped",
  "x-forwarded-proto": "stripped",
  // Read to choose a locale for an address without one, which is never a cacheable page, and to
  // decide whether to write NEXT_LOCALE - whose value is the address's own locale, the only cookie
  // isStorable lets a stored page carry.
  "accept-language": "locale cookie",
  // Whether this is a document load, again only for whether NEXT_LOCALE is written.
  "sec-fetch-dest": "locale cookie",
};

function middlewareFiles(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  return [...seen];
}

test("every request header next-intl's middleware reads is accounted for, and the forwarded ones never reach it", () => {
  const proxy = readFileSync(path.join(ROOT, "proxy.ts"), "utf8");
  assert.match(proxy, /^import createMiddleware from "next-intl\/middleware";\s*import \{ routing \} from "\.\/i18n\/routing";\s*export default createMiddleware\(routing\);/m,
    "proxy.ts is next-intl's middleware and nothing else; a middleware of our own reads the request too and belongs in this audit");
  const production = fileURLToPath(import.meta.resolve("next-intl/middleware"));
  const development = production.replace(`${path.sep}production${path.sep}`, `${path.sep}development${path.sep}`);
  assert.notEqual(production, development, `expected next-intl's production build, got ${production}`);
  const found = new Set();
  for (const entry of [production, development]) {
    const files = middlewareFiles(entry);
    assert.ok(files.length > 3, `expected the middleware's modules under ${path.dirname(entry)}`);
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/\.(?:get|has)\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1].toLowerCase());
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(MIDDLEWARE_READS).sort(),
    "next-intl's middleware reads a request header this audit does not account for. If it can make one reader's page differ from another's, the Worker must strip it (renderPage), key on it or refuse on it");

  const worker = readFileSync(path.join(ROOT, "worker", "index.ts"), "utf8");
  const stripped = [...worker.match(/const FORWARDED_HEADERS = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(stripped, Object.entries(MIDDLEWARE_READS).filter(([, why]) => why === "stripped").map(([name]) => name).sort());
  const render = worker.slice(worker.indexOf("function renderPage("), worker.indexOf("return handler.fetch(forwarded, env, ctx);"));
  assert.match(render, /const forwarded = new Request\(request, \{ headers: new Headers\(request\.headers\) \}\);\s*for \(const name of FORWARDED_HEADERS\) forwarded\.headers\.delete\(name\);/,
    "renderPage copies every request's headers and deletes the forwarded ones before anything renders");
});
