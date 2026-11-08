import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { streamErrorMessage } from "./chat-errors";
import { renderUiTool } from "./genui/tool";
import { createRunCodeTool } from "./tools/run-code";

type Chunk = { type: string; errorText?: string };

async function rejectedCall(input: string, toolName: "run_code" | "render_ui" = "run_code") {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-1", toolName, input },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
  const tools = { run_code: createRunCodeTool(), render_ui: renderUiTool };
  const result = streamText({ model, prompt: "run it", tools, stopWhen: stepCountIs(1) });
  const logged: string[] = [];
  const original = console.error;
  console.error = (label: unknown, ...details: unknown[]) => {
    if (label === "chat stream error") logged.push(details.map(String).join(" "));
  };
  const saved: string[] = [];
  try {
    const stream = toUIMessageStream({ stream: result.stream, tools, onError: (error) => streamErrorMessage(error, "sk-test-secret") });
    for await (const chunk of stream as unknown as AsyncIterable<Chunk>) {
      if ((chunk.type === "tool-input-error" || chunk.type === "tool-output-error") && chunk.errorText) saved.push(chunk.errorText);
    }
  } finally {
    console.error = original;
  }
  return { saved, logged };
}

function assertConcise(texts: string[], repeated: string, toolName = "run_code") {
  assert.ok(texts.length > 0, "the rejected call produced no error text");
  for (const text of texts) {
    assert.ok(text.length <= 300, `error text is ${text.length} characters`);
    assert.ok(!text.includes(repeated), "error text repeats the rejected input");
    assert.ok(!/[\r\n]/.test(text), "error text has a line break");
    assert.match(text, new RegExp(toolName));
  }
}

test("an oversized program is rejected with its reason and without its source", async () => {
  const { saved, logged } = await rejectedCall(JSON.stringify({ language: "python", code: "#".repeat(20_001) }));
  assertConcise(saved, "#".repeat(100));
  for (const text of saved) assert.match(text, /code.*20000/);
  assertConcise(logged, "#".repeat(100));
});

test("an unsupported language is rejected with its reason and without the program", async () => {
  const { saved, logged } = await rejectedCall(JSON.stringify({ language: "ruby", code: "puts 1" }));
  assertConcise(saved, "puts 1");
  for (const text of saved) assert.match(text, /language.*javascript/);
  assertConcise(logged, "puts 1");
});

test("input that is not JSON is rejected without echoing its text", async () => {
  const { saved, logged } = await rejectedCall(`{"language":"python","code":"${"#".repeat(20_001)}`);
  assertConcise(saved, "#".repeat(100));
  assertConcise(logged, "#".repeat(100));
  for (const text of [...saved, ...logged]) assert.match(text, /not valid JSON/);
});

test("a long layout key with line breaks is shortened in saved errors and logs", async () => {
  const key = "k\nk".repeat(2_000);
  const layout = { root: key, elements: { [key]: { type: "NotAComponent", props: {}, children: [] } } };
  const { saved, logged } = await rejectedCall(JSON.stringify(layout), "render_ui");
  assertConcise(saved, "k\nk\nk", "render_ui");
  for (const text of saved) assert.match(text, /elements\..*\.type: Invalid option/);
  assertConcise(logged, "k\nk\nk", "render_ui");
});

test("other failures keep their messages", () => {
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(streamErrorMessage("AI_APICallError: Rate limit reached", "sk-test-secret"), "Rate limit reached");
    assert.equal(streamErrorMessage(new Error("socket hang up"), "sk-test-secret"), "The model request failed");
    assert.equal(streamErrorMessage("token sk-test-secret was rejected", "sk-test-secret"), "token [redacted] was rejected");
    assert.equal(streamErrorMessage("GitHub said secret-token-value", ["sk-test-secret", "secret-token-value"]), "GitHub said [redacted]");
  } finally {
    console.error = error;
  }
});
