// Preloaded into each test file's own process by scripts/test.mjs, before the file
// imports anything. src/lib/db opens ORBIT_DATA_DIR when it loads, so the directory
// has to exist by then. A variable set once in the runner would be shared by every file.
// The directory goes inside the runner's ORBIT_TEST_ROOT, which the runner removes
// even when this process is killed. Without the runner it goes in the OS temp directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(process.env.ORBIT_TEST_ROOT || os.tmpdir(), "orbit-test-data-"));
process.env.ORBIT_DATA_DIR = dir;
// Lets the runner find this process and stop it on SIGINT or SIGTERM.
const pidFile = path.join(dir, "pid");
const pidTmp = `${pidFile}.tmp`;
fs.writeFileSync(pidTmp, String(process.pid));
fs.renameSync(pidTmp, pidFile);
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
