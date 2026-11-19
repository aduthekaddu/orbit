import { createHash, randomInt } from "node:crypto";
import { globSync } from "node:fs";
import { availableParallelism } from "node:os";
import { run } from "node:test";
import { tap } from "node:test/reporters";

const seed = process.env.ORBIT_TEST_SEED ?? String(randomInt(2 ** 32));
if (!/^\d{1,10}$/.test(seed)) throw new Error("ORBIT_TEST_SEED must be a decimal number");

const files = ["src/**/*.test.ts", "src/**/*.test.tsx"]
  .flatMap((pattern) => globSync(pattern))
  .map((file) => ({ file, rank: createHash("sha256").update(seed).update("\0").update(file).digest("hex") }))
  .sort((a, b) => a.rank.localeCompare(b.rank))
  .map(({ file }) => file);
if (files.length === 0) throw new Error("No Orbit test files were found");

console.error(`Orbit test order seed: ${seed} (${files.length} files)`);
run({ files, isolation: "process", concurrency: availableParallelism(), execArgv: ["--import", "tsx"] })
  .on("test:summary", ({ file, counts, success }) => {
    if (!file && (!success || counts.tests === 0)) process.exitCode = 1;
  })
  .compose(tap)
  .pipe(process.stdout);
