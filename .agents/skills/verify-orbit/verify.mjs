#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const PORT = 3210;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MOCK_PORT = 3299;
const MOCK_MODEL = "mock-genui";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const verifyDir = path.join(repoRoot, ".verify");
const sandbox = path.join(verifyDir, "sandbox");
const statePath = path.join(verifyDir, "server.json");
const logPath = path.join(verifyDir, "server.log");
const mockStatePath = path.join(verifyDir, "mock.json");
const mockLogPath = path.join(verifyDir, "mock.log");
const mockScript = path.join(repoRoot, "scripts/qa/mock-provider.mjs");
const scenarioDir = path.join(scriptDir, "scenarios");
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

// A launch killed mid-write leaves a truncated file. Treat it as no state so cleanup still runs.
function readState(file = statePath) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

function listenerPids(port = PORT) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
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
    retryAfter: Number(response.headers.get("x-retry-after")) || 0,
    text: await response.text(),
  };
}

async function waitReady() {
  const deadline = Date.now() + 45_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      // The sandbox server listens on loopback, so plain http is intended.
      const response = await fetch(`${ORIGIN}/api/setup`); // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
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

async function launch({ mock }) {
  const state = readState();
  if (state && alive(state.pid) && procCwd(state.pid) === sandbox) {
    const sandboxEnabled = process.env.ORBIT_SANDBOX === "on";
    if (state.sandboxEnabled !== sandboxEnabled) {
      const runningMode = typeof state.sandboxEnabled === "boolean" ? state.sandboxEnabled ? "on" : "off" : "unknown";
      fail(`sandbox mode mismatch. Running=${runningMode} requested=${sandboxEnabled ? "on" : "off"}. Run node .agents/skills/verify-orbit/verify.mjs cleanup, then launch again with ORBIT_SANDBOX=${sandboxEnabled ? "on" : "off"}.`);
    }
    const ollamaUrl = process.env.ORBIT_OLLAMA_URL ?? "";
    if ((state.ollamaUrl ?? "") !== ollamaUrl) {
      fail(`ollama url mismatch. Run node .agents/skills/verify-orbit/verify.mjs cleanup, then launch again.`);
    }
    if ((state.publicUrl ?? "") !== publicUrlEnv()) {
      fail(`public url mismatch. Run node .agents/skills/verify-orbit/verify.mjs cleanup, then launch again.`);
    }
    console.log(`already starting or running pid=${state.pid} origin=${ORIGIN}`);
  } else {
    await startServer();
  }
  if (mock) await startMock();
}

function publicUrlEnv() {
  return process.env.ORBIT_PUBLIC_URL?.trim() ?? "";
}

async function startServer() {
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
  const sandboxEnabled = process.env.ORBIT_SANDBOX === "on";
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
      ORBIT_SANDBOX: sandboxEnabled ? "on" : "off",
      DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
      ...(process.env.ORBIT_OLLAMA_URL ? { ORBIT_OLLAMA_URL: process.env.ORBIT_OLLAMA_URL } : {}),
      ...(publicUrlEnv() ? { ORBIT_PUBLIC_URL: publicUrlEnv() } : {}),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(statePath, JSON.stringify({ pid: child.pid, port: PORT, sandbox, origin: ORIGIN, sandboxEnabled, ollamaUrl: process.env.ORBIT_OLLAMA_URL ?? "", publicUrl: publicUrlEnv() }, null, 2));
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

async function startMock() {
  const state = readState(mockStatePath);
  if (state && alive(state.pid) && listenerPids(MOCK_PORT).includes(state.pid)) {
    console.log(`mock already running pid=${state.pid}`);
  } else {
    const listeners = listenerPids(MOCK_PORT);
    if (listeners.length > 0) {
      fail(`port ${MOCK_PORT} is in use by pid ${listeners[0]} cwd ${procCwd(listeners[0]) || "unknown"}. Stop it before launch --mock.`);
    }
    const logFd = fs.openSync(mockLogPath, "w");
    const child = spawn(process.execPath, [mockScript], {
      env: { PATH: process.env.PATH ?? "", MOCK_PORT: String(MOCK_PORT), MOCK_MODEL },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    fs.writeFileSync(mockStatePath, JSON.stringify({ pid: child.pid, port: MOCK_PORT }, null, 2));
    const deadline = Date.now() + 10_000;
    while (!listenerPids(MOCK_PORT).includes(child.pid)) {
      if (Date.now() > deadline) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The child already exited.
        }
        fail(`mock provider did not listen on ${MOCK_PORT}. Log: ${mockLogPath}`);
      }
      await sleep(100);
    }
    console.log(`mock ready pid=${child.pid} base=http://127.0.0.1:${MOCK_PORT}/v1 model=${MOCK_MODEL}`);
  }
  const cookies = await signInVerify();
  const saved = await request("/api/settings", {
    method: "PUT",
    cookies,
    json: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: FAKE_KEY, model: MOCK_MODEL, reasoningEffort: "low" },
  });
  const body = JSON.parse(saved.text);
  if (saved.status !== 200 || body.model !== MOCK_MODEL || body.keySet !== true) {
    fail(`saving mock settings returned ${saved.status}`);
  }
  console.log(`settings baseUrl=${body.baseUrl} model=${body.model} keySet=yes`);
}

async function stopMock() {
  const state = readState(mockStatePath);
  if (!state) return;
  let cmdline = "";
  try {
    cmdline = fs.readFileSync(`/proc/${state.pid}/cmdline`, "utf8");
  } catch {
    // The mock already exited.
  }
  if (cmdline) {
    if (!cmdline.includes(mockScript)) fail(`pid ${state.pid} is not the mock provider. Not killing it.`);
    process.kill(-state.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (alive(state.pid) && Date.now() < deadline) await sleep(100);
    if (alive(state.pid)) process.kill(-state.pid, "SIGKILL");
  }
  fs.rmSync(mockStatePath, { force: true });
  fs.rmSync(mockLogPath, { force: true });
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
  // The sandbox server listens on loopback, so plain http is intended.
  return fetch(`${ORIGIN}/api/setup`).then(async (response) => { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
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
  if (!state) {
    const orphans = listenerPids().filter((pid) => procCwd(pid) === sandbox);
    if (orphans.length > 0) fail(`server.json is missing or unreadable, but pid ${orphans.join(", ")} still serves the sandbox. Stop it, then run cleanup again.`);
    return;
  }
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
  await stopMock();
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
  // better-auth allows 3 sign-ins per 10 seconds, and back-to-back browse runs reach that.
  let signed = { status: 429, retryAfter: 0 };
  for (let attempt = 0; attempt < 3 && signed.status === 429; attempt += 1) {
    if (attempt > 0) await sleep((signed.retryAfter || 10) * 1000);
    signed = await request("/api/auth/sign-in/email", {
      method: "POST",
      cookies,
      json: { email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
    });
  }
  if (signed.status !== 200) {
    fail(`sign-in status ${signed.status}. Signup is closed and the verify account cannot sign in. Use an empty sandbox.`);
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
  lines.push(`chat page has Ask anything ${chatPage.text.includes("Ask anything") ? "yes" : "no"}`);
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
  if (chatPage.status !== 200 || !chatPage.text.includes("Connect a provider")) fail("chat page does not show the provider form");
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

function chromePath() {
  const system = "/usr/bin/google-chrome";
  return fs.existsSync(system) ? system : undefined;
}

async function browse(scenario) {
  if (!scenario || !/^[a-z-]+$/.test(scenario)) fail("usage: verify.mjs browse <scenario>");
  const scenarioPath = path.join(scenarioDir, `${scenario}.mjs`);
  if (!fs.existsSync(scenarioPath)) fail(`no scenario at ${scenarioPath}`);
  assertOurServer();
  await doctor();
  const cookies = await signInVerify();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(
    [...cookies.entries()].map(([name, value]) => ({ name, value, url: ORIGIN, httpOnly: true, sameSite: "Lax" })),
  );
  const page = await context.newPage();
  const evidence = path.join(evidenceRoot, scenario);
  fs.rmSync(evidence, { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
  const lines = [];
  let failed = 0;
  const step = (name, ok, detail = "") => {
    const line = ok ? `PASS ${name}` : `FAIL ${name}: ${detail}`;
    if (!ok) failed += 1;
    lines.push(line);
    console.log(line);
    return ok;
  };
  const shot = async (name, target = page) => {
    const file = path.join(evidence, `${name}.png`);
    await target.screenshot({ path: file });
    console.log(`shot ${path.relative(repoRoot, file)}`);
  };
  try {
    const run = (await import(scenarioPath)).default;
    await run({ page, origin: ORIGIN, step, shot });
  } catch (error) {
    step("scenario finished", false, redact(error instanceof Error ? error.message.split("\n")[0] : String(error)));
    await shot("error").catch(() => {});
  } finally {
    await browser.close();
  }
  writeEvidence(scenario, lines);
  if (failed > 0) fail(`browse ${scenario} failed ${failed} step(s)`);
  console.log(`browse ${scenario} passed`);
}

const DREAM_FACTS = ["I live in Lisbon", "I prefer dark mode", "My bike is blue"];

function localDreamDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function openSandboxDb() {
  const dbPath = path.join(sandbox, "data", "orbit.db");
  if (!fs.existsSync(dbPath)) fail(`sandbox database is missing at ${dbPath}`);
  const database = new Database(dbPath);
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

function seedDreamChats(database, userId) {
  let createdAt = Date.now() - 5_000;
  if (localDreamDate(new Date(createdAt)) !== localDreamDate()) createdAt = Date.now();
  const insertChat = database.prepare(
    "INSERT INTO chats (id, user_id, head_id, title, created_at, updated_at) VALUES (?, ?, ?, 'New chat', ?, ?)",
  );
  const insertMessage = database.prepare(
    "INSERT INTO messages (id, chat_id, parent_id, role, content, parts, position, created_at) VALUES (?, ?, NULL, 'user', ?, ?, 0, ?)",
  );
  const run = database.transaction(() => {
    for (const text of DREAM_FACTS) {
      const chatId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      insertChat.run(chatId, userId, messageId, createdAt, createdAt);
      insertMessage.run(messageId, chatId, text, JSON.stringify([{ type: "text", text }]), createdAt);
    }
  });
  run();
}

function dreamSnapshot(database, date) {
  const memories = database.prepare("SELECT count(*) AS n FROM memories").get().n;
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_runs'").get();
  if (!table) return { memories, run: null };
  const run = database
    .prepare(
      `SELECT date, state, added, merged, error, chat_ids AS chatIds, done_chat_ids AS doneChatIds, retry_chat_ids AS retryChatIds
       FROM memory_runs WHERE date = ?`,
    )
    .get(date);
  return { memories, run: run ?? null };
}

function formatDreamSnapshot(snapshot) {
  if (!snapshot.run) return `memories ${snapshot.memories}\nrun none`;
  const run = snapshot.run;
  const chats = JSON.parse(run.chatIds).length;
  const done = JSON.parse(run.doneChatIds).length;
  const retry = JSON.parse(run.retryChatIds).length;
  return `date=${run.date} state=${run.state} chats=${chats} done=${done} retry=${retry} added=${run.added} merged=${run.merged} memories=${snapshot.memories} error=${run.error ?? ""}`;
}

function runDreamCli(ollamaUrl) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "dream"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ORBIT_DATA_DIR: path.join(sandbox, "data"),
        ...(ollamaUrl ? { ORBIT_OLLAMA_URL: ollamaUrl } : {}),
        ...(readState(mockStatePath) ? { ORBIT_QA_TAGS: "1" } : {}),
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function startDriveOllama() {
  if (process.env.ORBIT_OLLAMA_URL) return { url: process.env.ORBIT_OLLAMA_URL, stop: async () => {} };
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts/qa/mock-ollama.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("mock ollama did not listen")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = /mock-ollama port=(\d+)/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock ollama exited ${code ?? "null"}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

async function shotMemory(cookies, name, viewport) {
  const { chromium } = await import("playwright");
  const executablePath = chromePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const context = await browser.newContext({ viewport });
    await context.addCookies(
      [...cookies.entries()].map(([cookieName, value]) => ({
        name: cookieName,
        value,
        url: ORIGIN,
        httpOnly: true,
        sameSite: "Lax",
      })),
    );
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/memory`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Memory" }).first().waitFor();
    const dir = path.join(evidenceRoot, "dreaming");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${path.relative(repoRoot, file)}`);
  } finally {
    await browser.close();
  }
}

async function driveDream() {
  assertOurServer();
  const date = localDreamDate();
  const database = openSandboxDb();
  const user = database.prepare("SELECT id FROM user LIMIT 1").get();
  if (!user) {
    database.close();
    fail("no user in the sandbox. Run launch --mock first.");
  }
  const before = dreamSnapshot(database, date);
  const lines = [`before ${formatDreamSnapshot(before).replaceAll("\n", " | ")}`];
  if (!before.run) seedDreamChats(database, user.id);
  database.close();
  const ollama = await startDriveOllama();
  try {
    const cookies = await signInVerify();
    if (!before.run) await shotMemory(cookies, "before", { width: 1280, height: 800 });
    const result = await runDreamCli(ollama.url);
    lines.push(`dream exit ${result.code}`);
    const afterDb = openSandboxDb();
    const after = dreamSnapshot(afterDb, date);
    afterDb.close();
    const summary = formatDreamSnapshot(after);
    lines.push(summary);
    console.log(summary);
    writeEvidence("dreaming", lines);
    if (result.code !== 0 || !after.run || after.run.state !== "done") fail(`drive dream failed. ${summary}`);
    if (!before.run && after.run.added === 0) fail(`drive dream added nothing. ${summary}`);
    await shotMemory(cookies, "after", { width: 1280, height: 800 });
    await shotMemory(cookies, "mobile", { width: 390, height: 844 });
    console.log("drive dream passed");
  } finally {
    await ollama.stop();
  }
}

// Plain fetch, so no Access cookie rides along. A DNS or TLS failure is recorded as an error, not a status.
async function probePublic(url) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    await response.body?.cancel();
    return { status: response.status, location: response.headers.get("location") ?? "" };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { status: 0, location: "", error: cause?.code ?? (cause instanceof Error ? cause.message : String(cause)) };
  }
}

// Status 0 is a network error, so only a real HTTP status counts as an answer.
function answered(probe) {
  return probe.status >= 200;
}

function isAccessLogin(location) {
  try {
    const host = new URL(location).hostname;
    return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

async function localBrowserSignin(lines) {
  const { chromium } = await import("playwright");
  const executablePath = chromePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(VERIFY_EMAIL);
    await page.getByLabel("Password").fill(VERIFY_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    let chatPath = "";
    try {
      await page.waitForURL((url) => url.pathname.startsWith("/c/"), { timeout: 15_000 });
      chatPath = new URL(page.url()).pathname;
    } catch {
      chatPath = "";
    }
    lines.push(`local signin landed ${chatPath || new URL(page.url()).pathname}`);
    const cookies = await context.cookies(ORIGIN);
    for (const cookie of cookies.filter((entry) => entry.name.includes("session_token"))) {
      lines.push(`local session cookie ${cookie.name} secure=${cookie.secure ? "yes" : "no"}`);
    }
    const settings = await page.goto(`${ORIGIN}/settings`, { waitUntil: "domcontentloaded" });
    const settingsPath = new URL(page.url()).pathname;
    const hasLabels = settingsPath === "/settings" && (await page.getByText("Base URL").count()) > 0;
    lines.push(`local settings status ${settings?.status() ?? 0} path ${settingsPath}`);
    lines.push(`local settings has Base URL ${hasLabels ? "yes" : "no"}`);
    const dir = path.join(evidenceRoot, "public");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "local-settings.png");
    await page.screenshot({ path: file });
    console.log(`shot ${path.relative(repoRoot, file)}`);
    return chatPath !== "" && settings?.status() === 200 && hasLabels;
  } finally {
    await browser.close();
  }
}

async function drivePublic() {
  assertOurServer();
  const publicUrl = readState()?.publicUrl ?? "";
  if (!publicUrl) {
    fail("the sandbox server has no ORBIT_PUBLIC_URL. Run cleanup, then launch with ORBIT_PUBLIC_URL set.");
  }
  const base = publicUrl.replace(/\/+$/, "");
  const lines = [`public url ${base}`];
  const root = await probePublic(`${base}/`);
  lines.push(`public root status ${root.status}${root.error ? ` error ${root.error}` : ""}`);
  lines.push(`public root location ${root.location || "none"}`);
  // No DNS answer, a TLS failure, or Cloudflare's 530 for a tunnel with no connector.
  const tunnelUp = answered(root) && root.status !== 530;
  const rootOk = root.status === 302 && isAccessLogin(root.location);
  let apiFailure = "";
  if (tunnelUp) {
    const api = await probePublic(`${base}/api/chats`);
    lines.push(`public api/chats status ${api.status}${api.error ? ` error ${api.error}` : ""}`);
    if (!answered(api)) apiFailure = `public api/chats got no HTTP response${api.error ? `, error ${api.error}` : ""}`;
    else if (api.status === 200) apiFailure = "public api/chats answered 200 without Access";
  } else {
    lines.push("public checks skipped, the tunnel is not up");
  }
  // Create the verify account when the sandbox is empty, then sign in from a fresh browser.
  if (JSON.parse((await request("/api/setup")).text).signupOpen === true) await signInVerify();
  const localOk = await localBrowserSignin(lines);
  writeEvidence("public", lines);
  for (const line of lines) console.log(line);
  if (tunnelUp && !rootOk) fail(`public root did not answer 302 to cloudflareaccess.com. status ${root.status}`);
  if (apiFailure) fail(apiFailure);
  if (!localOk) fail(`local sign-in at ${ORIGIN} did not open a protected page`);
  console.log(tunnelUp ? "drive public passed" : "drive public passed local sign-in and skipped the public checks");
}

const command = process.argv[2];
const feature = process.argv[3];

if (command === "launch") {
  await launch({ mock: process.argv.includes("--mock") });
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
} else if (command === "drive" && feature === "dream") {
  await driveDream();
} else if (command === "drive" && feature === "public") {
  await drivePublic();
} else if (command === "browse") {
  await browse(feature);
} else {
  fail("usage: verify.mjs launch [--mock] | doctor | cleanup | drive signup | drive signin | drive settings | drive chat | drive dream | drive public | browse <scenario>");
}
