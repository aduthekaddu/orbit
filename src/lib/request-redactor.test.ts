import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { seedTestConnection } from "./connection-fixture";
import { getDb } from "./db";
import { user } from "./db/schema";
import { parseViewer } from "./policy";
import { modelRedactors, requestRedactor } from "./request-redactor";
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
  const { input, output } = modelRedactors(member, snapshot, instance);
  assert.equal(input.isStoredSecret(snapshot.apiKey), true);
  assert.equal(output.isStoredSecret(snapshot.apiKey), true);
  assert.equal(output.isStoredSecret(urlCredential), true);
  assert.equal(input.isStoredSecret(instance.tavilyApiKey), false);
  assert.equal(output.isStoredSecret(instance.tavilyApiKey), true);
  assert.equal(output.isStoredSecret(adminProvider), false);
  assert.equal(output.text(`Example ${snapshot.apiKey}`), "Example [redacted]");
});
