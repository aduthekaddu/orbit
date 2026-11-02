import assert from "node:assert/strict";
import test from "node:test";
import { isPath, pathTo, toRepository, type StoredMessage } from "./chat-tree";

const tree: StoredMessage[] = [
  { id: "u1", parentId: null, role: "user", parts: [{ type: "text", text: "first" }] },
  { id: "a1", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "answer" }] },
  { id: "a2", parentId: "u1", role: "assistant", parts: [{ type: "text", text: "another answer" }] },
  { id: "u2", parentId: "a1", role: "user", parts: [{ type: "text", text: "follow up" }] },
];

test("pathTo follows each branch back to the root", () => {
  assert.deepEqual(pathTo(tree, "u2").map((m) => m.id), ["u1", "a1", "u2"]);
  assert.deepEqual(pathTo(tree, "a2").map((m) => m.id), ["u1", "a2"]);
  assert.deepEqual(pathTo(tree, null), []);
});

test("isPath refuses a missing link and messages from different branches", () => {
  assert.equal(isPath(tree, [tree[0], tree[3]]), false);
  assert.equal(isPath(tree, [tree[0], tree[2], tree[3]]), false);
  assert.equal(isPath(tree, [tree[0], tree[1], tree[3]]), true);
});

test("toRepository keeps every sibling and the last written head", () => {
  assert.deepEqual(toRepository(tree, "u2"), {
    headId: "u2",
    messages: tree.map(({ parentId, ...message }) => ({ parentId, message })),
  });
});
