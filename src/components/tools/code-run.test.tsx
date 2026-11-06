import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeRun } from "./code-run";

const input = { language: "python", code: "print(1+1)" };

for (const output of [{ error: "Unsupported language" }, "Unsupported language"]) {
  test(`a framework ${typeof output} error shows its reason and source`, () => {
    const html = renderToStaticMarkup(<CodeRun input={input} output={output} />);
    assert.match(html, /Unsupported language/);
    assert.match(html, /print\(1\+1\)/);
    assert.doesNotMatch(html, /Code returned an invalid result/);
  });
}

test("a sandbox failure still shows its error", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ ok: false, error: "Sandbox access was denied" }} />);
  assert.match(html, /Sandbox access was denied/);
});

test("a completed code run still shows stdout and exit status", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ stdout: "2\n", stderr: "", exitCode: 0, durationMs: 20, timedOut: false, truncated: false }} />);
  assert.match(html, /data-code-stdout=""[^>]*><code>2\n<\/code>/);
  assert.match(html, /Exit 0/);
  assert.doesNotMatch(html, /Code returned an invalid result/);
});

test("a cancelled call with no output keeps its source without an error", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={undefined} />);
  assert.match(html, /print\(1\+1\)/);
  assert.doesNotMatch(html, /Code returned an invalid result|text-destructive/);
});

test("an unknown malformed output keeps the invalid-result fallback", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ unexpected: true }} />);
  assert.match(html, /Code returned an invalid result/);
});

test("framework error text is escaped instead of rendered as HTML", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ error: "<script>bad()</script>" }} />);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
