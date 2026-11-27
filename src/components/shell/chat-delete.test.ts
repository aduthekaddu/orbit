import assert from "node:assert/strict";
import test from "node:test";
import { chatDeleteReducer, hiddenChatIds, initialChatDelete, type ChatDeleteEvent, type ChatDeleteState } from "./chat-delete";

const alpha = { id: "alpha", title: "Alpha", updatedAt: "2026-11-01T10:00:00.000Z" };
const beta = { id: "beta", title: "Beta", updatedAt: "2026-11-01T09:00:00.000Z" };
const gamma = { id: "gamma", title: "Gamma", updatedAt: "2026-11-01T08:00:00.000Z" };

function after(events: ChatDeleteEvent[], from: ChatDeleteState = initialChatDelete) {
  return events.reduce(chatDeleteReducer, from);
}

function hidden(state: ChatDeleteState) {
  return [...hiddenChatIds(state)].sort();
}

test("nothing is hidden before a delete", () => {
  assert.deepEqual(initialChatDelete, { pending: null, committing: [], failed: null });
  assert.deepEqual(hidden(initialChatDelete), []);
});

test("delete hides the chat at once, and undo brings it back without a request", () => {
  const deleted = after([{ type: "delete", chat: alpha, wasOpen: true }]);
  assert.deepEqual(deleted.pending, { chat: alpha, wasOpen: true });
  assert.deepEqual(deleted.committing, []);
  assert.deepEqual(hidden(deleted), ["alpha"]);

  const undone = chatDeleteReducer(deleted, { type: "undo" });
  assert.deepEqual(undone, initialChatDelete);
  assert.deepEqual(hidden(undone), []);
});

test("delete, then expire, then committed: the chat stays hidden until the server answers", () => {
  const deleted = after([{ type: "delete", chat: alpha, wasOpen: false }]);
  const expired = chatDeleteReducer(deleted, { type: "expire" });
  assert.equal(expired.pending, null);
  assert.deepEqual(expired.committing, [alpha]);
  assert.deepEqual(hidden(expired), ["alpha"]);

  const committed = chatDeleteReducer(expired, { type: "committed", id: "alpha" });
  assert.deepEqual(committed, initialChatDelete);
  assert.deepEqual(hidden(committed), []);
});

test("a second delete of a hidden chat is ignored, so a double click sends one request", () => {
  const once = after([{ type: "delete", chat: alpha, wasOpen: false }]);
  assert.equal(chatDeleteReducer(once, { type: "delete", chat: alpha, wasOpen: false }), once);

  const committing = chatDeleteReducer(once, { type: "expire" });
  assert.equal(chatDeleteReducer(committing, { type: "delete", chat: alpha, wasOpen: true }), committing);
  assert.deepEqual(committing.committing, [alpha]);
});

test("deleting another chat while one is pending commits the first and keeps one Undo for the second", () => {
  const state = after([
    { type: "delete", chat: alpha, wasOpen: true },
    { type: "delete", chat: beta, wasOpen: false },
  ]);
  assert.deepEqual(state.pending, { chat: beta, wasOpen: false });
  assert.deepEqual(state.committing, [alpha]);
  assert.deepEqual(hidden(state), ["alpha", "beta"]);

  const third = chatDeleteReducer(state, { type: "delete", chat: gamma, wasOpen: false });
  assert.deepEqual(third.pending, { chat: gamma, wasOpen: false });
  assert.deepEqual(third.committing, [alpha, beta]);
  assert.deepEqual(hidden(third), ["alpha", "beta", "gamma"]);

  // Undo restores only the chat its toast names. The first one is already on its way to the server.
  const undone = chatDeleteReducer(third, { type: "undo" });
  assert.equal(undone.pending, null);
  assert.deepEqual(hidden(undone), ["alpha", "beta"]);
});

test("a failed delete puts the chat back and names it until dismissed", () => {
  const failed = after([
    { type: "delete", chat: alpha, wasOpen: false },
    { type: "expire" },
    { type: "failed", id: "alpha" },
  ]);
  assert.deepEqual(failed, { pending: null, committing: [], failed: alpha });
  assert.deepEqual(hidden(failed), []);

  const dismissed = chatDeleteReducer(failed, { type: "dismiss" });
  assert.deepEqual(dismissed, initialChatDelete);
});

test("a failure for one chat leaves the pending Undo of another in place", () => {
  const state = after([
    { type: "delete", chat: alpha, wasOpen: false },
    { type: "delete", chat: beta, wasOpen: true },
    { type: "failed", id: "alpha" },
  ]);
  assert.deepEqual(state.pending, { chat: beta, wasOpen: true });
  assert.deepEqual(state.committing, []);
  assert.deepEqual(state.failed, alpha);
  assert.deepEqual(hidden(state), ["beta"]);
});

test("deleting the chat a failure names again clears that failure", () => {
  const state = after([
    { type: "delete", chat: alpha, wasOpen: false },
    { type: "expire" },
    { type: "failed", id: "alpha" },
    { type: "delete", chat: alpha, wasOpen: false },
  ]);
  assert.deepEqual(state, { pending: { chat: alpha, wasOpen: false }, committing: [], failed: null });
});

test("undo, expire, committed and failed with nothing to act on change nothing", () => {
  assert.equal(chatDeleteReducer(initialChatDelete, { type: "undo" }), initialChatDelete);
  assert.equal(chatDeleteReducer(initialChatDelete, { type: "expire" }), initialChatDelete);
  const pending = after([{ type: "delete", chat: alpha, wasOpen: false }]);
  assert.equal(chatDeleteReducer(pending, { type: "committed", id: "alpha" }), pending);
  assert.equal(chatDeleteReducer(pending, { type: "failed", id: "alpha" }), pending);
  assert.equal(chatDeleteReducer(pending, { type: "committed", id: "beta" }), pending);
});

test("deletes sent as the last page went away commit again, hidden until the server answers", () => {
  const sent = chatDeleteReducer(initialChatDelete, { type: "commit", chats: [alpha, beta] });
  assert.deepEqual(sent, { pending: null, committing: [alpha, beta], failed: null });
  assert.deepEqual(hidden(sent), ["alpha", "beta"]);

  // A chat that is already hidden is not sent twice, and an empty list changes nothing.
  assert.equal(chatDeleteReducer(sent, { type: "commit", chats: [alpha] }), sent);
  assert.equal(chatDeleteReducer(initialChatDelete, { type: "commit", chats: [] }), initialChatDelete);

  // A failure puts the chat back and names it, as for any delete.
  const failed = chatDeleteReducer(sent, { type: "failed", id: "alpha" });
  assert.deepEqual(failed, { pending: null, committing: [beta], failed: alpha });
  assert.deepEqual(hidden(failed), ["beta"]);
});
