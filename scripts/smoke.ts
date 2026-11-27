import Database from "better-sqlite3";
import type { UIMessage, UIMessageChunk } from "ai";
import { orbitChatTransport } from "../src/lib/chat-transport";
import { OPENCODE_GO_BASE_URL, outboundSessionHeader } from "../src/lib/provider";
import type { ListedModel } from "../src/lib/model-list";
import { connectProvider } from "./qa/connect-provider.mjs";

const origin = new URL(process.env.ORBIT_QA_ORIGIN || "http://127.0.0.1:3210").origin;
const email = "smoke@orbit.local";
const password = "orbit-smoke-pass";
const model = process.env.ORBIT_MODEL?.trim() || "deepseek-v4.1-flash";

function redact(value: string) {
  const secret = process.env.ORBIT_API_KEY;
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}

function fail(message: string): never {
  console.error(redact(message));
  process.exit(1);
}

const baseUrl = process.env.ORBIT_BASE_URL?.trim();
const apiKey = process.env.ORBIT_API_KEY?.trim();
if (!baseUrl || !apiKey) fail("ORBIT_BASE_URL and ORBIT_API_KEY are required");

const cookies = new Map<string, string>();

function cookieHeader() {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function storeCookies(response: Response) {
  for (const entry of response.headers.getSetCookie()) {
    const pair = entry.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("origin", origin);
  if (cookieHeader()) headers.set("cookie", cookieHeader());
  const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  storeCookies(response);
  return response;
}

async function send(path: string, { method, json }: { method?: string; json?: unknown } = {}) {
  const response = await request(path, { method, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: response.status, text: await response.text() };
}

async function auth() {
  const signup = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Smoke", email, password }),
  });
  if (signup.ok) {
    console.log("signed up");
    return;
  }
  const signin = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) {
    const signupBody = await signup.text();
    const signinBody = await signin.text();
    fail(`auth failed signup=${signup.status} signin=${signin.status} ${signupBody.slice(0, 180)} ${signinBody.slice(0, 180)}`);
  }
  console.log("signed in");
}

async function main() {
  if (!baseUrl || !apiKey) fail("ORBIT_BASE_URL and ORBIT_API_KEY are required");
  const providerBase = baseUrl;
  const providerKey = apiKey;
  const opencode = providerBase.replace(/\/+$/, "") === OPENCODE_GO_BASE_URL;
  const sent = await outboundSessionHeader(providerBase, "chat-1");
  const other = await outboundSessionHeader("https://example.com/v1", "chat-1");
  if (other) fail("opencode session header set for a different base URL");
  if (opencode && sent !== "chat-1") fail(`opencode session header missing on request value=${sent ?? "none"}`);
  if (!opencode && sent) fail("opencode session header set for a different base URL");
  console.log(`opencode session header on request: ${sent === "chat-1" ? "yes" : "no"}`);
  const ready = await request("/api/setup");
  if (!ready.ok) fail(`server not ready ${ready.status}`);

  await auth();

  const { connection, defaults } = await connectProvider(send, { label: "Smoke", baseUrl: providerBase, apiKey: providerKey, model });
  if (defaults.connectionId !== connection.id || defaults.model !== model) fail("the default model was not saved");
  console.log(`connection kind=${connection.kind} keySet=yes default model=${defaults.model} effort=${defaults.effort}`);

  const listed = await send(`/api/connections/${connection.id}/models`);
  if (listed.text.includes(providerKey)) fail("the model list contained the key");
  const listedBody = JSON.parse(listed.text) as { models?: ListedModel[] };
  const ids = (listedBody.models ?? []).map((item) => item.id);
  const chosen = listedBody.models?.find((item) => item.id === model);
  if (listed.status !== 200 || !ids.includes(model) || ids.length < 2) {
    fail(`model list incomplete status=${listed.status} count=${ids.length}`);
  }
  const reasoning = chosen?.caps?.reasoning;
  console.log(`models=${ids.length} ${model} reasoning=${reasoning === true ? "yes" : reasoning === false ? "no" : "unknown"}`);

  const created = await request("/api/chats", { method: "POST" });
  const createdBody = (await created.json()) as { id?: string };
  if (!created.ok || !createdBody.id) fail(`create chat failed ${created.status}`);
  const chatId = createdBody.id;

  const prompt = "Reply with the single word pong";
  const userMessageId = crypto.randomUUID();
  const localId = `__LOCALID_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let sentId = "";
  const transport = orbitChatTransport(chatId, {
    api: `${origin}/api/chat`,
    headers: { cookie: cookieHeader(), origin },
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { id?: string };
        sentId = body.id ?? "";
      }
      return fetch(input, init);
    },
  });
  transport.setRuntime({
    thread: { getModelContext: () => undefined },
    threads: { mainItem: { initialize: async () => ({ remoteId: localId }) } },
  } as never);
  const message: UIMessage = {
    id: userMessageId,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };
  let stream: ReadableStream<UIMessageChunk>;
  try {
    stream = await transport.sendMessages({
      chatId,
      messages: [message],
      abortSignal: AbortSignal.timeout(120_000),
      trigger: "submit-message",
      messageId: userMessageId,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "chat failed";
    fail(`chat failed ${messageText.slice(0, 240)}`);
  }
  let text = "";
  const types: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    if (chunk && typeof chunk === "object" && "type" in chunk && typeof chunk.type === "string") {
      if (types.length < 12) types.push(chunk.type);
      if (chunk.type === "text-delta" && "delta" in chunk && typeof chunk.delta === "string") text += chunk.delta;
    }
  }
  text = text.trim();
  if (sentId !== chatId) fail(`first message used id=${sentId || "none"} open=${chatId}`);
  if (!text) fail(`no streamed text types=${types.join(",") || "none"}`);
  console.log(`streamed chars=${text.length} preview=${JSON.stringify(redact(text.slice(0, 80)))}`);
  console.log("first message chat id matches open chat: yes");

  const reloaded = await request(`/api/chats/${chatId}`);
  const reloadedBody = (await reloaded.json()) as { messages?: Array<{ role: string; parts?: unknown }> };
  if (!reloaded.ok || (reloadedBody.messages?.length ?? 0) < 2) {
    fail(`reload missing messages count=${reloadedBody.messages?.length ?? 0}`);
  }
  console.log(`reload messages=${reloadedBody.messages?.length}`);

  const sqlite = new Database("data/orbit.db", { readonly: true, fileMustExist: true });
  const chatRow = sqlite.prepare("select id, title from chats where id = ?").get(chatId) as { id: string; title: string } | undefined;
  const rows = sqlite
    .prepare("select role, content from messages where chat_id = ? order by position")
    .all(chatId) as Array<{ role: string; content: string }>;
  sqlite.close();
  if (!chatRow) fail("chat row missing");
  const roles = rows.map((row) => row.role).sort();
  if (rows.length < 2 || !roles.includes("user") || !roles.includes("assistant")) {
    fail(`db messages incomplete count=${rows.length} roles=${roles.join(",")}`);
  }
  if (rows.some((row) => row.content.trim().length === 0)) fail("db message content empty");
  console.log(`db chat=1 messages=${rows.length} roles=${roles.join(",")}`);
  console.log("smoke passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "smoke failed";
  fail(message);
});
