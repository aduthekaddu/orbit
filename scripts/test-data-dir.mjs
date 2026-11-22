// Preloaded into each test file's own process by scripts/test.mjs, before the file
// imports anything. src/lib/db opens ORBIT_DATA_DIR when it loads, so the directory
// has to exist by then. A variable set once in the runner would be shared by every file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-data-"));
process.env.ORBIT_DATA_DIR = dir;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
