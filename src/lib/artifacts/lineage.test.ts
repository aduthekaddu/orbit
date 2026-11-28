import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactKind } from "./detect";
import { lineageFor, type ArtifactCandidate, type ExistingArtifact, type MessageNode } from "./lineage";

let clock = 0;
const user = (id: string, parentId: string | null): MessageNode => ({ id, parentId, role: "user", createdAt: ++clock });
const reply = (id: string, parentId: string): MessageNode => ({ id, parentId, role: "assistant", createdAt: ++clock });

let seq = 0;
function stored(
  message: MessageNode,
  lineageId: string,
  derivedTitle: string,
  { kind = "html", position = 0, userTitle = null }: { kind?: ArtifactKind; position?: number; userTitle?: string | null } = {},
): ExistingArtifact {
  return {
    id: `${message.id}-${position}`, messageId: message.id, textOrdinal: 0, blockIndex: position, artifactPosition: position,
    kind, derivedTitle, userTitle, lineageId, createdAt: message.createdAt, seq: ++seq,
  };
}

function block(message: MessageNode, derivedTitle: string, { kind = "html", position = 0 }: { kind?: ArtifactKind; position?: number } = {}): ArtifactCandidate {
  return { messageId: message.id, textOrdinal: 0, blockIndex: position, artifactPosition: position, kind, derivedTitle };
}

const join = (lineageId: string, userTitle: string | null = null) => ({ kind: "join", lineageId, userTitle });
const fresh = { kind: "new" };

test("a regeneration joins the earlier reply's artifact at the same position even when its title changed", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const earlier = [stored(first, "L1", "Counter", { userTitle: "Tally" })];
  assert.deepEqual(lineageFor(block(second, "Clicker"), [prompt, first, second], earlier), join("L1", "Tally"));
});

test("a regeneration of an untitled artifact joins by position", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const earlier = [stored(first, "L1", "HTML page")];
  assert.deepEqual(lineageFor(block(second, "HTML page"), [prompt, first, second], earlier), join("L1"));
});

test("a reply to an edited first prompt joins the original reply's artifact by position", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const edited = user("p2", null);
  const second = reply("a2", edited.id);
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(second, "Clicker"), [prompt, first, edited, second], earlier), join("L1"));
});

test("a reply to an edited later prompt joins the original reply's artifact by position", () => {
  const opening = user("p0", null);
  const intro = reply("a0", opening.id);
  const prompt = user("p1", intro.id);
  const first = reply("a1", prompt.id);
  const edited = user("p1b", intro.id);
  const second = reply("a2", edited.id);
  const tree = [opening, intro, prompt, first, edited, second];
  const earlier = [stored(intro, "L0", "Intro"), stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(second, "Clicker"), tree, earlier), join("L1"));
});

test("a follow-up with the same title joins that lineage and inherits its rename", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = reply("a2", next.id);
  const earlier = [stored(first, "L1", "Counter", { userTitle: "Tally" })];
  assert.deepEqual(lineageFor(block(second, "Counter"), [prompt, first, next, second], earlier), join("L1", "Tally"));
});

test("a follow-up whose title is the user's rename joins that lineage, ignoring case and outer space", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = reply("a2", next.id);
  const earlier = [stored(first, "L1", "Counter", { userTitle: " TALLY " })];
  assert.deepEqual(lineageFor(block(second, "tally"), [prompt, first, next, second], earlier), join("L1", " TALLY "));
});

test("a follow-up with a different title starts a new lineage, since only regenerations and edits join by position", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = reply("a2", next.id);
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(second, "Chart"), [prompt, first, next, second], earlier), fresh);
});

test("two untitled follow-up artifacts never merge on a fallback title", () => {
  for (const [kind, fallback] of [["html", "HTML page"], ["svg", "SVG image"], ["react", "React component"]] as const) {
    const prompt = user(`${kind}-p1`, null);
    const first = reply(`${kind}-a1`, prompt.id);
    const next = user(`${kind}-p2`, first.id);
    const second = reply(`${kind}-a2`, next.id);
    const earlier = [stored(first, `${kind}-L1`, fallback, { kind })];
    assert.deepEqual(lineageFor(block(second, fallback, { kind }), [prompt, first, next, second], earlier), fresh, kind);
  }
});

test("an artifact on a branch that split off earlier does not join a lineage on another branch", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = reply("a2", next.id);
  const editedOpening = user("p1b", null);
  const otherFirst = reply("a1b", editedOpening.id);
  const otherNext = user("p3", otherFirst.id);
  const third = reply("a3", otherNext.id);
  const tree = [prompt, first, next, second, editedOpening, otherFirst, otherNext, third];
  const earlier = [stored(second, "L2", "Counter")];
  assert.deepEqual(lineageFor(block(third, "Counter"), tree, earlier), fresh);
});

test("a title match joins the newest matching relative", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = reply("a2", next.id);
  const last = user("p3", second.id);
  const third = reply("a3", last.id);
  const tree = [prompt, first, next, second, last, third];
  const earlier = [stored(first, "L1", "Counter"), stored(second, "L2", "Counter")];
  assert.deepEqual(lineageFor(block(third, "Counter"), tree, earlier), join("L2"));
});

test("between two matches saved at the same time, the later row wins", () => {
  const prompt = user("p1", null);
  const first = reply("a1", prompt.id);
  const next = user("p2", first.id);
  const second = { ...reply("a2", next.id), createdAt: first.createdAt };
  const last = user("p3", second.id);
  const third = reply("a3", last.id);
  const tree = [prompt, first, next, second, last, third];
  const earlier = [stored(second, "L-second", "Counter"), stored(first, "L-first", "Counter")];
  assert.deepEqual(lineageFor(block(third, "Counter"), tree, earlier), join("L-first"));
});

test("a regeneration that reorders two artifacts keeps each in its own lineage by title", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const tree = [prompt, first, second];
  const earlier = [stored(first, "L-counter", "Counter"), stored(first, "L-chart", "Chart", { position: 1 })];
  const chart = lineageFor(block(second, "Chart"), tree, earlier);
  assert.deepEqual(chart, join("L-chart"));
  assert.deepEqual(lineageFor(block(second, "Counter", { position: 1 }), tree, earlier, new Set(["L-chart"])), join("L-counter"));
});

test("two artifacts in one reply never share a lineage", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const tree = [prompt, first, second];
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(second, "Counter"), tree, earlier), join("L1"));
  assert.deepEqual(lineageFor(block(second, "Counter", { position: 1 }), tree, earlier, new Set(["L1"])), fresh);
});

test("a regeneration joins the newest relative that has the same kind at the same position", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const third = reply("a3", prompt.id);
  const tree = [prompt, first, second, third];
  const earlier = [
    stored(first, "L-chart", "Chart"),
    stored(second, "L-drawing", "Drawing", { kind: "svg" }),
    stored(second, "L-notes", "Notes", { position: 1 }),
  ];
  assert.deepEqual(lineageFor(block(third, "Graph"), tree, earlier), join("L-chart"));
});

test("a regeneration with a different kind at the same position starts a new lineage", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const second = reply("a2", prompt.id);
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(second, "Counter", { kind: "svg" }), [prompt, first, second], earlier), fresh);
});

test("rows of the candidate's own message never count as an earlier version", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(first, "Counter", { position: 1 }), [prompt, first], earlier), fresh);
});

test("a reply or prompt missing from the tree starts a new lineage", () => {
  const prompt = user("p", null);
  const first = reply("a1", prompt.id);
  const orphan = reply("a2", "gone");
  const earlier = [stored(first, "L1", "Counter")];
  assert.deepEqual(lineageFor(block(orphan, "Counter"), [prompt, first, orphan], earlier), fresh);
  assert.deepEqual(lineageFor(block(reply("a3", prompt.id), "Counter"), [prompt, first], earlier), fresh);
});
