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

test("a run that closes without a terminal chunk tells live and replay listeners it was interrupted", async () => {
  const run = await reserve();
  const start = { type: "start", messageId: "reply-chat" } as const;
  startReplyRun(run, new ReadableStream({
    start(controller) {
      controller.enqueue(start);
      controller.close();
    },
  }), () => null);
  const expected = [start, { type: "error", errorText: "The reply was interrupted." }];
  const live = await readAll(watchReply(run));
  const replay = findReplyRun("chat", "user", "reply-chat");
  assert.ok(replay);
  assert.deepEqual({ live, replay: await readAll(watchReply(replay.run)) }, { live: expected, replay: expected });
});

test("a stopped run that closes without an abort chunk sends the saved marker and abort", async () => {
  const run = await reserve();
  startReplyRun(run, new ReadableStream({
    start(controller) {
      run.controller.signal.addEventListener("abort", () => controller.close(), { once: true });
    },
  }), () => "stopped");
  const live = readAll(watchReply(run));
  assert.equal(stopReplyRun("chat", "user"), true);
  assert.deepEqual(await live, [
    { type: "data-reply-end", data: { reason: "stopped" } }, { type: "abort" },
  ]);
});

test("a provider error followed by finish sends the saved marker before the error", async () => {
  const run = await reserve();
  const error = { type: "error", errorText: "Response stream ended without a finish reason." } as const;
  startReplyRun(run, new ReadableStream({
    start(controller) {
      controller.enqueue(error);
      controller.enqueue({ type: "finish", finishReason: "error" });
      controller.close();
    },
  }), () => "failed");
  assert.deepEqual(await readAll(watchReply(run)), [
    { type: "data-reply-end", data: { reason: "failed" } }, error,
  ]);
});

test("a read failure after finish still ends the reply with an error", async () => {
  const run = await reserve();
  startReplyRun(run, new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "finish", finishReason: "stop" });
    },
    pull(controller) {
      controller.error(new Error("Stream cleanup failed."));
    },
  }), () => null);
  assert.deepEqual(await readAll(watchReply(run)), [{ type: "error", errorText: "The reply was interrupted." }]);
});

test("the replay budget evicts the oldest ended run and leaves the running reply intact", async () => {
  const live = await reserve("live");
  const finish = { type: "finish", finishReason: "stop" } as const;
  const delta = { type: "text-delta", id: "answer", delta: "x".repeat(1024 * 1024) } as const;
  const stream = (close: boolean) => new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (let i = 0; i < 22; i++) controller.enqueue(delta);
      if (close) {
        controller.enqueue(finish);
        controller.close();
      } else {
        live.controller.signal.addEventListener("abort", () => controller.close(), { once: true });
      }
    },
  });
  startReplyRun(live, stream(false), () => null);
  const liveReader = watchReply(live).getReader();
  try {
    assert.deepEqual((await liveReader.read()).value, delta);
    for (const chatId of ["oldest", "second", "newest"]) {
      const run = await reserve(chatId);
      startReplyRun(run, stream(true), () => null);
      await run.done;
      if (chatId === "second") assert.ok(findReplyRun("oldest", "user", "reply-oldest"));
    }
    assert.equal(findReplyRun("oldest", "user", "reply-oldest"), null);
    assert.ok(findReplyRun("second", "user", "reply-second"));
    assert.ok(findReplyRun("newest", "user", "reply-newest"));
    assert.equal(findReplyRun("live", "user")?.run, live);
    assert.deepEqual((await liveReader.read()).value, delta);
  } finally {
    await liveReader.cancel();
    await discardReplyRun("live");
  }
});

test("an ended reply remains replayable for ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = await reserve();
  const finish = { type: "finish", finishReason: "stop" } as const;
  startReplyRun(run, new ReadableStream({
    start(controller) {
      controller.enqueue(finish);
      controller.close();
    },
  }), () => null);
  await run.done;
  t.mock.timers.tick(10 * 60_000 - 1);
  const replay = findReplyRun("chat", "user", "reply-chat");
  assert.ok(replay);
  assert.deepEqual(await readAll(watchReply(replay.run)), [finish]);
  t.mock.timers.tick(1);
  assert.equal(findReplyRun("chat", "user", "reply-chat"), null);
});
