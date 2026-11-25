import assert from "node:assert/strict";
import test from "node:test";
import { idleSubmit, submitTransition, type SubmitEvent, type SubmitState } from "./submit-state";

function run(events: SubmitEvent[], from: SubmitState = idleSubmit) {
  return events.reduce(submitTransition, from);
}

test("a submit that fails keeps its error until the next submit", () => {
  assert.deepEqual(run([{ type: "submit" }, { type: "fail", error: "Could not save" }]), {
    status: "failed",
    error: "Could not save",
  });
  assert.deepEqual(run([{ type: "submit" }, { type: "fail", error: "x" }, { type: "submit" }]), { status: "pending" });
});

test("a submit that succeeds shows success until an edit", () => {
  assert.deepEqual(run([{ type: "submit" }, { type: "succeed" }]), { status: "succeeded" });
  assert.deepEqual(run([{ type: "submit" }, { type: "succeed" }, { type: "edit" }]), idleSubmit);
});

test("an edit clears an error", () => {
  assert.deepEqual(run([{ type: "submit" }, { type: "fail", error: "x" }, { type: "edit" }]), idleSubmit);
});

test("a pending submit ignores a second submit and edits", () => {
  const pending = run([{ type: "submit" }]);
  assert.equal(submitTransition(pending, { type: "submit" }), pending);
  assert.equal(submitTransition(pending, { type: "edit" }), pending);
});

test("a result with no pending submit changes nothing", () => {
  assert.equal(submitTransition(idleSubmit, { type: "succeed" }), idleSubmit);
  assert.equal(submitTransition(idleSubmit, { type: "fail", error: "x" }), idleSubmit);
});
