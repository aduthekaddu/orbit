import { run } from "node:test";
import { tap } from "node:test/reporters";

const requireAll = process.argv.includes("--require-all");
const tests = run({
  globPatterns: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  execArgv: ["--import", "tsx"],
  isolation: "process",
  concurrency: true,
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
