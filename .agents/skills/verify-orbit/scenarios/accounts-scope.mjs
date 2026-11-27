import assert from "node:assert/strict";
import fs from "node:fs";
import { connectProvider } from "../../../../scripts/qa/connect-provider.mjs";
import { startMockMcp } from "../../../../scripts/qa/mock-mcp.mjs";
import { searchSave } from "../../../../scripts/qa/settings-save.mjs";
import { eventually } from "../../../../src/lib/eventually.mjs";

const adminNote = "Admin deploys orbit-canary-18a to Fly.io";
const memberNote = "Member deploys orbit-member-canary-18a to Render";
const requestLog = new URL("../../../../.verify/mock-requests.jsonl", import.meta.url);
const proofFile = new URL("../../../../.verify/evidence/accounts-scope/member-provider-requests.jsonl", import.meta.url);

async function signIn(page, origin, { email, password }) {
  await page.goto(`${origin}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/c/"), { timeout: 15_000 });
}

async function send(request, origin, pathname, { method = "GET", json } = {}) {
  const response = await request.fetch(origin + pathname, { method, data: json, headers: { origin } });
  return { status: response.status(), text: await response.text() };
}

async function loadMemories(page, origin) {
  const response = await page.request.get(`${origin}/api/memories`);
  assert.equal(response.status(), 200, "list saved memories");
  return (await response.json()).memories;
}

async function adminNav(page) {
  const sidebar = await page.getByRole("link", { name: "Admin", exact: true }).count();
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  const commands = await palette.getByRole("option", { name: "Admin", exact: true }).count();
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  return { sidebar, commands };
}

function providerRequest(prompt, offset) {
  const entries = fs.readFileSync(requestLog, "utf8").slice(offset).trim();
  const first = entries ? entries.split("\n").map(JSON.parse).find((entry) =>
    entry.body?.stream === true && JSON.stringify(entry.body.messages).includes(prompt) && entry.body.messages.at(-1)?.role === "user",
  ) : null;
  assert.ok(first, "capture the first outbound provider request for this turn");
  const messages = JSON.stringify(first.body.messages);
  const tools = (first.body.tools ?? []).map((tool) => tool.function?.name);
  return {
    prompt,
    adminNote: messages.includes(adminNote),
    memberNote: messages.includes(memberNote),
    rememberInstructions: messages.includes("Call remember only when"),
    tools,
  };
}

export default async function accountsScope({ page, origin, step, shot, useProvider, seedMember, mockUrl }) {
  const memberContext = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
  const member = await memberContext.newPage();
  const adminGithub = await (await page.request.get(`${origin}/api/settings`)).json();
  const adminSettings = await (await page.request.get(`${origin}/api/admin/settings`)).json();
  const mcp = await startMockMcp();
  const chats = [];
  const evidence = [];
  let memberPreferences;
  let githubSaved = false;
  let searchSaved = false;
  let hourSaved = false;
  async function chat(actor, prompt, reply) {
    const created = await actor.request.post(`${origin}/api/chats`);
    assert.equal(created.status(), 201, "create an owned chat");
    const { id } = await created.json();
    chats.push({ actor, id });
    await actor.goto(`${origin}/c/${id}`);
    const composer = actor.getByPlaceholder("Ask anything");
    await composer.fill(prompt);
    await composer.press("Enter");
    await actor.locator('[data-message-role="assistant"]').getByText(reply, { exact: true }).last().waitFor({ timeout: 30_000 });
    await actor.getByRole("button", { name: "Send", exact: true }).waitFor();
    return id;
  }

  try {
    assert.equal(adminGithub.githubTokenSet, false, "use a sandbox without a saved GitHub token");
    await useProvider();
    const adminChat = await chat(page, `[qa:remember] ${adminNote}`, "Saved.");
    const adminMemory = (await loadMemories(page, origin)).find((memory) => memory.text === adminNote);
    assert.ok(adminMemory, "admin can see their saved memory");
    const github = await page.request.put(`${origin}/api/settings`, {
      data: { githubToken: mcp.token, githubMcpUrl: mcp.url },
    });
    assert.equal(github.status(), 200, "save the admin's mock GitHub token");
    githubSaved = true;

    await signIn(member, origin, await seedMember());
    await connectProvider((pathname, init) => send(member.request, origin, pathname, init), {
      label: "Member mock", baseUrl: mockUrl, apiKey: "test-key-not-real", model: "mock-genui",
    });
    memberPreferences = await (await member.request.get(`${origin}/api/preferences`)).json();

    await member.goto(`${origin}/memory`);
    await member.getByRole("heading", { name: "Memory", exact: true }).first().waitFor();
    const listed = await loadMemories(member, origin);
    step("member Memory page and API are empty", listed.length === 0 && await member.getByText(adminNote, { exact: true }).count() === 0);
    await shot("member-memory-empty", member);

    const chatPage = await member.goto(`${origin}/c/${adminChat}`);
    step("member cannot open the admin chat", chatPage?.status() === 404 && await member.getByRole("heading", { name: "Not found" }).isVisible());
    const adminPage = await member.goto(`${origin}/admin`);
    step("member receives the 404 page at /admin", adminPage?.status() === 404 && await member.getByRole("heading", { name: "Not found" }).isVisible());
    await shot("member-admin-404", member);
    const read = await member.request.get(`${origin}/api/admin/settings`);
    const write = await member.request.put(`${origin}/api/admin/settings`, { data: { searxngUrl: "https://example.test" } });
    step("member receives 403 on both admin settings requests", read.status() === 403 && write.status() === 403, `GET ${read.status()}, PUT ${write.status()}`);

    await member.goto(`${origin}/settings`);
    const memberNav = await adminNav(member);
    step("member has no Admin link or command", memberNav.sidebar === 0 && memberNav.commands === 0, JSON.stringify(memberNav));
    const memberGithub = await (await member.request.get(`${origin}/api/settings`)).json();
    step("member settings shows GitHub without the admin token, Search, or Code sandbox",
      memberGithub.githubTokenSet === false &&
      await member.getByRole("heading", { name: "GitHub", exact: true }).isVisible() &&
      await member.getByRole("heading", { name: /^(Search|Code sandbox)$/ }).count() === 0);

    if (memberPreferences.memory === "off") {
      const enabled = await member.request.patch(`${origin}/api/preferences`, { data: { memory: "on" } });
      assert.equal(enabled.status(), 200, "enable memory for the scoped test turn");
    }
    await chat(member, `[qa:remember] ${memberNote}`, "Saved.");
    const query = "[qa:plain] Where does orbit-canary-18a or orbit-member-canary-18a deploy?";
    const offset = fs.readFileSync(requestLog, "utf8").length;
    await chat(member, query, "pong");
    const scoped = providerRequest(query, offset);
    evidence.push(scoped);
    step("provider receives member notes and memory tools without admin notes or GitHub tools",
      scoped.memberNote && !scoped.adminNote && scoped.tools.includes("remember") && scoped.tools.includes("forget") && !scoped.tools.some((name) => name?.startsWith("github_")),
      JSON.stringify(scoped));

    await chat(member, `[qa:forget] ${adminMemory.id}`, "No memory with that id");
    step("member cannot forget the admin memory", (await loadMemories(page, origin)).some((memory) => memory.id === adminMemory.id));
    await shot("forget-refused", member);

    await member.goto(`${origin}/settings`);
    const memory = member.getByRole("switch", { name: "Memory", exact: true });
    assert.equal(await memory.getAttribute("aria-checked"), "true");
    const savedOff = member.waitForResponse((response) => new URL(response.url()).pathname === "/api/preferences" && response.request().method() === "PATCH");
    await memory.click();
    assert.equal((await savedOff).status(), 200);
    await member.reload();
    step("Memory remains Off after refresh", await memory.getAttribute("aria-checked") === "false");
    await memory.scrollIntoViewIfNeeded();
    await shot("memory-off", member);
    const offQuery = "[qa:plain] Where does orbit-member-canary-18a deploy with Memory off?";
    const offOffset = fs.readFileSync(requestLog, "utf8").length;
    await chat(member, offQuery, "pong");
    const off = providerRequest(offQuery, offOffset);
    evidence.push(off);
    const adminPreferences = await (await page.request.get(`${origin}/api/preferences`)).json();
    step("Memory off removes member recall and memory tools and leaves admin Memory on",
      !off.memberNote && !off.adminNote && !off.rememberInstructions && !off.tools.includes("remember") && !off.tools.includes("forget") && adminPreferences.memory === "on",
      JSON.stringify(off));

    await page.goto(`${origin}/admin`);
    const admin = await adminNav(page);
    step("admin has the Admin link and command", admin.sidebar === 1 && admin.commands === 1, JSON.stringify(admin));
    for (const name of ["Search", "Code sandbox", "Dreaming"]) {
      step(`admin sees ${name}`, await page.getByRole("heading", { name, exact: true }).isVisible());
    }
    const search = page.getByLabel("SearXNG URL", { exact: true });
    await search.fill("https://example.test");
    const savedSearch = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/settings" && response.request().method() === "PUT");
    await searchSave(page).click();
    const saved = await savedSearch;
    searchSaved = saved.ok();
    step("admin saves the search URL", saved.ok() && (await saved.json()).searxngUrl === "https://example.test");
    await page.reload();
    await eventually(() => search.inputValue(), (url) => url === "https://example.test", { timeoutMs: 5_000, what: "admin's saved search URL after reload" });
    const hour = page.getByRole("combobox", { name: "Hour", exact: true });
    const dreamHour = adminSettings.dreamHour === 23 ? 0 : 23;
    const hourLabel = `${String(dreamHour).padStart(2, "0")}:00`;
    await hour.click();
    step("Dreaming offers all 24 hours", await page.getByRole("option").count() === 24);
    const savedHour = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/settings" && response.request().method() === "PUT");
    await page.getByRole("option", { name: hourLabel, exact: true }).click();
    const hourResponse = await savedHour;
    hourSaved = hourResponse.ok();
    const savedDreamHour = hourSaved ? (await hourResponse.json()).dreamHour : null;
    await page.reload();
    step("admin saves the dream hour and it persists after refresh",
      savedDreamHour === dreamHour && (await hour.innerText()).trim() === hourLabel);
    for (const width of [1280, 390, 360]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
      step(`admin page fits ${width} pixels`, await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth));
      await shot(width === 1280 ? "admin-page" : `admin-page-${width}`);
    }
  } finally {
    try {
      if (evidence.length) fs.writeFileSync(proofFile, evidence.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const pending = [];
      const removeNotes = async (actor, note) => {
        const response = await actor.request.get(`${origin}/api/memories`);
        if (!response.ok()) return;
        const { memories } = await response.json();
        for (const memory of memories.filter((memory) => memory.text === note)) {
          const deleted = await actor.request.delete(`${origin}/api/memories/${memory.id}`);
          assert.ok(deleted.ok(), "delete the test memory");
        }
      };
      pending.push(removeNotes(page, adminNote), removeNotes(member, memberNote));
      if (githubSaved) pending.push(page.request.put(`${origin}/api/settings`, { data: { githubToken: null, githubMcpUrl: adminGithub.githubMcpUrl } }));
      if (searchSaved || hourSaved) pending.push(page.request.put(`${origin}/api/admin/settings`, {
        data: { searxngUrl: adminSettings.searxngUrl, dreamHour: adminSettings.dreamHour },
      }));
      if (memberPreferences?.memory) pending.push(member.request.patch(`${origin}/api/preferences`, { data: { memory: memberPreferences.memory } }));
      for (const { actor, id } of chats) pending.push(actor.request.delete(`${origin}/api/chats/${id}`));
      const results = await Promise.allSettled(pending);
      step("account scenario cleans up its test notes, chats, settings, and GitHub token",
        results.every((result) => result.status === "fulfilled" && (result.value === undefined || result.value.ok())),
        results.map((result) => result.status === "rejected" ? result.reason.message : result.value?.status()).join(", "));
    } finally {
      await Promise.all([mcp.close(), memberContext.close()]);
    }
  }
}
