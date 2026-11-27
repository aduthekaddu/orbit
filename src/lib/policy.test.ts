import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./policy";

const { parseHostingMode, parseViewer, policyFor } = policy;
const admin = parseViewer({ id: "fixture-admin", role: "admin" });
const member = parseViewer({ id: "fixture-member", role: "member" });
const modes = [
  { hosting: "personal", signup: "invite", error: "closed", allowsMember: false, shares: false, guarded: false },
  { hosting: "team", signup: "invite", error: "invite-required", allowsMember: true, shares: true, guarded: false },
  { hosting: "community", signup: "invite", error: "invite-required", allowsMember: true, shares: false, guarded: true },
  { hosting: "community", signup: "open", error: null, allowsMember: true, shares: false, guarded: true },
] as const;
const invited = ["none", "valid", "invalid"] as const;
const first = { ok: true, role: "admin", invite: "keep" };
const newMember = { ok: true, role: "member" };

for (const mode of modes) {
  test(`${mode.hosting} ${mode.signup} enforces the signup and connection policy`, () => {
    const parsed = parseHostingMode(mode.hosting, mode.signup);
    const rules = policyFor(parsed);
    for (const invite of invited) assert.deepEqual(rules.signup({ accounts: 0, invite }), first);
    const outcomes = [
      mode.error ? { ok: false, reason: mode.error } : { ...newMember, invite: "keep" },
      mode.allowsMember ? { ...newMember, invite: "consume" } : { ok: false, reason: "closed" },
      { ok: false, reason: mode.allowsMember ? "invite-invalid" : "closed" },
    ];
    for (const [index, invite] of invited.entries()) {
      assert.deepEqual(rules.signup({ accounts: 2, invite }), outcomes[index]);
    }
    assert.equal(rules.openWithoutInvite(0), true);
    assert.equal(rules.openWithoutInvite(1), mode.signup === "open");
    assert.equal(rules.mayInvite(admin), mode.allowsMember);
    assert.equal(rules.mayInvite(member), false);
    assert.equal(rules.mayCreateConnection(admin), true);
    assert.equal(rules.mayCreateConnection(member), mode.guarded);
    assert.equal(rules.connectionOwner(admin, admin.id), admin.id);
    assert.equal(rules.connectionOwner(member, admin.id), mode.shares ? admin.id : member.id);
    assert.equal(rules.guardsPrivateHosts, mode.guarded);
  });
}

test("settings parsing rejects unknown hosting and signup modes", () => {
  assert.throws(() => parseHostingMode("unknown", "invite"), /hosting mode/i);
  assert.throws(() => parseHostingMode("community", "unknown"), /signup mode/i);
});

test("mode transitions protect existing accounts and revoke only across hosting modes", () => {
  assert.equal(typeof policy.switchMode, "function", "the mode transition policy must exist");
  for (const from of modes) {
    for (const to of modes) {
      const current = parseHostingMode(from.hosting, from.signup);
      const requested = parseHostingMode(to.hosting, to.signup);
      const expected = {
        ok: true,
        deletePendingInvites: from.hosting !== to.hosting,
        resetSignupMode: from.hosting === "community" && to.hosting !== "community",
      };
      for (const accounts of [0, 1, 2]) {
        const refusal = from.hosting !== "personal" && to.hosting === "personal" && accounts > 1;
        assert.deepEqual(policy.switchMode(current, requested, accounts), refusal ? { ok: false, reason: "accounts-exist" } : expected);
      }
    }
  }
});
