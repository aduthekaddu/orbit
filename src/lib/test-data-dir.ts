import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// The database module opens ORBIT_DATA_DIR as soon as it loads, and imports run
// in order, so a test file imports this before anything that can reach it.
export const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-data-"));
process.env.ORBIT_DATA_DIR = testDataDir;

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));
