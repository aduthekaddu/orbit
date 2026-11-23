import assert from "node:assert/strict";
import test from "node:test";
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
