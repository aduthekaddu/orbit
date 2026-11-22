import assert from "node:assert/strict";
import test from "node:test";
import { isCrossOriginWrite, resolveAuthBaseUrl, resolveTrustedOrigins } from "./auth-origins";

test("a public base URL trusts only the deployment origin", () => {
  assert.deepEqual(resolveTrustedOrigins("https://orbit.example.com", undefined), ["https://orbit.example.com"]);
});

test("a local base URL trusts that origin", () => {
  assert.deepEqual(resolveTrustedOrigins("http://127.0.0.1:3210", ""), ["http://127.0.0.1:3210"]);
});

test("explicit extra origins are trimmed, deduplicated, and kept", () => {
  assert.deepEqual(
    resolveTrustedOrigins(
      "https://orbit.example.com",
      " http://127.0.0.1:3211, https://staging.example.com ,http://127.0.0.1:3211",
    ),
    ["https://orbit.example.com", "http://127.0.0.1:3211", "https://staging.example.com"],
  );
});

test("a malformed base URL still keeps the explicit origins", () => {
  assert.deepEqual(resolveTrustedOrigins("not a url", "http://127.0.0.1:3211"), ["http://127.0.0.1:3211"]);
});

test("ORBIT_PUBLIC_URL becomes the auth base URL", () => {
  assert.equal(
    resolveAuthBaseUrl({ BETTER_AUTH_URL: "http://127.0.0.1:3210", ORBIT_PUBLIC_URL: "https://orbit.example.com" }),
    "https://orbit.example.com",
  );
});

test("without ORBIT_PUBLIC_URL the auth base URL stays BETTER_AUTH_URL", () => {
  assert.equal(resolveAuthBaseUrl({ BETTER_AUTH_URL: "http://127.0.0.1:3210" }), "http://127.0.0.1:3210");
  assert.equal(
    resolveAuthBaseUrl({ BETTER_AUTH_URL: "http://127.0.0.1:3210", ORBIT_PUBLIC_URL: "  " }),
    "http://127.0.0.1:3210",
  );
  assert.equal(resolveAuthBaseUrl({}), "http://127.0.0.1:3210");
});

test("ORBIT_PUBLIC_URL adds the public origin and keeps the local one", () => {
  assert.deepEqual(resolveTrustedOrigins("http://127.0.0.1:3210", undefined, "https://orbit.example.com/"), [
    "http://127.0.0.1:3210",
    "https://orbit.example.com",
  ]);
});

test("ORBIT_PUBLIC_URL keeps the explicit origins", () => {
  assert.deepEqual(
    resolveTrustedOrigins("http://127.0.0.1:3210", "http://127.0.0.1:3211", "https://orbit.example.com"),
    ["http://127.0.0.1:3210", "https://orbit.example.com", "http://127.0.0.1:3211"],
  );
});

test("an empty ORBIT_PUBLIC_URL changes no origins", () => {
  assert.deepEqual(resolveTrustedOrigins("http://127.0.0.1:3210", undefined, ""), ["http://127.0.0.1:3210"]);
});

const trustedOrigin = "https://orbit.example.com";
const trustedOrigins = [trustedOrigin, "https://*.example.com"];

for (const { name, method, headers, crossOrigin } of [
  { name: "a POST marked same-site", method: "POST", headers: { "sec-fetch-site": "same-site", origin: trustedOrigin }, crossOrigin: true },
  { name: "a POST from a foreign origin", method: "POST", headers: { origin: "http://other.example" }, crossOrigin: true },
  { name: "a POST from a trusted origin", method: "POST", headers: { origin: trustedOrigin }, crossOrigin: false },
  { name: "a POST marked same-origin", method: "POST", headers: { "sec-fetch-site": "same-origin", origin: trustedOrigin }, crossOrigin: false },
  { name: "a POST marked same-origin from a foreign origin", method: "POST", headers: { "sec-fetch-site": "same-origin", origin: "http://other.example" }, crossOrigin: true },
  { name: "a POST with neither header", method: "POST", headers: {}, crossOrigin: false },
  { name: "a POST from an opaque origin", method: "POST", headers: { origin: "null" }, crossOrigin: true },
  { name: "a POST whose origin has a path", method: "POST", headers: { origin: `${trustedOrigin}/path` }, crossOrigin: true },
  { name: "a POST from an origin only a wildcard matches", method: "POST", headers: { origin: "https://other.example.com" }, crossOrigin: true },
  { name: "a DELETE from a foreign origin", method: "DELETE", headers: { origin: "http://other.example" }, crossOrigin: true },
  { name: "a GET from a foreign origin", method: "GET", headers: { origin: "http://other.example" }, crossOrigin: false },
]) {
  test(`${name} is ${crossOrigin ? "a cross-origin write" : "not a cross-origin write"}`, () => {
    assert.equal(isCrossOriginWrite({ method, headers: new Headers(headers) }, trustedOrigins), crossOrigin);
  });
}
