import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import { LIMITS, r, readJsonBody } from "./route-schema";

const FIX = 'Build route schemas from `r` in "@/lib/route-schema": `r.text(max)` for a string and `r.list(item, max)` for an array. A limit goes in LIMITS.';
const routes = globSync("src/app/api/**/route.ts").sort();

// A route that takes input through one of these must parse it with a schema built from `r`.
const readsInput = /\.(?:json|text|formData|arrayBuffer|blob)\(\)|\bsearchParams\b|\bcontext\.params\b/;
const importsZod = /from\s+["']zod(?:\/[^"']*)?["']|require\(\s*["']zod/;
const importsRouteSchema = /from\s+["']@\/lib\/route-schema["']/;

test("the route walk finds the routes", () => {
  assert.ok(routes.length >= 10, `found ${routes.length} routes under src/app/api`);
});

test("no route imports zod directly, because zod builds a string with no limit", () => {
  const offenders = routes.filter((file) => importsZod.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], `These routes import zod. ${FIX}`);
});

test("every route that reads a body, a query or a path parameter parses it with a schema built from `r`", () => {
  const offenders = routes.filter((file) => {
    const source = readFileSync(file, "utf8");
    return readsInput.test(source) && !importsRouteSchema.test(source);
  });
  assert.deepEqual(offenders, [], `These routes read request input and have no bounded schema. ${FIX}`);
});

test("`r` builds no string, array or unchecked value without a limit", () => {
  const unbounded = ["string", "array", "unknown", "any", "record", "custom", "json", "coerce", "templateLiteral", "stringbool"];
  assert.deepEqual(Object.keys(r).filter((name) => unbounded.includes(name)), [], "`r` exposes a way to build an unbounded value");
  assert.throws(() => r.text(10).parse("a".repeat(11)), /too_big|Too big|<=10/);
  assert.throws(() => r.list(r.text(1), 2).parse(["a", "b", "c"]), /too_big|Too big|<=2/);
});

test("a route that takes stored history caps the body before it parses it", () => {
  const offenders = routes.filter((file) => {
    const source = readFileSync(file, "utf8");
    return /\br\.history\b/.test(source) && !/\breadJsonBody\(\s*\w+,\s*LIMITS\.requestBytes\s*\)/.test(source);
  });
  assert.deepEqual(offenders, [], "These routes use `r.history`, whose limit is the request size cap. Read the body with `readJsonBody(request, LIMITS.requestBytes)` first.");
});

test("a history string or list is bounded by the request size cap", () => {
  assert.throws(() => r.history.text().parse("a".repeat(LIMITS.requestBytes + 1)), /too_big|Too big|<=/);
  assert.equal(r.history.text().parse("a".repeat(LIMITS.requestBytes)).length, LIMITS.requestBytes);
});

test("readJsonBody stops at the cap, with or without a content-length header", async () => {
  const body = JSON.stringify({ text: "a".repeat(100) });
  const sized = (text: string, headers: Record<string, string> = {}) => new Request("http://orbit.test/x", { method: "POST", headers, body: text });
  assert.deepEqual(await readJsonBody(sized(body), 1000), { ok: true, json: { text: "a".repeat(100) } });
  assert.deepEqual(await readJsonBody(sized(body), 50), { ok: false, reason: "too-large" });
  assert.deepEqual(await readJsonBody(sized("{}", { "content-length": "999999" }), 50), { ok: false, reason: "too-large" });
  assert.deepEqual(await readJsonBody(sized("{not json"), 1000), { ok: false, reason: "invalid" });
  assert.deepEqual(await readJsonBody(new Request("http://orbit.test/x", { method: "POST" }), 1000), { ok: false, reason: "invalid" });
});
