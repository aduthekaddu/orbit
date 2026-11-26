import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

const repo = process.cwd();
const dirs: string[] = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-lazy-open-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function importInChild(modulePath: string, options: { cwd?: string; env: NodeJS.ProcessEnv; script?: string }) {
  const script = options.script ?? "await import(process.argv[1]);";
  return spawnSync(process.execPath, ["--import", "tsx", "-e", script, modulePath], {
    cwd: options.cwd ?? repo,
    env: options.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const DB_REACHING_MODULES = [
  "./src/lib/db/index.ts",
  "./src/lib/settings.ts",
  "./src/lib/preferences.ts",
  "./src/lib/messages.ts",
  "./src/lib/secrets.ts",
  "./src/lib/connections.ts",
  "./src/lib/auth.ts",
  "./src/app/api/auth/[...all]/route.ts",
  "./src/proxy.ts",
];

test("importing db-reaching modules writes nothing to the data directory", async (t) => {
  for (const specifier of DB_REACHING_MODULES) {
    await t.test(specifier, () => {
      const existing = makeTempDir("empty");
      fs.chmodSync(existing, 0o755);
      const envExisting: NodeJS.ProcessEnv = { ...process.env, ORBIT_DATA_DIR: existing };
      delete envExisting.BETTER_AUTH_SECRET;
      delete envExisting.NODE_TEST_CONTEXT;

      const resExisting = importInChild(specifier, { env: envExisting });
      assert.equal(resExisting.status, 0, resExisting.stderr || resExisting.stdout);
      assert.deepEqual(
        fs.readdirSync(existing),
        [],
        `${specifier} created files in ORBIT_DATA_DIR on import: ${fs.readdirSync(existing).join(", ")}`,
      );
      assert.equal(fs.statSync(existing).mode & 0o777, 0o755, `${specifier} changed ORBIT_DATA_DIR permissions on import`);

      const parent = makeTempDir("missing");
      const missing = path.join(parent, "data");
      const envMissing: NodeJS.ProcessEnv = { ...process.env, ORBIT_DATA_DIR: missing };
      delete envMissing.BETTER_AUTH_SECRET;
      delete envMissing.NODE_TEST_CONTEXT;

      const resMissing = importInChild(specifier, { env: envMissing });
      assert.equal(resMissing.status, 0, resMissing.stderr || resMissing.stdout);
      assert.equal(fs.existsSync(missing), false, `${specifier} created a missing ORBIT_DATA_DIR on import`);
    });
  }
});

test("importing a db-reaching module without ORBIT_DATA_DIR in a test process neither throws nor creates ./data", () => {
  const cwd = makeTempDir("no-data-dir");
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(cwd, "node_modules"), "dir");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: "1" };
  delete env.ORBIT_DATA_DIR;
  delete env.BETTER_AUTH_SECRET;

  const settingsUrl = pathToFileURL(path.join(repo, "src/lib/settings.ts")).href;
  const result = importInChild(settingsUrl, {
    cwd,
    env,
    script: `const mod = await import(process.argv[1]); console.log(typeof mod.toPublicSettings);`,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "function");
  assert.equal(fs.existsSync(path.join(cwd, "data")), false);
});
