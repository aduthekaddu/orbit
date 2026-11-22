import path from "node:path";
import { readEnv } from "./env";

export function dataDirectory() {
  const configured = readEnv("ORBIT_DATA_DIR");
  if (configured) return configured;
  // The Node test runner sets NODE_TEST_CONTEXT in each test file's process.
  if (readEnv("NODE_TEST_CONTEXT")) {
    throw new Error("ORBIT_DATA_DIR is not set, so this test would open ./data in the checkout. Run tests with npm test, or node --import tsx --import ./scripts/test-data-dir.mjs --test <file>");
  }
  return path.join(process.cwd(), "data");
}
