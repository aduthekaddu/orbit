import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { anthropicFallbacks, fallbackModel, withoutRefusedParts } from "./anthropic-fallback";

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

const reasoning = { type: "reasoning", text: "Mock thinking." } as const;
const text = { type: "text", text: "Mock answer." } as const;
const assistant = (...content: Extract<Parameters<typeof withoutRefusedParts>[0][number], { role: "assistant" }>["content"]) =>
  ({ role: "assistant", content }) as const;

test("the fallback boundary spans adjacent assistant messages in Anthropic history", () => {
  const input = [assistant(reasoning, text), assistant(boundary, text)];
  assert.deepEqual(withoutRefusedParts(input), [assistant(text), assistant(boundary, text)]);
});

test("the fallback boundary spans assistant messages joined by removing an empty tool reply", () => {
  const call = { type: "tool-call", toolCallId: "mock-call", toolName: "mock", input: {} } as const;
  const tool = { role: "tool", content: [{ type: "tool-result", toolName: "mock", toolCallId: "mock-call", output: { type: "text", value: "Mock result." } }] } as const;
  const prompt: Parameters<typeof withoutRefusedParts>[0] = [
    assistant(call, boundary, reasoning, text),
    { ...tool, content: [...tool.content] },
    assistant(boundary, text),
  ];
  assert.deepEqual(withoutRefusedParts(prompt), [assistant(boundary, text), assistant(boundary, text)]);
});

test("only tool events after the last fallback reach the consumer of the provider stream", async () => {
  const fallback = { type: "custom", kind: boundary.kind, providerMetadata: boundary.providerOptions } as const;
  const mockCall = (id: string): LanguageModelV4StreamPart[] => [
    { type: "tool-input-start", id, toolName: "mock" },
    { type: "tool-input-delta", id, delta: "{}" },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName: "mock", input: "{}" },
  ];
  const next = mockCall("accepted");
  const interrupted = mockCall("interrupted");
  const parts: LanguageModelV4StreamPart[] = [
    ...mockCall("previous"),
    fallback,
    ...mockCall("also-previous"),
    ...interrupted.slice(0, 2),
    fallback,
    ...interrupted.slice(2),
    ...next,
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ];
  const doStream = async () => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  });
  assert.ok(anthropicFallbacks.wrapStream);
  const { stream } = await anthropicFallbacks.wrapStream({
    doStream,
    doGenerate: async () => { throw new Error("Unexpected generate call"); },
    params: { prompt: [] },
    model: createAnthropic({ apiKey: "test" })("claude-opus-5-5"),
  });
  const received: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) received.push(part);
  assert.deepEqual(received, [fallback, fallback, ...next, parts.at(-1)]);
});
