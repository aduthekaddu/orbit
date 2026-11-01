import assert from "node:assert/strict";
import test from "node:test";
import { codeBodyStart, editedMessageText, replaceCode, replaceTextParts } from "./chat-parts";

test("editing code in one text part preserves other prose and the generated tool", () => {
  const tool = { type: "tool-render_ui" as const, toolCallId: "tool", state: "output-available" as const, input: {}, output: {} };
  const parts = [{ type: "text" as const, text: "before" }, tool, { type: "text" as const, text: "```js\nold\n```" }, { type: "text" as const, text: "after" }];
  const text = editedMessageText(parts, 2, "```js\nnew\n```");
  assert.equal(text, "before\n\n```js\nnew\n```\n\nafter");
  assert.deepEqual(replaceTextParts(parts, text), [{ type: "text", text }, tool]);
});

test("editing the second of two identical code blocks changes only the second", () => {
  const markdown = "intro\n\n```ts\nold\n```\n\n```ts\nold\n```\n\noutro";
  const start = codeBodyStart(markdown, 22, "old\n");
  assert.equal(start, 28);
  assert.equal(
    replaceCode(markdown, "old\n", "new", start, start + "old\n".length),
    "intro\n\n```ts\nold\n```\n\n```ts\nnew\n```\n\noutro",
  );
});

test("editing a later code block whose code prefixes an earlier block changes only the later one", () => {
  const markdown = "```ts\na\nb\n```\n\n```ts\na\n```\n\nend";
  const start = codeBodyStart(markdown, 15, "a\n");
  assert.equal(start, 21);
  assert.equal(
    replaceCode(markdown, "a\n", "c", start, start + "a\n".length),
    "```ts\na\nb\n```\n\n```ts\nc\n```\n\nend",
  );
});

test("saving a new body into an empty code block keeps the closing fence on its own line", () => {
  const markdown = "```ts\n```";
  const start = codeBodyStart(markdown, 0, "");
  assert.equal(start, 6);
  assert.equal(replaceCode(markdown, "", "new", start, start), "```ts\nnew\n```");
});

test("a stale code range leaves the message unchanged instead of editing an earlier block", () => {
  const markdown = "```ts\nold\n```\n\n```ts\nold\n```\n\nend";
  const staleStart = 15;
  const staleEnd = staleStart + "old\n".length;
  assert.equal(replaceCode(markdown, "old\n", "new", staleStart, staleEnd), markdown);
});
