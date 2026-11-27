import { createHash, randomInt } from "node:crypto";
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function parseWorkers(raw, source) {
  if (raw === undefined) return undefined;
  const count = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(count)) {
    throw new Error(source + " must be a positive safe integer");
  }
  return count;
}

const { values, tokens } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "require-all": { type: "boolean", default: false },
    shuffle: { type: "boolean", default: false },
    workers: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
  tokens: true,
});

if (tokens.some((token) => token.kind === "option-terminator")) {
  throw new Error("Unexpected argument '--'. This command does not take positional arguments");
}

const requireAll = values["require-all"];
const workers = values.workers !== undefined
  ? parseWorkers(values.workers, "--workers")
  : parseWorkers(process.env.ORBIT_TEST_WORKERS, "ORBIT_TEST_WORKERS");
const effectiveWorkers = workers ?? Math.max(availableParallelism() - 1, 1);

const seed = process.env.ORBIT_TEST_SEED ?? (values.shuffle ? String(randomInt(2 ** 32)) : undefined);
if (seed !== undefined && !/^\d{1,10}$/.test(seed)) throw new Error("ORBIT_TEST_SEED must be a decimal number");
const found = ["src/**/*.test.ts", "src/**/*.test.tsx"].flatMap((pattern) => globSync(pattern)).sort();
if (found.length === 0) throw new Error("No Orbit test files were found");

// node:test starts files in array order, so the listed slow files start first and the rest
// follow, sorted or shuffled by the seed. The list's own comment says how to refresh it.
const slowList = "scripts/slow-test-files.txt";
const slowFiles = readFileSync(slowList, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
slowFiles.forEach((file, index) => {
  if (!found.includes(file)) throw new Error(`${slowList} lists ${file}, which is not a test file. Fix or remove that line.`);
  if (slowFiles.indexOf(file) !== index) throw new Error(`${slowList} lists ${file} twice`);
});
let rest = found.filter((file) => !slowFiles.includes(file));
if (seed !== undefined) {
  rest = rest
    .map((file) => ({ file, rank: createHash("sha256").update(seed).update("\0").update(file).digest("hex") }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .map(({ file }) => file);
}
const files = [...slowFiles, ...rest];
if (seed !== undefined) {
  const fileLabel = files.length === 1 ? "file" : "files";
  const workerLabel = effectiveWorkers === 1 ? "worker" : "workers";
  console.error(`Orbit test order seed: ${seed} (${files.length} ${fileLabel}, ${effectiveWorkers} ${workerLabel})`);
}

// One root for every file's data directory (see test-data-dir.mjs). A file killed by a signal
// cannot clean up after itself, so the runner removes finished file directories and the whole
// root when the run ends. On SIGINT or SIGTERM it aborts queued files, stops the files still
// running and waits until each process has exited and been reaped, so none outlives the runner
// or recreates the root afterwards. Only a SIGKILL of this runner leaves the root behind.
const root = mkdtempSync(join(tmpdir(), "orbit-test-run-"));
process.env.ORBIT_TEST_ROOT = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function readPid(entry) {
  try {
    const raw = readFileSync(join(root, entry, "pid"), "utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) return undefined;
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid === process.pid) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const tracked = new Set();

function liveFiles() {
  for (const entry of readdirSync(root)) {
    const pid = readPid(entry);
    if (pid !== undefined && isAlive(pid)) tracked.add(pid);
  }
  for (const pid of tracked) {
    if (!isAlive(pid)) tracked.delete(pid);
  }
  return [...tracked];
}

function pruneExitedFiles() {
  for (const entry of readdirSync(root)) {
    const pid = readPid(entry);
    if (pid !== undefined && !isAlive(pid)) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
}

const controller = new AbortController();
let stopping = false;
let forceKill = false;

async function stopFiles(graceMs) {
  const termed = new Set();
  for (let waited = 0, pids = liveFiles(); pids.length > 0; waited += 50, pids = liveFiles()) {
    const hard = forceKill || waited >= graceMs;
    for (const pid of pids) {
      if (!hard && termed.has(pid)) continue;
      termed.add(pid);
      try {
        process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
      } catch {
        // Exited since the check.
      }
    }
    await sleep(50);
  }
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, async () => {
    if (stopping) {
      forceKill = true;
      for (const pid of liveFiles()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Exited since the check.
        }
      }
      return;
    }
    stopping = true;
    liveFiles();
    controller.abort();
    await stopFiles(5000);
    process.exit(code);
  });
}

const tests = run({
  files,
  execArgv: ["--import", "tsx", "--import", fileURLToPath(new URL("./test-data-dir.mjs", import.meta.url))],
  isolation: "process",
  concurrency: workers ?? true,
  signal: controller.signal,
});

// The summary counts leave out a skipped suite, so count every skip or todo mark, on tests and suites.
let notRun = 0;
const countNotRun = ({ skip, todo }) => {
  if (skip !== undefined || todo !== undefined) notRun += 1;
};
tests.on("test:pass", countNotRun);
tests.on("test:fail", countNotRun);

let completed = false;
tests.on("test:summary", ({ file, counts, success }) => {
  if (file) {
    if (!stopping) pruneExitedFiles();
    return;
  }
  if (stopping) return;
  completed = true;
  if (!success || counts.tests === 0) process.exitCode = 1;
  if (requireAll && (counts.passed !== counts.tests || notRun > 0)) {
    console.error(`Full suite needs every test to pass: ${counts.passed}/${counts.tests} passed, ${notRun} tests or suites skipped or todo.`);
    process.exitCode = 1;
  }
});
tests.on("end", () => {
  if (completed || stopping) return;
  console.error("The test runner did not report a suite result.");
  process.exitCode = 1;
});
tests.compose(tap).pipe(process.stdout);
