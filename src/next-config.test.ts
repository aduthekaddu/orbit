import assert from "node:assert/strict";
import { globSync } from "node:fs";
import test, { before } from "node:test";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import nextConfig from "../next.config";

// A next.config.ts header rule that matches a route handler replaces the handler's own header of the
// same name (Next.js 16.4.6, PR 163), so frame and CSP rules must match pages only.
let rules: ReturnType<typeof buildCustomRoute<{ source: string; headers: { key: string; value: string }[] }>>[] = [];
before(async () => {
  rules = (await loadCustomRoutes(nextConfig)).headers.map((rule) => buildCustomRoute("header", rule));
});

function configHeaders(path: string) {
  const headers = new Map<string, string>();
  for (const rule of rules) {
    if (rule.match(path)) for (const { key, value } of rule.headers) headers.set(key.toLowerCase(), value);
  }
  return headers;
}

function appPaths(file: "page.tsx" | "route.ts") {
  return globSync(`src/app/**/${file}`).map((found) =>
    "/" + found.split("/").slice(2, -1).filter((segment) => !/^\(.+\)$/.test(segment))
      .map((segment) => (segment.startsWith("[") ? "x" : segment)).join("/"),
  );
}

const pages = appPaths("page.tsx");
const handlers = [...appPaths("route.ts"), "/api/files/x"];
const sharePaths = ["/s/x", "/s/x/frame/1"];

test("the app has the pages and route handlers this test reads", () => {
  assert.ok(pages.includes("/c/x") && pages.includes("/login"), pages.join(" "));
  assert.ok(handlers.includes("/api/chats") && handlers.includes("/api/auth/x"), handlers.join(" "));
});

test("every app page refuses to be framed and loads no URL into a frame", () => {
  for (const path of pages) {
    const headers = configHeaders(path);
    const directives = headers.get("content-security-policy")?.split(";").map((value) => value.trim()) ?? [];
    assert.ok(directives.includes("frame-ancestors 'none'"), `${path}: ${headers.get("content-security-policy")}`);
    assert.ok(directives.includes("frame-src 'none'"), `${path}: ${headers.get("content-security-policy")}`);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
  }
});

test("no header rule replaces the CSP or frame header of a route handler or a share page", () => {
  for (const path of [...handlers, ...sharePaths]) {
    const headers = configHeaders(path);
    assert.equal(headers.get("content-security-policy"), undefined, path);
    assert.equal(headers.get("x-frame-options"), undefined, path);
  }
});

test("every response outside /s/ sends nosniff and a same-origin referrer, static files included", () => {
  for (const path of [...pages, ...handlers, "/_next/static/chunks/app.js", "/icon.svg", "/missing-page"]) {
    const headers = configHeaders(path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(headers.get("referrer-policy"), "same-origin", path);
  }
  for (const path of sharePaths) {
    assert.equal(configHeaders(path).get("referrer-policy"), undefined, path);
  }
});
