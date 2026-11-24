import assert from "node:assert/strict";
import { test } from "node:test";
import { toRepository, type StoredMessage } from "../chat-tree";
import { artifactHistory } from "./history";

const messages: StoredMessage[] = [
  { id: "prompt", parentId: null, role: "user", parts: [{ type: "text", text: "Make a page" }] },
  { id: "first.reply", parentId: "prompt", role: "assistant", parts: [{ type: "text", text: "```html\n<h1>First</h1>\n```" }] },
  { id: "second.reply", parentId: "prompt", role: "assistant", parts: [{ type: "text", text: "```html\n<h1>Second</h1>\n```" }] },
  { id: "later-prompt", parentId: "second.reply", role: "user", parts: [{ type: "text", text: "Continue" }] },
  { id: "later-reply", parentId: "later-prompt", role: "assistant", parts: [{ type: "text", text: "More" }] },
];

test("an artifact on another saved branch restores that reply without changing saved history", () => {
  const history = toRepository(messages, "later-reply");
  const selected = artifactHistory(history, "first.reply.0.8");
  assert.equal(selected.headId, "first.reply");
  assert.equal(selected.messages, history.messages);
  assert.equal(history.headId, "later-reply");
});

test("an artifact on another branch keeps the turns below its reply visible", () => {
  const history = toRepository([
    ...messages,
    { id: "first-follow-up", parentId: "first.reply", role: "user", parts: [{ type: "text", text: "Continue the first page" }] },
    { id: "first-follow-up-reply", parentId: "first-follow-up", role: "assistant", parts: [{ type: "text", text: "More on the first page" }] },
  ], "later-reply");
  assert.equal(artifactHistory(history, "first.reply.0.8").headId, "first-follow-up-reply");
});

test("an earlier artifact on the saved branch keeps the later turns visible", () => {
  const history = toRepository(messages, "later-reply");
  assert.equal(artifactHistory(history, "second.reply.0.8"), history);
});

test("missing, malformed, foreign and user-message artifact keys keep the saved branch", () => {
  const history = toRepository(messages, "later-reply");
  for (const key of [undefined, "", "first.reply", "first.reply.0", "first.reply.-1.0", "first.reply.0.not-an-offset", "foreign.0.0", "prompt.0.0"]) {
    assert.equal(artifactHistory(history, key), history);
  }
});
