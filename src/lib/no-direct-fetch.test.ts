import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

// Browser code is every file under src/components, every file under src/app outside the route handlers in
// src/app/api, and any other file that starts with "use client". The chat stream transport
// (src/lib/chat-transport.ts) hands a stream to the AI SDK and is neither, so it is not scanned.
const HELPER = "src/lib/request-json.ts";

// Open PRs rewrite these files by hand. https://github.com/aduthekaddu/orbit/issues/185 tracks moving them to requestJson.
const ALLOWED = new Map([
  ["src/components/memory/memory-list.tsx", "PR #159, PR #166"],
  ["src/components/shell/command-palette.tsx", "PR #167"],]);

const FETCH_CALL = /\bfetch\s*\(/;

function browserFiles() {
  return globSync("src/**/*.{ts,tsx}")
    .filter((file) => !/\.test\.tsx?$/.test(file) && file !== HELPER)
    .filter((file) => {
      if (file.startsWith("src/components/")) return true;
      if (file.startsWith("src/app/") && !file.startsWith("src/app/api/")) return true;
      return /^\s*["']use client["']/.test(readFileSync(file, "utf8"));
    });
}

function fetchCalls(file: string) {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => (FETCH_CALL.test(line) ? [`${file}:${index + 1}`] : []));
}

test("browser code sends requests through requestJson, not fetch", () => {
  const calls = browserFiles()
    .filter((file) => !ALLOWED.has(file))
    .flatMap(fetchCalls);
  assert.deepEqual(calls, [], `Call requestJson from ${HELPER} instead of fetch, so the request names what happens when it fails:\n${calls.join("\n")}`);
});

test("every allowlisted file still calls fetch", () => {
  const files = new Set(browserFiles());
  const stale = [...ALLOWED.keys()].filter((file) => !files.has(file) || fetchCalls(file).length === 0);
  assert.deepEqual(stale, [], `Remove these from ALLOWED, they no longer call fetch:\n${stale.join("\n")}`);
});
