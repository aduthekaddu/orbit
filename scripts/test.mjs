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

const globs = ["src/**/*.test.ts", "src/**/*.test.tsx"];
const seed = process.env.ORBIT_TEST_SEED ?? (values.shuffle ? String(randomInt(2 ** 32)) : undefined);
let files;
if (seed !== undefined) {
  if (!/^\d{1,10}$/.test(seed)) throw new Error("ORBIT_TEST_SEED must be a decimal number");
  files = globs
    .flatMap((pattern) => globSync(pattern))
    .map((file) => ({ file, rank: createHash("sha256").update(seed).update("\0").update(file).digest("hex") }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .map(({ file }) => file);
  if (files.length === 0) throw new Error("No Orbit test files were found");
  const fileLabel = files.length === 1 ? "file" : "files";
  const workerLabel = effectiveWorkers === 1 ? "worker" : "workers";
  console.error(`Orbit test order seed: ${seed} (${files.length} ${fileLabel}, ${effectiveWorkers} ${workerLabel})`);
}

// One root for every file's data directory (see test-data-dir.mjs). A file killed by a signal
// cannot clean up after itself, so the runner removes the whole root when the run ends.
// On SIGINT or SIGTERM it first stops the files still running and waits for them to exit,
// so none recreates the root afterwards. Only a SIGKILL of this runner leaves the root behind.
const root = mkdtempSync(join(tmpdir(), "orbit-test-run-"));
process.env.ORBIT_TEST_ROOT = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function runningFiles() {
  const pids = [];
  for (const entry of readdirSync(root)) {
    try {
      const pid = Number(readFileSync(join(root, entry, "pid"), "utf8"));
      process.kill(pid, 0);
      pids.push(pid);
    } catch {
      // No pid yet, or the file already exited.
    }
  }
  return pids;
}

async function stopFiles(graceMs) {
  for (let waited = 0, pids = runningFiles(); pids.length > 0; waited += 50, pids = runningFiles()) {
    for (const pid of pids) {
      try {
        process.kill(pid, waited < graceMs ? "SIGTERM" : "SIGKILL");
      } catch {
        // Exited since the check.
      }
    }
    await sleep(50);
  }
}

let stopping = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await stopFiles(5000);
    process.exit(code);
  });
}

const tests = run({
  ...(files ? { files } : { globPatterns: globs }),
  execArgv: ["--import", "tsx", "--import", fileURLToPath(new URL("./test-data-dir.mjs", import.meta.url))],
  isolation: "process",
  concurrency: workers ?? true,
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
  if (file) return;
  completed = true;
  if (!success || counts.tests === 0) process.exitCode = 1;
  if (requireAll && (counts.passed !== counts.tests || notRun > 0)) {
    console.error(`Full suite needs every test to pass: ${counts.passed}/${counts.tests} passed, ${notRun} tests or suites skipped or todo.`);
    process.exitCode = 1;
  }
});
tests.on("end", () => {
  if (completed) return;
  console.error("The test runner did not report a suite result.");
  process.exitCode = 1;
});
tests.compose(tap).pipe(process.stdout);
