import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { seedTestConnection } from "./connection-fixture";
import { getDb } from "./db";
import { user } from "./db/schema";
import { parseViewer } from "./policy";
import { modelRedactors, publicConnections, requestRedactor } from "./request-redactor";
import { saveGithub } from "./user-github";

const admin = parseViewer({ id: "redactor-admin", role: "admin" });
const member = parseViewer({ id: "redactor-member", role: "member" });
const memberProvider = "fixture-member-provider";
const adminProvider = "fixture-admin-provider";
const memberGitHub = "fixture-member-github";
const instance = { tavilyApiKey: "fixture-search-credential", searxngUrl: "https://fixture.invalid/search" };

before(() => {
  const db = getDb();
  for (const viewer of [admin, member]) {
    db.insert(user).values({ ...viewer, name: "Fixture", email: `${viewer.id}@orbit.test` }).run();
  }
  seedTestConnection(admin.id, { baseUrl: "https://fixture.invalid/v1", apiKey: adminProvider, model: "fixture-model" });
  seedTestConnection(member.id, { baseUrl: "https://fixture.invalid/v1", apiKey: memberProvider, model: "fixture-model" });
  assert.ok(saveGithub(member.id, { githubToken: memberGitHub }).ok);
});

after(() => getDb().$client.close());

test("viewer-facing redaction separates member and instance credential sources", () => {
  const memberRedactor = requestRedactor(member, instance);
  assert.equal(memberRedactor.isStoredSecret(memberProvider), true);
  assert.equal(memberRedactor.isStoredSecret(memberGitHub), true);
  assert.equal(memberRedactor.isStoredSecret(adminProvider), false);
  assert.equal(memberRedactor.isStoredSecret(instance.tavilyApiKey), false);
  assert.equal(requestRedactor(admin, instance).isStoredSecret(instance.tavilyApiKey), true);
});

test("trusted output redaction includes the exact call credentials and instance search settings", () => {
  const urlCredential = "fixture-model-url-value";
  const snapshot = { apiKey: "fixture-model-call-key", baseUrl: `https://fixture:${urlCredential}@fixture.invalid/v1` };
  const { input, output } = modelRedactors(member, snapshot, { ownProvider: true, instance });
  assert.equal(input.isStoredSecret(snapshot.apiKey), true);
  assert.equal(output.isStoredSecret(snapshot.apiKey), true);
  assert.equal(output.isStoredSecret(urlCredential), true);
  assert.equal(input.isStoredSecret(instance.tavilyApiKey), false);
  assert.equal(output.isStoredSecret(instance.tavilyApiKey), true);
  assert.equal(output.isStoredSecret(adminProvider), false);
  assert.equal(output.text(`Example ${snapshot.apiKey}`), "Example [redacted]");
});

test("shared provider credentials are protected on output and do not change submitted text", () => {
  const urlCredential = "fixture-shared-url-value";
  const provider = { apiKey: adminProvider, baseUrl: `https://fixture:${urlCredential}@fixture.invalid/v1` };
  const { input, output } = modelRedactors(member, provider, { ownProvider: false, instance });
  const text = `${provider.apiKey} ${urlCredential} ${instance.tavilyApiKey}`;
  assert.equal(input.text(text), text);
  assert.equal(output.text(text), "[redacted] [redacted] [redacted]");
});

test("a Team member receives only approved connection fields and uses their own input redactor", () => {
  const db = getDb().$client;
  db.prepare("update provider_connections set label = ? where user_id = ?").run(`Label ${adminProvider}`, admin.id);
  const adminConnections = publicConnections(admin);
  assert.equal(adminConnections.length, 1);
  assert.ok("baseUrl" in adminConnections[0]);
  db.prepare("update instance_settings set hosting_mode = 'team'").run();
  try {
    assert.deepEqual(publicConnections(member), [{ id: adminConnections[0].id, kind: "openai-compatible", label: "Label [redacted]" }]);
    assert.equal(requestRedactor(member).isStoredSecret(adminProvider), false);
    assert.equal(requestRedactor(member).isStoredSecret(memberProvider), true);
  } finally {
    db.prepare("update instance_settings set hosting_mode = 'personal'").run();
  }
});
