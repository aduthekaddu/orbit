import assert from "node:assert/strict";
import test from "node:test";
import { editedMessageText, replaceTextParts } from "./chat-parts";

test("editing code in one text part preserves other prose and the generated tool", () => {
  const tool = { type: "tool-render_ui" as const, toolCallId: "tool", state: "output-available" as const, input: {}, output: {} };
  const parts = [{ type: "text" as const, text: "before" }, tool, { type: "text" as const, text: "```js\nold\n```" }, { type: "text" as const, text: "after" }];
  const text = editedMessageText(parts, 2, "```js\nnew\n```");
  assert.equal(text, "before\n\n```js\nnew\n```\n\nafter");
  assert.deepEqual(replaceTextParts(parts, text), [{ type: "text", text }, tool]);
});
