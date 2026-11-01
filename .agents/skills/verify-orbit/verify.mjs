#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const PORT = 3210;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const verifyDir = path.join(repoRoot, ".verify");
const sandbox = path.join(verifyDir, "sandbox");
const statePath = path.join(verifyDir, "server.json");
const logPath = path.join(verifyDir, "server.log");
const evidenceRoot = path.join(verifyDir, "evidence");

const VERIFY_EMAIL = "verify@orbit.local";
const VERIFY_PASSWORD = "orbit-verify-pass";
const FAKE_KEY = "test-key-not-real";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState() {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function procCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

function listenerPids() {
  const hex = PORT.toString(16).toUpperCase().padStart(4, "0");
  const needle = `0100007F:${hex}`;
  const inodes = new Set();
  let tcp = "";
  try {
    tcp = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch {
    return [];
  }
  for (const line of tcp.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[1]?.toUpperCase() !== needle || parts[3]?.toUpperCase() !== "0A") continue;
    inodes.add(parts[9]);
  }
  if (inodes.size === 0) return [];
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = "";
      try {
        target = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) {
        pids.push(Number(entry));
        break;
      }
    }
  }
  return pids;
}

function sandboxListening() {
  return listenerPids().some((pid) => procCwd(pid) === sandbox);
}

function linkIntoSandbox(name) {
  const source = path.join(repoRoot, name);
  if (!fs.existsSync(source)) return;
  fs.symlinkSync(source, path.join(sandbox, name));
}

function makeSandbox() {
  fs.mkdirSync(verifyDir, { recursive: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "data"), { recursive: true });
  for (const name of ["package.json", "package-lock.json", "node_modules", ".next", "drizzle", "next.config.ts"]) {
    linkIntoSandbox(name);
  }
}

function redact(text) {
  let out = text;
  for (const value of [process.env.ORBIT_API_KEY, process.env.BETTER_AUTH_SECRET, VERIFY_PASSWORD, FAKE_KEY]) {
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}

async function request(urlPath, { method = "GET", json, cookies, redirect = "manual" } = {}) {
  const headers = new Headers();
  headers.set("origin", ORIGIN);
  if (json !== undefined) headers.set("content-type", "application/json");
  if (cookies && cookies.size > 0) {
    headers.set("cookie", [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "));
  }
  const response = await fetch(`${ORIGIN}${urlPath}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect,
  });
  if (cookies && typeof response.headers.getSetCookie === "function") {
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  return {
    status: response.status,
    location: response.headers.get("location"),
    text: await response.text(),
  };
}

async function waitReady() {
  const deadline = Date.now() + 45_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/api/setup`);
      const text = await response.text();
      if (response.ok) {
        const body = JSON.parse(text);
        if (typeof body.signupOpen === "boolean") return body;
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.name : "fetch failed";
    }
    await sleep(250);
  }
  throw new Error(`GET /api/setup did not report signupOpen within 45s. Last result: ${last}. Log: ${logPath}`);
}

function assertOurServer() {
  const state = readState();
  if (!state || !alive(state.pid) || procCwd(state.pid) !== sandbox || !sandboxListening()) {
    fail(`sandbox server is not up on ${ORIGIN}. Run launch, then doctor.`);
  }
}

async function launch() {
  const state = readState();
  if (state && alive(state.pid) && procCwd(state.pid) === sandbox && sandboxListening()) {
    console.log(`already running pid=${state.pid} origin=${ORIGIN}`);
    return;
  }
  const listeners = listenerPids();
  if (listeners.length > 0) {
    const owner = listeners[0];
    fail(`port ${PORT} is in use by pid ${owner} cwd ${procCwd(owner) || "unknown"}. Stop that server before launch.`);
  }
  if (!fs.existsSync(path.join(repoRoot, ".next"))) {
    fail("missing .next. Run npm run build in the repo before launch.");
  }
  makeSandbox();
  fs.mkdirSync(verifyDir, { recursive: true });
  const logFd = fs.openSync(logPath, "w");
  const child = spawn("npm", ["start", "--", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: sandbox,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      LANG: process.env.LANG || "C.UTF-8",
      TMPDIR: process.env.TMPDIR || "/tmp",
      NODE_ENV: "production",
      BETTER_AUTH_URL: ORIGIN,
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(statePath, JSON.stringify({ pid: child.pid, port: PORT, sandbox, origin: ORIGIN }, null, 2));
  try {
    const ready = await waitReady();
    console.log(`ready origin=${ORIGIN} pid=${child.pid} signupOpen=${ready.signupOpen ? "yes" : "no"}`);
  } catch (error) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child already exited.
    }
    fail(error instanceof Error ? error.message : "launch failed");
  }
}

function doctor() {
  const state = readState();
  if (!state) fail("no server.json. Run launch first.");
  if (!alive(state.pid)) fail(`pid ${state.pid} is not running.`);
  if (procCwd(state.pid) !== sandbox) fail(`pid ${state.pid} cwd is not the sandbox.`);
  const listeners = listenerPids();
  if (!listeners.some((pid) => procCwd(pid) === sandbox)) {
    fail(`nothing from the sandbox is listening on ${ORIGIN}.`);
  }
  return fetch(`${ORIGIN}/api/setup`).then(async (response) => {
    const text = await response.text();
    if (!response.ok) fail(`GET /api/setup status ${response.status}`);
    const body = JSON.parse(text);
    if (typeof body.signupOpen !== "boolean") fail("GET /api/setup has no signupOpen boolean.");
    const dbPath = path.join(sandbox, "data", "orbit.db");
    console.log(`origin ${ORIGIN}`);
    console.log(`pid ${state.pid}`);
    console.log(`cwd ${sandbox}`);
    console.log(`signupOpen ${body.signupOpen ? "yes" : "no"}`);
    console.log(`db ${fs.existsSync(dbPath) ? "yes" : "no"}`);
    console.log("doctor ok");
  });
}

function portFree() {
  return listenerPids().length === 0;
}

async function waitForStopped(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid) && portFree()) return true;
    await sleep(100);
  }
  return !alive(pid) && portFree();
}

async function stopServer() {
  const state = readState();
  if (!state) return;
  if (alive(state.pid) && procCwd(state.pid) !== sandbox) {
    fail(`pid ${state.pid} is not the sandbox server. Not killing it.`);
  }
  if (alive(state.pid) || sandboxListening()) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  let stopped = await waitForStopped(state.pid, 5_000);
  if (!stopped) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    stopped = await waitForStopped(state.pid, 5_000);
  }
  if (!stopped) {
    const listeners = listenerPids().map((pid) => `${pid} cwd ${procCwd(pid) || "unknown"}`);
    fail(
      `server did not stop. pid ${state.pid} alive=${alive(state.pid) ? "yes" : "no"} listeners ${listeners.join(", ") || "none"}. Sandbox left in place.`,
    );
  }
}

async function cleanup() {
  await stopServer();
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(statePath, { force: true });
  fs.rmSync(logPath, { force: true });
  console.log(`cleanup done. evidence remains at ${evidenceRoot}`);
}

function writeEvidence(name, lines) {
  const dir = path.join(evidenceRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "summary.txt");
  fs.writeFileSync(file, `${lines.map(redact).join("\n")}\n`);
  console.log(`evidence ${file}`);
  return file;
}

async function signInVerify() {
  const cookies = new Map();
  const setup = await request("/api/setup", { cookies });
  const open = JSON.parse(setup.text).signupOpen === true;
  if (open) {
    const created = await request("/api/auth/sign-up/email", {
      method: "POST",
      cookies,
      json: { name: "Verify", email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
    });
    if (created.status !== 200) fail(`signup status ${created.status}`);
    return cookies;
  }
  const signed = await request("/api/auth/sign-in/email", {
    method: "POST",
    cookies,
    json: { email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
  });
  if (signed.status !== 200) {
    fail("signup is closed and the verify account cannot sign in. Use an empty sandbox.");
  }
  return cookies;
}

async function driveSignup() {
  assertOurServer();
  const lines = [];
  const cookies = new Map();
  const page = await request("/signup");
  lines.push(`signup page status ${page.status}`);
  lines.push(`signup page has Create account ${page.text.includes("Create account") ? "yes" : "no"}`);
  if (page.status !== 200 || !page.text.includes("Create account")) {
    writeEvidence("signup", lines);
    fail("signup page is not usable");
  }
  const created = await request("/api/auth/sign-up/email", {
    method: "POST",
    cookies,
    json: { name: "Verify", email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
  });
  lines.push(`signup status ${created.status}`);
  if (created.status !== 200) {
    writeEvidence("signup", lines);
    fail(`signup status ${created.status}`);
  }
  const home = await request("/", { cookies });
  lines.push(`home status ${home.status}`);
  lines.push(`home location ${home.location ?? "none"}`);
  const chatPath = home.location?.startsWith("http") ? new URL(home.location).pathname : home.location;
  if ((home.status !== 307 && home.status !== 302) || !chatPath?.startsWith("/c/")) {
    writeEvidence("signup", lines);
    fail("home did not redirect to a chat");
  }
  const chatPage = await request(chatPath, { cookies });
  lines.push(`chat page status ${chatPage.status}`);
  lines.push(`chat page has Message ${chatPage.text.includes("Message") ? "yes" : "no"}`);
  const listed = await request("/api/chats", { cookies });
  let count = 0;
  try {
    count = JSON.parse(listed.text).chats?.length ?? 0;
  } catch {
    count = 0;
  }
  lines.push(`chats status ${listed.status}`);
  lines.push(`chats count ${count}`);
  const loggedOut = await request("/api/chats");
  lines.push(`logged out chats status ${loggedOut.status}`);
  const dbPath = path.join(sandbox, "data", "orbit.db");
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  const users = sqlite.prepare("select count(*) as n from user").get().n;
  const chats = sqlite.prepare("select count(*) as n from chats").get().n;
  sqlite.close();
  lines.push(`db users ${users}`);
  lines.push(`db chats ${chats}`);
  const again = await request("/api/auth/sign-up/email", {
    method: "POST",
    json: { name: "Other", email: "other@orbit.local", password: VERIFY_PASSWORD },
  });
  lines.push(`second signup status ${again.status}`);
  writeEvidence("signup", lines);
  if (chatPage.status !== 200 || !chatPage.text.includes("Message")) fail("chat page missing composer");
  if (listed.status !== 200 || count < 1) fail("chat list empty");
  if (loggedOut.status !== 401) fail(`logged out chats status ${loggedOut.status}`);
  if (users !== 1 || chats < 1) fail(`db users ${users} chats ${chats}`);
  if (again.status !== 403) fail(`second signup status ${again.status}`);
  console.log("drive signup passed");
}

async function driveSettings() {
  assertOurServer();
  const cookies = await signInVerify();
  const page = await request("/settings", { cookies });
  const saved = await request("/api/settings", {
    method: "PUT",
    cookies,
    json: {
      baseUrl: "https://example.com/v1",
      apiKey: FAKE_KEY,
      model: "example-model",
      reasoningEffort: "low",
    },
  });
  const savedBody = JSON.parse(saved.text);
  const read = await request("/api/settings", { cookies });
  const readBody = JSON.parse(read.text);
  const changed = await request("/api/settings", {
    method: "PUT",
    cookies,
    json: {
      baseUrl: "https://other.example/v1",
      model: "example-model",
      reasoningEffort: "low",
    },
  });
  let changedError = "";
  try {
    changedError = JSON.parse(changed.text).error ?? "";
  } catch {
    changedError = "";
  }
  const labels = ["Base URL", "API key", "Model", "Save"];
  const pageHasLabels = labels.every((label) => page.text.includes(label));
  const lines = [
    `settings page status ${page.status}`,
    `settings page has labels ${pageHasLabels ? "yes" : "no"}`,
    `save status ${saved.status}`,
    `save has apiKey ${Object.prototype.hasOwnProperty.call(savedBody, "apiKey") ? "yes" : "no"}`,
    `save keySet ${savedBody.keySet === true ? "yes" : "no"}`,
    `save baseUrl ${savedBody.baseUrl ?? "none"}`,
    `save model ${savedBody.model ?? "none"}`,
    `save reasoningEffort ${savedBody.reasoningEffort ?? "none"}`,
    `read status ${read.status}`,
    `read has apiKey ${Object.prototype.hasOwnProperty.call(readBody, "apiKey") ? "yes" : "no"}`,
    `read keySet ${readBody.keySet === true ? "yes" : "no"}`,
    `read baseUrl ${readBody.baseUrl ?? "none"}`,
    `read model ${readBody.model ?? "none"}`,
    `read reasoningEffort ${readBody.reasoningEffort ?? "none"}`,
    `read contains key text ${read.text.includes(FAKE_KEY) ? "yes" : "no"}`,
    `base change without key status ${changed.status}`,
    `base change without key error ${changedError || "none"}`,
  ];
  writeEvidence("settings", lines);
  if (page.status !== 200 || !pageHasLabels) fail("settings page missing status or labels");
  if (
    saved.status !== 200 ||
    savedBody.keySet !== true ||
    savedBody.baseUrl !== "https://example.com/v1" ||
    savedBody.model !== "example-model" ||
    savedBody.reasoningEffort !== "low"
  ) {
    fail("settings save did not return the saved public values");
  }
  if (
    read.status !== 200 ||
    readBody.keySet !== true ||
    readBody.baseUrl !== "https://example.com/v1" ||
    readBody.model !== "example-model" ||
    readBody.reasoningEffort !== "low"
  ) {
    fail("settings read did not return the saved public values");
  }
  if ("apiKey" in savedBody || "apiKey" in readBody || read.text.includes(FAKE_KEY)) fail("settings leaked the key");
  if (changed.status !== 400 || !changedError.toLowerCase().includes("api key")) {
    fail(`base URL change without a key returned ${changed.status}`);
  }
  console.log("drive settings passed");
}

function countUsers() {
  const dbPath = path.join(sandbox, "data", "orbit.db");
  if (!fs.existsSync(dbPath)) return [];
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = sqlite.prepare("select email from user").all();
  sqlite.close();
  return rows.map((row) => row.email);
}

async function driveSignin() {
  assertOurServer();
  const setup = await request("/api/setup");
  if (JSON.parse(setup.text).signupOpen === true) fail("no account yet. Run drive signup first.");
  const page = await request("/login");
  const cookies = new Map();
  const signed = await request("/api/auth/sign-in/email", {
    method: "POST",
    cookies,
    json: { email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
  });
  const home = await request("/", { cookies });
  const lines = [
    `login page status ${page.status}`,
    `login page has Sign in ${page.text.includes("Sign in") ? "yes" : "no"}`,
    `signin status ${signed.status}`,
    `home status ${home.status}`,
    `home location ${home.location ?? "none"}`,
  ];
  writeEvidence("signin", lines);
  if (page.status !== 200 || !page.text.includes("Sign in")) fail("login page missing Sign in");
  if (signed.status !== 200) fail(`signin status ${signed.status}`);
  const location = home.location ?? "";
  if ((home.status !== 307 && home.status !== 302) || !location.includes("/c/")) fail("signed-in home did not open a chat");
  console.log("drive signin passed");
}

async function driveChat() {
  assertOurServer();
  const baseUrl = process.env.ORBIT_BASE_URL?.trim();
  const apiKey = process.env.ORBIT_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    fail("ORBIT_BASE_URL and ORBIT_API_KEY are required. The chat drive calls the provider.");
  }
  const emails = countUsers();
  if (emails.length > 0 && emails.some((email) => email !== "smoke@orbit.local")) {
    fail("this sandbox already has a user other than smoke@orbit.local. Chat smoke needs the first account. Use an empty sandbox.");
  }
  const child = spawn("npx", ["tsx", path.join(repoRoot, "scripts/smoke.ts")], {
    cwd: sandbox,
    env: { ...process.env, ORBIT_BASE_URL: baseUrl, ORBIT_API_KEY: apiKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const text = redact(output);
  writeEvidence("chat", [`exit ${code}`, text.trim()]);
  process.stdout.write(text);
  if (code !== 0) fail(`smoke exit ${code}`);
  console.log("drive chat passed");
}

const command = process.argv[2];
const feature = process.argv[3];

if (command === "launch") {
  await launch();
} else if (command === "doctor") {
  await doctor();
} else if (command === "cleanup") {
  await cleanup();
} else if (command === "drive" && feature === "signup") {
  await driveSignup();
} else if (command === "drive" && feature === "signin") {
  await driveSignin();
} else if (command === "drive" && feature === "settings") {
  await driveSettings();
} else if (command === "drive" && feature === "chat") {
  await driveChat();
} else {
  fail("usage: verify.mjs launch | doctor | cleanup | drive signup | drive signin | drive settings | drive chat");
}
