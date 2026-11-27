import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eventually } from "../../../../src/lib/eventually.mjs";
import { replyText } from "../../../../scripts/qa/reply-text.mjs";

// Slice 16 chat management: draft chats that get a row only with their first message, rename and delete from the
// row menu with a five-second undo, the delete commit on expiry and on pagehide, failed requests, and the sidebar
// footer with the Sign out confirmation. Every check runs at each viewport; the confirmed sign-out runs last.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dbPath = path.join(repoRoot, ".verify", "sandbox", "data", "orbit.db");
const EMAIL = "verify@orbit.local";
const VIEWPORTS = [
  { label: "1440", viewport: { width: 1440, height: 900 }, touch: false },
  { label: "390", viewport: { width: 390, height: 844 }, touch: true },
  { label: "360", viewport: { width: 360, height: 740 }, touch: true },
];
const UNDO_MS = 5_000;
const WORDS = Array.from({ length: 50 }, (_, index) => `word${index + 1}`);

const visible = (locator, timeout = 10_000) => locator.waitFor({ timeout }).then(() => true, () => false);
// Waits for a control and names it when it never shows, so the first missing control is the failure line.
async function need(locator, what, timeout = 10_000) {
  if (!(await visible(locator, timeout))) throw new Error(`no ${what} after ${timeout}ms`);
  return locator;
}

function readDb(run) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return run(db);
  } finally {
    db.close();
  }
}

function ftsIntact() {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    db.close();
  }
}

const chatRow = (id) => readDb((db) => db.prepare("SELECT title, updated_at AS updatedAt, model, reasoning_effort AS effort FROM chats WHERE id = ?").get(id) ?? null);
const replyWords = (text) => text.match(/\bword\d+\b/g) ?? [];
const wordCount = (text) => replyWords(text).length;
// All 50 words once each, in order: a replay that repeats or drops part of the reply fails.
const wordsIntact = (text) => JSON.stringify(replyWords(text)) === JSON.stringify(WORDS);

function draftId(url) {
  const parsed = new URL(url);
  const match = /^\/c\/([0-9a-f-]{36})$/.exec(parsed.pathname);
  return match && parsed.searchParams.has("new") ? match[1] : null;
}

function chatId(url) {
  return /^\/c\/([0-9a-f-]{36})$/.exec(new URL(url).pathname)?.[1] ?? null;
}

function viewportRun(context, { label, touch, page }) {
  const { origin, step, shot } = context;
  const composer = page.getByPlaceholder("Ask anything");
  const lastReply = () => page.locator('[data-message-role="assistant"]').last();
  const api = {
    chats: async () => (await (await page.request.get(`${origin}/api/chats`)).json()).chats,
    status: async (urlPath) => (await page.request.get(`${origin}${urlPath}`)).status(),
    // A rename the page did not make reaches the sidebar only with the next server render, so this reloads.
    name: async (id, title) => {
      const answer = await page.request.patch(`${origin}/api/chats/${id}`, { data: { title } });
      if (answer.status() !== 200) throw new Error(`PATCH /api/chats/${id} answered ${answer.status()}`);
      await page.reload();
      await composer.waitFor({ timeout: 15_000 });
    },
  };

  // The sidebar on a desktop, the drawer on a phone.
  async function list() {
    if (!touch) return page.locator("aside").filter({ has: page.getByRole("button", { name: "New chat" }) }).first();
    const drawer = page.getByRole("dialog", { name: "Chats" });
    if (!(await drawer.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
    await drawer.waitFor({ timeout: 5_000 });
    return drawer;
  }
  async function closeList() {
    const drawer = page.getByRole("dialog", { name: "Chats" });
    if (!touch || !(await drawer.isVisible())) return;
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 5_000 });
  }
  const rowLink = (container, id) => container.locator(`a[href="/c/${id}"]`);
  const rowHrefs = async (container) => container.locator('a[href^="/c/"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")));

  async function newDraft() {
    const before = page.url();
    await closeList();
    await page.getByRole("button", { name: "New chat" }).locator("visible=true").first().click();
    const url = await eventually(() => page.url(), (value) => value !== before && draftId(value) !== null, { timeoutMs: 10_000, what: "a draft URL /c/<id>?new after New chat" }).catch(() => null);
    if (!url) throw new Error(`no draft URL /c/<id>?new after New chat; url ${page.url()}`);
    await composer.waitFor({ timeout: 10_000 });
    return draftId(url);
  }

  async function send(text) {
    await eventually(() => composer.isEnabled(), Boolean, { timeoutMs: 15_000, what: "the composer to be ready" });
    await composer.fill(text);
    await composer.press("Enter");
  }
  async function replyDone(text, timeout = 30_000) {
    await lastReply().getByText(text).first().waitFor({ timeout });
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout });
  }

  async function pickReasoner() {
    await (await need(page.locator("[data-model-chip]").first(), "model chip on the draft")).click();
    const picker = page.locator("[data-model-picker]").first();
    await picker.waitFor({ timeout: 10_000 });
    await picker.locator("[data-model-option='mock-reasoner']").first().click({ timeout: 20_000 });
    await picker.getByRole("radio", { name: "Medium", exact: true }).click();
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 5_000 });
  }

  // Opens the row menu for one chat and returns its menu items. Without a label it takes the row's one Actions button.
  async function menu(id, label) {
    const container = await list();
    const row = rowLink(container, id).locator("..");
    if (!touch) await rowLink(container, id).hover();
    const name = label === undefined ? /^Actions for / : `Actions for ${label}`;
    await (await need(row.getByRole("button", { name }), `Actions for ${label ?? id} row button`)).click();
    const rename = await need(page.getByRole("menuitem", { name: "Rename" }), "Rename menu item", 5_000);
    return { container, row, rename, remove: page.getByRole("menuitem", { name: "Delete" }) };
  }
  const toast = (scope = page) => scope.getByRole("status").filter({ hasText: "Chat deleted" });
  const titleInput = () => page.getByRole("textbox", { name: "Chat title" });
  const requests = (method, id) => {
    const seen = [];
    const listener = (request) => {
      if (request.method() === method && new URL(request.url()).pathname === `/api/chats/${id}`) seen.push(request);
    };
    page.on("request", listener);
    return { seen, stop: () => page.off("request", listener) };
  };

  async function drafts() {
    await page.goto(`${origin}/`);
    await composer.waitFor({ timeout: 15_000 });
    const before = (await api.chats()).length;
    const rowsBefore = (await rowHrefs(await list())).length;
    await closeList();
    for (let click = 0; click < 3; click += 1) await newDraft();
    const after = (await api.chats()).length;
    const rowsAfter = (await rowHrefs(await list())).length;
    await closeList();
    step(`${label}: New chat three times adds no rows to the sidebar or GET /api/chats`, after === before && rowsAfter === rowsBefore, `api ${before} -> ${after}, sidebar ${rowsBefore} -> ${rowsAfter}`);
    const heading = (await page.locator("header h1").first().textContent())?.trim() ?? null;
    step(`${label}: the draft header title is empty`, heading === "", `h1 ${JSON.stringify(heading)}`);

    const id = draftId(page.url());
    await pickReasoner();
    await send("[qa:plain] hello");
    await replyDone("pong");
    const committed = await eventually(() => page.url(), (url) => chatId(url) === id && !new URL(url).searchParams.has("new"), { timeoutMs: 10_000, what: "?new to leave the URL" }).catch(() => page.url());
    const shown = await visible(rowLink(await list(), id), 10_000);
    await closeList();
    const row = chatRow(id);
    step(
      `${label}: the first send creates one row pinned to the picked model and strips ?new`,
      !new URL(committed).searchParams.has("new") && shown && (await api.chats()).length === before + 1 && row?.model === "mock-reasoner" && row?.effort === "medium",
      `url ${committed}, row shown ${shown}, db ${JSON.stringify(row)}`,
    );
    return id;
  }

  async function reloadMidStream() {
    const id = await newDraft();
    await send("[qa:slow] reload during the first reply");
    await lastReply().getByText("word3").waitFor({ timeout: 15_000 });
    await eventually(() => page.url(), (url) => !new URL(url).searchParams.has("new"), { timeoutMs: 5_000, what: "?new to leave the URL once the reply starts" }).catch(() => {});
    await page.reload();
    const landed = page.url();
    await replyDone("word50", 30_000).catch(() => {});
    // The reply's own text, without the model label that follows word50.
    const text = await replyText(lastReply()).catch(() => "");
    step(`${label}: reloading mid-stream lands on /c/<id> and reattaches to the reply`, chatId(landed) === id && !new URL(landed).searchParams.has("new") && wordsIntact(text), `url ${landed}, ${wordCount(text)} words, reply ${JSON.stringify(text.slice(0, 30))}…${JSON.stringify(text.slice(-30))}`);
    return id;
  }

  async function offlineDraft() {
    const id = await newDraft();
    await pickReasoner();
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === "/api/chat", timeout: 10_000 }).then(() => true, () => false);
    // A full page load in this window, such as the browser's offline page, would drop the picked model. A load
    // clears the marker. A same-document URL change does not.
    const loads = [];
    const onLoad = () => loads.push(page.url());
    await page.evaluate(() => {
      window.orbitOfflineDraft = true;
    });
    // Once online, the page refreshes to learn whether the send reached the server. The model must survive that too.
    const refreshed = () => page.waitForResponse((response) => response.request().headers().rsc === "1" && !response.request().headers()["next-router-prefetch"] && new URL(response.url()).pathname === `/c/${id}`, { timeout: 10_000 }).then(() => true, () => false);
    let refresh = null;
    page.on("load", onLoad);
    await page.context().setOffline(true);
    try {
      await send("[qa:plain] hello");
      await failed;
    } finally {
      refresh = refreshed();
      await page.context().setOffline(false);
    }
    const refreshLanded = await refresh;
    page.off("load", onLoad);
    const samePage = await page.evaluate(() => window.orbitOfflineDraft === true);
    const kept = page.url();
    const chip = (await page.locator("[data-model-chip]").first().innerText()).toLowerCase();
    const listed = (await api.chats()).some((chat) => chat.id === id);
    await page.reload();
    const draft = await visible(composer, 10_000);
    const notFound = await page.getByText("This page could not be found").count();
    step(
      `${label}: an offline first send keeps ?new, creates no row, keeps the model, and reloads as a draft`,
      draftId(kept) === id && refreshLanded && samePage && !listed && chip.includes("reasoner") && chatRow(id) === null && draft && notFound === 0 && draftId(page.url()) === id,
      `url ${kept}, refresh after online ${refreshLanded}, same page ${samePage}, loads ${JSON.stringify(loads)}, listed ${listed}, chip ${JSON.stringify(chip)}, after reload ${page.url()} 404 ${notFound}`,
    );
  }

  async function rename(id) {
    await page.goto(`${origin}/c/${id}`);
    await composer.waitFor({ timeout: 15_000 });
    const label0 = await eventually(async () => (await rowLink(await list(), id).innerText()).trim(), (text) => text !== "" && text !== "Untitled", { timeoutMs: 10_000, what: "the chat title" });
    const orderBefore = await rowHrefs(await list());
    const updatedBefore = chatRow(id)?.updatedAt;
    const patches = requests("PATCH", id);
    const newTitle = `Renamed ${label}`;

    const first = await menu(id, label0);
    if (label === "1440") await shot("menu-desktop");
    if (label === "390") await shot("menu-sheet-390");
    await first.rename.click();
    const input = await need(titleInput(), "Chat title rename input", 5_000);
    const prefilled = await input.inputValue();
    const focused = await input.evaluate((element) => element === document.activeElement);
    await input.fill(newTitle);
    if (label === "1440") await shot("rename");
    const answered = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/chats/${id}`, { timeout: 10_000 });
    await input.press("Enter");
    const response = await answered.catch(() => null);
    const container = await list();
    const shown = await eventually(async () => (await rowLink(container, id).innerText()).trim(), (text) => text === newTitle, { timeoutMs: 5_000, what: "the new title in the sidebar" }).catch(() => "");
    await closeList();
    const header = (await page.locator("header h1").first().textContent())?.trim();
    const body = response ? await response.json().catch(() => null) : null;
    step(
      `${label}: Rename from the row menu updates the sidebar and header`,
      prefilled === label0 && focused && response?.status() === 200 && body?.id === id && body?.title === newTitle && shown === newTitle && header === newTitle,
      `prefilled ${JSON.stringify(prefilled)} focused ${focused}, PATCH ${response?.status()} ${JSON.stringify(body)}, row ${JSON.stringify(shown)}, h1 ${JSON.stringify(header)}`,
    );
    await page.reload();
    await composer.waitFor({ timeout: 15_000 });
    const kept = (await rowLink(await list(), id).innerText()).trim();
    const orderAfter = await rowHrefs(await list());
    await closeList();
    step(
      `${label}: the new title survives reload without changing sort order or updated_at`,
      kept === newTitle && JSON.stringify(orderAfter) === JSON.stringify(orderBefore) && chatRow(id)?.updatedAt === updatedBefore,
      `row ${JSON.stringify(kept)}, order same ${JSON.stringify(orderAfter) === JSON.stringify(orderBefore)}, updated_at ${updatedBefore} -> ${chatRow(id)?.updatedAt}`,
    );

    const escape = await menu(id, newTitle);
    await escape.rename.click();
    await titleInput().fill("Escape title");
    await titleInput().press("Escape");
    await titleInput().waitFor({ state: "hidden", timeout: 5_000 });
    const blank = await menu(id, newTitle);
    await blank.rename.click();
    await titleInput().fill("   ");
    await titleInput().press("Enter");
    await titleInput().waitFor({ state: "hidden", timeout: 5_000 });
    const unchanged = (await rowLink(await list(), id).innerText()).trim();

    await page.route(`**/api/chats/${id}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.fallback()));
    try {
      const failing = await menu(id, newTitle);
      await failing.rename.click();
      await titleInput().fill("Will not save");
      await titleInput().press("Enter");
      const alerted = await visible(page.getByRole("alert").filter({ hasText: "Could not rename" }), 5_000);
      const rolledBack = await eventually(async () => (await rowLink(await list(), id).innerText()).trim(), (text) => text === newTitle, { timeoutMs: 5_000, what: "the title to roll back" }).catch(() => "");
      step(`${label}: a PATCH 500 rolls the title back and shows Could not rename`, alerted && rolledBack === newTitle, `alert ${alerted}, row ${JSON.stringify(rolledBack)}`);
    } finally {
      await page.unroute(`**/api/chats/${id}`);
      await closeList();
    }
    // A request from Escape or blank input would have been seen before the 500 attempt answered.
    patches.stop();
    step(`${label}: Escape and blank input send no request`, unchanged === newTitle && patches.seen.length === 2, `row ${JSON.stringify(unchanged)}, PATCH requests ${patches.seen.length} (1 rename + 1 forced 500 expected)`);
    return newTitle;
  }

  // By id: a rerun on the same sandbox leaves older chats with the same titles.
  async function paletteHas(id) {
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.waitFor({ timeout: 5_000 });
    const count = await dialog.locator(`[cmdk-item][data-value="${id}"]`).count();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    return count > 0;
  }

  async function deleteOpenAndUndo(id, title) {
    const deletes = requests("DELETE", id);
    const opened = await menu(id, title);
    await opened.remove.click();
    const draftUrl = await eventually(() => page.url(), (url) => draftId(url) !== null, { timeoutMs: 5_000, what: "a draft after deleting the open chat" }).catch(() => page.url());
    const shownToast = await visible(toast(), 3_000);
    if (label === "360") await shot("undo-toast-360");
    const gone = !(await rowLink(await list(), id).isVisible());
    await closeList();
    const inPalette = await paletteHas(id);
    await (await need(toast().getByRole("button", { name: "Undo" }), "Undo button in the Chat deleted toast", 3_000)).click();
    const back = await eventually(() => page.url(), (url) => chatId(url) === id, { timeoutMs: 5_000, what: "the chat to reopen" }).catch(() => page.url());
    const restored = await visible(rowLink(await list(), id), 5_000);
    await closeList();
    const backInPalette = await paletteHas(id);
    step(
      `${label}: deleting the open chat hides it, opens a draft, and Undo restores it`,
      draftId(draftUrl) !== null && shownToast && gone && !inPalette && chatId(back) === id && restored && backInPalette && (await api.status(`/api/chats/${id}`)) === 200,
      `draft ${draftUrl}, toast ${shownToast}, hidden ${gone}, in palette ${inPalette}, back ${back}, restored ${restored}, back in palette ${backInPalette}`,
    );
    deletes.stop();
    step(`${label}: Undo sends no DELETE`, deletes.seen.length === 0, `${deletes.seen.length} DELETE requests`);
  }

  async function deleteInactiveAndUndo(id, title) {
    const opened = await menu(id, title);
    await opened.remove.click();
    const scope = touch ? page.getByRole("dialog", { name: "Chats" }) : page;
    const inside = await visible(toast(scope), 3_000);
    const drawerOpen = touch ? await page.getByRole("dialog", { name: "Chats" }).isVisible() : true;
    await toast(scope).getByRole("button", { name: "Undo" }).click({ timeout: 3_000 }).catch(() => {});
    const restored = await visible(rowLink(await list(), id), 5_000);
    await closeList();
    step(`${label}: deleting an inactive chat shows Undo ${touch ? "inside the drawer" : "on the page"} and Undo restores it`, inside && drawerOpen && restored, `toast ${inside}, drawer open ${drawerOpen}, restored ${restored}`);
  }

  async function deleteStreamingAndUndo(id, title) {
    await page.goto(`${origin}/c/${id}`);
    await composer.waitFor({ timeout: 15_000 });
    await send("[qa:slow] keep streaming through undo");
    await lastReply().getByText("word3").waitFor({ timeout: 15_000 });
    const opened = await menu(id, title);
    await opened.remove.click();
    await eventually(() => page.url(), (url) => draftId(url) !== null, { timeoutMs: 5_000, what: "a draft after deleting the streaming chat" });
    await toast().getByRole("button", { name: "Undo" }).click({ timeout: 3_000 });
    await eventually(() => page.url(), (url) => chatId(url) === id, { timeoutMs: 5_000, what: "the chat to reopen" });
    await replyDone("word50", 30_000).catch(() => {});
    const text = await replyText(lastReply()).catch(() => "");
    step(`${label}: Undo during [qa:slow] reattaches and all 50 words finish`, wordsIntact(text), `${wordCount(text)} words, reply ${JSON.stringify(text.slice(0, 30))}…${JSON.stringify(text.slice(-30))}`);
  }

  async function deleteStreamingAndExpire(id, title) {
    const token = `quokka${label}gone`;
    await page.goto(`${origin}/c/${id}`);
    await composer.waitFor({ timeout: 15_000 });
    await send(`[qa:slow] expire ${token}`);
    await lastReply().getByText("word3").waitFor({ timeout: 15_000 });
    const deletes = requests("DELETE", id);
    const opened = await menu(id, title);
    await opened.remove.click();
    await toast().waitFor({ timeout: 3_000 });
    await toast().waitFor({ state: "hidden", timeout: UNDO_MS + 5_000 });
    const chat = await eventually(() => api.status(`/api/chats/${id}`), (status) => status === 404, { timeoutMs: 10_000, what: "GET /api/chats/<id> to answer 404" }).catch(() => null);
    const stream = await api.status(`/api/chats/${id}/stream`);
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByPlaceholder("Search").fill(token);
    const noHits = await visible(dialog.getByText("No results", { exact: true }), 10_000);
    await page.keyboard.press("Escape");
    const fts = ftsIntact();
    deletes.stop();
    step(
      `${label}: letting Undo expire during [qa:slow] deletes the chat and stops its reply`,
      chat === 404 && stream === 404 && noHits && fts === true && deletes.seen.length === 1,
      `chat ${chat}, stream ${stream}, palette No results ${noHits}, fts ${fts}, DELETE requests ${deletes.seen.length}`,
    );
  }

  async function deleteThenReload(id, title) {
    await newDraft();
    const opened = await menu(id, title);
    const clicked = Date.now();
    await opened.remove.click();
    await page.reload();
    const status = await eventually(() => api.status(`/api/chats/${id}`), (value) => value === 404, { timeoutMs: UNDO_MS, what: "the pagehide delete to land" }).catch(() => null);
    const elapsed = Date.now() - clicked;
    // The reload can render its sidebar before the DELETE lands, so the row may show until the page has loaded.
    const container = await list();
    const listed = await eventually(() => rowLink(container, id).count(), (count) => count === 0, { timeoutMs: 5_000, what: "the deleted row to leave the reloaded sidebar" }).catch(() => rowLink(container, id).count());
    await closeList();
    step(`${label}: reloading right after Delete commits it through pagehide`, status === 404 && elapsed < UNDO_MS && listed === 0, `status ${status} after ${elapsed}ms, rows ${listed}`);
  }

  // A tab can still hold a `/c/<id>?new` entry for a chat it has since deleted. Back opens a draft under that id, and
  // its first message saves the chat again. Deleting it again in the same page must send a second DELETE.
  async function deleteRecreated() {
    const id = crypto.randomUUID();
    await page.goto(`${origin}/c/${id}?new`);
    await composer.waitFor({ timeout: 15_000 });
    // Saved by a request this page did not send, so this history entry keeps ?new.
    const saved = await page.request.post(`${origin}/api/chat`, {
      data: { id, messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: `[qa:plain] saved elsewhere ${label}` }] }] },
    });
    await saved.body();
    if (saved.status() !== 200) throw new Error(`POST /api/chat for ${id} answered ${saved.status()}`);
    // The next reply's refresh lists the saved chat.
    await newDraft();
    await send(`[qa:plain] list the saved chat ${label}`);
    await replyDone("pong");
    await need(rowLink(await list(), id), "the chat saved by the request", 10_000);
    async function deleteAndExpire() {
      const deletes = requests("DELETE", id);
      const opened = await menu(id);
      await opened.remove.click();
      await toast().waitFor({ timeout: 3_000 });
      await toast().waitFor({ state: "hidden", timeout: UNDO_MS + 5_000 });
      const status = await eventually(() => api.status(`/api/chats/${id}`), (value) => value === 404, { timeoutMs: 10_000, what: "GET /api/chats/<id> to answer 404" }).catch(() => api.status(`/api/chats/${id}`));
      deletes.stop();
      return { status, sent: deletes.seen.length };
    }
    const first = await deleteAndExpire();
    await closeList();
    await page.goBack();
    const reopened = await eventually(() => page.url(), (url) => draftId(url) === id, { timeoutMs: 10_000, what: "Back to open the deleted id as a draft" }).catch(() => page.url());
    // The URL changes before the draft renders, and a send into the chat still on screen would go to that chat.
    await eventually(() => page.locator("[data-message-role]").count(), (count) => count === 0, { timeoutMs: 10_000, what: "the empty draft to replace the last chat" });
    await composer.waitFor({ timeout: 15_000 });
    await send(`[qa:plain] saved again ${label}`);
    await replyDone("pong");
    await need(rowLink(await list(), id), "the chat saved again", 10_000);
    const second = await deleteAndExpire();
    await closeList();
    step(
      `${label}: a chat saved again under an id this page deleted deletes again`,
      first.status === 404 && first.sent === 1 && draftId(reopened) === id && second.status === 404 && second.sent === 1,
      `first delete ${first.status} with ${first.sent} DELETE, Back ${reopened}, second delete ${second.status} with ${second.sent} DELETE`,
    );
  }

  async function failedDelete(id, title) {
    const deletes = requests("DELETE", id);
    await page.route(`**/api/chats/${id}`, (route) => (route.request().method() === "DELETE" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.fallback()));
    try {
      const opened = await menu(id, title);
      await opened.remove.dblclick();
      const alerted = await visible(page.getByRole("alert").filter({ hasText: "Could not delete" }), UNDO_MS + 5_000);
      const restored = await visible(rowLink(await list(), id), 5_000);
      step(`${label}: a DELETE 500 restores the row and shows Could not delete`, alerted && restored, `alert ${alerted}, restored ${restored}`);
      step(`${label}: double-clicking Delete sends one request`, deletes.seen.length === 1, `${deletes.seen.length} DELETE requests`);
    } finally {
      deletes.stop();
      await page.unroute(`**/api/chats/${id}`);
      await closeList();
    }
    step(`${label}: the chat is still there after the failed delete`, (await api.status(`/api/chats/${id}`)) === 200, "GET did not answer 200");
    const missing = await page.request.delete(`${origin}/api/chats/${crypto.randomUUID()}`);
    step(`${label}: DELETE on a missing id answers 404`, missing.status() === 404, `status ${missing.status()}`);
  }

  async function footer({ confirm }) {
    const container = await list();
    const memory = container.getByRole("link", { name: "Memory", exact: true });
    const settings = container.getByRole("link", { name: "Settings", exact: true });
    const email = container.getByText(EMAIL, { exact: true });
    const links = {
      memory: (await memory.isVisible()) && (await memory.getAttribute("href")) === "/memory",
      settings: (await settings.isVisible()) && (await settings.getAttribute("href")) === "/settings",
      email: (await email.isVisible()) && (await email.evaluate((node) => node.closest("a") === null)),
    };
    step(`${label}: Memory and Settings are labeled links and the email is plain text`, links.memory && links.settings && links.email, JSON.stringify(links));
    if (label === "360") await shot("drawer-360");
    const url = page.url();
    await container.getByRole("button", { name: "Sign out" }).click();
    const dialog = await need(page.getByRole("dialog", { name: "Sign out?" }), "Sign out? dialog", 5_000);
    if (label === "1440") await shot("signout-confirm");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    step(`${label}: Cancel in Sign out? keeps the session`, page.url() === url && (await api.status("/api/chats")) === 200, `url ${page.url()}`);
    if (!confirm) {
      await closeList();
      return;
    }
    await (await list()).getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("dialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
    const left = await page.waitForURL(/\/login$/, { timeout: 10_000 }).then(() => true, () => false);
    step(`${label}: confirming Sign out opens /login and ends the session`, left && (await api.status("/api/chats")) === 401, `url ${page.url()}`);
  }

  return async ({ last }) => {
    const first = await drafts();
    const reloaded = await reloadMidStream();
    await offlineDraft();
    const renamed = await rename(first);
    await deleteOpenAndUndo(first, renamed);
    await api.name(reloaded, `Other ${label}`);
    await deleteInactiveAndUndo(reloaded, `Other ${label}`);
    await deleteStreamingAndUndo(first, renamed);
    await deleteStreamingAndExpire(first, renamed);
    await newDraft();
    await send(`[qa:plain] reload right after delete ${label}`);
    await replyDone("pong");
    const reloadChat = chatId(page.url());
    await api.name(reloadChat, `Reload ${label}`);
    await deleteThenReload(reloadChat, `Reload ${label}`);
    await deleteRecreated();
    await failedDelete(reloaded, `Other ${label}`);
    await footer({ confirm: last });
  };
}

export default async function chatManage(context) {
  const { page } = context;
  await context.useProvider();
  for (const [index, { label, viewport, touch }] of VIEWPORTS.entries()) {
    let target = page;
    let phone = null;
    if (touch) {
      phone = await page.context().browser().newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      await phone.addCookies(await page.context().cookies());
      target = await phone.newPage();
    } else {
      await page.setViewportSize(viewport);
    }
    try {
      const run = viewportRun({ ...context, shot: (name) => context.shot(name, target) }, { label, touch, page: target });
      await run({ last: index === VIEWPORTS.length - 1 });
    } finally {
      await phone?.close();
    }
  }
}
