import Database from "better-sqlite3";
import { OPENCODE_GO_BASE_URL, outboundSessionHeader, reasoningAllowed } from "../src/lib/provider";

const origin = "http://127.0.0.1:3210";
const email = "smoke@orbit.local";
const password = "orbit-smoke-pass";
const model = "deepseek-v4.1-flash";

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

if (reasoningAllowed({ capabilities: { reasoning: { supported: false } } }) !== false) {
  fail("reasoning gate allowed an unsupported model");
}
if (!reasoningAllowed({ id: "plain" })) fail("missing reasoning metadata should allow the slider");
if (!reasoningAllowed({ capabilities: { reasoning: { supported: true, effort: ["max"] } } })) {
  fail("reasoning gate blocked a model that supports reasoning");
}
console.log("reasoning gate: yes");

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

function streamedText(raw: string) {
  let text = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as { type?: string; delta?: string; textDelta?: string };
      if (event.type === "text-delta" && typeof event.delta === "string") text += event.delta;
      if (typeof event.textDelta === "string") text += event.textDelta;
    } catch {
      // ignore keepalives
    }
  }
  return text;
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

  const before = await request("/api/settings");
  const beforeBody = (await before.json()) as { keySet?: boolean; baseUrl?: string; apiKey?: unknown };
  if (!before.ok) fail(`settings read failed ${before.status}`);
  if ("apiKey" in beforeBody) fail("settings leaked apiKey before save");
  console.log(`settings before save keySet=${beforeBody.keySet ? "yes" : "no"}`);

  const saved = await request("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: providerBase,
      apiKey: providerKey,
      model,
      reasoningEffort: "low",
    }),
  });
  const savedBody = (await saved.json()) as { model?: string; keySet?: boolean; apiKey?: unknown; error?: string };
  if (!saved.ok) fail(`settings save failed ${saved.status} ${savedBody.error ?? ""}`);
  if ("apiKey" in savedBody) fail("settings leaked apiKey");
  if (savedBody.model !== model || savedBody.keySet !== true) fail("settings did not store the model");
  const serialized = JSON.stringify(savedBody);
  if (serialized.includes(providerKey)) fail("settings response contained the key");
  console.log(`settings saved model=${savedBody.model} keySet=yes`);

  const listed = await request("/api/models", {
    method: "POST",
    body: JSON.stringify({ baseUrl: providerBase }),
  });
  const listedBody = (await listed.json()) as { models?: Array<{ id?: string; reasoning?: boolean | null }> };
  const ids = (listedBody.models ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
  const chosen = listedBody.models?.find((item) => item.id === model);
  if (!listed.ok || !ids.includes(model) || ids.length < 2) {
    fail(`model list incomplete status=${listed.status} count=${ids.length}`);
  }
  console.log(`models=${ids.length} ${model} reasoning=${chosen?.reasoning === true ? "yes" : chosen?.reasoning === false ? "no" : "unknown"}`);

  const created = await request("/api/chats", { method: "POST" });
  const createdBody = (await created.json()) as { id?: string };
  if (!created.ok || !createdBody.id) fail(`create chat failed ${created.status}`);
  const chatId = createdBody.id;

  const prompt = "Reply with the single word pong";
  const userMessageId = crypto.randomUUID();
  const chat = await request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      id: chatId,
      trigger: "submit-message",
      messageId: userMessageId,
      messages: [
        {
          id: userMessageId,
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
      ],
    }),
  });
  if (!chat.ok || !chat.body) {
    const errorBody = await chat.text();
    fail(`chat failed ${chat.status} ${errorBody.slice(0, 240)}`);
  }
  const raw = await chat.text();
  const text = streamedText(raw).trim();
  if (!text) {
    const types = [...raw.matchAll(/"type":"([^"]+)"/g)].map((match) => match[1]).slice(0, 12);
    fail(`no streamed text bytes=${raw.length} types=${types.join(",") || "none"}`);
  }
  console.log(`streamed chars=${text.length} preview=${JSON.stringify(redact(text.slice(0, 80)))}`);

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
