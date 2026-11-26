import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_APPEARANCE,
  appearanceAttributes,
  colorSchemeFor,
  nextPatch,
  parseAppearance,
  reduceSaveQueue,
  saveQueue,
  shownAppearance,
  themeColorFor,
  type Appearance,
  type SaveQueue,
  type SaveQueueEvent,
} from "./appearance";

test("appearanceAttributes turns each choice into one data attribute", () => {
  assert.deepEqual(appearanceAttributes(DEFAULT_APPEARANCE), {
    "data-theme": "dark",
    "data-text-size": "md",
    "data-reply-font": "sans",
    "data-chat-width": "normal",
    "data-accent": "sun",
  });
});

test("parseAppearance keeps known values and falls back per field", () => {
  assert.deepEqual(parseAppearance({ theme: "neon", textSize: "lg" }), { ...DEFAULT_APPEARANCE, textSize: "lg" });
  assert.deepEqual(parseAppearance({ theme: "light", textSize: 3, replyFont: "serif", chatWidth: "wide", accent: "rose", userId: "u" }), {
    theme: "light",
    textSize: "md",
    replyFont: "serif",
    chatWidth: "wide",
    accent: "rose",
  });
  assert.deepEqual(parseAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance("dark"), DEFAULT_APPEARANCE);
});

test("themeColorFor gives one color per fixed theme and two media entries for system", () => {
  assert.equal(themeColorFor("dark"), "#0b0c0f");
  const system = themeColorFor("system");
  assert.ok(Array.isArray(system));
  assert.deepEqual(
    system.map((entry) => entry.media),
    ["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"],
  );
  assert.deepEqual(
    system.map((entry) => entry.color),
    [themeColorFor("light"), themeColorFor("dark")],
  );
});

test("colorSchemeFor tells the browser which form controls to draw", () => {
  assert.equal(colorSchemeFor("dark"), "dark");
  assert.equal(colorSchemeFor("dim"), "dark");
  assert.equal(colorSchemeFor("light"), "light");
  assert.equal(colorSchemeFor("system"), "light dark");
});

// Drives the queue the way the Appearance card does: after every event, send whatever is waiting.
function run(start: Appearance, events: (SaveQueueEvent | "server-ok" | "server-fail")[], server = { ...start }) {
  let queue: SaveQueue = saveQueue(start);
  const sent: Partial<Appearance>[] = [];
  const flush = () => {
    const patch = nextPatch(queue);
    if (!patch) return;
    sent.push(patch);
    queue = reduceSaveQueue(queue, { type: "send" });
  };
  for (const event of events) {
    if (event === "server-ok") {
      Object.assign(server, queue.inFlight);
      queue = reduceSaveQueue(queue, { type: "saved", appearance: { ...server } });
    } else if (event === "server-fail") {
      queue = reduceSaveQueue(queue, { type: "failed", error: "Could not save" });
    } else {
      queue = reduceSaveQueue(queue, event);
    }
    flush();
  }
  return { queue, sent, server };
}

const select = (patch: Partial<Appearance>): SaveQueueEvent => ({ type: "select", patch });

test("rapid clicks on one field send at most two ordered saves that end on the last choice", () => {
  const { queue, sent, server } = run(DEFAULT_APPEARANCE, [
    select({ theme: "light" }),
    select({ theme: "dim" }),
    select({ theme: "system" }),
    "server-ok",
    "server-ok",
  ]);
  assert.deepEqual(sent, [{ theme: "light" }, { theme: "system" }]);
  assert.equal(server.theme, "system");
  assert.deepEqual(shownAppearance(queue), { ...DEFAULT_APPEARANCE, theme: "system" });
  assert.equal(queue.inFlight, null);
});

test("clicks on other fields while a save is out go together in one follow-up save", () => {
  const { sent, server, queue } = run(DEFAULT_APPEARANCE, [
    select({ theme: "dim" }),
    select({ textSize: "lg" }),
    select({ replyFont: "serif" }),
    select({ accent: "sky" }),
    "server-ok",
    "server-ok",
  ]);
  assert.deepEqual(sent, [{ theme: "dim" }, { textSize: "lg", replyFont: "serif", accent: "sky" }]);
  assert.deepEqual(server, { theme: "dim", textSize: "lg", replyFont: "serif", chatWidth: "normal", accent: "sky" });
  assert.deepEqual(queue.committed, server);
});

test("choosing the saved value again while idle sends nothing", () => {
  const { sent } = run(DEFAULT_APPEARANCE, [select({ theme: "dark" })]);
  assert.deepEqual(sent, []);
});

test("switching back to the saved value while a save is out sends it back", () => {
  const { sent, server } = run(DEFAULT_APPEARANCE, [select({ theme: "light" }), select({ theme: "dark" }), "server-ok", "server-ok"]);
  assert.deepEqual(sent, [{ theme: "light" }, { theme: "dark" }]);
  assert.equal(server.theme, "dark");
});

test("a failed save puts back only what it carried and keeps earlier saves", () => {
  const { queue } = run(DEFAULT_APPEARANCE, [
    select({ theme: "dim" }),
    select({ textSize: "lg" }),
    "server-ok",
    "server-fail",
  ]);
  assert.deepEqual(shownAppearance(queue), { ...DEFAULT_APPEARANCE, theme: "dim" });
  assert.equal(queue.error, "Could not save");
  assert.equal(queue.inFlight, null);
});

test("the next click clears the error", () => {
  const { queue } = run(DEFAULT_APPEARANCE, [select({ theme: "light" }), "server-fail", select({ accent: "rose" })]);
  assert.equal(queue.error, null);
  assert.deepEqual(queue.inFlight, { accent: "rose" });
});

test("a save keeps another tab's change to a field this card did not touch", () => {
  const server = { ...DEFAULT_APPEARANCE, accent: "sand" as const };
  const { queue } = run(DEFAULT_APPEARANCE, [select({ theme: "light" }), "server-ok"], server);
  assert.deepEqual(shownAppearance(queue), { ...DEFAULT_APPEARANCE, theme: "light", accent: "sand" });
});
