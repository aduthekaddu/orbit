import assert from "node:assert/strict";
import test from "node:test";
import { format } from "node:util";
import { simulateReadableStream, stepCountIs, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { getTableColumns } from "drizzle-orm";
import { CREDENTIAL_NOUNS, logProviderError, REDACTED, Redactor, streamErrorMessage, type SettingsLabels, type StoredCredentials } from "./chat-errors";
import { settings } from "./db/schema";
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
  console.error = (...args: unknown[]) => {
    const line = format(...args);
    if (line.startsWith("chat stream error ")) logged.push(line.slice("chat stream error ".length));
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

test("other failures keep their messages, and a message that holds a stored credential is withheld whole", () => {
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(streamErrorMessage("AI_APICallError: Rate limit reached", redact), "Rate limit reached");
    assert.equal(streamErrorMessage(new Error("socket hang up"), redact), "The model request failed");
    assert.equal(streamErrorMessage("token made-up-provider-key was rejected", redact), REDACTED);
    assert.equal(streamErrorMessage("GitHub said made-up-github-token", redact), REDACTED);
    assert.equal(streamErrorMessage("search said made-up-search-key", redact), REDACTED);
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
  assert.deepEqual(lines, [["chat title [redacted]"]]);
});

const PROVIDER_KEY = "made-up-provider-key";

function toolInputError(...issues: Array<{ path: string[]; message?: string }>) {
  const json = issues.map(({ path, message = "Invalid input" }) => ({ code: "invalid_type", path, message }));
  const error = new Error(`Invalid input for tool run_code: {}\nError message: ${JSON.stringify(json)}`);
  error.name = "AI_InvalidToolInputError";
  return error;
}

function capturedErrors(run: () => unknown) {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(format(...args));
  try {
    return { result: run(), lines };
  } finally {
    console.error = original;
  }
}

test("a credential cut by the length limit leaves no part of itself in the tool error or its log line", () => {
  const { result, lines } = capturedErrors(() => streamErrorMessage(toolInputError({ path: ["x".repeat(30) + PROVIDER_KEY] }), redact));
  assert.equal(result, "Invalid input for tool run_code: [redacted]");
  assert.deepEqual(lines, [`chat stream error ${result}`]);
});

test("a credential spelled by joining the error path leaves no part of itself, even where the field is cut", () => {
  const dotted = new Redactor({ apiKey: "made.up.provider.key", tavilyApiKey: "", githubToken: "" });
  for (const path of [["x".repeat(35), "x".repeat(35), "made", "up", "provider", "key"], ["x".repeat(34) + "made.up", "provider.key"]]) {
    const { result, lines } = capturedErrors(() => streamErrorMessage(toolInputError({ path }), dotted));
    assert.equal(result, "Invalid input for tool run_code: [redacted]");
    for (const text of [String(result), ...lines]) assert.doesNotMatch(text, /made|provider\.key/);
  }
});

test("a credential that starts inside a shorter one is masked whole", () => {
  const overlap = new Redactor({ apiKey: "made-up-left-0001", tavilyApiKey: "", githubToken: "left-0001-made-up-right" });
  assert.equal(overlap.text("made-up-left-0001-made-up-right"), "[redacted]");
});

test("a credential that the marker rebuilds again and again is masked in time that grows with the text, not its square", () => {
  const secret = "]made-up-key";
  const bracket = new Redactor({ apiKey: secret, tavilyApiKey: "", githubToken: "" });
  const started = performance.now();
  const masked = bracket.text(secret + "made-up-key".repeat(20_000));
  const elapsed = performance.now() - started;
  assert.ok(!masked.includes(secret), "the masked text carries the credential");
  assert.ok(elapsed < 500, `masking 220,012 characters took ${elapsed.toFixed(0)} ms`);
});

test("a credential shorter than the minimum length never reaches a log line or stream error text", () => {
  const short = new Redactor({ apiKey: "sk-1234", tavilyApiKey: "", githubToken: "" });
  const { result, lines } = capturedErrors(() => {
    short.logError("chat provider error", "AI_APICallError", "401", "key sk-1234 was rejected");
    return streamErrorMessage("key sk-1234 was rejected", short);
  });
  assert.equal(result, "[redacted]");
  assert.deepEqual(lines, ["chat provider error [redacted]"]);
});

test("a thrown value that is not an Error is logged by type", () => {
  const { lines } = capturedErrors(() => logProviderError(Object.create(null), redact));
  assert.deepEqual(lines, ["chat provider error object"]);
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
  type Names =
    | "webhookSecret" | "proxyPassword" | "proxyPasswd" | "sshPassphrase" | "githubPat" | "awsCredential" | "sessionCookie" | "signingJwt"
    | "apiKeys" | "accessToken2" | "apiKeys2" | "timeout";
  const labels: SettingsLabels<Names> = {
    // @ts-expect-error A name ending in Secret cannot be labelled setting.
    webhookSecret: "setting",
    // @ts-expect-error A name ending in Password cannot be labelled setting.
    proxyPassword: "setting",
    // @ts-expect-error A name ending in Passwd cannot be labelled setting.
    proxyPasswd: "setting",
    // @ts-expect-error A name ending in Passphrase cannot be labelled setting.
    sshPassphrase: "setting",
    // @ts-expect-error A name ending in Pat cannot be labelled setting.
    githubPat: "setting",
    // @ts-expect-error A name ending in Credential cannot be labelled setting.
    awsCredential: "setting",
    // @ts-expect-error A name ending in Cookie cannot be labelled setting.
    sessionCookie: "setting",
    // @ts-expect-error A name ending in Jwt cannot be labelled setting.
    signingJwt: "setting",
    // @ts-expect-error A plural credential name cannot be labelled setting.
    apiKeys: "setting",
    // @ts-expect-error A numbered credential name cannot be labelled setting.
    accessToken2: "setting",
    // @ts-expect-error A plural and numbered credential name cannot be labelled setting.
    apiKeys2: "setting",
    timeout: "setting",
  };
  assert.equal(labels.timeout, "setting");
});

test("every settings column named like a credential is masked", () => {
  const credentialName = new RegExp(`(?:${CREDENTIAL_NOUNS.join("|")})s?\\d*$`, "i");
  const columns = Object.keys(getTableColumns(settings));
  const values = Object.fromEntries(columns.map((column) => [column, `made-up-${column}-value-0006`]));
  const all = new Redactor(values as unknown as StoredCredentials);
  const named = columns.filter((column) => credentialName.test(column));
  assert.ok(named.length > 0, "no settings column is named like a credential");
  for (const column of named) assert.equal(all.text(values[column]), REDACTED, `${column} is not masked`);
});

function only(keys: Partial<StoredCredentials>) {
  return new Redactor({ apiKey: "", tavilyApiKey: "", githubToken: "", ...keys });
}

function shownErrors(redactor: Redactor, error: unknown) {
  const { result, lines } = capturedErrors(() => streamErrorMessage(error, redactor));
  return [String(result), ...lines];
}

test("a tool error whose key differs only by collapsed whitespace shows no part of it", () => {
  const redactor = only({ apiKey: "made-up  proxy-secret" });
  const errors = [toolInputError({ path: ["code"], message: "made-up  proxy-secret" }), toolInputError({ path: ["made-up  proxy-secret"] })];
  for (const error of errors) {
    for (const text of shownErrors(redactor, error)) assert.doesNotMatch(text, /proxy-secret/, text);
  }
});

test("an error name written inside a key is not stripped before the key is found", () => {
  const redactor = only({ apiKey: "made-up-AI_KeyError: proxy-0007" });
  for (const text of shownErrors(redactor, "rejected made-up-AI_KeyError: proxy-0007")) assert.doesNotMatch(text, /made-up|proxy-0007/, text);
});

test("a key spelled across a field and its message, or across two issues, leaves no part of itself where a cut falls", () => {
  const message = "made-up-message-".repeat(8);
  const second = "made-up-message-".repeat(7) + "made-up";
  const cases = [
    { key: `made-up-field: ${message}`, error: toolInputError({ path: ["made-up-field"], message }) },
    { key: `made-up-; made-up-path: ${second}`, error: toolInputError({ path: ["p"], message: "m".repeat(100) + "made-up-" }, { path: ["made-up-path"], message: second }) },
  ];
  for (const { key, error } of cases) {
    for (const text of shownErrors(only({ apiKey: key }), error)) assert.doesNotMatch(text, /made-up/, text);
  }
});

test("a short key that overlaps a long one leaves no part of either", () => {
  const redactor = only({ apiKey: "fakeproxy01", githubToken: "1-made-up-long-key" });
  for (const text of shownErrors(redactor, "rejected fakeproxy01-made-up-long-key")) assert.doesNotMatch(text, /fakeproxy|made-up/, text);
});

test("a key that the fallback marker spells is not shown by the marker", () => {
  for (const key of [REDACTED, "redact"]) {
    const redactor = only({ apiKey: key });
    const { result, lines } = capturedErrors(() => {
      redactor.logError("chat title", `rejected ${key}`);
      return streamErrorMessage(`the key ${key} failed`, redactor);
    });
    for (const text of [String(result), ...lines]) assert.ok(!text.includes(key), `${key} is shown in: ${text}`);
  }
});

test("a log line cannot assemble a key from its label and separate details", () => {
  const spanning = only({ apiKey: "401 made-up-proxy-key" });
  const rejected = Object.assign(new Error("made-up-proxy-key rejected"), { statusCode: 401 });
  const { lines } = capturedErrors(() => logProviderError(rejected, spanning));
  assert.deepEqual(lines, ["chat provider error [redacted]"]);
  const inLabel = only({ apiKey: "provider" });
  const labelled = capturedErrors(() => logProviderError(new Error("boom"), inLabel));
  for (const line of labelled.lines) assert.ok(!line.includes("provider"), line);
});

test("a key of one repeated character is matched in time that grows with the text, not with the text times the key", () => {
  const repeated = only({ apiKey: "x".repeat(10_000) });
  const started = performance.now();
  const masked = repeated.text("x".repeat(400_000));
  const elapsed = performance.now() - started;
  assert.equal(masked, REDACTED);
  assert.ok(elapsed < 500, `masking 400,000 characters took ${elapsed.toFixed(0)} ms`);
});

test("a key that overlaps its own next copy is masked to the end of that copy", () => {
  const key = "made-up-made-up-made-up";
  assert.equal(only({ apiKey: key }).text(`${key}-made-up`), REDACTED);
});

test("percent-encoded forms of a stored credential are masked in text and withheld in diagnostics", () => {
  const key = "made+up/provider=key&01";
  const redactor = only({ apiKey: key });
  const encoded = encodeURIComponent(key);
  const partial = "made%2bup%2fprovider=key&01";
  assert.equal(redactor.text(`url?k=${encoded}`), "url?k=[redacted]");
  assert.equal(redactor.text(`url?k=${partial}`), "url?k=[redacted]");
  assert.equal(redactor.diagnostic(`failed ${encoded}`), REDACTED);
  assert.equal(redactor.diagnostic(`failed ${partial}`), REDACTED);
  const hyphen = "made-up-provider-key";
  const partialHyphen = "made%2dup-provider-key";
  assert.equal(only({ apiKey: hyphen }).text(partialHyphen), REDACTED);
});

test("base64 and Basic-auth base64 forms of a stored credential are masked in text and withheld in diagnostics", () => {
  const key = "made-up-provider-key";
  const redactor = only({ apiKey: key });
  const plainB64 = Buffer.from(key).toString("base64");
  const urlB64 = Buffer.from(key).toString("base64url");
  assert.equal(redactor.text(`token=${plainB64}`), "token=[redacted]");
  assert.equal(redactor.text(`token=${urlB64}`), "token=[redacted]");
  assert.equal(redactor.diagnostic(`Authorization: Bearer ${plainB64}`), REDACTED);
  for (const user of ["", "a", "ab", "abc", "user"]) {
    const basic = Buffer.from(`${user}:${key}`).toString("base64");
    const masked = redactor.text(`Authorization: Basic ${basic}`);
    assert.equal(masked.includes(basic), false, `Basic auth for ${user} was not masked: ${masked}`);
    assert.match(masked, /\[redacted\]/);
    const leftover = masked.replace("Authorization: Basic ", "").replace("[redacted]", "");
    assert.equal(Buffer.from(leftover, "base64").toString("utf8").includes("made"), false);
    assert.equal(redactor.diagnostic(`Authorization: Basic ${basic}`), REDACTED);
  }
});

test("JSON unicode escapes and nested-JSON quote escapes of a stored credential are masked", () => {
  const key = "made-up-provider-key";
  const redactor = only({ apiKey: key });
  const unicodeEscaped = `\\u006dade-up\\u002dprovider-key`;
  const doubleUnicodeEscaped = `\\\\u006dade-up\\\\u002dprovider-key`;
  assert.equal(redactor.text(`{"k":"${unicodeEscaped}"}`), `{"k":"[redacted]"}`);
  assert.equal(redactor.text(`{\\"k\\":\\"${doubleUnicodeEscaped}\\"}`), `{\\"k\\":\\"[redacted]\\"}`);
  assert.equal(redactor.diagnostic(`failed ${unicodeEscaped}`), REDACTED);

  const quotedKey = 'made-up"provider"key';
  const quotedRedactor = only({ apiKey: quotedKey });
  const innerJson = JSON.stringify({ secret: quotedKey });
  const nestedJson = JSON.stringify({ body: innerJson });
  const maskedInner = quotedRedactor.text(innerJson);
  const maskedNested = quotedRedactor.text(nestedJson);
  assert.equal(maskedInner, '{"secret":"[redacted]"}');
  assert.equal(JSON.parse(maskedNested).body, '{"secret":"[redacted]"}');
  assert.equal(quotedRedactor.diagnostic(nestedJson), REDACTED);
});

test("a stored credential split by terminal escape codes is masked", () => {
  const key = "made-up-provider-key";
  const redactor = only({ apiKey: key });
  const colored = "before made-up\u001b[31m-provider-key after";
  assert.equal(redactor.text(colored), "before [redacted] after");
  assert.equal(redactor.diagnostic(colored), REDACTED);
});
