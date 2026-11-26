import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { orbitChatTransport } from "./chat-transport";

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

test("sending a message reports the reply id from the stream response header", async () => {
  const ids: string[] = [];
  const transport = orbitChatTransport("c1", {
    api: "http://orbit.test/api/chat",
    fetch: async () => new Response("data: [DONE]\n\n", {
      headers: { "x-resumable-stream-id": "reply-id" },
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
