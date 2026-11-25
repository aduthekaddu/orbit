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

// Drops `//` and `/* */` comments, every run of whitespace, and a comma right before `)`, `]`
// or `}`, all outside string and template literals. A run of whitespace between two word
// characters becomes one space, so `return x` stays apart. A regex literal or a nested template
// literal is read as plain code.
const token = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\s+|[\w$]+|[\s\S]/g;

function withoutFormatting(code: string): string {
  let out = "";
  let gap = false;
  for (const [text] of code.matchAll(token)) {
    if (/^(\/\/|\/\*|\s)/.test(text)) {
      gap = true;
      continue;
    }
    if (gap && /[\w$]$/.test(out) && /^[\w$]/.test(text)) out += " ";
    if (/^[)\]}]$/.test(text) && out.endsWith(",")) out = out.slice(0, -1);
    out += text;
    gap = false;
  }
  return out;
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

test("formatting and comments do not change a function's hashed text, and code does", () => {
  const code = 'function f(a) {\n  // why\n  return a + "x  y"; /* note */\n}';
  assert.equal(withoutFormatting(code), 'function f(a){return a+"x  y";}');
  assert.equal(withoutFormatting("function f(\n  a,\n) {\n  return [a, 'x  y',];\n}"), "function f(a){return[a,'x  y'];}");
  assert.notEqual(withoutFormatting(code), withoutFormatting(code.replace("a +", "a -")));
  assert.notEqual(withoutFormatting(code), withoutFormatting(code.replace('"x  y"', '"x y"')));
});

test("the chat models were checked against the current code of every function they name", () => {
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, string>;
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
    const hash = createHash("sha256").update(withoutFormatting(text)).digest("hex");
    if (record[key] !== hash) {
      problems.push(`${key} changed after the models were last checked against it. Recheck each model action whose \`code:\` line names it, run scripts/ci/tlc.sh, then record "${key}": "${hash}".`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!named.includes(key)) problems.push(`${key} is in docs/architecture/model-sync.json, but no model names it. Remove it.`);
  }
  assert.deepEqual(problems, [], `Follow .agents/skills/verify-chat-turn/SKILL.md, then update docs/architecture/model-sync.json:\n${problems.join("\n")}`);
});
