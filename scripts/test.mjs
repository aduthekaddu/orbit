import { run } from "node:test";
import { tap } from "node:test/reporters";

const requireAll = process.argv.includes("--require-all");
const tests = run({
  globPatterns: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  execArgv: ["--import", "tsx"],
  isolation: "process",
  concurrency: true,
});

let completed = false;
tests.on("test:summary", ({ file, counts, success }) => {
  if (file) return;
  completed = true;
  if (!success || counts.tests === 0) process.exitCode = 1;
  if (requireAll && counts.passed !== counts.tests) {
    console.error(`Full suite needs every test to pass: ${counts.passed}/${counts.tests} passed, ${counts.skipped} skipped, ${counts.todo} todo.`);
    process.exitCode = 1;
  }
});
tests.on("end", () => {
  if (completed) return;
  console.error("The test runner did not report a suite result.");
  process.exitCode = 1;
});
tests.compose(tap).pipe(process.stdout);
