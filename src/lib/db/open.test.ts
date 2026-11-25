import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const repo = process.cwd();
const dirs: string[] = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("the database sets its busy timeout before it switches to WAL", () => {
  const source = fs.readFileSync("src/lib/db/index.ts", "utf8");
  assert.match(source, /new Database\(dbPath, \{ timeout: 5000 \}\)/);
  const timeoutAt = source.search(/new Database\(dbPath, \{ timeout: 5000 \}\)/);
  const walAt = source.search(/pragma\("journal_mode = WAL"\)/);
  assert.ok(timeoutAt !== -1 && walAt !== -1 && timeoutAt < walAt, "the constructor timeout must come before the WAL pragma");
  const pragmaTimeoutAt = source.search(/pragma\("busy_timeout = 5000"\)/);
  assert.ok(pragmaTimeoutAt !== -1 && pragmaTimeoutAt < walAt, "busy_timeout must be set before the WAL pragma");
});

test("fifteen workers can open a fresh data directory without a locked database", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-db-open-"));
  dirs.push(dir);
  const source = `
import("./src/lib/db/index.ts").then(
  (mod) => {
    const getDb = mod.getDb ?? mod.default.getDb;
    getDb();
    console.log("READY");
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
`;
  const start = () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "-e", source], {
      cwd: repo,
      env: { ...process.env, ORBIT_DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`child timed out\n${stdout}\n${stderr}`));
      }, 45_000);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  };
  const results = await Promise.all(Array.from({ length: 15 }, () => start()));
  const failed = results.filter((result) => result.code !== 0 || !result.stdout.includes("READY"));
  assert.equal(failed.length, 0, failed.map((result) => `${result.code}: ${result.stderr || result.stdout}`).join("\n"));
});
