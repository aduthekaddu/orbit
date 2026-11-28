import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { eventually } from "@/lib/eventually.mjs";
import { createToolsStore, ToolsPanel, ToolsProvider, ToolsTrigger, type AvailableTool } from "./tools-sheet";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };
type ToolsStore = ReturnType<typeof createToolsStore>;

const TOOLS: AvailableTool[] = [
  { id: "web_search", label: "Web search" },
  { id: "github", label: "GitHub" },
  { id: "memory", label: "Memory" },
];

const saved = (initialDisabledTools: string[] = []) => createToolsStore({ chatId: "chat-1", initialDisabledTools, draft: false });
const draft = () => createToolsStore({ chatId: "chat-1", initialDisabledTools: [], draft: true });

function Shell({ store, tools, children }: { store: ToolsStore; tools: AvailableTool[]; children: ReactNode }) {
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/c/chat-1">
        <ToolsProvider store={store} availableTools={tools}>
          {children}
        </ToolsProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const paintPanel = (store: ToolsStore, tools = TOOLS, layout: "popover" | "sheet" = "popover") =>
  renderToStaticMarkup(<Shell store={store} tools={tools}><ToolsPanel layout={layout} /></Shell>);
const paintTrigger = (store: ToolsStore, tools = TOOLS) => renderToStaticMarkup(<Shell store={store} tools={tools}><ToolsTrigger /></Shell>);

// --- Reading server markup -------------------------------------------------------------------

const decode = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const textOf = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const startTags = (html: string, pattern: RegExp) => [...html.matchAll(/<[a-zA-Z][^>]*>/g)].map(([tag]) => tag).filter((tag) => pattern.test(tag));
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

type ShownSwitch = { label: string; on: boolean; disabled: boolean };

// Each role="switch" with the text of the <label for> that names it.
function switches(html: string): ShownSwitch[] {
  return startTags(html, /\srole="switch"/).map((tag) => {
    const id = attr(tag, "id");
    assert.ok(id, "each switch has an id for its label");
    const label = new RegExp(`<label[^>]*\\sfor="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html);
    assert.ok(label, `switch ${id} has a <label for>`);
    return { label: textOf(label[1]), on: attr(tag, "aria-checked") === "true", disabled: attr(tag, "disabled") !== null };
  });
}

// The text of the element each role="switch" names in aria-labelledby.
const labelledBy = (html: string) => startTags(html, /\srole="switch"/).map((tag) => {
  const id = attr(tag, "aria-labelledby");
  const named = id ? new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</`).exec(html) : null;
  return named ? textOf(named[1]) : null;
});
const shown = (store: ToolsStore, tools = TOOLS) => switches(paintPanel(store, tools)).map(({ label, on }) => [label, on]);

// The outer HTML of the element whose start tag begins at `start`.
function outer(html: string, start: number) {
  const name = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start))?.[1];
  assert.ok(name, "an element starts here");
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, "g");
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  throw new Error(`<${name}> never closes`);
}

const withRole = (html: string, role: string) =>
  [...html.matchAll(/<[a-zA-Z][^>]*>/g)].filter(([tag]) => new RegExp(`\\srole="${role}"`).test(tag)).map((match) => outer(html, match.index));
const alerts = (html: string) => withRole(html, "alert").map(textOf);

function trigger(html: string) {
  const [tag] = startTags(html, /\sdata-tools-trigger=/);
  assert.ok(tag, "the trigger renders");
  const button = outer(html, html.indexOf(tag));
  return { tag, label: attr(tag, "aria-label"), dots: startTags(button, /\bbg-sun\b/) };
}

// --- Network -------------------------------------------------------------------------------------

type Sent = { path: string; method: string; body: unknown; answer: (response: Response | Error) => void };

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// The chat's stored list on the fake server, which PATCH /api/chats/[id] changes the way the route does.
let stored = new Set<string>();

// Holds every PATCH until the test answers it, and counts how many were out at once. GET /api/chats/[id] answers
// the stored list at once, or fails while `reads.fail` is set.
function serve(initial: string[] = []) {
  stored = new Set(initial);
  const sent: Sent[] = [];
  const counts = { open: 0, most: 0 };
  const reads = { fail: false };
  globalThis.fetch = (input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      if (reads.fail) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(Response.json({ id: "chat-1", title: "New chat", disabledTools: [...stored].sort(), messages: [], headId: null }));
    }
    counts.open += 1;
    counts.most = Math.max(counts.most, counts.open);
    return new Promise<Response>((resolve, reject) => {
      sent.push({
        path: new URL(String(input), "http://orbit.test").pathname,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        answer: (response) => {
          counts.open -= 1;
          if (response instanceof Error) reject(response);
          else resolve(response);
        },
      });
    });
  };
  return { sent, counts, reads };
}

const arrived = (sent: Sent[], count: number) =>
  eventually(() => sent.length, (length) => length >= count, { timeoutMs: 2_000, what: `${count} PATCH request(s)` });

type Switches = { toolsOff: string[]; toolsOn: string[] };

// The server's answer to PATCH /api/chats/[id]: the stored list with the switches applied, in canonical order.
function accept(request: Sent) {
  const { toolsOff, toolsOn } = request.body as Switches;
  for (const id of toolsOff) stored.add(id);
  for (const id of toolsOn) stored.delete(id);
  request.answer(Response.json({ id: "chat-1", title: "New chat", disabledTools: [...stored].sort() }));
}

function assertPatch(request: Sent, switches: Switches) {
  assert.deepEqual({ path: request.path, method: request.method }, { path: "/api/chats/chat-1", method: "PATCH" });
  assert.deepEqual(request.body, switches, "the PATCH carries only the switches that changed");
}

// --- Panel ----------------------------------------------------------------------------------------

test("the panel has one labelled switch per available tool, on unless this chat turned it off", () => {
  const html = paintPanel(saved(["memory"]));
  assert.deepEqual(switches(html), [
    { label: "Web search", on: true, disabled: false },
    { label: "GitHub", on: true, disabled: false },
    { label: "Memory", on: false, disabled: false },
  ]);
  assert.deepEqual(labelledBy(html), ["Web search", "GitHub", "Memory"], "each switch names its tool for assistive tech that skips <label for> on a button");
  assert.doesNotMatch(textOf(html), /Generated UI|Code sandbox/, "only the tools the page passed are listed");
  assert.deepEqual(alerts(html), []);
});

test("a Slice 23 server entry gets a switch like any other tool", () => {
  assert.deepEqual(shown(saved(["mcp:docs"]), [...TOOLS, { id: "mcp:docs", label: "Docs" }]), [
    ["Web search", true],
    ["GitHub", true],
    ["Memory", true],
    ["Docs", false],
  ]);
});

test("with no tools available the panel says so and still links to the Tools page", () => {
  for (const layout of ["popover", "sheet"] as const) {
    const html = paintPanel(saved(), [], layout);
    assert.deepEqual(switches(html), []);
    assert.match(textOf(html), /No tools available/);
    assert.match(html, /<a[^>]*href="\/tools"[^>]*>Tools<\/a>/, `${layout} links to /tools`);
  }
});

test("both layouts link to the Tools page under the switches", () => {
  for (const layout of ["popover", "sheet"] as const) {
    const html = paintPanel(saved(), TOOLS, layout);
    assert.equal(switches(html).length, 3);
    assert.ok(html.lastIndexOf('role="switch"') < html.indexOf('href="/tools"'), `${layout} puts the link after the switches`);
  }
});

// --- Trigger --------------------------------------------------------------------------------------

test("the trigger reads Tools with no dot while every available tool is on", () => {
  const { tag, label, dots } = trigger(paintTrigger(saved()));
  assert.match(tag, /^<button[^>]*\stype="button"/);
  assert.equal(label, "Tools");
  assert.deepEqual(dots, []);
});

test("the trigger counts the available tools this chat turned off and shows the sun dot", () => {
  const { label, dots } = trigger(paintTrigger(saved(["web_search", "memory"])));
  assert.equal(label, "Tools (2 off)");
  assert.equal(dots.length, 1);
  assert.equal(attr(dots[0], "aria-hidden"), "true");
});

test("a tool turned off in this chat but no longer available does not count", () => {
  const { label, dots } = trigger(paintTrigger(saved(["github"]), TOOLS.filter((tool) => tool.id !== "github")));
  assert.equal(label, "Tools");
  assert.deepEqual(dots, []);
});

// --- Draft chats ------------------------------------------------------------------------------------

test("a draft keeps its switches locally, sends no PATCH, and hands the list to the first send", async () => {
  const { sent } = serve();
  const store = draft();
  store.toggle("web_search", false);
  assert.deepEqual(shown(store), [["Web search", false], ["GitHub", true], ["Memory", true]]);
  assert.equal(trigger(paintTrigger(store)).label, "Tools (1 off)");
  await store.flush();
  assert.equal(sent.length, 0, "a draft has no chats row to PATCH");
  assert.deepEqual(store.draftDisabledTools(), ["web_search"]);
});

test("the switches lock while a draft's first send creates the chat, then save through PATCH", async () => {
  const { sent } = serve(["web_search"]);
  const store = draft();
  store.toggle("web_search", false);
  store.sendStarted();
  assert.ok(switches(paintPanel(store)).every((item) => item.disabled), "every switch is disabled while the chat is created");
  await store.flush();
  assert.equal(sent.length, 0);

  store.chatCreated();
  assert.ok(switches(paintPanel(store)).every((item) => !item.disabled));
  assert.equal(store.draftDisabledTools(), undefined, "a saved chat's send carries no list");
  store.toggle("memory", false);
  await arrived(sent, 1);
  assertPatch(sent[0], { toolsOff: ["memory"], toolsOn: [] });
  accept(sent[0]);
  await store.flush();
  assert.deepEqual(shown(store), [["Web search", false], ["GitHub", true], ["Memory", false]]);
});

test("a first send that fails before the chat exists unlocks the switches and keeps the draft", async () => {
  const { sent } = serve();
  const store = draft();
  store.sendStarted();
  store.sendFinished();
  assert.ok(switches(paintPanel(store)).every((item) => !item.disabled));
  store.toggle("github", false);
  await store.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(store.draftDisabledTools(), ["github"]);
});

// --- Saved chats ------------------------------------------------------------------------------------

test("a saved chat sends one PATCH at a time and folds clicks made meanwhile into one follow-up", async () => {
  const { sent, counts } = serve();
  const store = saved();
  store.toggle("web_search", false);
  await arrived(sent, 1);
  assertPatch(sent[0], { toolsOff: ["web_search"], toolsOn: [] });

  store.toggle("memory", false);
  store.toggle("memory", true);
  store.toggle("github", false);
  assert.deepEqual(shown(store), [["Web search", false], ["GitHub", false], ["Memory", true]], "the switches move at once");

  accept(sent[0]);
  await arrived(sent, 2);
  assertPatch(sent[1], { toolsOff: ["github"], toolsOn: [] });
  accept(sent[1]);
  await store.flush();
  assert.equal(sent.length, 2, "the memory clicks cancel out and send nothing");
  assert.equal(counts.most, 1, "never more than one PATCH in flight");
  assert.deepEqual(shown(store), [["Web search", false], ["GitHub", false], ["Memory", true]]);
});

test("a saved chat's PATCH carries only the switches that changed, however long the stored list is", async () => {
  const servers = Array.from({ length: 60 }, (_, index) => `mcp:${"s".repeat(70)}-${index}`);
  const { sent } = serve(["github", "memory", ...servers]);
  const store = saved(["github", "memory", ...servers]);
  store.toggle("web_search", false);
  store.toggle("memory", true);
  await arrived(sent, 1);
  assertPatch(sent[0], { toolsOff: ["web_search"], toolsOn: [] });
  store.toggle("web_search", true);
  accept(sent[0]);
  await arrived(sent, 2);
  assertPatch(sent[1], { toolsOff: [], toolsOn: ["memory", "web_search"] });
  assert.ok(JSON.stringify(sent[1].body).length < 4096, "the body stays under the route's 4096-byte cap");
  accept(sent[1]);
  await store.flush();
  assert.deepEqual([...store.getSnapshot().committed].sort(), ["github", ...servers].sort(), "entries for tools not available right now stay");
});

test("a failed PATCH puts the switch back and shows Could not save tools. until the next save works", async () => {
  const { sent } = serve();
  const store = saved();
  store.toggle("web_search", false);
  await arrived(sent, 1);
  assert.deepEqual(shown(store)[0], ["Web search", false]);
  assert.equal(trigger(paintTrigger(store)).label, "Tools (1 off)");

  sent[0].answer(Response.json({ error: "Internal error" }, { status: 500 }));
  await store.flush();
  for (const layout of ["popover", "sheet"] as const) {
    const html = paintPanel(store, TOOLS, layout);
    assert.deepEqual(switches(html).map(({ label, on }) => [label, on]), [["Web search", true], ["GitHub", true], ["Memory", true]]);
    assert.deepEqual(alerts(html), ["Could not save tools."], `${layout} shows the error`);
  }
  assert.equal(trigger(paintTrigger(store)).label, "Tools");

  store.toggle("memory", false);
  await arrived(sent, 2);
  accept(sent[1]);
  await store.flush();
  assert.deepEqual(alerts(paintPanel(store)), []);
  assert.deepEqual(shown(store), [["Web search", true], ["GitHub", true], ["Memory", false]]);
});

test("a PATCH that saved but lost its answer leaves the switch as the server saved it", async () => {
  const { sent } = serve(["memory"]);
  const store = saved(["memory"]);
  store.toggle("memory", true);
  await arrived(sent, 1);
  stored.delete("memory");
  sent[0].answer(new TypeError("Failed to fetch"));
  await store.flush();
  assert.deepEqual(shown(store)[2], ["Memory", true]);
  assert.deepEqual(alerts(paintPanel(store)), [], "nothing failed to save");
  assert.equal(sent.length, 1);
});

test("a PATCH lost on the network rolls back the same way when the chat cannot be read either", async () => {
  const { sent, reads } = serve(["memory"]);
  const store = saved(["memory"]);
  store.toggle("memory", true);
  await arrived(sent, 1);
  reads.fail = true;
  sent[0].answer(new TypeError("Failed to fetch"));
  await store.flush();
  assert.deepEqual(shown(store)[2], ["Memory", false]);
  assert.deepEqual(alerts(paintPanel(store)), ["Could not save tools."]);
});

test("when a PATCH fails, only what it carried goes back and a click made meanwhile still saves", async () => {
  const { sent } = serve();
  const store = saved();
  store.toggle("web_search", false);
  await arrived(sent, 1);
  store.toggle("memory", false);
  sent[0].answer(Response.json({ error: "Internal error" }, { status: 500 }));
  await arrived(sent, 2);
  assertPatch(sent[1], { toolsOff: ["memory"], toolsOn: [] });
  accept(sent[1]);
  await store.flush();
  assert.deepEqual(shown(store), [["Web search", true], ["GitHub", true], ["Memory", false]]);
});

test("a saved chat keeps its switches usable while a reply streams", async () => {
  const { sent } = serve();
  const store = saved();
  store.sendStarted();
  assert.ok(switches(paintPanel(store)).every((item) => !item.disabled));
  store.toggle("web_search", false);
  await arrived(sent, 1);
  assertPatch(sent[0], { toolsOff: ["web_search"], toolsOn: [] });
  accept(sent[0]);
  store.sendFinished();
  await store.flush();
});

// --- Send ordering (orbitChatTransport beforeSend) -----------------------------------------------

test("flush waits for every queued PATCH, so the next send uses the saved switches", async () => {
  const { sent } = serve();
  const store = saved();
  store.toggle("web_search", false);
  await arrived(sent, 1);
  store.toggle("memory", false);
  let flushed = false;
  const flushing = store.flush().then(() => {
    flushed = true;
  });
  accept(sent[0]);
  await arrived(sent, 2);
  assert.equal(flushed, false, "flush still waits for the follow-up PATCH");
  accept(sent[1]);
  await flushing;
  assert.equal(flushed, true);
});

test("flush resolves after a failed PATCH so the send still goes", async () => {
  const { sent } = serve();
  const store = saved();
  store.toggle("web_search", false);
  await arrived(sent, 1);
  const flushing = store.flush();
  sent[0].answer(new Response("<html>Bad Gateway</html>", { status: 502 }));
  await flushing;
  assert.deepEqual(shown(store)[0], ["Web search", true]);
});

test("flush with nothing to save sends nothing", async () => {
  const { sent } = serve();
  await saved(["memory"]).flush();
  await draft().flush();
  assert.equal(sent.length, 0);
});
