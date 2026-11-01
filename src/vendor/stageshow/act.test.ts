import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "commonjs", source: "module.exports = {}", shortCircuit: true };
    return nextLoad(url, context);
  },
});

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { ActEnv } from "./act";
import type { Keys } from "./keys";
import type { Layout } from "./looks";

const actModule = import("./act");

type State = { text: string };

class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly events: string[] = [];
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  offsetWidth = 100;
  clientLeft = 0;
  clientTop = 0;

  constructor(readonly target?: string) {
    if (target) this.attrs.set("data-target", target);
  }

  setAttribute(name: string, value = "") {
    this.events.push(name);
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attrs.has(name);
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
  }

  querySelector(selector: string) {
    const match = /^\[data-target="(.+)"\]$/.exec(selector);
    return (match && this.children.find((child) => child.target === match[1])) || null;
  }

  querySelectorAll() {
    return [];
  }

  contains(node: unknown) {
    for (let n = node as FakeElement | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }

  append(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
}

function envFor(root: FakeElement, cursorEl: FakeElement, layout: Layout = "wide") {
  let state: State = { text: "" };
  const seen: string[] = [];
  const keys: Keys = { id: 0, caps: [], show: false, down: false };
  const env: ActEnv<State> = {
    rootRef: { current: root as unknown as HTMLDivElement },
    cursorRef: { current: cursorEl as unknown as HTMLDivElement },
    pos: { current: { x: 0, y: 0 } },
    hovered: { current: null },
    kindRef: { current: "pointer" },
    keysRef: { current: keys },
    dragging: { current: false },
    autoUsed: { current: false },
    autoRef: { current: null },
    scaleRef: { current: 1 },
    speed: 1,
    layout,
    cursor: { style: "touch" },
    resolve: () => ({ x: 100, y: 100 }),
    place: () => {},
    remeasure: () => {},
    ripple: () => {},
    setState: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
      seen.push(state.text);
    },
    setKind: () => {},
    setKeys: () => {},
    setLastKeys: () => {},
  };
  return { env, seen };
}

const host = globalThis as any;
let realWindow: unknown;
let realRaf: unknown;
let realCancelRaf: unknown;

before(() => {
  realWindow = host.window;
  realRaf = host.requestAnimationFrame;
  realCancelRaf = host.cancelAnimationFrame;
  host.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  host.requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0);
  host.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

after(() => {
  host.window = realWindow;
  host.requestAnimationFrame = realRaf;
  host.cancelAnimationFrame = realCancelRaf;
});

test("type never leaves half an emoji in state", async () => {
  const { createAct } = await actModule;
  const { env, seen } = envFor(new FakeElement(), new FakeElement());
  const act = createAct(new AbortController().signal, env);

  await act.type("text", "a😀b", { interval: 0 });

  assert.equal(seen.at(-1), "a😀b");
  for (const value of seen) {
    assert.ok("a😀b".startsWith(value), `not a prefix of the text: ${JSON.stringify(value)}`);
    assert.ok(value.isWellFormed(), `state held a lone surrogate: ${JSON.stringify(value)}`);
  }
});

test("an aborted drag drops the touch dot", async () => {
  const { createAct, Stopped } = await actModule;
  const cursor = new FakeElement();
  const { env } = envFor(new FakeElement(), cursor);
  const controller = new AbortController();
  const act = createAct(controller.signal, env);

  const run = act.drag({ x: 100, y: 100 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cursor.hasAttribute("data-touching"), true, "the finger lands");
  controller.abort();
  await assert.rejects(run, (error) => error instanceof Stopped);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(cursor.hasAttribute("data-touching"), false, "the finger leaves with the stage");
});

for (const layout of ["wide", "compact"] as const) {
  test(`move and click use the ${layout} target of a per-layout pair`, async () => {
    const { createAct } = await actModule;
    const root = new FakeElement();
    const wide = root.append(new FakeElement("wide-btn"));
    const compact = root.append(new FakeElement("compact-btn"));
    const { env } = envFor(root, new FakeElement(), layout);
    const act = createAct(new AbortController().signal, env);
    const target = { wide: "wide-btn", compact: "compact-btn" };
    const chosen = layout === "compact" ? compact : wide;
    const other = layout === "compact" ? wide : compact;

    await act.move(target, { duration: 1 });
    assert.ok(chosen.events.includes("data-hover"), "the chosen target hovers");
    assert.ok(!other.events.includes("data-hover"), "the other layout's target stays still");

    await act.click(target);
    assert.ok(chosen.events.includes("data-pressed"), "the chosen target is pressed");
    assert.ok(!other.events.includes("data-pressed"), "the other layout's target is not pressed");
  });
}
