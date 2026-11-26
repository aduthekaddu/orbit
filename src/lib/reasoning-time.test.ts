import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderMetadata, TextStreamPart, ToolSet, UIMessage } from "ai";
import { settleReasoningTimes, stampReasoningTimes, stripOrbitTiming } from "./reasoning-time";

test("reasoning metadata survives updates and includes the elapsed time", async () => {
  let time = 500;
  const signature = { anthropic: { signature: "signature" } };
  const transform = stampReasoningTimes(() => time);
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  async function stamp(chunk: TextStreamPart<ToolSet>, at: number): Promise<ProviderMetadata | undefined> {
    time = at;
    const [, result] = await Promise.all([writer.write(chunk), reader.read()]);
    return result.value && "providerMetadata" in result.value ? result.value.providerMetadata : undefined;
  }

  assert.deepEqual(await stamp({ type: "reasoning-start", id: "r" }, 500),
    { orbitTiming: { startedAt: 500 } });
  assert.deepEqual(await stamp({ type: "reasoning-delta", id: "r", text: "thinking", providerMetadata: signature }, 750),
    { ...signature, orbitTiming: { startedAt: 500 } });
  assert.deepEqual(await stamp({ type: "reasoning-end", id: "r" }, 900),
    { ...signature, orbitTiming: { startedAt: 500, thoughtMs: 400 } });
  await writer.close();
});

test("an interrupted reasoning part gets a duration and only provider metadata is sent back", () => {
  const reasoning = {
    type: "reasoning",
    text: "thinking",
    providerMetadata: { anthropic: { signature: "signature" }, orbitTiming: { startedAt: 500 } },
  } as const;
  assert.deepEqual(settleReasoningTimes([reasoning], () => 900), [{
    ...reasoning,
    providerMetadata: { ...reasoning.providerMetadata, orbitTiming: { startedAt: 500, thoughtMs: 400 } },
  }]);
  const history: UIMessage[] = [{ id: "reply", role: "assistant", parts: [reasoning] }];
  assert.deepEqual(stripOrbitTiming(history), [{
    ...history[0],
    parts: [{ ...reasoning, providerMetadata: { anthropic: { signature: "signature" } } }],
  }]);
  assert.equal(history[0].parts[0], reasoning);
});

test("reasoning that reaches EOF without an end chunk receives its elapsed time", async () => {
  let time = 500;
  const transform = stampReasoningTimes(() => time);
  const writer = transform.writable.getWriter();
  const chunks: TextStreamPart<ToolSet>[] = [];
  const read = (async () => {
    for await (const chunk of transform.readable) chunks.push(chunk);
  })();
  await writer.write({ type: "reasoning-start", id: "r" });
  await writer.write({ type: "error", error: new Error("Provider error.") });
  const metadata = { anthropic: { signature: "signature" } };
  await writer.write({ type: "reasoning-delta", id: "r", text: "thinking", providerMetadata: metadata });
  time = 900;
  await writer.close();
  await read;
  assert.deepEqual(chunks.at(-1), {
    type: "reasoning-end", id: "r", providerMetadata: { ...metadata, orbitTiming: { startedAt: 500, thoughtMs: 400 } },
  });
});
