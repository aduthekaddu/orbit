import assert from "node:assert/strict";
import test from "node:test";
import { parseHostingMode, parseViewer, policyFor } from "./policy";

test("Personal permits only the first signup, as admin", () => {
  const personal = policyFor(parseHostingMode("personal"));
  assert.deepEqual(personal.signup({ accounts: 0, invite: "none" }), { ok: true, role: "admin", invite: "keep" });
  for (const invite of ["none", "invalid", "valid"] as const) {
    assert.deepEqual(personal.signup({ accounts: 1, invite }), { ok: false, reason: "closed" });
  }
  assert.equal(personal.openWithoutInvite(0), true);
  assert.equal(personal.openWithoutInvite(2), false);
});

test("Personal resolves every account's own connections", () => {
  const personal = policyFor(parseHostingMode("personal"));
  const admin = parseViewer({ id: "admin", role: "admin" });
  const member = parseViewer({ id: "member", role: "member" });
  assert.equal(personal.connectionOwner(member, admin.id), member.id);
  assert.equal(personal.mayCreateConnection(admin), true);
  assert.equal(personal.mayCreateConnection(member), false);
  assert.equal(personal.mayInvite(admin), false);
  assert.equal(personal.guardsPrivateHosts, false);
  assert.throws(() => parseHostingMode("team"), /hosting mode/i);
});
