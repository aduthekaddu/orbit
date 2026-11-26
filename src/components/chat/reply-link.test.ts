import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Chat } from "@ai-sdk/react";
import { createUIMessageStreamResponse, type ChatRequestOptions, type UIMessage, type UIMessageChunk } from "ai";
import { orbitChatTransport } from "@/lib/chat-transport";
import { eventually } from "@/lib/eventually.mjs";
import { createReplyLink } from "./reply-link";

const prompt = { id: "u1", role: "user", parts: [{ type: "text", text: "question" }] } as const;
const reply = { id: "a1", role: "assistant", parts: [{ type: "text", text: "finished" }] } as const;
const key = "orbit-stream:chat";
const noSaved = new Set<string>();

function browser(t: TestContext, storedReply?: string) {
  const stored = new Map(storedReply ? [[key, storedReply]] : []);
  const window = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const navigator = { onLine: true };
  for (const [name, value] of Object.entries({ window, document, navigator })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { stored, window, document, navigator };
}

function fixture(
  t: TestContext,
  {
    resumeStatus = 200,
    storedReply,
    respond = () => new Response(null, { status: 500 }),
  }: { resumeStatus?: number; storedReply?: string; respond?: (url: string, init?: RequestInit) => Response } = {},
) {
  const { stored, window, document, navigator } = browser(t, storedReply);
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => respond(url, init));
  const refresh = t.mock.fn();
  const stop = t.mock.fn(async () => {});
  const setMessages = t.mock.fn();
  const clearError = t.mock.fn();
  const link = createReplyLink("chat", refresh);
  const resumeStream = t.mock.fn(async (options?: ChatRequestOptions) => {
    assert.ok(options?.body && "replyId" in options.body);
    assert.equal(options.body.replyId, "a1");
    link.reconnectResponse(resumeStatus);
  });
  const disconnect = link.connect({ resumeStream, setMessages, clearError, stop });
  t.after(disconnect);
  return { link, stored, window, document, navigator, fetch, setMessages, resumeStream, stop, refresh, disconnect };
}

test("a dropped stream retries while the tab stays online and visible", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { link, resumeStream, stored } = fixture(t);
  link.accept("a1");
  link.finish({ isDisconnect: true, isAbort: false, messages: [] });
  assert.equal(stored.get(key), "a1");
  assert.equal(link.getSnapshot().state.kind, "reconnecting");
  t.mock.timers.tick(249);
  assert.equal(resumeStream.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(resumeStream.mock.callCount(), 1);
  assert.equal(link.getSnapshot().state.kind, "attached");
});

test("going online or returning to the tab retries immediately", (t) => {
  const { link, resumeStream, window, document, navigator } = fixture(t);
  document.visibilityState = "hidden";
  navigator.onLine = false;
  link.accept("a1");
  link.finish({ isDisconnect: true, isAbort: false, messages: [] });
  window.dispatchEvent(new Event("online"));
  assert.equal(resumeStream.mock.callCount(), 0);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(resumeStream.mock.callCount(), 0);
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  assert.equal(resumeStream.mock.callCount(), 1);
});

test("mount clears a saved checkpoint and skips a stored reply on a different branch", async (t) => {
  await t.test("clears a reply already in history", (t) => {
    const { link, stored, resumeStream } = fixture(t, { storedReply: "a1" });
    link.mount(null, new Set(["a1"]), true, "u1");
    assert.equal(stored.get(key), undefined);
    assert.equal(resumeStream.mock.callCount(), 0);
  });
  await t.test("skips a stored reply when focused on a different branch", (t) => {
    const { link, stored, resumeStream } = fixture(t, { storedReply: "a1" });
    link.mount(null, noSaved, false, "u1");
    assert.equal(stored.get(key), "a1");
    assert.equal(resumeStream.mock.callCount(), 0);
  });
  await t.test("attaches a reply reported by the server", (t) => {
    const { link, stored, resumeStream } = fixture(t);
    link.mount("a1", noSaved, true, "u1");
    assert.equal(stored.get(key), "a1");
    assert.equal(resumeStream.mock.callCount(), 1);
  });
});

test("a missing stream restores a saved reply from the chat path", async (t) => {
  const { link, stored, setMessages, refresh } = fixture(t, {
    resumeStatus: 204,
    storedReply: "a1",
    respond: () => Response.json({
      headId: "a1",
      messages: [{ message: prompt, parentId: null }, { message: reply, parentId: "u1" }],
    }),
  });
  link.mount(null, noSaved, true, "u1");
  await eventually(() => link.getSnapshot().state.kind, (kind) => kind === "attached", {
    timeoutMs: 1_000,
    what: "saved reply to replace the stream",
  });
  assert.deepEqual(setMessages.mock.calls[0]?.arguments, [[prompt, reply]]);
  assert.equal(stored.get(key), undefined);
  assert.equal(refresh.mock.callCount(), 1);
});

test("a missing stream with no saved reply leaves the partial reply available", async (t) => {
  const { link, stored, setMessages } = fixture(t, {
    resumeStatus: 204,
    storedReply: "a1",
    respond: () => Response.json({ headId: "u1", messages: [{ message: prompt, parentId: null }] }),
  });
  link.mount(null, noSaved, true, "u1");
  await eventually(() => link.getSnapshot().state.kind, (kind) => kind === "lost", {
    timeoutMs: 1_000,
    what: "interrupted reply to be shown",
  });
  assert.equal(stored.get(key), undefined);
  assert.equal(setMessages.mock.callCount(), 0);
});

test("a failed history fetch keeps the checkpoint for another attempt", async (t) => {
  let reads = 0;
  const { link, stored, window, resumeStream } = fixture(t, {
    resumeStatus: 204,
    storedReply: "a1",
    respond: () => {
      reads += 1;
      if (reads === 1) throw new TypeError("Load failed");
      return Response.json({ headId: "u1", messages: [{ message: prompt, parentId: null }] });
    },
  });
  link.mount(null, noSaved, true, "u1");
  await eventually(() => link.getSnapshot().state, (state) => state.kind === "reconnecting" && state.attempt === 1, {
    timeoutMs: 1_000,
    what: "failed history request to schedule a retry",
  });
  assert.equal(stored.get(key), "a1");
  window.dispatchEvent(new Event("online"));
  await eventually(() => link.getSnapshot().state.kind, (kind) => kind === "lost", {
    timeoutMs: 1_000,
    what: "second history read to finish",
  });
  assert.equal(resumeStream.mock.callCount(), 2);
});

test("a protocol failure clears the checkpoint and a local unmount abort preserves it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { link, stored, resumeStream, refresh, disconnect } = fixture(t);
  link.accept("a1");
  link.finish({ isAbort: false, isDisconnect: false, messages: [] });
  t.mock.timers.tick(5_000);
  assert.equal(stored.get(key), undefined);
  assert.equal(refresh.mock.callCount(), 1);
  assert.equal(resumeStream.mock.callCount(), 0);
  link.accept("a1");
  link.finish({ isAbort: true, isDisconnect: false, messages: [] });
  disconnect();
  assert.equal(stored.get(key), "a1");
});

test("Stop leaves the stream open on failure and shows an error", async (t) => {
  const { link, fetch, stop, stored } = fixture(t);
  link.accept("a1");
  await link.stop();
  assert.equal(fetch.mock.calls[0]?.arguments[0], "/api/chats/chat/stop");
  assert.equal(fetch.mock.calls[0]?.arguments[1]?.method, "POST");
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(link.getSnapshot().state.kind, "attached");
  assert.equal(link.getSnapshot().stopError, "Could not stop");
  assert.equal(stored.get(key), "a1");
});

test("Stop stays pending while recovering a dropped stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { link, stop, stored, resumeStream } = fixture(t, {
    respond: () => Response.json({ ok: true, stopped: true }),
  });
  link.accept("a1");
  await link.stop();
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(link.getSnapshot().state.kind, "stopping");
  link.finish({ isAbort: false, isDisconnect: true, messages: [] });
  assert.equal(link.getSnapshot().state.kind, "stopping");
  t.mock.timers.tick(250);
  assert.equal(resumeStream.mock.callCount(), 1);
  assert.equal(link.getSnapshot().state.kind, "stopping");
  link.finish({ isAbort: false, isDisconnect: false, messages: [] });
  assert.equal(stored.get(key), undefined);
  assert.equal(link.getSnapshot().state.kind, "attached");
});

test("mount cleanup cancels its local request and keeps the checkpoint for the next connect", async (t) => {
  const { link, stored, disconnect } = fixture(t);
  const first = Promise.withResolvers<void>();
  const stop = t.mock.fn(async () => first.resolve());
  const callbacks = { setMessages() {}, clearError() {}, stop };
  const cleanup = link.connect({ ...callbacks, resumeStream: () => first.promise });
  link.mount("a1", noSaved, true, "u1");
  cleanup();
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(stored.get(key), "a1");
  const resume = t.mock.fn(async () => link.reconnectResponse(200));
  const cleanupAgain = link.connect({ ...callbacks, resumeStream: resume });
  t.after(cleanupAgain);
  await eventually(() => link.getSnapshot().state.kind, (kind) => kind === "attached", {
    timeoutMs: 1_000,
    what: "the new connection to retrieve the pending reply",
  });
  assert.equal(resume.mock.callCount(), 1);
  disconnect();
});

function streamResponse(chunks: UIMessageChunk[], headers?: Record<string, string>) {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return createUIMessageStreamResponse({ stream, headers });
}

function streaming(chat: Chat<UIMessage>) {
  if (chat.status === "streaming") return Promise.resolve();
  const ready = Promise.withResolvers<void>();
  const unsubscribe = chat["~registerStatusCallback"](() => {
    if (chat.status === "streaming") {
      unsubscribe();
      ready.resolve();
    }
  });
  return ready.promise;
}

const partial: UIMessageChunk[] = [
  { type: "start", messageId: "a1" },
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "partial" },
];

function sdkFixture(t: TestContext, reconnect: (signal?: AbortSignal | null) => Response | Promise<Response>, send: (signal?: AbortSignal | null) => Response | Promise<Response> = () => streamResponse(partial, {
  "x-resumable-stream-id": "a1",
})) {
  const browserState = browser(t);
  const refresh = t.mock.fn();
  const link = createReplyLink("chat", refresh);
  const request = t.mock.fn(reconnect);
  const transport = orbitChatTransport("chat", {
    fetch: async (_input, init) => init?.method === "GET" ? request(init.signal) : send(init?.signal),
    onReplyId: link.accept,
    onReconnectResponse: link.reconnectResponse,
  });
  const finish = t.mock.fn(link.finish);
  const chat = new Chat({ transport, onFinish: finish });
  const resumeStream = t.mock.fn(chat.resumeStream);
  const disconnect = link.connect({
    resumeStream,
    setMessages: (messages) => { chat.messages = typeof messages === "function" ? messages(chat.messages) : messages; },
    clearError: chat.clearError,
    stop: chat.stop,
  });
  t.after(async () => {
    disconnect();
    await chat.stop();
  });
  return { ...browserState, chat, link, request, resumeStream, finish, refresh };
}

test("replayed prefixes that disconnect keep increasing the reconnect delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { chat, link, resumeStream, stored } = sdkFixture(t, () => streamResponse(partial));
  await chat.sendMessage({ text: "question" });
  for (const [index, delay] of [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000].entries()) {
    t.mock.timers.tick(delay - 1);
    assert.equal(resumeStream.mock.callCount(), index, `reconnect ${index + 1} waits ${delay} ms`);
    t.mock.timers.tick(1);
    assert.equal(resumeStream.mock.callCount(), index + 1);
    await resumeStream.mock.calls[index]?.result;
    assert.equal(link.getSnapshot().state.kind, "reconnecting");
    assert.equal(stored.get(key), "a1");
  }
  const last = chat.messages.at(-1);
  assert.deepEqual(last?.parts.find((part) => part.type === "text")?.text, "partial");
});

test("the SDK does not call finish for short reconnect responses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses = [undefined, 503, 429, 404];
  const { chat, link, stored, resumeStream, finish } = sdkFixture(t, () => {
    const status = statuses.shift();
    if (status === undefined) throw new TypeError("Network failed before response headers");
    return new Response(null, { status });
  });
  await chat.sendMessage({ text: "question" });
  assert.equal(finish.mock.callCount(), 1);
  for (const [index, delay] of [250, 500, 1_000, 2_000].entries()) {
    t.mock.timers.tick(delay);
    await resumeStream.mock.calls[index]?.result;
    assert.equal(finish.mock.callCount(), 1);
    assert.equal(stored.get(key), index === 3 ? undefined : "a1");
  }
  assert.equal(link.getSnapshot().state.kind, "lost");
});

test("the mounted chat resumes a reply discovered after its POST loses headers", async (t) => {
  const { chat, link, finish, refresh, resumeStream } = sdkFixture(t, () => streamResponse([
    ...partial,
    { type: "text-delta", id: "text", delta: " then finished" },
    { type: "text-end", id: "text" },
    { type: "finish", finishReason: "stop" },
  ]), () => { throw new TypeError("Network failed before response headers"); });
  link.mount(null, noSaved, true, "u1");
  await chat.sendMessage({ ...prompt, parts: [...prompt.parts] });
  assert.equal(finish.mock.calls[0]?.arguments[0].isDisconnect, true);
  assert.equal(refresh.mock.callCount(), 1);

  link.mount("a1", noSaved, true, "u1");
  assert.equal(resumeStream.mock.callCount(), 1, "the refreshed reply id reaches the SDK reconnect");
  await resumeStream.mock.calls[0]?.result;
  assert.equal(chat.messages.at(-1)?.id, "a1");
  assert.equal(chat.messages.at(-1)?.parts.find((part) => part.type === "text")?.text, "partial then finished");
});

test("a pre-header disconnect keeps Retry until the same prompt has a live reply", async (t) => {
  const { chat, link, window, document, navigator, refresh, resumeStream } = sdkFixture(
    t, () => new Response(null, { status: 204 }),
    () => { throw new TypeError("Network failed before response headers"); },
  );
  link.mount(null, noSaved, true, null);
  navigator.onLine = false;
  await chat.sendMessage({ ...prompt, parts: [...prompt.parts] });
  assert.equal(refresh.mock.callCount(), 1);

  link.mount(null, noSaved, true, "u1");
  link.mount("another-reply", noSaved, true, "another-prompt");
  assert.equal(resumeStream.mock.callCount(), 0);
  assert.equal(chat.status, "error");

  document.visibilityState = "hidden";
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  assert.equal(refresh.mock.callCount(), 1);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refresh.mock.callCount(), 2);
});

test("a 204 reconnect reaches history without calling the SDK finish callback", async (t) => {
  const { chat, link, finish, stored } = sdkFixture(t, () => new Response(null, { status: 204 }));
  t.mock.method(globalThis, "fetch", async () => Response.json({
    headId: "a1",
    messages: [{ message: prompt, parentId: null }, { message: reply, parentId: "u1" }],
  }));
  link.mount("a1", noSaved, true, "u1");
  await eventually(() => chat.messages, (messages) => messages.at(-1)?.id === "a1", {
    timeoutMs: 1_000,
    what: "the saved reply after a 204 reconnect",
  });
  assert.deepEqual(chat.messages, [prompt, reply]);
  assert.equal(finish.mock.callCount(), 0);
  assert.equal(stored.get(key), undefined);
});

test("a failed Stop error clears when the reply finishes", async (t) => {
  const { link } = fixture(t);
  link.accept("a1");
  await link.stop();
  assert.equal(link.getSnapshot().stopError, "Could not stop");
  link.finish({ isAbort: false, isDisconnect: false, messages: [] });
  assert.equal(link.getSnapshot().state.kind, "attached");
  assert.equal(link.getSnapshot().stopError, "");
});

for (const saved of [true, false]) {
  test(`a failed Stop error clears when a missing stream is ${saved ? "restored" : "lost"}`, async (t) => {
    const { link, window } = fixture(t, {
      resumeStatus: 204,
      respond: (_url, init) => init?.method === "POST"
        ? new Response(null, { status: 500 })
        : Response.json({
            headId: saved ? "a1" : "u1",
            messages: [
              { message: prompt, parentId: null },
              ...(saved ? [{ message: reply, parentId: "u1" }] : []),
            ],
          }),
    });
    link.accept("a1");
    await link.stop();
    assert.equal(link.getSnapshot().stopError, "Could not stop");
    link.finish({ isAbort: false, isDisconnect: true, messages: [] });
    assert.equal(link.getSnapshot().stopError, "Could not stop");
    window.dispatchEvent(new Event("online"));
    await eventually(() => link.getSnapshot().state.kind, (kind) => kind === (saved ? "attached" : "lost"), {
      timeoutMs: 1_000,
      what: "the missing stream to be resolved",
    });
    assert.equal(link.getSnapshot().stopError, "");
  });
}

test("Stop replaces a reconnect stalled before headers", async (t) => {
  const first = Promise.withResolvers<Response>();
  const headersRequested = Promise.withResolvers<void>();
  let firstSignal: AbortSignal | null | undefined;
  let requests = 0;
  const { chat, link, request, resumeStream } = sdkFixture(t, (signal) => {
    if (++requests > 1) return streamResponse([...partial, { type: "abort" }]);
    firstSignal = signal;
    signal?.addEventListener("abort", () => first.reject(signal.reason), { once: true });
    headersRequested.resolve();
    return first.promise;
  });
  t.after(() => first.resolve(new Response(null, { status: 204 })));
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, stopped: true }));
  link.mount("a1", noSaved, true, "u1");
  await headersRequested.promise;
  try {
    await link.stop();
    assert.equal(firstSignal?.aborted, true);
    await eventually(() => request.mock.callCount(), (count) => count === 2, {
      timeoutMs: 1_000,
      what: "the replacement reconnect to reach the server",
    });
    await resumeStream.mock.calls[1]?.result;
    assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
    assert.deepEqual(chat.messages.at(-1)?.parts.find((part) => part.type === "text")?.text, "partial");
  } finally {
    first.resolve(new Response(null, { status: 204 }));
  }
});

test("Stop stays pending when a fallback replay attaches before server cleanup completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishReplay = () => {};
  const replay = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of partial) controller.enqueue(chunk);
      finishReplay = () => {
        controller.enqueue({ type: "abort" });
        controller.close();
      };
    },
  });
  const primary = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of partial) controller.enqueue(chunk);
    },
  });
  const { chat, link, request, resumeStream, stored } = sdkFixture(t,
    () => createUIMessageStreamResponse({ stream: replay }),
    () => createUIMessageStreamResponse({
      stream: primary,
      headers: { "x-resumable-stream-id": "a1" },
    }),
  );
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, stopped: true }));
  const sending = chat.sendMessage({ text: "question" });
  await streaming(chat);
  assert.equal(stored.get(key), "a1");
  await link.stop();
  t.mock.timers.tick(1_500);
  await sending;
  await streaming(chat);
  try {
    assert.equal(request.mock.callCount(), 1);
    assert.equal(link.getSnapshot().state.kind, "stopping");
    await link.stop();
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    finishReplay();
    await resumeStream.mock.calls[0]?.result;
  }
  assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
  assert.equal(stored.get(key), undefined);
});

test("a missing replay restores the saved reply after Stop is confirmed", async (t) => {
  const { chat, link, stored } = sdkFixture(t, () => new Response(null, { status: 204 }));
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ ok: true, stopped: true })
    : Response.json({
      headId: "a1",
      messages: [{ message: prompt, parentId: null }, { message: reply, parentId: "u1" }],
    }));
  await chat.sendMessage({ text: "question" });
  await link.stop();
  await eventually(() => chat.messages, (messages) => messages.at(-1)?.parts.some((part) =>
    part.type === "text" && part.text === "finished") === true, {
    timeoutMs: 1_000,
    what: "the saved reply after Stop",
  });
  assert.deepEqual(chat.messages, [prompt, reply]);
  assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
  assert.equal(stored.get(key), undefined);
});

test("headers arriving before Stop is confirmed let the same replay finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = Promise.withResolvers<Response>();
  const headersRequested = Promise.withResolvers<void>();
  const stopResponse = Promise.withResolvers<Response>();
  let finishReplay = () => {};
  const { chat, link, request, resumeStream } = sdkFixture(t, () => {
    headersRequested.resolve();
    return response.promise;
  });
  t.mock.method(globalThis, "fetch", () => stopResponse.promise);
  link.mount("a1", noSaved, true, "u1");
  await headersRequested.promise;
  const stopping = link.stop();
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of partial) controller.enqueue(chunk);
      finishReplay = () => {
        controller.enqueue({ type: "abort" });
        controller.close();
      };
    },
  });
  response.resolve(createUIMessageStreamResponse({ stream }));
  await streaming(chat);
  try {
    stopResponse.resolve(Response.json({ ok: true, stopped: true }));
    await stopping;
    assert.equal(link.getSnapshot().state.kind, "stopping");
    assert.equal(request.mock.callCount(), 1);
  } finally {
    finishReplay();
    await resumeStream.mock.calls[0]?.result;
  }
  t.mock.timers.tick(1_500);
  assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
  assert.equal(request.mock.callCount(), 1);
});

test("Stop cancels a reply before its response headers arrive", async (t) => {
  const sendResponse = Promise.withResolvers<Response>();
  const sendStarted = Promise.withResolvers<void>();
  const { chat, link, stored, refresh } = sdkFixture(t, () => new Response(null, { status: 204 }), () => {
    sendStarted.resolve();
    return sendResponse.promise;
  });
  t.after(() => sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" })));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, stopped: true }));
  const sending = chat.sendMessage({ text: "question" });
  await sendStarted.promise;
  try {
    await link.stop();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0]?.arguments[0], "/api/chats/chat/stop");
    assert.equal(link.getSnapshot().state.kind, "stopping");
    sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" }));
    await sending;
    assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
    assert.equal(stored.get(key), undefined);
    assert.equal(refresh.mock.callCount(), 1);
  } finally {
    sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" }));
    await sending;
  }
});

test("Stop aborts a stalled pre-header send when the server has no active reply", async (t) => {
  const sendStarted = Promise.withResolvers<void>();
  const sendResponse = Promise.withResolvers<Response>();
  let sendSignal: AbortSignal | null | undefined;
  const { chat, link, refresh } = sdkFixture(t, () => new Response(null, { status: 204 }), (signal) => {
    sendSignal = signal;
    signal?.addEventListener("abort", () => sendResponse.reject(signal.reason), { once: true });
    sendStarted.resolve();
    return sendResponse.promise;
  });
  t.after(() => sendResponse.resolve(streamResponse([{ type: "abort" }])));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, stopped: false }));
  const sending = chat.sendMessage({ text: "question" });
  await sendStarted.promise;
  try {
    await link.stop();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(sendSignal?.aborted, true);
    await sending;
    assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
    assert.equal(refresh.mock.callCount(), 1);
  } finally {
    sendResponse.resolve(streamResponse([{ type: "abort" }]));
    await sending;
  }
});

test("Stop retries against the server when headers arrive while a pre-header stop sees no run", async (t) => {
  const sendStarted = Promise.withResolvers<void>();
  const sendResponse = Promise.withResolvers<Response>();
  const firstStop = Promise.withResolvers<Response>();
  let closed = false;
  let finishStream = () => {};
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of partial) controller.enqueue(chunk);
      finishStream = () => {
        if (closed) return;
        closed = true;
        controller.enqueue({ type: "abort" });
        controller.close();
      };
    },
  });
  const { chat, link } = sdkFixture(t, () => new Response(null, { status: 204 }), () => {
    sendStarted.resolve();
    return sendResponse.promise;
  });
  let stops = 0;
  const fetch = t.mock.method(globalThis, "fetch", () => {
    stops += 1;
    if (stops === 1) return firstStop.promise;
    return Promise.resolve(Response.json({ ok: true, stopped: true }));
  });
  t.after(() => {
    firstStop.resolve(Response.json({ ok: true, stopped: false }));
    sendResponse.resolve(createUIMessageStreamResponse({ stream, headers: { "x-resumable-stream-id": "a1" } }));
    finishStream();
  });
  const sending = chat.sendMessage({ text: "question" });
  await sendStarted.promise;
  try {
    const stopping = link.stop();
    assert.equal(link.getSnapshot().state.kind, "stopping");
    sendResponse.resolve(createUIMessageStreamResponse({ stream, headers: { "x-resumable-stream-id": "a1" } }));
    await streaming(chat);
    assert.equal(link.getSnapshot().state.kind, "stopping");
    firstStop.resolve(Response.json({ ok: true, stopped: false }));
    await stopping;
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(link.getSnapshot().state.kind, "stopping");
    finishStream();
    await sending;
    assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
  } finally {
    firstStop.resolve(Response.json({ ok: true, stopped: false }));
    sendResponse.resolve(createUIMessageStreamResponse({ stream, headers: { "x-resumable-stream-id": "a1" } }));
    finishStream();
    await sending;
  }
});

test("a failed pre-header Stop reports an error and leaves Stop retryable", async (t) => {
  const sendStarted = Promise.withResolvers<void>();
  const sendResponse = Promise.withResolvers<Response>();
  const { chat, link } = sdkFixture(t, () => new Response(null, { status: 204 }), () => {
    sendStarted.resolve();
    return sendResponse.promise;
  });
  t.after(() => sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" })));
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 500 }));
  const sending = chat.sendMessage({ text: "question" });
  await sendStarted.promise;
  try {
    await link.stop();
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(link.getSnapshot().state, { kind: "attached", replyId: null });
    assert.equal(link.getSnapshot().stopError, "Could not stop");
    sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" }));
    await sending;
    assert.equal(link.getSnapshot().stopError, "");
  } finally {
    sendResponse.resolve(streamResponse([{ type: "abort" }], { "x-resumable-stream-id": "a1" }));
    await sending;
  }
});
