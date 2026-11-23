import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// These tests copy verify.mjs, ci-e2e.sh and the mocks into a scratch checkout and run them. A stub app stands in for
// Orbit, so no build is needed. Reverting any of those scripts to fixed ports turns a test here red.

const repo = process.cwd();

const STUB_APP = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const putLog = path.join(process.cwd(), "..", "put.jsonl");
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

const checkouts: Checkout[] = [];
const spawned: ChildProcess[] = [];
const usedPorts = new Set<number>();

function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; detached?: boolean }): { child: ChildProcess; done: Promise<Result> } {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(command, args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, detached: options.detached, stdio: ["ignore", "pipe", "pipe"] });
  spawned.push(child);
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const done = new Promise<Result>((resolve) => child.once("close", (code) => resolve({ code, out })));
  return { child, done };
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
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function procEntries(): string[] {
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
}

function pidsUnder(dir: string): number[] {
  const pids: number[] = [];
  for (const entry of procEntries()) {
    let cmdline = "";
    let cwd = "";
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue;
    }
    if (cmdline.includes(dir) || cwd.startsWith(dir)) pids.push(Number(entry));
  }
  return pids;
}

class Checkout {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-qa-checkout-"));
  port = 0;

  constructor(options: { stubVerify?: boolean } = {}) {
    for (const file of [
      ".agents/skills/verify-orbit/verify.mjs",
      "scripts/qa/mock-provider.mjs",
      "scripts/qa/mock-ollama.mjs",
      "scripts/qa/ci-e2e.sh",
    ]) {
      fs.mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
      fs.copyFileSync(path.join(repo, file), path.join(this.dir, file));
    }
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(this.dir, "node_modules"));
    fs.mkdirSync(path.join(this.dir, ".next"));
    fs.writeFileSync(path.join(this.dir, "stub-app.mjs"), STUB_APP);
    fs.writeFileSync(path.join(this.dir, "package.json"), JSON.stringify({ scripts: { start: `node ${path.join(this.dir, "stub-app.mjs")}` } }));
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

after(async () => {
  for (const checkout of checkouts) {
    if (checkout.port) await run(process.execPath, [path.join(checkout.dir, ".agents/skills/verify-orbit/verify.mjs"), "cleanup"], { cwd: checkout.dir, env: { ORBIT_VERIFY_PORT: String(checkout.port) } }).done.catch(() => {});
    for (const pid of pidsUnder(checkout.dir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(checkout.dir, { recursive: true, force: true });
  }
  for (const child of spawned) if (child.exitCode === null && child.pid && !child.signalCode) child.kill("SIGKILL");
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
  parent.child.kill("SIGKILL");
  assert.equal(result.code, 0, result.out);
  assert.ok(Date.now() - started < 4_000, `cleanup took ${Date.now() - started} ms`);
  assert.equal(checkout.record(), null);
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
