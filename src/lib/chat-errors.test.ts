import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Redactor, streamErrorMessage, type SettingsLabels } from "./chat-errors";
import { renderUiTool } from "./genui/tool";
import { createRunCodeTool } from "./tools/run-code";

type Chunk = { type: string; errorText?: string };

const redact = new Redactor({ apiKey: "made-up-provider-key", tavilyApiKey: "made-up-search-key", githubToken: "made-up-github-token" });

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
    const stream = toUIMessageStream({ stream: result.stream, tools, onError: (error) => streamErrorMessage(error, redact) });
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
    assert.equal(streamErrorMessage("AI_APICallError: Rate limit reached", redact), "Rate limit reached");
    assert.equal(streamErrorMessage(new Error("socket hang up"), redact), "The model request failed");
    assert.equal(streamErrorMessage("token made-up-provider-key was rejected", redact), "token [redacted] was rejected");
    assert.equal(streamErrorMessage("GitHub said made-up-github-token", redact), "GitHub said [redacted]");
    assert.equal(streamErrorMessage("search said made-up-search-key", redact), "search said [redacted]");
  } finally {
    console.error = error;
  }
});

test("every stored credential is redacted from text, nested values and field names", () => {
  assert.equal(redact.text("a made-up-provider-key b made-up-search-key c made-up-github-token"), "a [redacted] b [redacted] c [redacted]");
  assert.deepEqual(redact.value({ issues: ["made-up-search-key"], "made-up-github-token": { title: "made-up-provider-key" } }), {
    issues: ["[redacted]"],
    "[redacted]": { title: "[redacted]" },
  });
});

test("an empty credential redacts nothing", () => {
  const none = new Redactor({ apiKey: "", tavilyApiKey: "", githubToken: "" });
  assert.equal(none.text("plain text"), "plain text");
  assert.deepEqual(none.value({ key: "value" }), { key: "value" });
});

test("a log line through the redactor carries no stored credential", () => {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args);
  try {
    redact.logError("chat title", "rejected made-up-search-key", "and made-up-provider-key");
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, [["chat title", "rejected [redacted]", "and [redacted]"]]);
});

const PROVIDER_KEY = "made-up-provider-key";

function toolInputError(path: string[]) {
  const issues = [{ code: "invalid_type", path, message: "Invalid input" }];
  return `Invalid input for tool run_code: {}\nError message: ${JSON.stringify(issues)}`;
}

test("a credential cut by the length limit leaves no part of itself in the tool error", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const text = streamErrorMessage(toolInputError(["x".repeat(30) + PROVIDER_KEY]), redact);
    assert.doesNotMatch(text, new RegExp(PROVIDER_KEY.slice(0, 6)));
  } finally {
    console.error = original;
  }
});

test("a credential rebuilt by joining the error path is redacted", () => {
  const dotted = new Redactor({ apiKey: "made.up.provider.key", tavilyApiKey: "", githubToken: "" });
  const original = console.error;
  console.error = () => {};
  try {
    assert.doesNotMatch(streamErrorMessage(toolInputError(["made", "up", "provider", "key"]), dotted), /made\.up\.provider\.key/);
  } finally {
    console.error = original;
  }
});

test("a credential shorter than the minimum length leaves saved text and field names alone", () => {
  const short = new Redactor({ apiKey: "type", tavilyApiKey: "ollama", githubToken: "[redacted]" });
  const part = { type: "text", text: "type ollama into the [redacted] field" };
  assert.deepEqual(short.value(part), part);
  assert.equal(short.text("ollama"), "ollama");
});

test("a credential rebuilt by the marker itself is redacted", () => {
  const rebuilt = new Redactor({ apiKey: "made-up-provider-key", tavilyApiKey: "[redacted]-tail-000005", githubToken: "" });
  assert.equal(rebuilt.text("made-up-provider-key-tail-000005"), "[redacted]");
});

test("a settings field named like a credential must be labelled one", () => {
  const labels: SettingsLabels<"webhookSecret" | "proxyPassword" | "timeout"> = {
    // @ts-expect-error A name ending in Secret cannot be labelled setting.
    webhookSecret: "setting",
    // @ts-expect-error A name ending in Password cannot be labelled setting.
    proxyPassword: "setting",
    timeout: "setting",
  };
  assert.equal(labels.timeout, "setting");
});
