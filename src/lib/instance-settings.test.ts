import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import { seedTestConnection } from "./connection-fixture";
import { getDb } from "./db";
import { instanceSettings, user } from "./db/schema";
import { getInstance, saveInstance, toPublicInstance } from "./instance-settings";
import { decryptSecret, SecretUnreadable } from "./secrets";
import type { UserId } from "./session";

const adminId = "instance-admin" as UserId;
const memberId = "instance-member" as UserId;
const key = randomBytes(24).toString("hex");
const envNames = ["ORBIT_SEARXNG_URL", "ORBIT_TAVILY_API_KEY", "ORBIT_SANDBOX", "ORBIT_SECRET_KEY"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(() => {
  process.env.ORBIT_SEARXNG_URL = "https://search.example.test";
  process.env.ORBIT_TAVILY_API_KEY = key;
  getDb().insert(user).values([
    { id: adminId, name: "Admin", email: "instance-admin@orbit.test", role: "admin" },
    { id: memberId, name: "Member", email: "instance-member@orbit.test", role: "member" },
  ]).run();
});

after(() => {
  getDb().$client.close();
  for (const name of envNames) restore(name, originalEnv[name]);
});

function ciphertext() {
  return getDb().select({ value: instanceSettings.tavilyKeyCiphertext }).from(instanceSettings).get()?.value ?? "";
}

test("search environment settings seed encrypted values and only return key status publicly", () => {
  const row = getInstance();
  assert.deepEqual(row.hostingMode, { kind: "personal" });
  assert.equal(row.searxngUrl, "https://search.example.test");
  assert.equal(row.tavilyApiKey, key);
  const stored = ciphertext();
  assert.notEqual(stored, key);
  assert.equal(decryptSecret(stored, "instance_settings.tavily_api_key"), key);
  assert.throws(() => decryptSecret(stored, "user_github.token"), SecretUnreadable);
  const publicRow = toPublicInstance(adminId, row);
  assert.equal(publicRow.tavilyKeySet, true);
  assert.equal(publicRow.tavilyKeyReadable, true);
  assert.equal("tavilyApiKey" in publicRow, false);
  assert.equal(JSON.stringify(publicRow).includes(key), false);
});

test("an unreadable key survives an unrelated save and can be removed", () => {
  const prior = ciphertext();
  process.env.ORBIT_SECRET_KEY = randomBytes(32).toString("hex");
  try {
    const publicRow = toPublicInstance(adminId);
    assert.equal(publicRow.tavilyKeySet, true);
    assert.equal(publicRow.tavilyKeyReadable, false);
    assert.equal(getInstance().tavilyApiKey, "");
    assert.equal(saveInstance(adminId, { dreamHour: 7, tavilyApiKey: " " }).ok, true);
    assert.equal(ciphertext(), prior);
    assert.equal(saveInstance(adminId, { tavilyApiKey: null }).ok, true);
    assert.equal(ciphertext(), "");
    assert.equal(toPublicInstance(adminId).tavilyKeySet, false);
  } finally {
    restore("ORBIT_SECRET_KEY", originalEnv.ORBIT_SECRET_KEY);
  }
});

test("the admin cannot turn on the code sandbox when the server has disabled it", () => {
  delete process.env.ORBIT_SANDBOX;
  assert.equal(saveInstance(adminId, { sandbox: "on" }).ok, true);
  assert.equal(toPublicInstance(adminId).sandboxAvailable, false);
  assert.equal(toPublicInstance(adminId).sandbox, false);

  process.env.ORBIT_SANDBOX = "on";
  assert.equal(toPublicInstance(adminId).sandbox, true);
  assert.equal(saveInstance(adminId, { sandbox: "off" }).ok, true);
  assert.equal(toPublicInstance(adminId).sandboxAvailable, true);
  assert.equal(toPublicInstance(adminId).sandbox, false);
  assert.equal(toPublicInstance(adminId).dreamHour, 7);
});

test("admin search URLs only mask the admin's provider credentials and round-trip unchanged", () => {
  const adminPart = "fixture-connection-admin-992";
  const memberPart = "fixture-connection-member-619";
  seedTestConnection(adminId, { apiKey: adminPart, model: "mock" });
  seedTestConnection(memberId, { apiKey: memberPart, model: "mock" });
  const savedUrl = `https://search.example.test/${adminPart}/${memberPart}`;
  assert.equal(saveInstance(adminId, { searxngUrl: savedUrl }).ok, true);
  const { searxngUrl } = toPublicInstance(adminId);
  assert.equal(searxngUrl, `https://search.example.test/[redacted]/${memberPart}`);
  assert.equal(saveInstance(adminId, { searxngUrl }).ok, true);
  assert.equal(getInstance().searxngUrl, savedUrl);
});
