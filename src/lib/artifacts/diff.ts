export type DiffLine =
  | { kind: "context"; beforeLine: number; afterLine: number; text: string }
  | { kind: "removed"; beforeLine: number; afterLine: null; text: string }
  | { kind: "added"; beforeLine: null; afterLine: number; text: string };

type ContextLine = Extract<DiffLine, { kind: "context" }>;

export type DiffHunk =
  | { kind: "changes"; lines: DiffLine[] }
  | { kind: "collapsed"; lines: ContextLine[] };

export type ArtifactDiff =
  | { status: "identical" }
  | { status: "too-large"; beforeLines: number; afterLines: number }
  | { status: "ready"; added: number; removed: number; hunks: DiffHunk[] };

// A giant minified SVG must not freeze the page: past these sizes the LCS table is not built.
const MAX_LINES = 4_000;
const MAX_CELLS = 2_000_000;
const CONTEXT = 3;

/** Lines of a source with any line ending. A final line break ends the last line instead of starting an empty one. */
function splitLines(source: string): string[] {
  const text = source.replace(/\r\n?/g, "\n");
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The edit script for the changed middle: an exact LCS, removed lines before added ones in each change. */
function middleScript(before: string[], after: string[]): ("context" | "removed" | "added")[] {
  const width = after.length + 1;
  // lengths[i * width + j] is the LCS length of before[i..] and after[j..]. Both sides are at most MAX_LINES, so 16 bits hold it.
  const lengths = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i * width + j] = before[i] === after[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const script: ("context" | "removed" | "added")[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      script.push("context");
      i++;
      j++;
    } else if (j === after.length || (i < before.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      script.push("removed");
      i++;
    } else {
      script.push("added");
      j++;
    }
  }
  return script;
}

/** Splits the diff into change hunks, folding each unchanged run that leaves more than three lines beside every change. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind !== "context") {
      current.push(line);
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind === "context") end++;
    const run = lines.slice(index, end) as ContextLine[];
    const keepBefore = index > 0 ? CONTEXT : 0;
    const keepAfter = end < lines.length ? CONTEXT : 0;
    if (run.length > keepBefore + keepAfter) {
      current.push(...run.slice(0, keepBefore));
      if (current.length > 0) hunks.push({ kind: "changes", lines: current });
      hunks.push({ kind: "collapsed", lines: run.slice(keepBefore, run.length - keepAfter) });
      current = run.slice(run.length - keepAfter);
    } else {
      current.push(...run);
    }
    index = end;
  }
  if (current.length > 0) hunks.push({ kind: "changes", lines: current });
  return hunks;
}

/** A unified line diff between two versions of an artifact. Pure, with no dependencies. */
export function diffArtifactLines(before: string, after: string): ArtifactDiff {
  const old = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  const removedSpan = oldEnd - start;
  const addedSpan = nextEnd - start;
  // Only a final line break or a line ending differs, which no one can see.
  if (removedSpan === 0 && addedSpan === 0) return { status: "identical" };
  if (removedSpan > MAX_LINES || addedSpan > MAX_LINES || removedSpan * addedSpan > MAX_CELLS) {
    return { status: "too-large", beforeLines: old.length, afterLines: next.length };
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ kind: "context", beforeLine: i + 1, afterLine: i + 1, text: old[i] });
  let i = start;
  let j = start;
  let added = 0;
  let removed = 0;
  for (const step of middleScript(old.slice(start, oldEnd), next.slice(start, nextEnd))) {
    if (step === "context") {
      lines.push({ kind: "context", beforeLine: i + 1, afterLine: j + 1, text: old[i] });
      i++;
      j++;
    } else if (step === "removed") {
      lines.push({ kind: "removed", beforeLine: i + 1, afterLine: null, text: old[i] });
      i++;
      removed++;
    } else {
      lines.push({ kind: "added", beforeLine: null, afterLine: j + 1, text: next[j] });
      j++;
      added++;
    }
  }
  for (; i < old.length; i++, j++) lines.push({ kind: "context", beforeLine: i + 1, afterLine: j + 1, text: old[i] });
  return { status: "ready", added, removed, hunks: toHunks(lines) };
}
