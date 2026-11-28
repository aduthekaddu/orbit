import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { eventually } from "@/lib/eventually.mjs";
import type { ToolCheckResponse, ToolInspection, ToolView } from "@/lib/tools/status";
import { createToolsList, relativeTime, ToolsList, ToolsListView } from "./tools-list";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "b1" };
const AT = "2026-11-28T10:00:00.000Z";
type ToolsListStore = ReturnType<typeof createToolsList>;

// One view per tool as `/tools` shows it to an admin on a fresh Personal instance with ORBIT_SANDBOX unset.
const START: Record<ToolView["id"], ToolView> = {
  web_search: { id: "web_search", label: "Web search", scope: "instance", setup: { state: "missing", configure: "admin" }, health: { state: "untested" }, status: "off", canTest: false, toggleable: true, configureHref: "/admin#search" },
  run_code: { id: "run_code", label: "Code sandbox", scope: "instance", setup: { state: "server-off" }, health: { state: "untested" }, status: "off", canTest: false, toggleable: true, configureHref: null },
  github: { id: "github", label: "GitHub", scope: "personal", setup: { state: "missing", configure: "self" }, health: { state: "untested" }, status: "off", canTest: false, toggleable: true, configureHref: "/settings#github" },
  memory: { id: "memory", label: "Memory", scope: "personal", setup: { state: "ready" }, health: { state: "untested" }, status: "untested", canTest: true, toggleable: true, configureHref: "/settings#memory" },
  render_ui: { id: "render_ui", label: "Generated UI", scope: "built-in", setup: { state: "ready" }, health: { state: "untested" }, status: "ready", canTest: false, toggleable: false, configureHref: null },
};
const ALL = Object.values(START);

const readySearch: ToolView = { ...START.web_search, setup: { state: "ready" }, status: "untested", canTest: true };
const working = (tool: ToolView, lastGoodAt = AT): ToolView => ({ ...tool, health: { state: "working", lastGoodAt }, status: "working" });
const failing = (tool: ToolView, error: string): ToolView => ({ ...tool, health: { state: "failing", lastGoodAt: null, failedAt: AT, error }, status: "failing" });
const readyGithub: ToolView = { ...START.github, setup: { state: "ready" }, status: "untested", canTest: true };

const WEB_SCHEMA = {
  type: "object",
  properties: { query: { type: "string", minLength: 1, maxLength: 400 } },
  required: ["query"],
  additionalProperties: false,
};
const SEARCH_INSTRUCTION = "Use web_search for recent events, prices, or facts you are unsure of. Cite sources as markdown links to result URLs.";
const WEB_INSPECTION: ToolInspection = {
  id: "web_search",
  setup: { state: "ready" },
  instruction: SEARCH_INSTRUCTION,
  tools: [{ name: "web_search", description: "Search the web for current information.", inputSchema: WEB_SCHEMA }],
};
const MEMORY_INSPECTION: ToolInspection = {
  id: "memory",
  setup: { state: "ready" },
  instruction: "Call remember only when the user states a lasting fact or preference.",
  tools: [
    { name: "forget", description: "Remove one saved memory by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "remember", description: "Save a lasting fact.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ],
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/tools">{children}</PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const paintPage = (initial: ToolView[]) => renderToStaticMarkup(<Shell><ToolsList initial={initial} /></Shell>);
const paint = (list: ToolsListStore) => renderToStaticMarkup(<Shell><ToolsListView list={list} /></Shell>);

// --- Reading server markup -------------------------------------------------------------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// Every element whose start tag passes `keep`, as outer HTML in document order.
function elements(html: string, keep: (tag: string, attrs: string) => boolean): string[] {
  return located(html, keep).map((entry) => entry.html);
}

function located(html: string, keep: (tag: string, attrs: string) => boolean) {
  const found: { start: number; end: number; html: string }[] = [];
  const open: { name: string; start: number; keep: boolean }[] = [];
  const tags = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const [whole, closing, rawName, attrs, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      const index = open.findLastIndex((entry) => entry.name === name);
      if (index === -1) continue;
      const [entry] = open.splice(index);
      const end = match.index + whole.length;
      if (entry.keep) found.push({ start: entry.start, end, html: html.slice(entry.start, end) });
      continue;
    }
    const kept = keep(name, attrs);
    if (selfClosing || VOID.has(name)) {
      if (kept) found.push({ start: match.index, end: match.index + whole.length, html: whole });
      continue;
    }
    open.push({ name, start: match.index, keep: kept });
  }
  return found.sort((a, b) => a.start - b.start);
}

function attr(element: string, name: string) {
  const start = /^<[^>]*>/.exec(element)?.[0] ?? "";
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(start)?.[1];
  return value === undefined ? null : value.replaceAll("&amp;", "&");
}

const decode = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// Visible text, with `joiner` between tags. "" keeps words that one element splits into spans together.
function textOf(html: string, joiner = "") {
  return decode(html.replace(/<[^>]+>/g, joiner)).replace(/\s+/g, " ").trim();
}

function rowOf(html: string, id: string) {
  const rows = elements(html, (tag, attrs) => tag === "li" && attrs.includes(`data-tool-row="${id}"`));
  assert.equal(rows.length, 1, `one row for ${id}`);
  return rows[0];
}

const withRole = (html: string, role: string) => elements(html, (_tag, attrs) => new RegExp(`\\srole="${role}"`).test(attrs));
const buttons = (html: string) => elements(html, (tag) => tag === "button");
const links = (html: string) => elements(html, (tag, attrs) => tag === "a" && /\shref="/.test(attrs));
const named = (items: string[], name: string) => items.filter((item) => textOf(item) === name);

function expandButton(row: string) {
  const [button] = elements(row, (tag, attrs) => tag === "button" && /\saria-expanded="/.test(attrs));
  assert.ok(button, "the row has an expand button");
  return button;
}

function testButton(row: string) {
  const found = buttons(row).filter((button) => ["Test", "Testing"].includes(textOf(button)));
  assert.equal(found.length, 1, "the row has one Test button");
  return found[0];
}

const STATUS_WORDS = ["Working", "Failing", "Not tested", "Off", "On"];
const statusWords = (html: string) => STATUS_WORDS.filter((word) => new RegExp(`(^|[^A-Za-z])${word}($|[^A-Za-z])`).test(textOf(html, " ")));
const isDisabled = (element: string) => attr(element, "disabled") !== null;

// --- Network -------------------------------------------------------------------------------------

type Sent = { path: string; method: string; answer: (response: Response | Error) => void };

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// Holds every request until the test answers it.
function serve() {
  const sent: Sent[] = [];
  globalThis.fetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      sent.push({
        path: new URL(String(input), "http://orbit.test").pathname,
        method: init?.method ?? "GET",
        answer: (response) => (response instanceof Error ? reject(response) : resolve(response)),
      });
    });
  return sent;
}

const arrived = (sent: Sent[], count: number) =>
  eventually(() => sent.length, (length) => length >= count, { timeoutMs: 2_000, what: `${count} request(s) from the tools list` });
const json = (body: unknown, status = 200) => Response.json(body, { status });
const checked = (body: ToolCheckResponse) => json(body);

async function testRow(list: ToolsListStore, sent: Sent[], id: ToolView["id"], response: Response | Error) {
  const before = sent.length;
  const done = list.test(id);
  await arrived(sent, before + 1);
  assert.deepEqual({ path: sent[before].path, method: sent[before].method }, { path: `/api/tools/${id}/test`, method: "POST" });
  sent[before].answer(response);
  await done;
}

async function openRow(list: ToolsListStore, sent: Sent[], id: ToolView["id"], response: Response | Error) {
  const before = sent.length;
  const done = list.toggle(id);
  await arrived(sent, before + 1);
  assert.deepEqual({ path: sent[before].path, method: sent[before].method }, { path: `/api/tools/${id}`, method: "GET" });
  sent[before].answer(response);
  await done;
}

// --- First paint ------------------------------------------------------------------------------

test("the page lists the five tools in order, one row each", () => {
  const html = paintPage(ALL);
  const rows = elements(html, (tag, attrs) => tag === "li" && /\sdata-tool-row="/.test(attrs)).map((row) => attr(row, "data-tool-row"));
  assert.deepEqual(rows, ["web_search", "run_code", "github", "memory", "render_ui"]);
});

test("each row's button names the tool and shows exactly one status word", () => {
  const html = paintPage([working(readySearch), START.run_code, failing(readyGithub, "GitHub rejected the token."), START.memory, START.render_ui]);
  const expected: [ToolView["id"], string, string][] = [
    ["web_search", "Web search", "Working"],
    ["run_code", "Code sandbox", "Off"],
    ["github", "GitHub", "Failing"],
    ["memory", "Memory", "Not tested"],
    ["render_ui", "Generated UI", "On"],
  ];
  for (const [id, label, word] of expected) {
    const button = expandButton(rowOf(html, id));
    assert.match(textOf(button, " "), new RegExp(`^${label}\\b`), `${id} button starts with its label`);
    assert.deepEqual(statusWords(button), [word], `${id} shows ${word}`);
  }
});

test("the status dot is positive for Working and On, destructive for Failing, and muted for Off and Not tested", () => {
  const html = paintPage([working(readySearch), START.run_code, failing(readyGithub, "GitHub rejected the token."), START.memory, START.render_ui]);
  const dots = { positive: /\bbg-positive\b/, destructive: /\bbg-destructive\b/, muted: /\bbg-muted-foreground\/60\b/ };
  const expected: Record<ToolView["id"], keyof typeof dots> = { web_search: "positive", run_code: "muted", github: "destructive", memory: "muted", render_ui: "positive" };
  for (const [id, tone] of Object.entries(expected)) {
    const button = expandButton(rowOf(html, id));
    const tones = Object.entries(dots).filter(([, pattern]) => pattern.test(button)).map(([name]) => name);
    assert.deepEqual(tones, [tone], `${id} dot`);
  }
});

test("a row offers Test when it can test, Set up when it is off and has a place to set it up, and nothing otherwise", () => {
  const html = paintPage(ALL);
  const action = (id: ToolView["id"]) => {
    const row = rowOf(html, id);
    return {
      test: named(buttons(row), "Test").length,
      setUp: named(links(row), "Set up").map((link) => attr(link, "href")),
    };
  };
  assert.deepEqual(action("web_search"), { test: 0, setUp: ["/admin#search"] });
  assert.deepEqual(action("run_code"), { test: 0, setUp: [] });
  assert.deepEqual(action("github"), { test: 0, setUp: ["/settings#github"] });
  assert.deepEqual(action("memory"), { test: 1, setUp: [] });
  assert.deepEqual(action("render_ui"), { test: 0, setUp: [] });
});

test("a member sees Test on a ready instance tool and no link to Admin anywhere", () => {
  const memberSearch: ToolView = { ...readySearch, configureHref: null };
  const memberSearchOff: ToolView = { ...START.web_search, configureHref: null };
  const memberSandboxOff: ToolView = { ...START.run_code, setup: { state: "disabled", configure: "admin" }, configureHref: null };
  for (const tool of [memberSearch, memberSearchOff, memberSandboxOff]) {
    const row = rowOf(paintPage([tool]), tool.id);
    assert.deepEqual(links(row), [], `${tool.id} has no link for a member`);
    assert.doesNotMatch(row, /\/admin/);
    assert.doesNotMatch(textOf(row, " "), /unreadable/);
  }
  assert.equal(named(buttons(rowOf(paintPage([memberSearch]), "web_search")), "Test").length, 1);
});

test("an unreadable saved key or token shows one destructive line on its row", () => {
  const html = paintPage([
    { ...START.web_search, setup: { state: "unreadable", configure: "admin" } },
    { ...START.github, setup: { state: "unreadable", configure: "self" } },
    START.memory,
  ]);
  const line = (id: ToolView["id"], text: string) => elements(rowOf(html, id), (_tag, attrs) => /\btext-destructive\b/.test(attrs)).filter((element) => textOf(element) === text);
  assert.equal(line("web_search", "Key unreadable").length, 1);
  assert.equal(line("github", "Token unreadable").length, 1);
  assert.deepEqual(statusWords(expandButton(rowOf(html, "github"))), ["Off"]);
  assert.doesNotMatch(textOf(rowOf(html, "memory"), " "), /unreadable/);
  assert.doesNotMatch(textOf(paintPage([START.github]), " "), /unreadable/, "a missing token is not an unreadable one");
});

test("a tool the server saw failing shows its stored error as an alert with an icon", () => {
  const html = paintPage([failing(readyGithub, "GitHub rejected the token."), working(readySearch)]);
  const alerts = withRole(rowOf(html, "github"), "alert");
  assert.equal(alerts.length, 1);
  assert.equal(textOf(alerts[0]), "GitHub rejected the token.");
  assert.match(alerts[0], /<svg/);
  assert.deepEqual(withRole(rowOf(html, "web_search"), "alert"), []);
});

test("the last good call time waits for the browser, so the server never prints the reader's clock", () => {
  const html = paintPage([working(readySearch)]);
  assert.doesNotMatch(html, /<time/);
  assert.doesNotMatch(textOf(html, " "), /\bago\b|\bnow\b/);
});

test("relative times read now, minutes, hours, then days", () => {
  const at = Date.parse(AT);
  const second = 1_000;
  const minute = 60 * second;
  const hour = 60 * minute;
  const day = 24 * hour;
  assert.equal(relativeTime(AT, at), "now");
  assert.equal(relativeTime(AT, at + 59 * second), "now");
  assert.equal(relativeTime(AT, at - 30 * second), "now", "a server clock a little ahead still reads now");
  assert.equal(relativeTime(AT, at + 4 * minute + 10 * second), "4 min ago");
  assert.equal(relativeTime(AT, at + 2 * hour + 5 * minute), "2 hr ago");
  assert.equal(relativeTime(AT, at + 3 * day + 2 * hour), "3 d ago");
});

test("the expand button, the Test button, and links are siblings, never nested", () => {
  const html = paintPage([readySearch, START.github]);
  for (const id of ["web_search", "github"]) {
    const button = expandButton(rowOf(html, id));
    assert.equal(attr(button, "type"), "button");
    assert.equal(buttons(button).length, 1, `${id} expand button holds no other button`);
    assert.deepEqual(links(button), [], `${id} expand button holds no link`);
  }
});

// --- Test ---------------------------------------------------------------------------------------

test("Test shows Testing while it runs, keeps the row expandable, then shows the summary and duration", async () => {
  const sent = serve();
  const list = createToolsList([START.memory]);
  const done = list.test("memory");
  await arrived(sent, 1);
  assert.deepEqual({ path: sent[0].path, method: sent[0].method }, { path: "/api/tools/memory/test", method: "POST" });

  let row = rowOf(paint(list), "memory");
  const pending = testButton(row);
  assert.equal(textOf(pending), "Testing");
  assert.ok(isDisabled(pending), "Test is disabled while it runs");
  assert.equal(attr(pending, "aria-busy"), "true");
  assert.ok(!isDisabled(expandButton(row)), "the row still expands while testing");

  const opening = list.toggle("memory");
  await arrived(sent, 2);
  assert.deepEqual({ path: sent[1].path, method: sent[1].method }, { path: "/api/tools/memory", method: "GET" });
  sent[1].answer(json(MEMORY_INSPECTION));
  await opening;
  assert.equal(attr(expandButton(rowOf(paint(list), "memory")), "aria-expanded"), "true");
  await list.toggle("memory");

  sent[0].answer(checked({ ok: true, ms: 142, summary: "0 memories", tool: working(START.memory) }));
  await done;
  row = rowOf(paint(list), "memory");
  assert.deepEqual(statusWords(expandButton(row)), ["Working"]);
  const statuses = withRole(row, "status").map((element) => textOf(element));
  assert.deepEqual(statuses, ["0 memories · 142 ms"]);
  assert.deepEqual(withRole(row, "alert"), []);
  const again = testButton(row);
  assert.equal(textOf(again), "Test");
  assert.ok(!isDisabled(again));
});

test("a duration of a second or more prints seconds", async () => {
  const sent = serve();
  const list = createToolsList([readySearch]);
  await testRow(list, sent, "web_search", checked({ ok: true, ms: 1400, summary: "3 results", tool: working(readySearch) }));
  assert.deepEqual(withRole(rowOf(paint(list), "web_search"), "status").map((element) => textOf(element)), ["3 results · 1.4 s"]);
});

test("a check that ran and failed replaces the row and shows the check's error", async () => {
  const sent = serve();
  const list = createToolsList([working(readySearch)]);
  await testRow(list, sent, "web_search", checked({ ok: false, ms: 30, error: "Search is unavailable", tool: failing(readySearch, "Search is unavailable") }));
  const row = rowOf(paint(list), "web_search");
  assert.deepEqual(statusWords(expandButton(row)), ["Failing"]);
  const alerts = withRole(row, "alert");
  assert.equal(alerts.length, 1);
  assert.equal(textOf(alerts[0]), "Search is unavailable");
  assert.match(alerts[0], /<svg/);
  assert.deepEqual(withRole(row, "status"), []);
});

test("a refused Test shows the server's reason and keeps the stored status", async () => {
  const cases: { tool: ToolView; status: number; error: string; word: string }[] = [
    { tool: working(readySearch), status: 429, error: "Wait a moment before testing again.", word: "Working" },
    { tool: readySearch, status: 409, error: "Web search is not configured.", word: "Not tested" },
    { tool: failing(readyGithub, "GitHub rejected the token."), status: 429, error: "Wait a moment before testing again.", word: "Failing" },
  ];
  for (const { tool, status, error, word } of cases) {
    const sent = serve();
    const list = createToolsList([tool]);
    await testRow(list, sent, tool.id, json({ error }, status));
    const row = rowOf(paint(list), tool.id);
    assert.deepEqual(statusWords(expandButton(row)), [word], `${status} keeps ${word}`);
    const alerts = withRole(row, "alert");
    assert.equal(alerts.length, 1, `${status} shows one alert line`);
    assert.equal(textOf(alerts[0]), error);
    assert.equal(textOf(testButton(row)), "Test", "Test is ready again");
  }
});

test("a Test lost on the network, a proxy error page, or a body that does not parse still shows an error", async () => {
  const failures: [string, () => Response | Error][] = [
    ["network", () => new TypeError("Failed to fetch")],
    ["proxy page", () => new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["invalid body", () => json({ ok: true })],
  ];
  for (const [name, failure] of failures) {
    const sent = serve();
    const list = createToolsList([working(readySearch)]);
    await testRow(list, sent, "web_search", failure());
    const row = rowOf(paint(list), "web_search");
    const alerts = withRole(row, "alert");
    assert.equal(alerts.length, 1, `${name} shows one alert`);
    assert.notEqual(textOf(alerts[0]), "", `${name} alert has text`);
    assert.doesNotMatch(alerts[0], /Bad Gateway|<html/);
    assert.deepEqual(statusWords(expandButton(row)), ["Working"], `${name} keeps the stored status`);
  }
});

test("a passing Test clears the stored failure", async () => {
  const sent = serve();
  const list = createToolsList([failing(readyGithub, "GitHub rejected the token.")]);
  await testRow(list, sent, "github", checked({ ok: true, ms: 142, summary: "octocat", tool: working(readyGithub) }));
  const row = rowOf(paint(list), "github");
  assert.deepEqual(withRole(row, "alert"), []);
  assert.deepEqual(statusWords(expandButton(row)), ["Working"]);
  assert.deepEqual(withRole(row, "status").map((element) => textOf(element)), ["octocat · 142 ms"]);
});

// --- Expanded panel ---------------------------------------------------------------------------

test("expanding loads the model tool definitions once, showing a loading status first", async () => {
  const sent = serve();
  const list = createToolsList([readySearch, START.run_code]);
  const opening = list.toggle("web_search");
  await arrived(sent, 1);
  assert.deepEqual({ path: sent[0].path, method: sent[0].method }, { path: "/api/tools/web_search", method: "GET" });

  let row = rowOf(paint(list), "web_search");
  assert.equal(attr(expandButton(row), "aria-expanded"), "true");
  const [region] = withRole(row, "region");
  assert.ok(region, "the open row has a region");
  const loading = withRole(region, "status");
  assert.equal(loading.length, 1);
  assert.equal(attr(loading[0], "aria-label"), "Loading tool details");

  sent[0].answer(json(WEB_INSPECTION));
  await opening;
  row = rowOf(paint(list), "web_search");
  const [panel] = withRole(row, "region");
  const text = textOf(panel, " ");
  assert.match(text, /\bweb_search\b/);
  assert.ok(text.includes("Search the web for current information."));
  assert.ok(textOf(panel).replace(/\s+/g, "").includes(JSON.stringify(WEB_SCHEMA)), "the schema shows as JSON");
  assert.ok(text.includes("System instruction"));
  assert.ok(text.includes(SEARCH_INSTRUCTION));
  assert.deepEqual(withRole(panel, "status"), []);

  await list.toggle("web_search");
  assert.equal(attr(expandButton(rowOf(paint(list), "web_search")), "aria-expanded"), "false");
  await list.toggle("web_search");
  assert.equal(sent.length, 1, "opening the row again does not refetch");
  assert.ok(textOf(withRole(rowOf(paint(list), "web_search"), "region")[0], " ").includes(SEARCH_INSTRUCTION));
});

test("the expand button controls the region that it labels", async () => {
  const sent = serve();
  const list = createToolsList([readySearch]);
  await openRow(list, sent, "web_search", json(WEB_INSPECTION));
  const row = rowOf(paint(list), "web_search");
  const button = expandButton(row);
  const [region] = withRole(row, "region");
  const buttonId = attr(button, "id");
  const regionId = attr(region, "id");
  assert.ok(buttonId && regionId, "both carry ids");
  assert.equal(attr(button, "aria-controls"), regionId);
  assert.equal(attr(region, "aria-labelledby"), buttonId);
});

test("Tab moves from the expand button to Test, into the open panel, then to the next row", async () => {
  const sent = serve();
  const list = createToolsList([readySearch, START.run_code, START.github]);
  await openRow(list, sent, "web_search", json(WEB_INSPECTION));
  const html = paint(list);
  const rows = located(html, (tag, attrs) => tag === "li" && /\sdata-tool-row="/.test(attrs));
  const focusable = located(html, (tag, attrs) =>
    (tag === "button" && !/\sdisabled=""/.test(attrs)) || (tag === "a" && /\shref="/.test(attrs)) || /\stabindex="0"/.test(attrs),
  );
  const names = focusable.map((element) => {
    const row = rows.find((entry) => entry.start < element.start && element.end <= entry.end);
    const expands = /^<button[^>]*\saria-controls="/.test(element.html);
    return expands && row ? `expand ${attr(row.html, "data-tool-row")}` : textOf(element.html);
  });
  const from = names.indexOf("expand web_search");
  assert.deepEqual(names.slice(from, from + 6), ["expand web_search", "Test", "Configure", "expand run_code", "expand github", "Set up"]);
});

test("Configure in the open panel links to where the viewer may change the tool", async () => {
  const cases: [ToolView, ToolInspection, string | null][] = [
    [readySearch, WEB_INSPECTION, "/admin#search"],
    [{ ...readySearch, configureHref: null }, WEB_INSPECTION, null],
    [START.memory, MEMORY_INSPECTION, "/settings#memory"],
  ];
  for (const [tool, inspection, href] of cases) {
    const sent = serve();
    const list = createToolsList([tool]);
    await openRow(list, sent, tool.id, json(inspection));
    const [panel] = withRole(rowOf(paint(list), tool.id), "region");
    assert.deepEqual(named(links(panel), "Configure").map((link) => attr(link, "href")), href ? [href] : [], `${tool.id} with ${href}`);
  }
});

test("a failed load shows the error with Retry, and Retry or reopening loads again", async () => {
  const sent = serve();
  const list = createToolsList([readySearch]);
  await openRow(list, sent, "web_search", new TypeError("Failed to fetch"));
  let [panel] = withRole(rowOf(paint(list), "web_search"), "region");
  let [alert] = withRole(panel, "alert");
  assert.ok(alert, "the panel shows an alert");
  assert.notEqual(textOf(alert).replace(/Retry$/, ""), "");
  assert.equal(named(buttons(alert), "Retry").length, 1);

  await list.toggle("web_search");
  await openRow(list, sent, "web_search", json({ error: "Tool details are unavailable." }, 500));
  assert.equal(sent.length, 2, "reopening after a failure loads again");
  [panel] = withRole(rowOf(paint(list), "web_search"), "region");
  [alert] = withRole(panel, "alert");
  assert.ok(textOf(alert, " ").includes("Tool details are unavailable."));

  const retried = list.retry("web_search");
  await arrived(sent, 3);
  assert.deepEqual({ path: sent[2].path, method: sent[2].method }, { path: "/api/tools/web_search", method: "GET" });
  sent[2].answer(json(WEB_INSPECTION));
  await retried;
  [panel] = withRole(rowOf(paint(list), "web_search"), "region");
  assert.deepEqual(withRole(panel, "alert"), []);
  assert.ok(textOf(panel, " ").includes(SEARCH_INSTRUCTION));
});

test("a tool whose definitions could not be read shows the safe error with Retry", async () => {
  const sent = serve();
  const list = createToolsList([readyGithub]);
  await openRow(list, sent, "github", json({ id: "github", setup: { state: "ready" }, instruction: null, tools: [], error: "GitHub is unavailable." }));
  const [panel] = withRole(rowOf(paint(list), "github"), "region");
  const [alert] = withRole(panel, "alert");
  assert.ok(alert);
  assert.ok(textOf(alert, " ").includes("GitHub is unavailable."));
  assert.equal(named(buttons(alert), "Retry").length, 1);
});

test("a tool that is off says it is not sent to the model", async () => {
  const sent = serve();
  const list = createToolsList([START.github]);
  await openRow(list, sent, "github", json({ id: "github", setup: { state: "missing", configure: "self" }, instruction: null, tools: [] }));
  const [panel] = withRole(rowOf(paint(list), "github"), "region");
  assert.equal(textOf(panel, " "), "Not sent to the model");
});

test("a Test that changes the tool's health makes the next open load the definitions again", async () => {
  const sent = serve();
  const list = createToolsList([readySearch]);
  await openRow(list, sent, "web_search", json(WEB_INSPECTION));
  await list.toggle("web_search");
  await testRow(list, sent, "web_search", checked({ ok: true, ms: 900, summary: "3 results", tool: working(readySearch) }));
  await openRow(list, sent, "web_search", json(WEB_INSPECTION));
  assert.equal(sent.filter((request) => request.method === "GET").length, 2);
});
