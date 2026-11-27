import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { getAuth } from "./auth";
import { LOCAL_AUTH_URL } from "./auth-origins";
import { createTestAccount } from "./auth-test-helpers";
import { getDb } from "./db";
import { saveInstance } from "./instance-settings";
import { sessionFrom } from "./session";

const day = 24 * 60 * 60 * 1000;
const origin = new URL(LOCAL_AUTH_URL).origin;
const sqlite = getDb().$client;
let admin: Awaited<ReturnType<typeof createTestAccount>>;

before(async () => {
  admin = await createTestAccount({ role: "admin", email: "admin@orbit.test", name: "Admin A" });
  const request = new Request(origin, { headers: { cookie: admin.cookie } });
  assert.equal((await sessionFrom(request))?.user.id, admin.viewer.id);
});
after(() => { sqlite.close(); });

function signup(email: string, token: string) {
  return getAuth().handler(new Request(new URL("/api/auth/sign-up/email", origin), {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-orbit-invite": token },
    body: JSON.stringify({ email, name: "Invited member", password: "test-password-123" }),
  }));
}

async function assertInvalid(response: Response) {
  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, "Invite not valid");
}

async function createTeamInvite(now = Date.now()) {
  const invites = await import("./invites");
  assert.equal(saveInstance(admin.viewer.id, { hostingMode: "team" }).ok, true);
  const created = invites.createInvite(admin.viewer, now);
  assert.ok(created.ok);
  const { id, link } = created.invite;
  return { ...invites, id, token: new URL(link).pathname.split("/").at(-1)!, created: created.invite };
}

function inviteRow(id: string) {
  return sqlite.prepare("SELECT token_hash, claimed_at, used_at, used_by FROM invites WHERE id = ?").get(id);
}

function memberId(email: string) {
  return sqlite.prepare("SELECT id FROM user WHERE email = ? AND role = 'member'").pluck().get(email);
}

test("an invite returns its token once, keeps a hash in SQLite, and survives read-only link inspection", async () => {
  const now = Date.now();
  const { id, token, created, listPendingInvites, inspectInvite } = await createTeamInvite(now);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(new URL(created.link).origin, origin);
  assert.deepEqual(inviteRow(id), {
    token_hash: createHash("sha256").update(token).digest("hex"),
    claimed_at: null,
    used_at: null,
    used_by: null,
  });
  assert.deepEqual(listPendingInvites(now).find((item) => item.id === id), {
    id, createdAt: new Date(now), expiresAt: new Date(now + 7 * day),
  });

  for (const elapsed of [1, 2]) {
    assert.deepEqual(inspectInvite(token, now + elapsed), { kind: "pending", expiresAt: new Date(now + 7 * day) });
  }
  assert.equal(sqlite.prepare("SELECT count(*) FROM invites WHERE id = ? AND (claimed_at IS NOT NULL OR used_at IS NOT NULL)").pluck().get(id), 0);
});

test("one parallel signup spends the link and removal does not reopen it", async () => {
  const { id, token, inspectInvite, revokeInvite } = await createTeamInvite();
  const { removeMember } = await import("./admin-users");
  const emails = ["member-one@orbit.test", "member-two@orbit.test"];
  const replies = await Promise.all(emails.map((email) => signup(email, token)));
  assert.deepEqual(replies.map((response) => response.status).sort(), [200, 403]);
  const winner = replies.findIndex((response) => response.ok);
  const user = (await replies[winner].json()).user;
  assert.equal(user.role, "member");
  await assertInvalid(replies[1 - winner]);
  assert.equal(memberId(emails[winner]), user.id);
  assert.equal(memberId(emails[1 - winner]), undefined);
  assert.equal(sqlite.prepare("SELECT used_by FROM invites WHERE id = ? AND claimed_at IS NOT NULL AND used_at IS NOT NULL").pluck().get(id), user.id);
  assert.equal(inspectInvite(token).kind, "used");
  assert.equal(revokeInvite(id), false);

  assert.deepEqual(await removeMember(user.id), { ok: true });
  assert.equal(sqlite.prepare("SELECT count(*) FROM invites WHERE id = ? AND used_at IS NOT NULL AND used_by IS NULL").pluck().get(id), 1);
  await assertInvalid(await signup("reuse@orbit.test", token));
});

test("expired, revoked, unknown, and oversized invite tokens refuse signup", async () => {
  const expired = await createTeamInvite(Date.now() - 7 * day - 1);
  assert.equal(expired.inspectInvite(expired.token).kind, "expired");
  assert.equal(expired.listPendingInvites().some((item) => item.id === expired.id), false);
  await assertInvalid(await signup("late@orbit.test", expired.token));

  const revoked = await createTeamInvite();
  assert.equal(revoked.revokeInvite(revoked.id), true);
  assert.equal(revoked.revokeInvite(randomUUID()), false);
  assert.deepEqual(revoked.inspectInvite(revoked.token), revoked.inspectInvite(randomUUID()));
  await assertInvalid(await signup("revoked@orbit.test", revoked.token));
  await assertInvalid(await signup("unknown@orbit.test", randomUUID()));
  await assertInvalid(await signup("oversized@orbit.test", "a".repeat(129)));
});

test("a failed user INSERT holds the invite for five minutes and then releases it", async (t) => {
  const now = Date.now();
  const { token, id, inspectInvite } = await createTeamInvite(now);
  const { removeMember } = await import("./admin-users");
  const email = "retry@orbit.test";
  const clock = t.mock.method(Date, "now", () => now);
  t.mock.method(console, "error", () => {});
  sqlite.exec("CREATE TEMP TRIGGER fail_invited_user BEFORE INSERT ON user WHEN NEW.email = 'retry@orbit.test' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
  try {
    const response = await signup(email, token);
    assert.equal(response.status, 422);
    assert.equal(sqlite.prepare("SELECT claimed_at FROM invites WHERE id = ?").pluck().get(id), now);
  } finally {
    sqlite.exec("DROP TRIGGER fail_invited_user");
  }
  assert.equal(memberId(email), undefined);
  clock.mock.mockImplementation(() => now + 5 * 60 * 1000 - 1);
  assert.deepEqual(inspectInvite(token), { kind: "claimed", until: new Date(now + 5 * 60 * 1000) });
  await assertInvalid(await signup(email, token));
  assert.equal(memberId(email), undefined);

  clock.mock.mockImplementation(() => now + 5 * 60 * 1000);
  assert.equal((await signup(email, token)).status, 200);
  const member = memberId(email);
  assert.equal(typeof member, "string");
  assert.equal(sqlite.prepare("SELECT used_by FROM invites WHERE id = ?").pluck().get(id), member);
  assert.deepEqual(await removeMember(member), { ok: true });
});

test("a sequential duplicate-email refusal leaves the invite available immediately", async () => {
  const { token, id } = await createTeamInvite();
  const { removeMember } = await import("./admin-users");
  const duplicate = await createTestAccount({ role: "member", email: "duplicate@orbit.test", name: "Duplicate" });
  assert.equal((await signup("duplicate@orbit.test", token)).status, 422);
  assert.equal(sqlite.prepare("SELECT claimed_at FROM invites WHERE id = ?").pluck().get(id), null);
  const response = await signup("different@orbit.test", token);
  assert.equal(response.status, 200);
  const { id: createdId } = (await response.json()).user;
  assert.equal(sqlite.prepare("SELECT used_by FROM invites WHERE id = ?").pluck().get(id), createdId);
  assert.deepEqual(await removeMember(duplicate.viewer.id), { ok: true });
  assert.deepEqual(await removeMember(createdId), { ok: true });
});

test("hosting mode changes revoke unspent invites and keep spent ones", async () => {
  const { token, id, createInvite } = await createTeamInvite();
  const { removeMember } = await import("./admin-users");
  const response = await signup("spent@orbit.test", token);
  assert.equal(response.status, 200);
  await removeMember((await response.json()).user.id);

  for (const hostingMode of ["community", "team", "personal", "community", "personal"] as const) {
    const current = sqlite.prepare("SELECT hosting_mode FROM instance_settings").pluck().get();
    const made = current === "personal" ? null : createInvite(admin.viewer);
    assert.equal(saveInstance(admin.viewer.id, { hostingMode }).ok, true);
    if (made) {
      assert.ok(made.ok);
      assert.equal(inviteRow(made.invite.id), undefined);
    }
    assert.equal(sqlite.prepare("SELECT count(*) FROM invites WHERE id = ? AND used_at IS NOT NULL").pluck().get(id), 1);
  }
});
