import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const script = path.join(process.cwd(), "scripts/ci/codeql-gate.sh");
const hasJq = spawnSync("jq", ["--version"]).status === 0;
let directory: string;

function sarif(...findings: Array<[string, string, string?]>) {
  const results = findings.map(([ruleId, uri, hash]) => ({
    ruleId,
    locations: [{ physicalLocation: { artifactLocation: { uri } } }],
    partialFingerprints: hash ? { primaryLocationLineHash: hash } : {},
  }));
  fs.writeFileSync(path.join(directory, "javascript.sarif"), JSON.stringify({ runs: [{ results }] }));
}

function known(text: string) {
  const file = path.join(directory, "known.txt");
  fs.writeFileSync(file, text);
  return file;
}

function gate(file: string) {
  const result = spawnSync("bash", [script, directory, file], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-codeql-gate-"));
});

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("a run with no results passes", { skip: !hasJq && "jq is needed" }, () => {
  sarif();
  assert.equal(gate(known("# nothing is known\n")).ok, true);
});

test("a listed finding passes, and comments and blank lines in the list are ignored", { skip: !hasJq && "jq is needed" }, () => {
  sarif(["js/file-system-race", "src/lib/auth.ts"]);
  const result = gate(known("# why\n\njs/file-system-race src/lib/auth.ts\n"));
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /1 findings, all known/);
});

test("a finding that is not listed fails and names the rule and file", { skip: !hasJq && "jq is needed" }, () => {
  sarif(["js/file-system-race", "src/lib/auth.ts"], ["js/sql-injection", "src/lib/messages.ts"]);
  const result = gate(known("js/file-system-race src/lib/auth.ts\n"));
  assert.equal(result.ok, false);
  assert.match(result.output, /New CodeQL finding::js\/sql-injection in src\/lib\/messages\.ts/);
  assert.doesNotMatch(result.output, /New CodeQL finding::js\/file-system-race/);
});

test("the same rule in another file is a new finding", { skip: !hasJq && "jq is needed" }, () => {
  sarif(["js/file-system-race", "src/lib/other.ts"]);
  assert.equal(gate(known("js/file-system-race src/lib/auth.ts\n")).ok, false);
});

test("a listed finding that CodeQL no longer reports is a warning, not a failure", { skip: !hasJq && "jq is needed" }, () => {
  sarif();
  const result = gate(known("js/file-system-race src/lib/auth.ts\n"));
  assert.equal(result.ok, true);
  assert.match(result.output, /Fixed finding still listed::js\/file-system-race in src\/lib\/auth\.ts/);
});

test("a second finding of a listed rule in the same file is new when its line differs", { skip: !hasJq && "jq is needed" }, () => {
  sarif(["js/file-system-race", "src/lib/auth.ts", "aaaa:1"], ["js/file-system-race", "src/lib/auth.ts", "bbbb:1"]);
  const result = gate(known("js/file-system-race src/lib/auth.ts aaaa:1\n"));
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /New CodeQL finding::js\/file-system-race in src\/lib\/auth\.ts/);
});
