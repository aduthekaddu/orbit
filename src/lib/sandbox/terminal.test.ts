import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalControls } from "./terminal";

test("color sequences go and the words stay", () => {
  assert.equal(stripTerminalControls("\u001b[31mred\u001b[0m"), "red");
  assert.equal(stripTerminalControls("\u001b[1;38;5;196mbold\u001b[0m \u001b[38;2;255;0;0mtrue\u001b[m"), "bold true");
});

test("cursor, erase, and mode sequences go", () => {
  assert.equal(stripTerminalControls("a\u001b[2K\u001b[1Gb\u001b[?25lc\u001b[?1049h"), "abc");
});

test("window titles and hyperlinks go and the link text stays", () => {
  assert.equal(stripTerminalControls("\u001b]0;title\u0007text"), "text");
  assert.equal(stripTerminalControls("\u001b]2;title\u001b\\text"), "text");
  assert.equal(stripTerminalControls("\u001b]8;;https://evil.example/\u001b\\click me\u001b]8;;\u001b\\"), "click me");
});

test("device, application, and privacy strings go", () => {
  assert.equal(stripTerminalControls("a\u001bP1$r0m\u001b\\b\u001b_payload\u001b\\c\u001b^note\u001b\\d"), "abcd");
});

test("eight-bit sequences go", () => {
  assert.equal(stripTerminalControls("\u009b31mred\u009b0m \u009d0;title\u009cok"), "red ok");
});

test("a sequence that another escape interrupts leaves no stray parameters", () => {
  assert.equal(stripTerminalControls("\u001b[31\u001b[0mred"), "red");
  assert.equal(stripTerminalControls("a\u001b[38;5\u001b[1mb"), "ab");
  assert.equal(stripTerminalControls("\u009b31\u009b0mred"), "red");
  assert.equal(stripTerminalControls("\u001b]0;title\u001b[31mred"), "red");
  assert.equal(stripTerminalControls("\u001b[31\u0007red"), "red");
});

test("a sequence cut off by the output limit is dropped", () => {
  assert.equal(stripTerminalControls("ok\u001b[31"), "ok");
  assert.equal(stripTerminalControls("ok\u001b"), "ok");
  assert.equal(stripTerminalControls("ok\u001b]0;tit"), "ok");
});

test("line breaks and tabs stay and carriage returns become line breaks", () => {
  assert.equal(stripTerminalControls("a\tb\nc\r\nd\re"), "a\tb\nc\nd\ne");
});

test("bells, backspaces, nulls, and other control characters go", () => {
  assert.equal(stripTerminalControls("a\u0000b\u0007c\u0008d\u007fe\u000bf\u000cg\u0085h"), "abcdefgh");
});

test("ordinary text is untouched, including brackets, HTML, and Unicode", () => {
  for (const text of ["[31mred[0m", "<script>alert(1)</script>", "héllo ✓ 🚀 日本語", "  indented\n\tline", "a ] b [ c"]) {
    assert.equal(stripTerminalControls(text), text);
  }
});

test("many unterminated sequences are handled in linear time", () => {
  const started = performance.now();
  stripTerminalControls("\u001b]".repeat(50_000) + "\u001b[".repeat(50_000));
  assert.ok(performance.now() - started < 500);
});
