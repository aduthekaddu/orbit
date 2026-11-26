import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { eventually as waitUntil } from "./eventually.mjs";

// These tests copy verify.mjs, ci-e2e.sh, the mocks and src/lib/sandbox/owner.mjs into a scratch checkout and run them.
// A stub app stands in for Orbit, so no build is needed. Reverting any of those scripts to fixed ports turns a test here red.
// verify.mjs imports owner.mjs, so a checkout that omits it fails every launch and cleanup that loads verify.mjs.

const repo = process.cwd();

const STUB_APP = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const putLog = path.join(process.cwd(), "..", "put.jsonl");
if (process.argv.includes("--pause-before-bind")) {
  await new Promise((resolve) => {
    const gate = fs.watch("../..", (_event, file) => {
      if (file !== "release-bind") return;
      gate.close();
      resolve();
    });
    fs.writeFileSync("../../before-bind", "");
  });
}
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/setup") return res.end(JSON.stringify({ signupOpen: true }));
      if (req.url === "/api/auth/sign-up/email") return res.end("{}");
      if (req.url === "/api/settings" && req.method === "PUT") {
        const saved = JSON.parse(body);
        fs.appendFileSync(putLog, JSON.stringify(saved) + "\\n");
        return res.end(JSON.stringify({ baseUrl: saved.baseUrl, model: saved.model, keySet: true }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  })
  .listen(port, "127.0.0.1");
`;

// Stands in for verify.mjs in the ci-e2e.sh tests. On launch it records the Ollama URL the script exported and whether it answers.
const STUB_VERIFY = `
import fs from "node:fs";
if (process.argv[2] === "launch") {
  const url = process.env.ORBIT_OLLAMA_URL;
  const answer = await fetch(url + "/qa/received").then((response) => response.status, (error) => error.cause?.code ?? error.message);
  fs.mkdirSync(".verify", { recursive: true });
  fs.appendFileSync(".verify/ollama-seen.txt", url + " " + answer + "\\n");
  if (process.env.STUB_HOLD) await new Promise(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
`;

type Result = { code: number | null; out: string };
type TrackedChild = { child: ChildProcess; done: Promise<Result>; detached: boolean };

const checkouts: Checkout[] = [];
const spawned: TrackedChild[] = [];
const usedPorts = new Set<number>();

function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; detached?: boolean }): TrackedChild {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(command, args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, detached: options.detached, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const done = new Promise<Result>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    child.once("close", finish);
    child.once("error", (error) => {
      out += String(error);
      finish(null);
    });
  });
  const tracked: TrackedChild = { child, done, detached: Boolean(options.detached) };
  spawned.push(tracked);
  return tracked;
}

function readRange(): [number, number] {
  const [low, high] = fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
  return [low, high];
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// verify.mjs refuses an app port inside the OS's automatic range, so the stub app needs a port outside it.
async function appPort(): Promise<number> {
  const [low, high] = readRange();
  const start = 3300 + Math.floor(Math.random() * 100);
  for (let port = start; port < start + 150; port += 1) {
    if (port >= low && port <= high) continue;
    if (usedPorts.has(port) || !(await canBind(port))) continue;
    usedPorts.add(port);
    return port;
  }
  throw new Error(`no free port outside ${low}-${high} from ${start}`);
}

function status(port: number, urlPath: string): Promise<number | string> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, ms = 5_000): Promise<T> {
  return waitUntil(read, accept, { timeoutMs: ms, intervalMs: 25, what });
}

function procEntries(): string[] {
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
}

function pidsUnder(dir: string): number[] {
  const pids: number[] = [];
  for (const entry of procEntries()) {
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline = "";
    let cwd = "";
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue;
    }
    if (cmdline.includes(dir) || cwd.startsWith(dir)) pids.push(pid);
  }
  return pids;
}

class Checkout {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-qa-checkout-"));
  port = 0;

  constructor(options: { stubVerify?: boolean; pauseBeforeBind?: boolean } = {}) {
    for (const file of [
      ".agents/skills/verify-orbit/verify.mjs",
      "scripts/qa/mock-provider.mjs",
      "scripts/qa/mock-ollama.mjs",
      "scripts/qa/ci-e2e.sh",
      "src/lib/sandbox/owner.mjs",
    ]) {
      fs.mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
      fs.copyFileSync(path.join(repo, file), path.join(this.dir, file));
    }
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(this.dir, "node_modules"));
    fs.mkdirSync(path.join(this.dir, ".next"));
    fs.writeFileSync(path.join(this.dir, "stub-app.mjs"), STUB_APP);
    const start = ["node", path.join(this.dir, "stub-app.mjs")];
    if (options.pauseBeforeBind) start.push("--pause-before-bind");
    fs.writeFileSync(path.join(this.dir, "package.json"), JSON.stringify({ scripts: { start: start.join(" ") } }));
    if (options.stubVerify) {
      fs.writeFileSync(path.join(this.dir, ".agents/skills/verify-orbit/verify.mjs"), STUB_VERIFY);
      fs.mkdirSync(path.join(this.dir, ".agents/skills/verify-orbit/scenarios"), { recursive: true });
      fs.writeFileSync(path.join(this.dir, ".agents/skills/verify-orbit/scenarios/one.mjs"), "");
    }
    checkouts.push(this);
  }

  async verify(args: string[]): Promise<Result> {
    this.port ||= await appPort();
    return this.verifyStarted(args).done;
  }

  verifyStarted(args: string[]) {
    return run(process.execPath, [path.join(this.dir, ".agents/skills/verify-orbit/verify.mjs"), ...args], {
      cwd: this.dir,
      env: { ORBIT_VERIFY_PORT: String(this.port), ORBIT_MOCK_BASE_URL: undefined },
    });
  }

  record(): { pid: number; startTime: string; port: number } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, ".verify/mock.json"), "utf8"));
    } catch {
      return null;
    }
  }

  savedBaseUrls(): string[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, ".verify/put.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).baseUrl);
    } catch {
      return [];
    }
  }

  mockBase(env: Record<string, string | undefined> = {}): Promise<Result> {
    const script = "Promise.resolve().then(() => require(process.argv[1]).mockBase()).then(console.log, (e) => { console.error(e.message); process.exit(1); })";
    return run(process.execPath, ["-e", script, path.join(repo, "scripts/qa/genui-qa.cjs")], { cwd: this.dir, env: { ORBIT_MOCK_BASE_URL: undefined, ...env } }).done;
  }
}

function procStartTime(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const [state, ...rest] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return state === "Z" || state === "X" ? "" : (rest[18] ?? "");
  } catch {
    return "";
  }
}

function killPid(pid: number, group = false) {
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function stopProcessesUnder(dir: string) {
  const killed = new Map<number, string>();
  await eventually(
    () => {
      for (const pid of pidsUnder(dir)) {
        const started = procStartTime(pid);
        if (!started) continue;
        killed.set(pid, started);
        killPid(pid);
      }
      for (const [pid, started] of killed) {
        if (procStartTime(pid) !== started) killed.delete(pid);
      }
      const remaining = new Set(killed.keys());
      for (const pid of pidsUnder(dir)) {
        if (procStartTime(pid)) remaining.add(pid);
      }
      return [...remaining];
    },
    (remaining) => remaining.length === 0,
    `fixture processes under ${dir} stopped`,
  );
}

async function teardown(targets: Checkout[], children: TrackedChild[]) {
  const pendingChildren = new Map<number, string>();
  for (const { child, detached } of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    const started = procStartTime(child.pid);
    if (started) pendingChildren.set(child.pid, started);
    if (detached) killPid(child.pid, true);
    killPid(child.pid);
  }
  if (pendingChildren.size > 0) {
    await eventually(
      () => {
        for (const [pid, started] of pendingChildren) {
          if (procStartTime(pid) !== started) pendingChildren.delete(pid);
        }
        return [...pendingChildren.keys()];
      },
      (remaining) => remaining.length === 0,
      "tracked children stopped",
    );
  }
  for (const checkout of targets) {
    if (checkout.port && fs.existsSync(checkout.dir)) {
      await run(process.execPath, [path.join(checkout.dir, ".agents/skills/verify-orbit/verify.mjs"), "cleanup"], {
        cwd: checkout.dir,
        env: { ORBIT_VERIFY_PORT: String(checkout.port) },
      }).done.catch(() => {});
    }
    await stopProcessesUnder(checkout.dir);
  }
  await Promise.all(children.map((entry) => entry.done));
  for (const checkout of targets) {
    fs.rmSync(checkout.dir, { recursive: true, force: true });
  }
}

after(async () => {
  await teardown(checkouts, spawned);
});

test("two checkouts launching on one port report ready only for the server that owns it", async () => {
  const paused = new Checkout({ pauseBeforeBind: true });
  const contender = new Checkout();
  paused.port = contender.port = await appPort();

  const first = paused.verifyStarted(["launch"]);
  await eventually(() => fs.existsSync(path.join(paused.dir, "before-bind")), Boolean, "first server reached bind", 10_000);
  const second = await contender.verify(["launch"]);
  fs.writeFileSync(path.join(paused.dir, "release-bind"), "");

  const attempts = [
    { checkout: paused, result: await first.done },
    { checkout: contender, result: second },
  ];
  const output = attempts.map(({ result }) => `exit ${result.code}: ${result.out.trim()}`).join("\n");
  const winners = attempts.filter(({ result }) => result.code === 0);
  assert.equal(winners.length, 1, output);
  const [winner] = winners;
  assert.match(winner.result.out, /ready origin=/);
  const doctor = await winner.checkout.verify(["doctor"]);
  assert.equal(doctor.code, 0, doctor.out);
  const loser = attempts.find((attempt) => attempt !== winner);
  assert.ok(loser);
  assert.match(loser.result.out, /port .* in use/);
  assert.equal(fs.existsSync(path.join(loser.checkout.dir, ".verify/server.json")), false);
});

test("two checkouts that launch a mock at once each get their own mock, and cleanup stops it", async () => {
  const [a, b] = [new Checkout(), new Checkout()];
  const [first, second] = await Promise.all([a.verify(["launch", "--mock"]), b.verify(["launch", "--mock"])]);
  assert.equal(first.code, 0, first.out);
  assert.equal(second.code, 0, second.out);
  const ports = [a.record()?.port, b.record()?.port];
  assert.ok(ports[0] && ports[1], `records: ${ports}`);
  assert.notEqual(ports[0], ports[1]);
  for (const [checkout, port] of [[a, ports[0]], [b, ports[1]]] as const) {
    const base = `http://127.0.0.1:${port}/v1`;
    assert.deepEqual(checkout.savedBaseUrls(), [base]);
    assert.equal(await status(port, "/v1/models"), 200);
    const seen = await checkout.mockBase();
    assert.equal(seen.out.trim(), base, seen.out);
  }
  const [stopA, stopB] = await Promise.all([a.verify(["cleanup"]), b.verify(["cleanup"])]);
  assert.equal(stopA.code, 0, stopA.out);
  assert.equal(stopB.code, 0, stopB.out);
  for (const port of ports) assert.equal(await status(port as number, "/v1/models"), "ECONNREFUSED");
  assert.equal(a.record(), null);
});

test("two launches in one checkout at once share one mock", async () => {
  const checkout = new Checkout();
  const started = await checkout.verify(["launch"]);
  assert.equal(started.code, 0, started.out);
  const results = await Promise.all([checkout.verify(["launch", "--mock"]), checkout.verify(["launch", "--mock"])]);
  for (const result of results) assert.equal(result.code, 0, result.out);
  const port = checkout.record()?.port;
  assert.ok(port);
  assert.deepEqual(new Set(checkout.savedBaseUrls()), new Set([`http://127.0.0.1:${port}/v1`]));
  const mocks = pidsUnder(checkout.dir).filter((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("mock-provider.mjs"));
  assert.equal(mocks.length, 1, `mock providers: ${mocks}`);
});

test("three overlapping launches cannot reclaim a live mock record and orphan a provider", async () => {
  const checkout = new Checkout();
  const started = await checkout.verify(["launch"]);
  assert.equal(started.code, 0, started.out);

  const hookPath = path.join(checkout.dir, "race-hook.mjs");
  fs.writeFileSync(
    hookPath,
    `import fs from "node:fs";
import path from "node:path";
const dir = process.env.RACE_DIR;
const mockJson = path.join(dir, ".verify", "mock.json");
const origRead = fs.readFileSync;
const origRename = fs.renameSync;
let pausedRead = false;
let pausedRename = false;
function waitFor(file, timeoutMs) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(buf, 0, 0, 10);
}
fs.readFileSync = function (target, ...args) {
  let ok = false;
  let value;
  let caught;
  try {
    value = origRead.call(this, target, ...args);
    ok = true;
  } catch (error) {
    caught = error;
  }
  if (!pausedRead && String(target) === mockJson) {
    pausedRead = true;
    fs.writeFileSync(path.join(dir, ".verify", "a-read"), "");
    waitFor(path.join(dir, ".verify", "b-done"), 5_000);
  }
  if (ok) return value;
  throw caught;
};
fs.renameSync = function (from, to) {
  origRename.call(this, from, to);
  if (!pausedRename && String(from) === mockJson) {
    pausedRename = true;
    fs.writeFileSync(path.join(dir, ".verify", "a-moved"), "");
    waitFor(path.join(dir, ".verify", "c-done"), 5_000);
  }
};
`,
  );

  const aRead = path.join(checkout.dir, ".verify", "a-read");
  const bDone = path.join(checkout.dir, ".verify", "b-done");
  const aMoved = path.join(checkout.dir, ".verify", "a-moved");
  const cDone = path.join(checkout.dir, ".verify", "c-done");

  const a = run(process.execPath, ["--import", hookPath, path.join(checkout.dir, ".agents/skills/verify-orbit/verify.mjs"), "launch", "--mock"], {
    cwd: checkout.dir,
    env: { ORBIT_VERIFY_PORT: String(checkout.port), ORBIT_MOCK_BASE_URL: undefined, RACE_DIR: checkout.dir },
  });
  let aExited = false;
  a.done.then(() => {
    aExited = true;
  });

  await eventually(() => fs.existsSync(aRead), Boolean, "first launch read mock.json", 5_000);
  const b = checkout.verifyStarted(["launch", "--mock"]);
  // Unserialized launches let b publish while a is paused; serialized launches make b wait on a's lock.
  await Promise.race([b.done, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  fs.writeFileSync(bDone, "");

  await eventually(() => aExited || fs.existsSync(aMoved), Boolean, "first launch finished or moved mock.json", 5_000);
  const c = checkout.verifyStarted(["launch", "--mock"]);
  await c.done;
  fs.writeFileSync(cDone, "");

  const results = await Promise.all([a.done, b.done, c.done]);
  for (const result of results) assert.equal(result.code, 0, result.out);

  const record = checkout.record();
  assert.ok(record?.port, `missing mock record: ${JSON.stringify(record)}`);
  const mockPids = () => pidsUnder(checkout.dir).filter((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("mock-provider.mjs"));
  assert.deepEqual(mockPids(), [record.pid], "only the recorded mock provider should run");
  assert.deepEqual(new Set(checkout.savedBaseUrls()), new Set([`http://127.0.0.1:${record.port}/v1`]));

  const stopped = await checkout.verify(["cleanup"]);
  assert.equal(stopped.code, 0, stopped.out);
  assert.deepEqual(mockPids(), [], "cleanup should stop every mock provider");
});

test("three overlapping launches over a stale mock record share one new mock", async () => {
  const checkout = new Checkout();
  const started = await checkout.verify(["launch"]);
  assert.equal(started.code, 0, started.out);
  fs.writeFileSync(path.join(checkout.dir, ".verify/mock.json"), JSON.stringify({ pid: 1, startTime: "stale", port: 1 }));
  const results = await Promise.all([
    checkout.verify(["launch", "--mock"]),
    checkout.verify(["launch", "--mock"]),
    checkout.verify(["launch", "--mock"]),
  ]);
  for (const result of results) assert.equal(result.code, 0, result.out);
  const record = checkout.record();
  assert.ok(record?.port && record.startTime !== "stale");
  const mockPids = () => pidsUnder(checkout.dir).filter((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("mock-provider.mjs"));
  assert.deepEqual(mockPids(), [record.pid]);
  assert.deepEqual(new Set(checkout.savedBaseUrls()), new Set([`http://127.0.0.1:${record.port}/v1`]));
});

async function startLegacyMock(checkout: Checkout): Promise<{ pid: number; port: number; tracked: TrackedChild }> {
  const mockScript = path.join(checkout.dir, "scripts/qa/mock-provider.mjs");
  const tracked = run(process.execPath, [mockScript], { cwd: checkout.dir, detached: true });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("legacy mock printed no ready line")), 5_000);
    tracked.child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const match = /^mock provider on http:\/\/127\.0\.0\.1:(\d+)\/v1 model=\S+$/.exec(buf.slice(0, nl));
      clearTimeout(timer);
      if (match) resolve(Number(match[1]));
      else reject(new Error(`unexpected legacy mock line: ${buf.slice(0, nl)}`));
    });
    tracked.done.then((res) => {
      clearTimeout(timer);
      reject(new Error(`legacy mock exited early (${res.code}): ${res.out}`));
    });
  });
  assert.ok(tracked.child.pid);
  return { pid: tracked.child.pid, port, tracked };
}

test("cleanup and launch --mock stop a live mock recorded in the previous pid-port format", async () => {
  const cleanupCheckout = new Checkout();
  const legacy = await startLegacyMock(cleanupCheckout);
  assert.equal(await status(legacy.port, "/v1/models"), 200);
  fs.mkdirSync(path.join(cleanupCheckout.dir, ".verify"), { recursive: true });
  fs.writeFileSync(path.join(cleanupCheckout.dir, ".verify/mock.json"), JSON.stringify({ pid: legacy.pid, port: legacy.port }));

  const cleaned = await cleanupCheckout.verify(["cleanup"]);
  assert.equal(cleaned.code, 0, cleaned.out);
  assert.equal(await status(legacy.port, "/v1/models"), "ECONNREFUSED", "cleanup stopped the legacy mock");
  assert.equal(cleanupCheckout.record(), null);
  await legacy.tracked.done;

  const launchCheckout = new Checkout();
  const started = await launchCheckout.verify(["launch"]);
  assert.equal(started.code, 0, started.out);
  const oldMock = await startLegacyMock(launchCheckout);
  assert.equal(await status(oldMock.port, "/v1/models"), 200);
  fs.writeFileSync(path.join(launchCheckout.dir, ".verify/mock.json"), JSON.stringify({ pid: oldMock.pid, port: oldMock.port }));

  const launched = await launchCheckout.verify(["launch", "--mock"]);
  assert.equal(launched.code, 0, launched.out);
  assert.equal(await status(oldMock.port, "/v1/models"), "ECONNREFUSED", "launch --mock stopped the legacy mock");
  await oldMock.tracked.done;
  const record = launchCheckout.record();
  assert.ok(record?.pid && record.startTime && record.port);
  const mockPids = pidsUnder(launchCheckout.dir).filter((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("mock-provider.mjs"));
  assert.deepEqual(mockPids, [record.pid]);
});

test("cleanup drops a foreign leftover mock record without killing the process, and still stops the server", async () => {
  const checkout = new Checkout();
  const started = await checkout.verify(["launch"]);
  const decoy = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: checkout.dir, detached: true });
  assert.ok(decoy.child.pid);
  try {
    assert.equal(started.code, 0, started.out);
    fs.writeFileSync(path.join(checkout.dir, ".verify/mock.json"), JSON.stringify({ pid: decoy.child.pid, port: 3299 }));
    const cleaned = await checkout.verify(["cleanup"]);
    assert.equal(cleaned.code, 0, cleaned.out);
    assert.match(cleaned.out, /not the mock provider/i);
    assert.match(cleaned.out, /cleanup done/i);
    assert.notEqual(procStartTime(decoy.child.pid), "", "decoy process stays alive");
    assert.equal(checkout.record(), null, "leftover record is dropped");
    assert.equal(fs.existsSync(path.join(checkout.dir, ".verify/server.json")), false, "server record is removed");
    assert.equal(fs.existsSync(path.join(checkout.dir, ".verify/sandbox")), false, "sandbox is removed");
  } finally {
    killPid(decoy.child.pid, true);
    await decoy.done;
  }

  const afterExit = await checkout.verify(["cleanup"]);
  assert.equal(afterExit.code, 0, afterExit.out);
  assert.equal(checkout.record(), null);
});

test("a launch stopped while its mock starts leaves no mock without a record", async () => {
  const checkout = new Checkout();
  const started = await checkout.verify(["launch"]);
  assert.equal(started.code, 0, started.out);
  const launch = checkout.verifyStarted(["launch", "--mock"]);
  await eventually(() => fs.existsSync(path.join(checkout.dir, ".verify/mock.log")), Boolean, "mock.log appears", 10_000);
  launch.child.kill("SIGTERM");
  await launch.done;
  const mockProcesses = () => pidsUnder(checkout.dir).filter((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("mock-provider.mjs"));
  const record = checkout.record();
  if (record) {
    assert.deepEqual(mockProcesses(), [record.pid], "the recorded mock is the only one");
  } else {
    await eventually(mockProcesses, (pids) => pids.length === 0, "mock providers without a record");
  }
});

test("cleanup treats a zombie named in the mock record as stopped", async () => {
  const checkout = new Checkout();
  const parent = run("sh", ["-c", "sleep 0 & echo $!; exec sleep 60"], { cwd: checkout.dir });
  try {
    const zombie = await new Promise<number>((resolve) => {
      parent.child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    const stat = () => fs.readFileSync(`/proc/${zombie}/stat`, "utf8");
    await eventually(stat, (text) => text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3) === "Z", "the child is a zombie");
    const text = stat();
    const startTime = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
    fs.mkdirSync(path.join(checkout.dir, ".verify"), { recursive: true });
    fs.writeFileSync(path.join(checkout.dir, ".verify/mock.json"), JSON.stringify({ pid: zombie, startTime, port: 1 }));
    const started = Date.now();
    const result = await checkout.verify(["cleanup"]);
    assert.equal(result.code, 0, result.out);
    assert.ok(Date.now() - started < 4_000, `cleanup took ${Date.now() - started} ms`);
    assert.equal(checkout.record(), null);
  } finally {
    parent.child.kill("SIGKILL");
    await parent.done;
  }
});

test("genui-qa reads the mock port from the record and refuses a record that nothing answers", async () => {
  const checkout = new Checkout();
  fs.mkdirSync(path.join(checkout.dir, ".verify"), { recursive: true });

  const none = await checkout.mockBase();
  assert.equal(none.code, 1);
  assert.match(none.out, /launch --mock/);

  const override = await checkout.mockBase({ ORBIT_MOCK_BASE_URL: "http://127.0.0.1:1/v1" });
  assert.equal(override.out.trim(), "http://127.0.0.1:1/v1");

  const closed = await new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
  fs.writeFileSync(path.join(checkout.dir, ".verify/mock.json"), JSON.stringify({ pid: 1, startTime: "1", port: closed }));
  const stale = await checkout.mockBase();
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /does not answer/);
});

function ciRun(checkout: Checkout, env: Record<string, string> = {}, detached = false) {
  return run("bash", [path.join(checkout.dir, "scripts/qa/ci-e2e.sh"), "browse"], { cwd: checkout.dir, env: { ORBIT_VERIFY_PORT: "3230", ...env }, detached });
}

function ollamaSeen(checkout: Checkout): { url: string; answer: string } | null {
  try {
    const [url, answer] = fs.readFileSync(path.join(checkout.dir, ".verify/ollama-seen.txt"), "utf8").trim().split(" ");
    return { url, answer };
  } catch {
    return null;
  }
}

test("two ci-e2e.sh runs at once each start a mock Ollama on their own port and stop it", async () => {
  const [a, b] = [new Checkout({ stubVerify: true }), new Checkout({ stubVerify: true })];
  const [first, second] = await Promise.all([ciRun(a).done, ciRun(b).done]);
  assert.equal(first.code, 0, first.out);
  assert.equal(second.code, 0, second.out);
  const [seenA, seenB] = [ollamaSeen(a), ollamaSeen(b)];
  assert.ok(seenA && seenB, "both runs reached verify launch");
  assert.notEqual(seenA.url, seenB.url);
  assert.equal(seenA.answer, "200");
  assert.equal(seenB.answer, "200");
  for (const seen of [seenA, seenB]) {
    const port = Number(new URL(seen.url).port);
    await eventually(() => status(port, "/qa/received"), (code) => code === "ECONNREFUSED", `mock Ollama on ${port} stopped`);
  }
});

test("ci-e2e.sh stops its mock Ollama when it is interrupted or terminated", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const checkout = new Checkout({ stubVerify: true });
    const ci = ciRun(checkout, { STUB_HOLD: "1" }, true);
    const seen = await eventually(() => ollamaSeen(checkout), Boolean, "verify launch ran", 10_000);
    assert.ok(seen);
    process.kill(-(ci.child.pid as number), signal);
    const result = await ci.done;
    assert.notEqual(result.code, 0, `${signal}: ${result.out}`);
    const port = Number(new URL(seen.url).port);
    await eventually(() => status(port, "/qa/received"), (code) => code === "ECONNREFUSED", `${signal}: mock Ollama on ${port} stopped`);
  }
});

test("teardown awaits tracked children and detached fixture processes before removing checkout directories", async () => {
  const checkout = new Checkout();
  let trackedSettled = false;
  const tracked = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: checkout.dir });
  tracked.done.then(() => {
    trackedSettled = true;
  });

  const launcher = run(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", 'const http = require("node:http"); const server = http.createServer((_req, res) => res.end("ok")); server.listen(0, "127.0.0.1", () => console.log(process.pid + " " + server.address().port));'], { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "ignore"] });
let buf = "";
worker.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  const nl = buf.indexOf("\\n");
  if (nl === -1) return;
  process.stdout.write(buf.slice(0, nl + 1));
  worker.stdout.destroy();
  worker.unref();
  process.exit(0);
});`,
    ],
    { cwd: checkout.dir },
  );
  const launched = await launcher.done;
  assert.equal(launched.code, 0, launched.out);
  const [detachedPid, detachedPort] = launched.out.trim().split(" ").map(Number);
  assert.ok(detachedPid > 0 && detachedPort > 0, `unexpected launcher output: ${launched.out}`);
  assert.equal(await status(detachedPort, "/"), 200);

  await teardown([checkout], [tracked]);

  assert.equal(trackedSettled, true, "tracked child done promise settled before teardown returned");
  assert.equal(tracked.child.signalCode, "SIGKILL");
  assert.equal(procStartTime(detachedPid), "", "detached fixture process stopped before teardown returned");
  assert.deepEqual(pidsUnder(checkout.dir), []);
  assert.equal(await status(detachedPort, "/"), "ECONNREFUSED");
  assert.equal(fs.existsSync(checkout.dir), false);
});
