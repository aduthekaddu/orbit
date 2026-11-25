import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

// Browser code is every file under src/components, every file under src/app outside the route handlers in
// src/app/api, and any other file that starts with "use client". The chat stream transport
// (src/lib/chat-transport.ts) hands a stream to the AI SDK and is neither, so it is not scanned.
const HELPER = "src/lib/request-json.ts";

// Also catches fetch?.(, ["fetch"](, XMLHttpRequest, EventSource and sendBeacon. It misses an alias such as
// `const get = fetch`, a call split across lines, and a module without "use client" outside the scanned trees.
const REQUEST_CALL = /\bfetch\s*(\?\.\s*)?\(|\[\s*["'`]fetch["'`]\s*\]\s*(\?\.\s*)?\(|\bnew\s+(XMLHttpRequest|EventSource)\b|\bsendBeacon\s*\(/;

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
    .flatMap((line, index) => (REQUEST_CALL.test(line) ? [`${file}:${index + 1}`] : []));
}

test("browser code sends requests through requestJson, not fetch", () => {
  const calls = browserFiles().flatMap(fetchCalls);
  assert.deepEqual(calls, [], `Call requestJson from ${HELPER} instead of fetch, XMLHttpRequest, EventSource or sendBeacon, so the request names what happens when it fails:\n${calls.join("\n")}`);
});
