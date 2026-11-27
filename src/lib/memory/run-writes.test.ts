import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

const WRITER = "src/lib/memory/dream.ts";

// Misses SQL split so that the verb and the table name sit on different lines, and a table name built at run time.
const RUN_WRITE = /\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?memory_runs\b|\.(insert|update|delete)\(\s*(schema\.)?memoryRuns\b/i;

function runWrites() {
  return globSync("{src,scripts}/**/*.{ts,tsx,mjs}")
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) => (RUN_WRITE.test(line) ? [`${file}:${index + 1}`] : [])),
    );
}

test("only advance in dream.ts writes memory_runs", () => {
  const writes = runWrites();
  const elsewhere = writes.filter((write) => !write.startsWith(`${WRITER}:`));
  assert.deepEqual(
    elsewhere,
    [],
    `Change a dream run with advance(userId, date, event) in ${WRITER}, which applies transition from run-state.ts, instead of writing memory_runs:\n${elsewhere.join("\n")}`,
  );
  const inWriter = writes.filter((write) => write.startsWith(`${WRITER}:`));
  assert.equal(inWriter.length, 1, `${WRITER} must write memory_runs in one statement, WRITE_RUN in advance:\n${inWriter.join("\n")}`);
});
