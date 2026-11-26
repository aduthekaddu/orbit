import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { UIMessageChunk } from "ai";
import {
  bindReplyPlan, discardReplyRun, findReplyRun, MAX_RUNNING_PER_USER, releaseReplyRun,
  reserveReplyRun, resetReplyRunsForTest, startReplyRun, stopReplyRun, watchReply,
} from "./reply-runs";

afterEach(resetReplyRunsForTest);

async function reserve(chatId = "chat", userId = "user") {
  const reservation = await reserveReplyRun(chatId, userId);
  assert.ok(reservation.ok);
  bindReplyPlan(reservation.run, `reply-${chatId}`, "prompt");
  return reservation.run;
}

async function readAll(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("a cancelled listener leaves the run alive and a later listener receives the whole reply", async () => {
  const run = await reserve();
  const start = { type: "start", messageId: "reply-chat" } as const;
  const finish = { type: "finish", finishReason: "stop" } as const;
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  startReplyRun(run, new ReadableStream({ start(value) { controller = value; } }), () => null);
  try {
    const first = watchReply(run).getReader();
    controller.enqueue(start);
    assert.deepEqual((await first.read()).value, start);
    await first.cancel();
    assert.equal(run.controller.signal.aborted, false);

    const late = readAll(watchReply(run));
    controller.enqueue(finish);
    controller.close();
    await run.done;
    assert.deepEqual(await late, [start, finish]);
    assert.equal(findReplyRun("chat", "user"), null);
    assert.equal(findReplyRun("chat", "other", "reply-chat"), null);
    assert.equal(findReplyRun("chat", "user", "wrong"), null);
    assert.deepEqual(await readAll(watchReply(run)), [start, finish]);
  } finally {
    if (run.state.kind !== "ended") {
      controller.close();
      await run.done;
    }
  }
});

test("a stopping run keeps its reservation until one waiting sender can claim it", async () => {
  const run = await reserve();
  const listener = watchReply(run);
  assert.deepEqual(await reserveReplyRun("chat", "user"), { ok: false, reason: "busy" });
  assert.equal(stopReplyRun("chat", "other"), false);
  assert.equal(stopReplyRun("chat", "user"), true);
  assert.equal(stopReplyRun("chat", "user"), true);
  assert.equal(run.controller.signal.aborted, true);
  assert.deepEqual(await reserveReplyRun("chat", "user", { stopWaitMs: 1 }), { ok: false, reason: "busy" });

  const pending = Promise.all([reserveReplyRun("chat", "user"), reserveReplyRun("chat", "user")]);
  releaseReplyRun(run);
  assert.deepEqual(await readAll(listener), []);
  const results = await pending;
  for (const result of results) {
    if (result.ok) releaseReplyRun(result.run);
  }
  assert.deepEqual(results.map((result) => result.ok ? "reserved" : result.reason), ["reserved", "busy"]);
});

test("starting and stopping runs both count against the user limit", async () => {
  const active = await Promise.all(Array.from({ length: MAX_RUNNING_PER_USER }, (_, index) => reserve(`chat-${index}`)));
  const other = await reserve("other", "other");
  try {
    stopReplyRun(active[0].chatId, "user");
    assert.deepEqual(await reserveReplyRun("one-more", "user"), { ok: false, reason: "user-limit" });
  } finally {
    for (const run of [...active, other]) releaseReplyRun(run);
  }
});

test("a discarded reply drains before removal and sends the saved marker before its terminal chunk", async () => {
  const run = await reserve();
  const terminal = { type: "error", errorText: "Provider failed." } as const;
  startReplyRun(run, new ReadableStream({
    start(controller) {
      run.controller.signal.addEventListener("abort", () => {
        controller.enqueue(terminal);
        controller.close();
      }, { once: true });
    },
  }), () => "failed");
  const listener = readAll(watchReply(run));
  await discardReplyRun("chat");
  assert.deepEqual(await listener, [{ type: "data-reply-end", data: { reason: "failed" } }, terminal]);
  assert.equal(findReplyRun("chat", "user", "reply-chat"), null);
});
