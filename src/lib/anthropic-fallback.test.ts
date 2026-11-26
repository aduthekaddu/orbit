import assert from "node:assert/strict";
import test from "node:test";
import { fallbackModel, withoutRefusedParts } from "./anthropic-fallback";

type Prompt = Parameters<typeof withoutRefusedParts>[0];

const boundary = { type: "custom", kind: "anthropic.fallback", providerOptions: { anthropic: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } } } } as const;

test("a fallback part names the model it hands the reply to, and other parts name none", () => {
  assert.equal(fallbackModel({ type: "custom", kind: "anthropic.fallback", providerMetadata: boundary.providerOptions }), "claude-opus-5");
  assert.equal(fallbackModel({ type: "custom", kind: "other", providerMetadata: {} }), null);
  assert.equal(fallbackModel({ type: "text-delta" }), null);
});

test("a turn that fell back keeps its fallback block and its text, and loses the thinking and tool use from before the last block", () => {
  const prompt: Prompt = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "refused thinking" },
        { type: "tool-call", toolCallId: "early", toolName: "web_search", input: {} },
        { type: "text", text: "Partial " },
        boundary,
        { type: "reasoning", text: "fallback thinking" },
        { type: "tool-call", toolCallId: "late", toolName: "web_search", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "early", toolName: "web_search", output: { type: "text", value: "early" } },
        { type: "tool-result", toolCallId: "late", toolName: "web_search", output: { type: "text", value: "late" } },
      ],
    },
  ];
  const kept = withoutRefusedParts(prompt);
  assert.deepEqual(kept[1].content, [{ type: "text", text: "Partial " }, boundary, { type: "reasoning", text: "fallback thinking" }, { type: "tool-call", toolCallId: "late", toolName: "web_search", input: {} }]);
  assert.deepEqual(kept[2], { role: "tool", content: [{ type: "tool-result", toolCallId: "late", toolName: "web_search", output: { type: "text", value: "late" } }] });
});

test("a turn without a fallback is sent as it was", () => {
  const prompt: Prompt = [{ role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Answer" }] }];
  assert.deepEqual(withoutRefusedParts(prompt), prompt);
});
