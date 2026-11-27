import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { seedTestConnection } from "./connection-fixture";
import { getDb } from "./db";
import { user, userGithub } from "./db/schema";
import { requestRedactor } from "./request-redactor";
import { decryptSecret, SecretUnreadable } from "./secrets";
import type { UserId, Viewer } from "./session";
import { getGithub, saveGithub, toPublicGithub, trySeedAdminGithub } from "./user-github";

const admin = { id: "github-admin" as UserId, role: "admin" } satisfies Viewer;
const member = { id: "github-member" as UserId, role: "member" } satisfies Viewer;
const adminPart = "fixture-github-admin-105";
const memberPart = "fixture-github-member-346";
const adminKey = "fixture-provider-admin-999";
const memberKey = "fixture-provider-member-864";

before(() => {
  getDb().insert(user).values([
    { ...admin, name: "Admin", email: "github-admin@orbit.test" },
    { ...member, name: "Member", email: "github-member@orbit.test" },
  ]).run();
});

after(() => getDb().$client.close());

function ciphertext(userId: UserId) {
  return getDb().select({ value: userGithub.tokenCiphertext }).from(userGithub).where(eq(userGithub.userId, userId)).get()?.value;
}

test("only the admin inherits the environment token, and each user owns their own settings", (t) => {
  t.mock.method(console, "error", () => assert.fail("unexpected seeding error"));
  const oldToken = process.env.ORBIT_GITHUB_TOKEN;
  process.env.ORBIT_GITHUB_TOKEN = adminPart;
  try {
    trySeedAdminGithub(member);
    trySeedAdminGithub(admin);
    assert.equal(getGithub(admin.id).githubToken, adminPart);
    assert.equal(toPublicGithub(member.id).githubTokenSet, false);
    assert.equal("githubToken" in toPublicGithub(admin.id), false);
    assert.equal(ciphertext(member.id), undefined);
    const stored = ciphertext(admin.id);
    assert.ok(stored);
    assert.notEqual(stored, adminPart);
    assert.equal(decryptSecret(stored, "user_github.token"), adminPart);
    assert.throws(() => decryptSecret(stored, "instance_settings.tavily_api_key"), SecretUnreadable);

    assert.equal(saveGithub(member.id, { githubToken: memberPart, githubMcpUrl: "https://api.github.com/mcp/" }).ok, true);
    assert.equal(getGithub(admin.id).githubToken, adminPart);
    assert.equal(getGithub(admin.id).githubMcpUrl, "");
    assert.equal(getGithub(member.id).githubToken, memberPart);
    assert.equal(toPublicGithub(member.id).githubMcpUrl, "https://api.github.com/mcp/");
  } finally {
    if (oldToken === undefined) delete process.env.ORBIT_GITHUB_TOKEN;
    else process.env.ORBIT_GITHUB_TOKEN = oldToken;
  }
});

test("the public URL and request redactor mask only the viewer's provider and GitHub credentials", () => {
  seedTestConnection(admin.id, { apiKey: adminKey, model: "mock" });
  seedTestConnection(member.id, { apiKey: memberKey, model: "mock" });
  const originalUrl = `https://api.github.com/mcp/${memberPart}/${memberKey}/${adminPart}/${adminKey}`;
  assert.equal(saveGithub(member.id, { githubMcpUrl: originalUrl }).ok, true);
  const { githubMcpUrl } = toPublicGithub(member.id);
  assert.equal(githubMcpUrl, `https://api.github.com/mcp/[redacted]/[redacted]/${adminPart}/${adminKey}`);
  assert.equal(saveGithub(member.id, { githubMcpUrl }).ok, true);
  assert.equal(getGithub(member.id).githubMcpUrl, originalUrl);
  const redact = requestRedactor(member);
  assert.equal(redact.text(`${memberPart} ${memberKey}`), "[redacted] [redacted]");
  assert.equal(redact.text(`${adminPart} ${adminKey}`), `${adminPart} ${adminKey}`);
});

test("an unreadable token survives a URL change and can be cleared", () => {
  const prior = ciphertext(member.id);
  assert.ok(prior);
  const key = process.env.ORBIT_SECRET_KEY;
  process.env.ORBIT_SECRET_KEY = randomBytes(32).toString("hex");
  try {
    assert.equal(getGithub(member.id).githubToken, "");
    assert.equal(toPublicGithub(member.id).githubTokenSet, true);
    assert.equal(toPublicGithub(member.id).githubTokenReadable, false);
    assert.equal(saveGithub(member.id, { githubMcpUrl: "", githubToken: " " }).ok, true);
    assert.equal(ciphertext(member.id), prior);
    assert.equal(toPublicGithub(member.id).githubMcpUrl, "https://api.githubcopilot.com/mcp/");
    assert.equal(saveGithub(member.id, { githubToken: null }).ok, true);
    assert.equal(ciphertext(member.id), "");
    assert.equal(toPublicGithub(member.id).githubTokenSet, false);
  } finally {
    if (key === undefined) delete process.env.ORBIT_SECRET_KEY;
    else process.env.ORBIT_SECRET_KEY = key;
  }
});
