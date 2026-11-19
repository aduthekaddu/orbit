import { createHash, randomInt } from "node:crypto";
import { globSync } from "node:fs";
import { availableParallelism } from "node:os";
import { run } from "node:test";
import { tap } from "node:test/reporters";

const requireAll = process.argv.includes("--require-all");
const globs = ["src/**/*.test.ts", "src/**/*.test.tsx"];
const seed = process.env.ORBIT_TEST_SEED ?? (process.argv.includes("--shuffle") ? String(randomInt(2 ** 32)) : undefined);
let files;
if (seed !== undefined) {
  if (!/^\d{1,10}$/.test(seed)) throw new Error("ORBIT_TEST_SEED must be a decimal number");
  files = globs
    .flatMap((pattern) => globSync(pattern))
    .map((file) => ({ file, rank: createHash("sha256").update(seed).update("\0").update(file).digest("hex") }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .map(({ file }) => file);
  if (files.length === 0) throw new Error("No Orbit test files were found");
  console.error(`Orbit test order seed: ${seed} (${files.length} files)`);
}

const tests = run({
  ...(files ? { files } : { globPatterns: globs }),
  execArgv: ["--import", "tsx"],
  isolation: "process",
  concurrency: files ? availableParallelism() : true,
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
