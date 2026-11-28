import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import { RESUMABLE_STREAM_ID_HEADER as ASSISTANT_UI_STREAM_ID_HEADER } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import { orbitChatTransport } from "./chat-transport";
import { RESUMABLE_STREAM_ID_HEADER } from "./reply-runs";
import { SERVER_TIME_HEADER } from "./thought-time";

function send(response: Response) {
  const transport = orbitChatTransport("c1", { api: "http://orbit.test/api/chat", fetch: async () => response });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: "local" }) } },
  } as never);
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
  return transport.sendMessages({ chatId: "c1", messageId: undefined, trigger: "submit-message", messages, abortSignal: undefined });
}

test("a refused chat request shows the route's error text, not the JSON body", async () => {
  await assert.rejects(send(Response.json({ error: "Message is too long." }, { status: 413 })), { message: "Message is too long." });
});

test("a refusal that is not the route's JSON keeps its body text", async () => {
  await assert.rejects(send(new Response("Bad gateway", { status: 502 })), { message: "Bad gateway" });
  await assert.rejects(send(Response.json({ detail: "x" }, { status: 400 })), { message: '{"detail":"x"}' });
});

test("resuming a reply requests its chat and reply ids with the SDK abort signal", async () => {
  const controller = new AbortController();
  let requested: Request | undefined;
  const statuses: number[] = [];
  const transport = orbitChatTransport("chat/id", {
    fetch: async (input, init) => {
      requested = new Request(new URL(String(input), "http://orbit.test"), init);
      return new Response(null, { status: 204 });
    },
    onReconnectResponse: (status) => statuses.push(status),
  });
  const stream = await transport.reconnectToStream({
    chatId: "assistant-ui-local-id",
    abortSignal: controller.signal,
    body: { replyId: "reply?id" },
  });
  assert.equal(stream, null);
  assert.equal(requested?.url, "http://orbit.test/api/chats/chat%2Fid/stream?replyId=reply%3Fid");
  assert.equal(requested?.method, "GET");
  assert.deepEqual(statuses, [204]);
  controller.abort();
  assert.equal(requested?.signal.aborted, true);
});

test("the server, transport, and assistant-ui agree on the reply id header", async () => {
  assert.equal(RESUMABLE_STREAM_ID_HEADER, ASSISTANT_UI_STREAM_ID_HEADER);
  const ids: string[] = [];
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: async () => new Response("data: [DONE]\n\n", {
      headers: { [RESUMABLE_STREAM_ID_HEADER]: "reply-id" },
    }),
    onReplyId: (id) => ids.push(id),
  });
  const stream = await transport.sendMessages({
    chatId: "local-id", messageId: undefined, messages: [],
    trigger: "submit-message", abortSignal: undefined,
  });
  await stream.cancel();
  assert.deepEqual(ids, ["reply-id"]);
});

test("an HTTP stream that closes before a terminal chunk is a disconnect", async () => {
  const transport = orbitChatTransport("c1", {
    fetch: async () => new Response('data: {"type":"start","messageId":"reply-id"}\n\ndata: {"type":"finish-step"}\n\n'),
  });
  const finished = Promise.withResolvers<boolean>();
  const chat = new Chat({ transport, onFinish: ({ isDisconnect }) => finished.resolve(isDisconnect) });
  await chat.sendMessage({ text: "hello" });
  assert.equal(await finished.promise, true);
  assert.equal(chat.messages.at(-1)?.id, "reply-id");
});

test("an abort chunk ends a stopped HTTP stream without reconnecting", async () => {
  const transport = orbitChatTransport("c1", {
    fetch: async () => new Response('data: {"type":"abort"}\n\ndata: [DONE]\n\n'),
  });
  const finished = Promise.withResolvers<boolean>();
  const chat = new Chat({ transport, onFinish: ({ isDisconnect }) => finished.resolve(isDisconnect) });
  await chat.sendMessage({ text: "hello" });
  assert.equal(await finished.promise, false);
});

test("the transport reports valid server timestamps on stream responses and ignores invalid ones", async () => {
  const times: number[] = [];
  const responses = [
    new Response("data: [DONE]\n\n", { headers: { [RESUMABLE_STREAM_ID_HEADER]: "a1", [SERVER_TIME_HEADER]: "1700000000000" } }),
    new Response("data: [DONE]\n\n", { headers: { [SERVER_TIME_HEADER]: "1700000005000" } }),
    new Response("data: [DONE]\n\n", { headers: { [SERVER_TIME_HEADER]: "not-a-timestamp" } }),
    new Response(null, { status: 500, headers: { [SERVER_TIME_HEADER]: "1700000099999" } }),
  ];
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: async () => responses.shift() ?? new Response(null, { status: 204 }),
    onServerTime: (time) => times.push(time),
  });
  const first = await transport.sendMessages({
    chatId: "local-id", messageId: undefined, messages: [], trigger: "submit-message", abortSignal: undefined,
  });
  await first.cancel();
  const second = await transport.reconnectToStream({ chatId: "local-id", body: { replyId: "a1" } });
  await second?.cancel();
  const third = await transport.reconnectToStream({ chatId: "local-id", body: { replyId: "a1" } });
  await third?.cancel();
  await assert.rejects(transport.reconnectToStream({ chatId: "local-id", body: { replyId: "a1" } }));
  assert.deepEqual(times, [1700000000000, 1700000005000]);
});

test("every send carries the picker's current choice: a new message, an edit, and a regenerate", async () => {
  const bodies: Record<string, unknown>[] = [];
  let choice = { connectionId: "conn-1", model: "claude-opus-5-5", effort: "high" as const };
  let editing: string | null = null;
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("data: [DONE]\n\n");
    },
    editMessageId: () => editing,
    modelChoice: () => choice,
  });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: "local" }) } },
  } as never);
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
  const sendWith = async (trigger: "submit-message" | "regenerate-message") => {
    const stream = await transport.sendMessages({ chatId: "c1", messageId: undefined, trigger, messages, abortSignal: undefined });
    await stream.cancel();
  };
  await sendWith("submit-message");
  editing = "u1";
  choice = { connectionId: "conn-2", model: "mock-reasoner", effort: "low" as never };
  await sendWith("submit-message");
  await sendWith("regenerate-message");
  assert.deepEqual(bodies.map((body) => body.modelChoice), [
    { connectionId: "conn-1", model: "claude-opus-5-5", effort: "high" },
    { connectionId: "conn-2", model: "mock-reasoner", effort: "low" },
    { connectionId: "conn-2", model: "mock-reasoner", effort: "low" },
  ]);
  assert.deepEqual(bodies.map((body) => body.editMessageId), [undefined, "u1", undefined]);
});

test("a chat with no choice yet sends none and lets the server resolve it", async () => {
  let body: Record<string, unknown> = {};
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("data: [DONE]\n\n");
    },
    modelChoice: () => null,
  });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: "local" }) } },
  } as never);
  const stream = await transport.sendMessages({ chatId: "c1", messageId: undefined, trigger: "submit-message", messages: [], abortSignal: undefined });
  await stream.cancel();
  assert.equal("modelChoice" in body, false);
});

test("a chat send reports that it started before its answer arrives", async () => {
  const events: string[] = [];
  let answer: (response: Response) => void = () => {};
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: () => {
      events.push("fetch");
      return new Promise<Response>((resolve) => { answer = resolve; });
    },
    onSend: () => events.push("send"),
  });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: "local" }) } },
  } as never);
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
  const sent = transport.sendMessages({ chatId: "c1", messageId: undefined, trigger: "submit-message", messages, abortSignal: undefined });
  const { eventually } = await import("./eventually.mjs");
  await eventually(() => events.length, (count) => count === 2, { timeoutMs: 2_000, what: "the send to start" });
  assert.deepEqual(events, ["send", "fetch"]);
  answer(Response.json({ error: "Message is too long." }, { status: 413 }));
  await assert.rejects(sent, { message: "Message is too long." });
});

function sendWith(options: Parameters<typeof orbitChatTransport>[1], abortSignal?: AbortSignal) {
  const transport = orbitChatTransport("c1", { api: "http://orbit.test/api/chat", ...options });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: "local" }) } },
  } as never);
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
  return transport.sendMessages({ chatId: "c1", messageId: undefined, trigger: "submit-message", messages, abortSignal });
}

test("a draft's first send carries the tools it turned off", async () => {
  const bodies: unknown[] = [];
  await sendWith({
    disabledTools: () => ["web_search"],
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("data: [DONE]\n\n");
    },
  }).catch(() => undefined);
  assert.deepEqual((bodies[0] as { disabledTools?: unknown }).disabledTools, ["web_search"]);
});

test("a saved chat's send carries no tools list", async () => {
  const bodies: unknown[] = [];
  await sendWith({
    disabledTools: () => undefined,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("data: [DONE]\n\n");
    },
  }).catch(() => undefined);
  assert.equal("disabledTools" in (bodies[0] as object), false);
});

test("a send waits for a pending tools save before the request leaves", async () => {
  let release!: () => void;
  const saved = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const sending = sendWith({
    beforeSend: async () => {
      await saved;
      events.push("saved");
    },
    fetch: async () => {
      events.push("sent");
      return new Response("data: [DONE]\n\n");
    },
  }).catch(() => undefined);
  await Promise.resolve();
  assert.deepEqual(events, []);
  release();
  await sending;
  assert.deepEqual(events, ["saved", "sent"]);
});

test("Stop ends a send that waits for a tools save, and the request never leaves", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const sending = sendWith({
    beforeSend: () => new Promise<void>(() => {}),
    onSend: () => events.push("send"),
    fetch: async () => {
      events.push("fetch");
      return new Response("data: [DONE]\n\n");
    },
  }, controller.signal);
  controller.abort();
  await assert.rejects(sending, { name: "AbortError" });
  assert.deepEqual(events, []);
});
