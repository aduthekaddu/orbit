import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustedOrigins } from "./auth-origins";

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
