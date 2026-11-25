import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import * as runStatus from "./run-status";

const home = "src/lib/tools/run-status.ts";
const fix = `Decide how a tool call ended with toolCallRunEnd or toolRunEnd in ${home}, and take stop texts from STOP_MARKERS there.`;

// The stop texts saved chats hold. run-status.test.ts pins STOP_MARKERS to the same values.
const stored = ["Stopped", "Code run was stopped", "Search was stopped", "User cancelled tool call by sending a new message."];

// Literals that are UI copy, not stored stop texts.
const allowed = [{ file: "src/components/tools/code-run.tsx", text: "Stopped", why: "the label of a stopped run's outcome" }];

const receiver = String.raw`(?:\berrorText|\b(?:output|result)\??\.error\b)`;
const comparisons = [
  new RegExp(String.raw`(?<!typeof\s[\w.?]*)${receiver}\s*[!=]==?`),
  new RegExp(String.raw`[!=]==?\s*[\w.?]*${receiver}`),
  new RegExp(String.raw`${receiver}\??\.(?:includes|startsWith|endsWith|match)\(`),
  new RegExp(String.raw`\.test\(\s*[\w.?]*${receiver}`),
  new RegExp(String.raw`switch\s*\([^)]*${receiver}`),
  /[!=]==?\s*STOP_MARKERS\b|STOP_MARKERS\.\w+\s*[!=]==?|STOP_MARKERS\b.*\.(?:includes|indexOf|has)\(/,
];

const sources = globSync("src/**/*.{ts,tsx}").filter((file) => !/\.test\.tsx?$/.test(file)).sort();

function quoted(text: string) {
  return ['"', "'", "`"].map((quote) => quote + text + quote);
}

function literalHits(file: string, source: string) {
  return stored.filter((text) => quoted(text).some((literal) => source.includes(literal)) && !allowed.some((entry) => entry.file === file && entry.text === text));
}

test("only run-status.ts compares a tool call's errorText or output.error", () => {
  const offenders = sources
    .filter((file) => file !== home)
    .flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, index) => comparisons.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
  assert.deepEqual(offenders, [], fix);
});

test("only run-status.ts writes a stored stop text", () => {
  const offenders = sources
    .filter((file) => file !== home)
    .flatMap((file) => literalHits(file, readFileSync(file, "utf8")).map((text) => `${file}: ${JSON.stringify(text)}`));
  assert.deepEqual(offenders, [], fix);
});

test("run-status.ts compares stored text only through STOP_MARKERS", () => {
  const lines = readFileSync(home, "utf8").split("\n");
  const offenders = lines.flatMap((line, index) => comparisons.some((pattern) => pattern.test(line)) && /(["'`])(?!string\1)[^"'`]+\1/.test(line) ? [`${home}:${index + 1}: ${line.trim()}`] : []);
  assert.deepEqual(offenders, [], fix);
});

test("run-status.ts has one way to read a tool call's end", () => {
  assert.deepEqual(Object.keys(runStatus).sort(), ["STOP_MARKERS", "toolCallRunEnd", "toolRunEnd"], `${fix} Add a status or a field to ToolRunEnd instead of a second predicate.`);
});

test("each allowed literal is still in its file", () => {
  const stale = allowed.filter((entry) => !quoted(entry.text).some((literal) => readFileSync(entry.file, "utf8").includes(literal)));
  assert.deepEqual(stale, [], "Remove allowed entries whose literal is gone");
});
