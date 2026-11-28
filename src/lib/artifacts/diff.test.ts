import assert from "node:assert/strict";
import { test } from "node:test";
import { diffArtifactLines, type DiffHunk } from "./diff";

function lines(count: number, label = "line") {
  return Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
}

function text(rows: string[]) {
  return `${rows.join("\n")}\n`;
}

function ready(before: string, after: string) {
  const diff = diffArtifactLines(before, after);
  assert.equal(diff.status, "ready");
  return diff;
}

function shape(hunks: DiffHunk[]) {
  return hunks.map((hunk) => `${hunk.kind}:${hunk.lines.length}`);
}

test("identical sources have no differences", () => {
  assert.deepEqual(diffArtifactLines("<p>a</p>\n", "<p>a</p>\n"), { status: "identical" });
  assert.deepEqual(diffArtifactLines("", ""), { status: "identical" });
});

test("CRLF and LF versions of the same source are identical", () => {
  assert.deepEqual(diffArtifactLines("<p>a</p>\r\n<p>b</p>\r\n", "<p>a</p>\n<p>b</p>\n"), { status: "identical" });
  assert.deepEqual(diffArtifactLines("<p>a</p>\r<p>b</p>\r", "<p>a</p>\n<p>b</p>\n"), { status: "identical" });
});

test("a one-line edit shows the removed and added line between their context", () => {
  const diff = ready("<h1>Counter</h1>\n<p>Version 1</p>\n<button>+</button>\n", "<h1>Counter</h1>\n<p>Version 2</p>\n<button>+</button>\n");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.hunks, [
    {
      kind: "changes",
      lines: [
        { kind: "context", beforeLine: 1, afterLine: 1, text: "<h1>Counter</h1>" },
        { kind: "removed", beforeLine: 2, afterLine: null, text: "<p>Version 1</p>" },
        { kind: "added", beforeLine: null, afterLine: 2, text: "<p>Version 2</p>" },
        { kind: "context", beforeLine: 3, afterLine: 3, text: "<button>+</button>" },
      ],
    },
  ]);
});

test("a line ending change alone does not mark the whole file changed", () => {
  const diff = ready("<p>a</p>\r\n<p>b</p>\r\n<p>c</p>\r\n", "<p>a</p>\n<p>B</p>\n<p>c</p>\n");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test("added and removed lines keep their own line numbers", () => {
  const diff = ready(text(["a", "b", "c"]), text(["a", "x", "y", "c"]));
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  const changed = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
  assert.deepEqual(changed.map((line) => [line.kind, line.beforeLine, line.afterLine, line.text]), [
    ["removed", 2, null, "b"],
    ["added", null, 2, "x"],
    ["added", null, 3, "y"],
  ]);
});

test("a long unchanged middle collapses, keeping three lines of context on each side", () => {
  const middle = lines(20, "same");
  const diff = ready(text(["first", ...middle, "last"]), text(["FIRST", ...middle, "LAST"]));
  assert.deepEqual(shape(diff.hunks), ["changes:5", "collapsed:14", "changes:5"]);
  const [top, hidden, bottom] = diff.hunks;
  assert.deepEqual(top.lines.slice(2).map((line) => line.text), ["same 1", "same 2", "same 3"]);
  assert.equal(hidden.lines[0].text, "same 4");
  assert.equal(hidden.lines[0].beforeLine, 5);
  assert.equal(hidden.lines.at(-1)?.text, "same 17");
  assert.deepEqual(bottom.lines.slice(0, 3).map((line) => line.text), ["same 18", "same 19", "same 20"]);
});

test("six unchanged lines between two changes stay in view", () => {
  const middle = lines(6, "same");
  const diff = ready(text(["first", ...middle, "last"]), text(["FIRST", ...middle, "LAST"]));
  assert.deepEqual(shape(diff.hunks), ["changes:10"]);
});

test("unchanged lines before the first change and after the last change collapse to three", () => {
  const head = lines(10, "head");
  const tail = lines(8, "tail");
  const diff = ready(text([...head, "old", ...tail]), text([...head, "new", ...tail]));
  assert.deepEqual(shape(diff.hunks), ["collapsed:7", "changes:8", "collapsed:5"]);
  assert.deepEqual(diff.hunks[1].lines.map((line) => line.text), ["head 8", "head 9", "head 10", "old", "new", "tail 1", "tail 2", "tail 3"]);
});

test("a small edit inside a very long file still diffs", () => {
  const body = lines(10_000);
  const edited = [...body];
  edited[5_000] = "edited";
  const diff = ready(text(body), text(edited));
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test("too many changed lines is too large to compare, instead of freezing the page", () => {
  const before = text(lines(4_001, "old"));
  const after = text(lines(4_001, "new"));
  assert.deepEqual(diffArtifactLines(before, after), { status: "too-large", beforeLines: 4_001, afterLines: 4_001 });
});

test("a changed middle over two million cells is too large even under the line cap", () => {
  const diff = diffArtifactLines(text(lines(1_500, "old")), text(lines(1_500, "new")));
  assert.equal(diff.status, "too-large");
});

test("a source written from nothing is all added lines", () => {
  const diff = ready("", "<svg></svg>\n");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
});
