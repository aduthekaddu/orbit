import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import test from "node:test";

// A fixed delay stands in for "the thing has happened", so the check passes or fails with machine speed
// (a15fc63: a 2.5 s sleep, then one `docker ps` after Stop). Wait with eventually() from ./eventually.mjs,
// which reads until a predicate holds and fails with the last value read.

const SCANNED = [
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  ".agents/skills/verify-orbit/scenarios/*.mjs",
  "scripts/qa/genui-qa.cjs",
];

const FIX = "wait with eventually(read, predicate, { timeoutMs, what }) from src/lib/eventually.mjs";

const PATTERNS: { name: string; test: RegExp }[] = [
  { name: "setTimeout(", test: /(^|[^\w$.])(?:(?:globalThis|window|self)\.)?setTimeout\s*\(/ },
  { name: "setInterval(", test: /(^|[^\w$.])(?:(?:globalThis|window|self)\.)?setInterval\s*\(/ },
  { name: "waitForTimeout(", test: /\bwaitForTimeout\s*\(/ },
  { name: "sleep(", test: /(^|[^\w$.])sleep\s*\(/ },
  { name: "delay(", test: /(^|[^\w$.])delay\s*\(/ },
];
const TIMERS_PROMISES = /\bfrom\s+(["'])node:timers\/promises\1|require\(\s*(["'])node:timers\/promises\2\s*\)/;

// Replaces comments and the text of string and template literals with spaces, keeping line breaks.
// A `${...}` inside a template is masked with the template. A regex literal holding a quote can fool it.
export function maskNonCode(source: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && (ch === "`" || source[j] !== "\n")) j += source[j] === "\\" ? 2 : 1;
      out += ch + blank(source.slice(i + 1, j)) + (source[j] === ch ? ch : "");
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

export type FixedWait = { line: number; found: string };

export function findFixedWaits(source: string): FixedWait[] {
  const found: FixedWait[] = [];
  const lines = maskNonCode(source).split("\n");
  const raw = source.split("\n");
  lines.forEach((line, index) => {
    for (const { name, test: pattern } of PATTERNS) if (pattern.test(line)) found.push({ line: index + 1, found: name });
    if (TIMERS_PROMISES.test(raw[index] ?? "") && !/^\s*(\/\/|\*)/.test(raw[index] ?? "")) found.push({ line: index + 1, found: "node:timers/promises" });
  });
  return found;
}

// `count` is the number of waits the file keeps. A file that gains or loses one fails until the entry is updated.
// Add an entry only for a delay that is the behavior under test, or a wait for something that must not happen.
const ALLOWED: { file: string; count: number; reason: string }[] = [
  { file: "src/lib/sandbox/run.test.ts", count: 9, reason: "PR 187 rewrites this file without sleeps. Delete the entry when it merges." },
  { file: "scripts/qa/genui-qa.cjs", count: 8, reason: "PR 181 rewrites this script. Delete the entry when it merges, and convert any wait it keeps." },
  { file: ".agents/skills/verify-orbit/scenarios/sandbox-real.mjs", count: 1, reason: "Its reply-saved loop must end in a failed step. sandbox-verification.test.ts drives it with a no-op waitForTimeout stub, and PR 181 changes that test. Convert both together." },
  { file: "src/lib/memory/dream.test.ts", count: 1, reason: "A startup watchdog that rejects when the mock provider never prints its port; the wait itself is the stdout event. PRs 169, 180, 181 and 198 also edit this file." },
  { file: "src/lib/db/migration-lock.test.ts", count: 1, reason: "A watchdog that kills a hung child process after 30 s; the tests wait on the child's output with eventually." },
  { file: "src/lib/tools/github.test.ts", count: 4, reason: "Three races assert a call returns within its deadline (800 ms, 1 s), and one 50 ms pause asserts that a held tool call has not reached the server. Both check that something does not happen, so no state change ends the wait." },
  { file: "src/lib/tools/tavily-signal.test.ts", count: 4, reason: "The delays are the behavior under test: a slow Tavily call (150 ms), a slow fixture response (100 ms), and a search deadline (100 ms)." },
  { file: "src/vendor/stageshow/act.test.ts", count: 1, reason: "A requestAnimationFrame stand-in for the code under test, not a wait." },
];

function scannedFiles() {
  return [...new Set(SCANNED.flatMap((pattern) => globSync(pattern)))].sort();
}

test("the scan reports the a15fc63 shape: a fixed sleep, then one read of Docker", () => {
  const replay = [
    'import { execFileSync } from "node:child_process";',
    "await page.getByRole('button', { name: 'Stop' }).click();",
    "await page.waitForTimeout(2_500);",
    'const left = execFileSync("docker", ["ps", "--filter", "label=orbit.sandbox=true"]);',
    "await new Promise((resolve) => setTimeout(resolve, 2500));",
  ].join("\n");
  assert.deepEqual(findFixedWaits(replay), [
    { line: 3, found: "waitForTimeout(" },
    { line: 5, found: "setTimeout(" },
  ]);
});

test("the scan ignores comments, strings, and member calls that are not timers", () => {
  const quiet = [
    "// await sleep(10) and setTimeout(r, 5) in a comment",
    'const program = "time.sleep(8); setTimeout(r, 1)";',
    "const code = `await new Promise((r) => setTimeout(r, 5))`;",
    "win.setTimeout(() => {}, 0);",
    "t.mock.timers.enable({ apis: [\"setTimeout\"] });",
    "waitForTimeout: async () => {},",
  ].join("\n");
  assert.deepEqual(findFixedWaits(quiet), []);
});

test("no test or scenario waits with a fixed delay", () => {
  const files = scannedFiles();
  assert.ok(files.length > 50, `the scan found only ${files.length} files; check SCANNED`);
  const allowed = new Map(ALLOWED.map((entry) => [entry.file, entry]));
  const problems: string[] = [];
  for (const file of files) {
    const waits = findFixedWaits(readFileSync(file, "utf8"));
    const entry = allowed.get(file);
    if (!entry) {
      for (const wait of waits) problems.push(`${file}:${wait.line} uses ${wait.found}. ${FIX}. A delay that is the behavior under test goes in ALLOWED with its reason.`);
    } else if (waits.length !== entry.count) {
      problems.push(`${file} has ${waits.length} fixed waits at ${waits.map((wait) => wait.line).join(", ") || "no line"} but ALLOWED says ${entry.count}. ${waits.length < entry.count ? "Lower the count or delete the entry." : FIX + "."}`);
    }
  }
  for (const { file, reason } of ALLOWED) {
    if (!existsSync(file) || !files.includes(file)) problems.push(`ALLOWED lists ${file}, which the scan does not read. Delete the entry.`);
    if (reason.trim() === "") problems.push(`ALLOWED entry for ${file} has no reason.`);
  }
  assert.deepEqual(problems, []);
});
