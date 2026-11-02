import assert from "node:assert/strict";
import test from "node:test";
import { codeBodyStart, replaceCode, replaceTextPart, textPartIndex } from "./chat-parts";

test("editing code in one text part preserves other prose and the generated tool", () => {
  const tool = { type: "tool-render_ui" as const, toolCallId: "tool", state: "output-available" as const, input: {}, output: {} };
  const parts = [{ type: "text" as const, text: "before" }, tool, { type: "text" as const, text: "```js\nold\n```" }, { type: "text" as const, text: "after" }];
  assert.deepEqual(replaceTextPart(parts, 2, "```js\nnew\n```"), [
    parts[0],
    tool,
    { type: "text", text: "```js\nnew\n```" },
    parts[3],
  ]);
});

test("a part that is not text cannot be replaced", () => {
  const tool = { type: "tool-render_ui" as const, toolCallId: "tool", state: "output-available" as const, input: {}, output: {} };
  const parts = [{ type: "text" as const, text: "before" }, tool];
  assert.equal(replaceTextPart(parts, 1, "nope"), null);
  assert.equal(replaceTextPart(parts, 9, "nope"), null);
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

test("a prose match before the block does not move the code body", () => {
  const markdown = "null\n\n```json\nnull\n```";
  const start = codeBodyStart(markdown, 6, "null\n");
  assert.equal(start, 14);
  assert.equal(
    replaceCode(markdown, "null\n", "true", start, start + "null\n".length),
    "null\n\n```json\ntrue\n```",
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


test("an editable text part maps to its saved index past step markers and tools", () => {
  const parts = [
    { type: "step-start" as const },
    { type: "reasoning" as const, text: "thinking" },
    { type: "text" as const, text: "first" },
    { type: "step-start" as const },
    { type: "tool-render_ui" as const, toolCallId: "tool", state: "output-available" as const, input: {}, output: {} },
    { type: "text" as const, text: "second" },
  ];
  assert.equal(textPartIndex(parts, 0), 2);
  assert.equal(textPartIndex(parts, 1), 5);
  assert.equal(textPartIndex(parts, 2), undefined);
  assert.equal(textPartIndex([{ type: "text", text: "plain" }], 0), 0);
});
