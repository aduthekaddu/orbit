import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { getAuth } from "./auth";
import { LOCAL_AUTH_URL } from "./auth-origins";
import { getDb } from "./db";
import { encryptSecret } from "./secrets";

const origin = new URL(LOCAL_AUTH_URL).origin;
const providerKey = randomUUID();
const githubToken = randomUUID();
const sqlite = getDb().$client;

after(() => { sqlite.close(); });

function authRequest(endpoint: string, body: object, cookie?: string) {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return getAuth().handler(new Request(new URL(`/api/auth/${endpoint}`, origin), {
    method: "POST", headers, body: JSON.stringify(body),
  }));
}

function signup(email: string) {
  return authRequest("sign-up/email", { email, password: "test-password-123", name: "Account" });
}

test("parallel first signups leave one admin and subsequent public signup is closed", async (t) => {
  t.mock.method(console, "error", () => {});
  process.env.ORBIT_BASE_URL = new URL("/v1", origin).href;
  process.env.ORBIT_API_KEY = providerKey;
  process.env.ORBIT_MODEL = "environment-model";
  process.env.ORBIT_GITHUB_TOKEN = githubToken;
  t.after(() => {
    delete process.env.ORBIT_BASE_URL;
    delete process.env.ORBIT_API_KEY;
    delete process.env.ORBIT_MODEL;
    delete process.env.ORBIT_GITHUB_TOKEN;
  });

  const responses = await Promise.all([signup("first@orbit.test"), signup("second@orbit.test")]);
  assert.equal(responses.filter((response) => response.ok).length, 1);
  const created = await responses.find((response) => response.ok)!.json();
  assert.equal(created.user.role, "admin");
  assert.deepEqual(sqlite.prepare("SELECT id, role FROM user").all(), [{ id: created.user.id, role: "admin" }]);
  assert.equal((await signup("third@orbit.test")).status, 403);
  assert.deepEqual(sqlite.prepare("SELECT user_id FROM provider_connections").all(), [{ user_id: created.user.id }]);
  assert.deepEqual(sqlite.prepare("SELECT user_id FROM user_github").all(), [{ user_id: created.user.id }]);

  const { createTestAccount } = await import("./auth-test-helpers");
  const { NOTHING_PINNED, resolveChoice } = await import("./model-choice");
  const member = await createTestAccount({ role: "member", email: "member@orbit.test", name: "Member" });
  const response = await authRequest("update-user", { name: "Still Member", role: "admin" }, member.cookie);
  assert.ok(response.ok || response.status === 400);
  assert.equal(sqlite.prepare("SELECT role FROM user WHERE id = ?").pluck().get(member.viewer.id), "member");
  assert.deepEqual(resolveChoice(member.viewer, NOTHING_PINNED), { ok: false, reason: "no-connection" });

  sqlite.prepare("INSERT INTO pending_connection (id, base_url, api_key_ciphertext, model, effort, created_at) VALUES (1, ?, ?, 'pending-model', 'low', 1)")
    .run(new URL("/v1", origin).href, encryptSecret(randomUUID()));
  assert.deepEqual(resolveChoice(member.viewer, NOTHING_PINNED), { ok: false, reason: "no-connection" });
  assert.equal(sqlite.prepare("SELECT count(*) FROM pending_connection").pluck().get(), 1);
  assert.equal(sqlite.prepare("SELECT count(*) FROM provider_connections WHERE user_id = ?").pluck().get(member.viewer.id), 0);
  assert.equal(sqlite.prepare("SELECT count(*) FROM user_github WHERE user_id = ?").pluck().get(member.viewer.id), 0);
});

test("production code cannot import the test auth helpers", () => {
  const sources = fs.readdirSync("src", { recursive: true, encoding: "utf8" }).filter((name) => /(?<!\.test)\.tsx?$/.test(name));
  for (const name of sources) {
    assert.doesNotMatch(fs.readFileSync(path.join("src", name), "utf8"), /["'][^"'\n]*auth-test-helpers(?:\.ts)?["']/, name);
  }
});
