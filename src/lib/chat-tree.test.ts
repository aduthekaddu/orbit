import assert from "node:assert/strict";
import test from "node:test";
import { focusedHead, isPath, pathTo, toRepository, type StoredMessage } from "./chat-tree";

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

// Creation order. u1 -> a1 -> u2 -> a2 is the stored branch.
// u2b edits u2, and its branch runs on to a3b.
const branches = [
  { id: "u1", parentId: null },
  { id: "a1", parentId: "u1" },
  { id: "u2", parentId: "a1" },
  { id: "a2", parentId: "u2" },
  { id: "u2b", parentId: "a1" },
  { id: "a2b", parentId: "u2b" },
  { id: "u3b", parentId: "a2b" },
  { id: "a3b", parentId: "u3b" },
];

test("focusedHead keeps the stored head for a hit on its path", () => {
  for (const hit of ["u1", "a1", "u2", "a2"]) assert.equal(focusedHead(branches, "a2", hit), "a2");
  assert.equal(focusedHead(branches, "a2", null), "a2");
});

test("focusedHead opens a hit off the stored path through to the end of its branch", () => {
  for (const hit of ["u2b", "a2b", "u3b", "a3b"]) assert.equal(focusedHead(branches, "a2", hit), "a3b");
});

test("focusedHead opens the newest message below the hit when its branch forks again", () => {
  // a2c regenerates a2b. The chat then went back to a2b and wrote u3b and a3b last.
  const forked = [
    ...branches.slice(0, 6),
    { id: "a2c", parentId: "u2b" },
    ...branches.slice(6),
  ];
  assert.equal(focusedHead(forked, "a2", "u2b"), "a3b");
  assert.equal(focusedHead(forked, "a2", "a2c"), "a2c");
});
