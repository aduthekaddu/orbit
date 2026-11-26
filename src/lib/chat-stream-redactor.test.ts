import assert from "node:assert/strict";
import test from "node:test";
import { readUIMessageStream, simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import { REDACTED, Redactor } from "./chat-errors";
import { redactUIMessageStream } from "./chat-stream-redactor";

const PROVIDER_KEY = "made-up-provider-key-0001";
const TAVILY_KEY = "made-up-tavily-key-0002";
const GITHUB_TOKEN = "made-up-github-token-0003";

async function collectRedacted(chunks: UIMessageChunk[], redactor: Redactor): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of simulateReadableStream({ chunks }).pipeThrough(redactUIMessageStream(redactor))) {
    out.push(chunk);
  }
  return out;
}

async function reconstructMessage(chunks: UIMessageChunk[]): Promise<UIMessage> {
  let latest: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: simulateReadableStream({ chunks }) })) {
    latest = message;
  }
  assert.ok(latest, "readUIMessageStream produced no message");
  return latest;
}

test("reasoning-delta and text-delta preserve and redact providerMetadata across holdback, empty deltas, and zero-holdback", async () => {
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN });
  const input: UIMessageChunk[] = [
    { type: "start", messageId: "m-meta-1" },
    { type: "reasoning-start", id: "r1" },
    {
      type: "reasoning-delta",
      id: "r1",
      delta: "short thought",
      providerMetadata: { anthropic: { signature: "sig-held-1", trace: `token ${PROVIDER_KEY}` } },
    },
    { type: "reasoning-end", id: "r1" },
    { type: "reasoning-start", id: "r2" },
    { type: "reasoning-delta", id: "r2", delta: "longer reasoning text that exceeds the stream holdback window easily" },
    {
      type: "reasoning-delta",
      id: "r2",
      delta: "",
      providerMetadata: { anthropic: { signature: "sig-empty-delta-2" } },
    },
    { type: "reasoning-end", id: "r2" },
    { type: "text-start", id: "t1" },
    {
      type: "text-delta",
      id: "t1",
      delta: "prefix ",
      providerMetadata: { openai: { itemId: "item-1", [TAVILY_KEY]: `leak ${GITHUB_TOKEN}` } },
    },
    { type: "text-delta", id: "t1", delta: "followed by enough normal words to flush the active stream buffer" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop" },
  ];

  const redacted = await collectRedacted(input, redactor);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(PROVIDER_KEY), false, `provider key leaked in chunks: ${serialized}`);
  assert.equal(serialized.includes(TAVILY_KEY), false, `tavily key leaked in chunks: ${serialized}`);
  assert.equal(serialized.includes(GITHUB_TOKEN), false, `github token leaked in chunks: ${serialized}`);

  const message = await reconstructMessage(redacted);
  const r1 = message.parts.find((p) => p.type === "reasoning" && p.text === "short thought");
  const r2 = message.parts.find((p) => p.type === "reasoning" && p.text.startsWith("longer reasoning"));
  const t1 = message.parts.find((p) => p.type === "text");
  assert.ok(r1 && r1.type === "reasoning");
  assert.ok(r2 && r2.type === "reasoning");
  assert.ok(t1 && t1.type === "text");

  assert.deepEqual(r1.providerMetadata, { anthropic: { signature: "sig-held-1", trace: `token ${REDACTED}` } });
  assert.deepEqual(r2.providerMetadata, { anthropic: { signature: "sig-empty-delta-2" } });
  assert.deepEqual(t1.providerMetadata, { openai: { itemId: "item-1", [REDACTED]: `leak ${REDACTED}` } });

  // Zero-holdback fast path (no long secrets configured) must also keep empty-delta providerMetadata.
  const noLong = new Redactor({ apiKey: "ollama", tavilyApiKey: "", githubToken: "" });
  const zeroChunks = await collectRedacted(
    [
      { type: "start", messageId: "m-zero" },
      { type: "reasoning-start", id: "rz" },
      { type: "reasoning-delta", id: "rz", delta: "thinking" },
      { type: "reasoning-delta", id: "rz", delta: "", providerMetadata: { anthropic: { signature: "sig-zero" } } },
      { type: "reasoning-end", id: "rz" },
      { type: "finish", finishReason: "stop" },
    ],
    noLong,
  );
  const zeroMessage = await reconstructMessage(zeroChunks);
  const rz = zeroMessage.parts.find((p) => p.type === "reasoning");
  assert.ok(rz && rz.type === "reasoning");
  assert.equal(rz.text, "thinking");
  assert.deepEqual(rz.providerMetadata, { anthropic: { signature: "sig-zero" } });
});

test("cross-part redacted deltas keep each part's own providerMetadata even when a part's text redacts to empty", async () => {
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: "", githubToken: "" });
  const input: UIMessageChunk[] = [
    { type: "start", messageId: "m-cross-meta" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "made-up-", providerMetadata: { provider: { part: "first" } } },
    { type: "text-end", id: "t1" },
    { type: "text-start", id: "t2" },
    { type: "text-delta", id: "t2", delta: "provider-key-0001", providerMetadata: { provider: { part: "second" } } },
    { type: "text-end", id: "t2" },
    { type: "finish", finishReason: "stop" },
  ];

  const redacted = await collectRedacted(input, redactor);
  const message = await reconstructMessage(redacted);
  const textParts = message.parts.filter((p) => p.type === "text");
  assert.equal(textParts.length, 2);
  assert.equal(textParts[0].text, REDACTED);
  assert.deepEqual(textParts[0].providerMetadata, { provider: { part: "first" } });
  assert.equal(textParts[1].text, "");
  assert.deepEqual(textParts[1].providerMetadata, { provider: { part: "second" } });
});

test("credentials split across text, reasoning, and tool-input deltas with interleaved non-text chunks are masked", async () => {
  const redactor = new Redactor({ apiKey: PROVIDER_KEY, tavilyApiKey: TAVILY_KEY, githubToken: GITHUB_TOKEN });
  const basic = Buffer.from(`user:${PROVIDER_KEY}`).toString("base64");
  const midBasic = 10;

  const interleavedCases: Array<{ name: string; middle: UIMessageChunk }> = [
    { name: "message-metadata", middle: { type: "message-metadata", messageMetadata: { step: 1 } } },
    { name: "source-url", middle: { type: "source-url", sourceId: "s1", url: "https://example.com" } },
    { name: "source-document", middle: { type: "source-document", sourceId: "d1", mediaType: "text/plain", title: "doc" } },
    { name: "file", middle: { type: "file", mediaType: "text/plain", url: "data:text/plain;base64,aGk=" } },
    { name: "custom", middle: { type: "custom", kind: "vendor.ping" } },
    { name: "data-progress", middle: { type: "data-progress", data: { pct: 50 } } as UIMessageChunk },
    { name: "tool-output-denied", middle: { type: "tool-output-denied", toolCallId: "denied-1" } },
  ];

  for (const { name, middle } of interleavedCases) {
    const input: UIMessageChunk[] = [
      { type: "start", messageId: `m-${name}` },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Secret: made-up-" },
      middle,
      { type: "text-delta", id: "t1", delta: `provider-key-0001 and Basic ${basic.slice(0, midBasic)}` },
      middle,
      { type: "text-delta", id: "t1", delta: `${basic.slice(midBasic)} end` },
      { type: "text-end", id: "t1" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "check made-up-tavily-" },
      middle,
      { type: "reasoning-delta", id: "r1", delta: "key-0002 done" },
      { type: "reasoning-end", id: "r1" },
      { type: "finish", finishReason: "stop" },
    ];

    const redacted = await collectRedacted(input, redactor);
    const serialized = JSON.stringify(redacted);
    assert.equal(serialized.includes("made-up-"), false, `${name}: leaked literal prefix: ${serialized}`);
    assert.equal(serialized.includes("provider-key-0001"), false, `${name}: leaked literal suffix: ${serialized}`);
    assert.equal(serialized.includes("key-0002"), false, `${name}: leaked reasoning suffix: ${serialized}`);
    assert.equal(serialized.includes(basic.slice(6)), false, `${name}: leaked Basic-auth suffix: ${serialized}`);

    const textJoined = redacted
      .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.delta)
      .join("");
    assert.equal(textJoined, redactor.text(`Secret: ${PROVIDER_KEY} and Basic ${basic} end`), `${name}: text mismatch`);

    const reasoningJoined = redacted
      .filter((c): c is Extract<UIMessageChunk, { type: "reasoning-delta" }> => c.type === "reasoning-delta")
      .map((c) => c.delta)
      .join("");
    assert.equal(reasoningJoined, `check ${REDACTED} done`, `${name}: reasoning mismatch`);
  }

  // Interleaved message-metadata between tool-input deltas must not split tool-input redaction either.
  const toolInputChunks = await collectRedacted(
    [
      { type: "tool-input-start", toolCallId: "c1", toolName: "render_ui" },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"k":"made-up-github-' },
      { type: "message-metadata", messageMetadata: { step: 2 } },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: 'token-0003"}' },
      { type: "tool-input-available", toolCallId: "c1", toolName: "render_ui", input: { k: GITHUB_TOKEN } },
      { type: "finish", finishReason: "stop" },
    ],
    redactor,
  );
  const toolDeltaText = toolInputChunks
    .filter((c): c is Extract<UIMessageChunk, { type: "tool-input-delta" }> => c.type === "tool-input-delta")
    .map((c) => c.inputTextDelta)
    .join("");
  assert.equal(toolDeltaText, '{"k":"[redacted]"}');
  assert.equal(JSON.stringify(toolInputChunks).includes("made-up-github-"), false);

  // Interleaved chunk during State 3 (closed t1 + active t2 with deferred start) keeps cross-part masking and chunk order.
  const state3Chunks = await collectRedacted(
    [
      { type: "start", messageId: "m-state3" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "made-up-" },
      { type: "text-end", id: "t1" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "provider-" },
      { type: "source-url", sourceId: "s-mid", url: "https://example.com" },
      { type: "text-delta", id: "t2", delta: "key-0001!" },
      { type: "text-end", id: "t2" },
      { type: "finish", finishReason: "stop" },
    ],
    redactor,
  );
  const state3Text = state3Chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
  assert.equal(state3Text, `${REDACTED}!`);
  assert.equal(JSON.stringify(state3Chunks).includes("made-up-"), false);
  const t2StartIdx = state3Chunks.findIndex((c) => c.type === "text-start" && c.id === "t2");
  const sourceIdx = state3Chunks.findIndex((c) => c.type === "source-url");
  const t2EndIdx = state3Chunks.findIndex((c) => c.type === "text-end" && c.id === "t2");
  assert.ok(t2StartIdx >= 0 && sourceIdx > t2StartIdx && t2EndIdx > sourceIdx, `unexpected State 3 chunk order: ${JSON.stringify(state3Chunks)}`);

  // Interleaved reasoning block inside an open text part keeps the open text stream intact.
  const nestedReasoning = await collectRedacted(
    [
      { type: "start", messageId: "m-nested" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "made-up-" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thinking" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-delta", id: "t1", delta: "provider-key-0001" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop" },
    ],
    redactor,
  );
  const nestedMessage = await reconstructMessage(nestedReasoning);
  const nestedText = nestedMessage.parts.find((p) => p.type === "text");
  assert.ok(nestedText && nestedText.type === "text");
  assert.equal(nestedText.text, REDACTED);
});

test("property: redactUIMessageStream matches redactor.text() and preserves redacted providerMetadata across interleaved non-text chunks", async () => {
  const keys = [
    PROVIDER_KEY,
    'made+up/quote"key=0002',
    "made up space key 0003",
    "made-up-utf8-key-🔑-04",
  ];
  const redactor = new Redactor({
    apiKey: keys[0],
    tavilyApiKey: keys[1],
    githubToken: keys[2],
    baseUrl: `https://user:${encodeURIComponent(keys[3])}@example.com/v1`,
  });

  const makeRng = (seed: number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const noisePool = ["hello ", "world", "1234", "%", "%2F", "\\", "\\u00", "=", "dXNl", "🔑", "made-up-", "\u001b[31m", "\u001b[0m", " "];

  const encodeVariant = (rng: () => number, key: string): string => {
    const kind = Math.floor(rng() * 7);
    if (kind === 0) return key;
    if (kind === 1) return encodeURIComponent(key);
    if (kind === 2) {
      const prefix = pick(rng, ["", "u:", "us:", "use:", "user:"]);
      return Buffer.from(prefix + key, "utf8").toString(rng() < 0.5 ? "base64" : "base64url");
    }
    if (kind === 3) return Buffer.from(`user:${key}`, "utf8").toString("base64").replaceAll("/", "\\/");
    if (kind === 4) return [...key].map((ch, idx) => (idx % 3 === 0 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch)).join("");
    if (kind === 5) return JSON.stringify({ k: key });
    const cut = 1 + Math.floor(rng() * (key.length - 1));
    return `${key.slice(0, cut)}\u001b[31m${key.slice(cut)}`;
  };

  const makeInterleaved = (rng: () => number, seq: number): UIMessageChunk => {
    const kind = Math.floor(rng() * 5);
    const maybeSecret = rng() < 0.35 ? pick(rng, keys) : "ok";
    if (kind === 0) return { type: "message-metadata", messageMetadata: { seq, note: `meta-${maybeSecret}` } };
    if (kind === 1) return { type: "source-url", sourceId: `s-${seq}`, url: `https://example.com/${maybeSecret}` };
    if (kind === 2) return { type: "custom", kind: "vendor.note", providerMetadata: { vendor: { seq, tag: maybeSecret } } };
    if (kind === 3) return { type: "file", mediaType: "text/plain", url: `https://files.example.com/${seq}?k=${maybeSecret}` };
    return { type: "data-note", data: { seq, label: maybeSecret } } as UIMessageChunk;
  };

  for (const seed of [404, 505, 606]) {
    const rng = makeRng(seed);
    for (let trial = 0; trial < 100; trial++) {
      const buildText = () => {
        const pieces: string[] = [];
        const count = 2 + Math.floor(rng() * 5);
        for (let p = 0; p < count; p++) {
          pieces.push(rng() < 0.45 ? encodeVariant(rng, pick(rng, keys)) : pick(rng, noisePool));
        }
        return pieces.join("");
      };

      const reasoningText = buildText();
      const bodyText = buildText();
      const chunks: UIMessageChunk[] = [{ type: "start", messageId: `m-${seed}-${trial}` }];
      let seq = 0;

      const emitStreamedPart = (kind: "reasoning" | "text", id: string, full: string) => {
        let lastMeta: Record<string, Record<string, string>> | undefined;
        chunks.push(kind === "reasoning" ? { type: "reasoning-start", id } : { type: "text-start", id });
        let pos = 0;
        while (pos < full.length) {
          const step = 1 + Math.floor(rng() * (rng() < 0.7 ? 8 : 20));
          const delta = full.slice(pos, pos + step);
          pos += step;
          const attachMeta = rng() < 0.3;
          const meta = attachMeta
            ? { provider: { sig: `sig-${seed}-${trial}-${seq++}`, note: rng() < 0.35 ? `v:${pick(rng, keys)}` : "clean" } }
            : undefined;
          if (meta) lastMeta = meta;
          chunks.push(
            kind === "reasoning"
              ? { type: "reasoning-delta", id, delta, ...(meta ? { providerMetadata: meta } : {}) }
              : { type: "text-delta", id, delta, ...(meta ? { providerMetadata: meta } : {}) },
          );
          if (rng() < 0.25) chunks.push(makeInterleaved(rng, seq++));
        }
        if (rng() < 0.4) {
          const emptyMeta = { anthropic: { signature: `end-sig-${seed}-${trial}-${seq++}` } };
          lastMeta = emptyMeta;
          chunks.push(
            kind === "reasoning"
              ? { type: "reasoning-delta", id, delta: "", providerMetadata: emptyMeta }
              : { type: "text-delta", id, delta: "", providerMetadata: emptyMeta },
          );
        }
        chunks.push(kind === "reasoning" ? { type: "reasoning-end", id } : { type: "text-end", id });
        return lastMeta;
      };

      const expectedReasoningMeta = emitStreamedPart("reasoning", "r1", reasoningText);
      if (rng() < 0.5) chunks.push(makeInterleaved(rng, seq++));
      const expectedTextMeta = emitStreamedPart("text", "t1", bodyText);
      chunks.push({ type: "finish", finishReason: "stop" });

      const redacted = await collectRedacted(chunks, redactor);
      const serialized = JSON.stringify(redacted);
      for (const key of keys) {
        assert.equal(serialized.includes(key), false, `seed=${seed} trial=${trial} leaked literal key ${key}`);
      }

      const message = await reconstructMessage(redacted);
      const rPart = message.parts.find((p) => p.type === "reasoning");
      const tPart = message.parts.find((p) => p.type === "text");
      assert.ok(rPart && rPart.type === "reasoning", `seed=${seed} trial=${trial} missing reasoning part`);
      assert.ok(tPart && tPart.type === "text", `seed=${seed} trial=${trial} missing text part`);

      assert.equal(rPart.text, redactor.text(reasoningText), `seed=${seed} trial=${trial} reasoning mismatch`);
      assert.equal(tPart.text, redactor.text(bodyText), `seed=${seed} trial=${trial} text mismatch`);
      assert.deepEqual(
        rPart.providerMetadata,
        expectedReasoningMeta ? redactor.value(expectedReasoningMeta) : undefined,
        `seed=${seed} trial=${trial} reasoning providerMetadata mismatch`,
      );
      assert.deepEqual(
        tPart.providerMetadata,
        expectedTextMeta ? redactor.value(expectedTextMeta) : undefined,
        `seed=${seed} trial=${trial} text providerMetadata mismatch`,
      );
    }
  }
});
