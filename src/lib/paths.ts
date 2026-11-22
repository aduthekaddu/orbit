import path from "node:path";
import { readEnv } from "./env";

// NODE_TEST_CONTEXT is missing when a test file runs as a plain program, from tsx, or under --test-isolation=none.
function runsAsTest() {
  return Boolean(readEnv("NODE_TEST_CONTEXT"))
    || process.execArgv.includes("--test")
    || /\.test\.tsx?$/.test(process.argv[1] ?? "");
}

export function dataDirectory() {
  const configured = readEnv("ORBIT_DATA_DIR");
  if (configured) return configured;
  if (runsAsTest()) {
    throw new Error("ORBIT_DATA_DIR is not set, so this test would open ./data in the checkout. Run tests with npm test, or node --import tsx --import ./scripts/test-data-dir.mjs --test <file>");
  }
  return path.join(process.cwd(), "data");
}
