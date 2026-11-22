import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const models = path.join(process.cwd(), "docs/architecture");
const recordFile = path.join(models, "model-sync.json");

// The text from a top-level `function name(` line to the next line that is a lone `}`.
function functionText(file: string, name: string): string | undefined {
  const lines = fs.readFileSync(path.join(process.cwd(), file), "utf8").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(export )?(async )?function ${name}\\b`).test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line === "}");
  return end === -1 ? undefined : lines.slice(start, end + 1).join("\n");
}

function namedFunctions(): string[] {
  const named = new Set<string>();
  for (const file of fs.readdirSync(models).filter((name) => name.endsWith(".tla"))) {
    for (const match of fs.readFileSync(path.join(models, file), "utf8").matchAll(/\\\* code: (\S+) ([A-Za-z_$][\w$]*)/g)) {
      named.add(`${match[1]} ${match[2]}`);
    }
  }
  return [...named].sort();
}

test("the chat models were checked against the current text of every function they name", () => {
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as { syncCommit: string; functions: Record<string, string> };
  const named = namedFunctions();
  assert.ok(named.length > 0, "no `\\* code:` lines found in docs/architecture/*.tla");
  const problems: string[] = [];
  for (const key of named) {
    const [file, name] = key.split(" ");
    const text = fs.existsSync(path.join(process.cwd(), file)) ? functionText(file, name) : undefined;
    if (text === undefined) {
      problems.push(`${key}: a model names this function, but ${file} has no top-level \`function ${name}(\` block ending in a lone \`}\`. Point the model's \`code:\` line at the function that now does this step.`);
      continue;
    }
    const hash = createHash("sha256").update(text).digest("hex");
    if (record.functions[key] !== hash) {
      problems.push(`${key} changed after the models were last checked against it at ${record.syncCommit}. Recheck each model action whose \`code:\` line names it, run scripts/ci/tlc.sh, then record "${key}": "${hash}".`);
    }
  }
  for (const key of Object.keys(record.functions)) {
    if (!named.includes(key)) problems.push(`${key} is in docs/architecture/model-sync.json, but no model names it. Remove it.`);
  }
  assert.deepEqual(problems, [], `Follow .agents/skills/verify-chat-turn/SKILL.md, then update docs/architecture/model-sync.json and its syncCommit:\n${problems.join("\n")}`);
});
