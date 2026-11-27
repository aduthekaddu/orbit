import assert from "node:assert/strict";
import test from "node:test";
import { appliedSave, type SettingsSnapshot } from "./settings-form";

const submitted: SettingsSnapshot = { url: "https://settings.example.test", secret: "test-key" };

test("unchanged values clear the secret and report saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted }), { clearSecret: true, saved: true });
});

test("a secret typed during a save or removal stays in the field", () => {
  for (const secret of [submitted.secret, null]) {
    assert.deepEqual(appliedSave({ ...submitted, secret }, { ...submitted, secret: "new-test-key" }), {
      clearSecret: false,
      saved: false,
    });
  }
});

test("the saved secret clears even if a newer URL awaits saving", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, url: "https://new.example.test" }), { clearSecret: true, saved: false });
});
