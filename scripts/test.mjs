import { createHash, randomInt } from "node:crypto";
import { globSync } from "node:fs";
import { availableParallelism } from "node:os";
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
