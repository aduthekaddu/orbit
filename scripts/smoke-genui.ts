import path from "node:path";
import type { toRepository } from "../src/lib/chat-tree";
import Database from "better-sqlite3";
import { parseRenderSpec } from "../src/lib/genui/spec";
import { dataDirectory } from "../src/lib/paths";
import { connectProvider } from "./qa/connect-provider.mjs";

const origin = new URL(process.env.ORBIT_QA_ORIGIN || "http://127.0.0.1:3211").origin;
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

async function request(path: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("origin", origin);
  if (cookieHeader()) headers.set("cookie", cookieHeader());
  const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
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

function savedSpec(parts: unknown) {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; toolName?: unknown; state?: unknown; output?: unknown };
    const type = typeof record.type === "string" ? record.type : "";
    const named = type === "tool-render_ui" || (type === "dynamic-tool" && record.toolName === "render_ui");
    if (!named || record.state !== "output-available") continue;
    const output = record.output;
    if (!output || typeof output !== "object" || !("ok" in output) || output.ok !== true || !("spec" in output)) continue;
    return output.spec;
  }
  return null;
}

async function main() {
  if (!baseUrl || !apiKey) fail("ORBIT_BASE_URL and ORBIT_API_KEY are required");
  const ready = await request("/api/setup");
  if (!ready.ok) fail(`server not ready ${ready.status}`);

  await auth();

  const { connection, defaults } = await connectProvider(
    async (path, { method, json }) => {
      const response = await request(path, { method, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: response.status, text: await response.text() };
    },
    { label: "Smoke", baseUrl, apiKey, model },
  );
  if (defaults.connectionId !== connection.id || defaults.model !== model) fail("the default model was not saved");
  console.log(`connection kind=${connection.kind} keySet=yes default model=${defaults.model}`);

  const created = await request("/api/chats", { method: "POST" });
  const createdBody = (await created.json()) as { id?: string };
  if (!created.ok || !createdBody.id) fail(`create chat failed ${created.status}`);
  const chatId = createdBody.id;

  const prompt = [
    "Call the render_ui tool exactly once.",
    "Arguments are one spec object with root and elements, not a patch stream.",
    "Use a Card titled Smoke whose child is a Metric labeled Checks with value 1.",
    "Set every unused optional string to null.",
    "Include children arrays.",
  ].join(" ");
  const userMessageId = crypto.randomUUID();
  const chat = await request(
    "/api/chat",
    {
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
    },
    180_000,
  );
  if (!chat.ok || !chat.body) {
    const errorBody = await chat.text();
    fail(`chat failed ${chat.status} ${errorBody.slice(0, 240)}`);
  }
  const raw = await chat.text();
  const types = [...raw.matchAll(/"type":"([^"]+)"/g)].map((match) => match[1]).slice(0, 16);
  console.log(`stream bytes=${raw.length} types=${types.join(",") || "none"}`);

  const reloaded = await request(`/api/chats/${chatId}`);
  const reloadedBody = (await reloaded.json()) as ReturnType<typeof toRepository>;
  if (!reloaded.ok) fail(`reload failed ${reloaded.status}`);
  const reloadedMessages = reloadedBody.messages.map(({ message }) => message);
  const assistant = reloadedMessages.filter((message) => message.role === "assistant");
  const fromApi = assistant.map((message) => savedSpec(message.parts)).find((spec) => spec != null);
  if (!fromApi) {
    fail(`reload has no render_ui spec messages=${reloadedBody.messages?.length ?? 0} roles=${reloadedMessages.map((message) => message.role).join(",")}`);
  }
  const checked = parseRenderSpec(fromApi);
  if (!checked.ok) fail(`saved spec failed validation ${checked.error}`);
  const elementCount = Object.keys(checked.spec.elements).length;
  console.log(`reload spec root=${checked.spec.root} elements=${elementCount}`);

  const sqlite = new Database(path.join(dataDirectory(), "orbit.db"), { readonly: true, fileMustExist: true });
  const rows = sqlite
    .prepare("select role, parts from messages where chat_id = ? order by position")
    .all(chatId) as Array<{ role: string; parts: string }>;
  sqlite.close();
  const fromDb = rows
    .filter((row) => row.role === "assistant")
    .map((row) => savedSpec(JSON.parse(row.parts) as unknown))
    .find((spec) => spec != null);
  if (!fromDb) fail("db row has no render_ui spec");
  const dbChecked = parseRenderSpec(fromDb);
  if (!dbChecked.ok) fail(`db spec failed validation ${dbChecked.error}`);
  console.log(`db spec root=${dbChecked.spec.root} elements=${Object.keys(dbChecked.spec.elements).length}`);
  console.log("genui smoke passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "smoke failed";
  fail(message);
});
