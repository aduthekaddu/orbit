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

const finished = { stdout: "  indented ✓\nline two\n", stderr: "warning\n", exitCode: 0, durationMs: 20, timedOut: false, truncated: false };

test("a finished code run offers copy buttons for source, standard output, and standard error", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={finished} />);
  for (const label of ["Copy source", "Copy standard output", "Copy standard error"]) {
    assert.match(html, new RegExp(`<button[^>]*aria-label="${label}"`));
  }
});

test("a code run with no output channel text offers no copy button for it", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ ...finished, stdout: "", stderr: "" }} />);
  assert.match(html, /aria-label="Copy source"/);
  assert.doesNotMatch(html, /Copy standard output/);
  assert.doesNotMatch(html, /Copy standard error/);
});

test("a running code card offers only the source copy button", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={undefined} />);
  assert.match(html, /aria-label="Copy source"/);
  assert.doesNotMatch(html, /Copy standard/);
});

const silent = { stdout: "", stderr: "", exitCode: 0, durationMs: 20, timedOut: false, truncated: false };

test("a silent run shows no output wells and no output labels", () => {
  const html = renderToStaticMarkup(<CodeRun input={{ language: "python", code: "pass" }} output={silent} />);
  assert.doesNotMatch(html, /data-code-stdout|data-code-stderr/);
  assert.doesNotMatch(html, />stdout<|>stderr</);
  assert.match(html, /Copy source/);
  assert.match(html, /Exit 0/);
  assert.match(html, /20 ms/);
});

test("a run with only standard output hides the empty standard error well", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ ...silent, stdout: "2\n" }} />);
  assert.match(html, /data-code-stdout=""[^>]*><code>2\n<\/code>/);
  assert.doesNotMatch(html, /data-code-stderr/);
  assert.doesNotMatch(html, />stderr</);
});

test("a run with only standard error hides the empty standard output well", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ ...silent, stderr: "boom\n", exitCode: 1 }} />);
  assert.match(html, /data-code-stderr=""[^>]*><code>boom\n<\/code>/);
  assert.doesNotMatch(html, /data-code-stdout/);
  assert.doesNotMatch(html, />stdout</);
});

test("a silent failure and a silent timeout keep their result and show no wells", () => {
  const failed = renderToStaticMarkup(<CodeRun input={input} output={{ ...silent, exitCode: 3 }} />);
  assert.doesNotMatch(failed, /data-code-stdout|data-code-stderr/);
  assert.match(failed, /Exit 3/);
  const timedOut = renderToStaticMarkup(<CodeRun input={input} output={{ ...silent, exitCode: null, timedOut: true, durationMs: 10064 }} />);
  assert.doesNotMatch(timedOut, /data-code-stdout|data-code-stderr/);
  assert.match(timedOut, /Timed out/);
  assert.match(timedOut, /10064 ms/);
});

test("output made only of blank lines gets no well, like empty output", () => {
  const html = renderToStaticMarkup(<CodeRun input={{ language: "python", code: "print()" }} output={{ ...silent, stdout: "\n", stderr: " \n\t" }} />);
  assert.doesNotMatch(html, /data-code-stdout|data-code-stderr/);
  assert.doesNotMatch(html, />stdout<|>stderr</);
  assert.match(html, /Exit 0/);
});

test("output with text keeps its leading and trailing blank lines", () => {
  const html = renderToStaticMarkup(<CodeRun input={input} output={{ ...silent, stdout: "\n  two\n\n" }} />);
  assert.match(html, /data-code-stdout=""[^>]*><code>\n {2}two\n\n<\/code>/);
});
