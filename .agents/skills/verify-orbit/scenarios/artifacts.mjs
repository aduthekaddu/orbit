import { execFileSync } from "node:child_process";
import path from "node:path";
import { eventually } from "../../../../src/lib/eventually.mjs";

async function security(frame, origin, kind, step) {
  const state = await frame.locator("body").evaluate(async (_body, appOrigin) => {
    let parentBlocked = false;
    let cookiesBlocked = false;
    let fetchBlocked = false;
    try { void parent.document; } catch { parentBlocked = true; }
    try { void document.cookie; } catch { cookiesBlocked = true; }
    try { await fetch(`${appOrigin}/api/chats`); } catch { fetchBlocked = true; }
    return { parentBlocked, cookiesBlocked, fetchBlocked };
  }, origin);
  step(`${kind} cannot read parent.document`, state.parentBlocked);
  step(`${kind} cannot read document.cookie`, state.cookiesBlocked);
  step(`${kind} cannot fetch the app origin`, state.fetchBlocked);
}

export default async function artifacts({ page, origin, step, shot }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.request.post(`${origin}/api/chats`);
  const { id } = await response.json();
  const chatUrl = `${origin}/c/${id}`;
  await page.goto(chatUrl);
  const composer = page.getByPlaceholder("Ask anything");
  const reply = page.locator('[data-message-role="assistant"]').last();
  const previews = reply.getByRole("button", { name: "Preview", exact: true });
  const panel = page.getByRole("complementary", { name: "Artifact", exact: true });
  const iframe = page.locator('iframe[title="Artifact preview"]');
  const frame = iframe.contentFrame();

  async function send(kind) {
    const previousReplies = await page.locator('[data-message-role="assistant"]').count();
    await composer.fill(`[qa:artifact-${kind}]`);
    await composer.press("Enter");
    await page.locator('[data-message-role="assistant"]').nth(previousReplies).waitFor({ timeout: 30_000 });
    await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 30_000 });
    await reply.locator('[data-status="complete"]').waitFor({ timeout: 30_000 });
  }

  async function open() {
    await previews.click();
    await iframe.waitFor({ timeout: 10_000 });
  }

  async function openHtml() {
    const deadline = Date.now() + 10_000;
    const [loaded] = await Promise.all([
      page.waitForEvent("framenavigated", {
        predicate: (child) => child.parentFrame() === page.mainFrame() && child.url() === "about:srcdoc",
        timeout: 10_000,
      }),
      open(),
    ]);
    await loaded.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) });
    // A sandboxed srcdoc iframe has an opaque origin (OOPIF), so Chromium can still route browser clicks
    // to the parent <iframe> until Viz aggregates the child's hit-test region. Confirm pointer routing first.
    const body = loaded.locator("body");
    await body.waitFor({ timeout: Math.max(1, deadline - Date.now()) });
    let attempt = 0;
    await eventually(async () => {
      await body.hover({
        position: { x: 1 + (attempt++ % 2), y: 1 },
        timeout: Math.max(1, deadline - Date.now()),
      });
      return body.evaluate((node) => node.matches(":hover"));
    }, Boolean, { timeoutMs: Math.max(1, deadline - Date.now()), what: "the HTML artifact frame to accept pointer input" });
    return loaded;
  }

  async function close() {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await iframe.waitFor({ state: "hidden" });
  }

  await send("html");
  const hasPreview = await previews.count() === 1;
  if (!hasPreview) {
    await shot("before");
    step("HTML code block has a Preview button", false, "no Preview button");
    return;
  }
  step("HTML code block has a Preview button", true);
  const html = await openHtml();
  await frame.getByRole("heading", { name: "Artifact HTML", exact: true }).waitFor();
  step("HTML heading renders in the preview", true);
  step("iframe sandbox is exactly allow-scripts", await iframe.getAttribute("sandbox") === "allow-scripts");
  const htmlButton = html.getByRole("button", { name: "Change color" });
  await htmlButton.click();
  step("HTML button responds to a click", await htmlButton.evaluate(node => node.style.backgroundColor === "green"));
  await security(frame, origin, "HTML", step);
  // The forged message goes to the page itself, so the wildcard target is the point of the check.
  await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener("message", () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
    window.postMessage({ type: "orbit-artifact-error", message: "Forged artifact error" }, "*"); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
  }));
  step("parent ignores error messages from another window", !await page.getByRole("alert").filter({ hasText: "Forged artifact error" }).count());
  await shot("html");
  const artifactUrl = page.url();
  step("open artifact is stored in the URL", Boolean(new URL(artifactUrl).searchParams.get("artifact")));
  step("desktop page has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await frame.getByRole("button", { name: "Change color" }).focus();
  await page.keyboard.press("Escape");
  await iframe.waitFor({ state: "detached" });
  step("Escape closes the panel while the frame has focus", !new URL(page.url()).searchParams.has("artifact"));
  const reopened = await openHtml();
  const reopenedButton = reopened.getByRole("button", { name: "Change color" });
  await reopenedButton.click();
  step("reopened HTML button responds to a click", await reopenedButton.evaluate(node => node.style.backgroundColor === "green"));

  await panel.getByRole("tab", { name: "Code", exact: true }).click();
  step("Code tab shows the artifact source", await panel.getByRole("tabpanel").innerText().then(text => text.includes("Artifact HTML")));
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  step("Download returns an HTML file", download.suggestedFilename().endsWith(".html"));
  // A headless context holds clipboard-write at "prompt" and denies the write, so grant it first,
  // as sandbox-copy.mjs does, and verify what actually landed on the clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await panel.getByRole("button", { name: "Copy", exact: true }).click();
  await panel.getByRole("button", { name: "Copied", exact: true }).waitFor();
  const copiedSource = await eventually(() => page.evaluate(() => navigator.clipboard.readText()), (text) => text !== "", { timeoutMs: 3_000, what: "Copy to write the artifact source" });
  const shownSource = await panel.getByRole("tabpanel").locator("code").textContent();
  step("Copy reports the copied source", copiedSource === shownSource, `clipboard ${JSON.stringify(copiedSource)}`);
  await panel.getByRole("tab", { name: "Preview", exact: true }).click();
  step("switching tabs keeps the running artifact", !reopened.isDetached() && await reopenedButton.evaluate(node => node.style.backgroundColor === "green"));
  await panel.getByRole("button", { name: "Reload", exact: true }).click();
  await frame.getByRole("button", { name: "Change color" }).waitFor();
  step("Reload resets the running artifact", await frame.getByRole("button", { name: "Change color" }).evaluate(node => node.style.backgroundColor === ""));

  await reply.getByRole("button", { name: "Edit code", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit html block", exact: true });
  const source = await editor.inputValue();
  await editor.fill(source.replace("Artifact HTML", "Artifact HTML edited"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await frame.getByRole("heading", { name: "Artifact HTML edited", exact: true }).waitFor();
  step("Edit code updates the open preview", true);
  await page.reload();
  await iframe.waitFor();
  await frame.getByRole("heading", { name: "Artifact HTML edited", exact: true }).waitFor();
  step("reload reopens the artifact from the URL", page.url() === artifactUrl);
  await shot("reloaded");
  await page.keyboard.press("Escape");
  await iframe.waitFor({ state: "hidden" });
  step("Escape closes the panel and removes its URL parameter", !new URL(page.url()).searchParams.has("artifact"));

  await send("svg");
  await open();
  await frame.locator("svg").waitFor();
  step("SVG renders in the preview", true);
  await security(frame, origin, "SVG", step);
  await shot("svg");
  await close();
  step("Close removes the artifact URL parameter", !new URL(page.url()).searchParams.has("artifact"));

  await send("react");
  await open();
  await frame.getByRole("button", { name: "Count 0", exact: true }).waitFor({ timeout: 60_000 });
  step("anonymous default React component renders", true);
  await frame.getByRole("button", { name: "Count 0", exact: true }).click();
  await frame.getByRole("button", { name: "Count 1", exact: true }).waitFor();
  step("React counter changes after a click", true);
  await security(frame, origin, "React", step);
  await shot("react-clicked");
  let reactSource;
  for (const [name, prefix] of [
    ["lodash", "import 'lodash';"],
    ["https://esm.sh/lodash-es", "export { default as other } from 'https://esm.sh/lodash-es';"],
    ["other-package", "import('other-package');"],
    ["constructor", "import 'constructor';"],
  ]) {
    await reply.getByRole("button", { name: "Edit code", exact: true }).click();
    const reactEditor = page.getByRole("textbox", { name: "Edit jsx block", exact: true });
    if (reactSource === undefined) reactSource = await reactEditor.inputValue();
    await reactEditor.fill(`${prefix}\n${reactSource}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: `Unsupported import: ${name}` }).waitFor({ timeout: 30_000 });
    step(`React rejects unsupported import ${name}`, true);
  }
  await close();

  await send("error");
  await open();
  const error = page.getByRole("alert").filter({ hasText: "Artifact exploded" });
  await error.first().waitFor();
  step("runtime error is shown under the preview", true);
  await shot("error");
  await panel.getByRole("button", { name: "Fix", exact: true }).click();
  step("Fix fills the composer with the runtime error", (await composer.inputValue()).includes("Artifact exploded"));
  await close();
  await composer.fill("");

  const phone = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await page.context().cookies());
  const mobile = await phone.newPage();
  await mobile.goto(artifactUrl);
  await mobile.frameLocator("iframe").getByRole("heading", { name: "Artifact HTML edited", exact: true }).waitFor();
  const sheet = mobile.getByRole("dialog");
  step("phone opens the preview in a dialog", await sheet.isVisible());
  await sheet.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const bounds = await sheet.boundingBox();
  step("phone dialog fills the screen", bounds && Math.abs(bounds.width - 390) <= 1 && Math.abs(bounds.height - 844) <= 1, JSON.stringify(bounds));
  step("phone has no horizontal overflow", await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot("mobile", mobile);
  await mobile.getByRole("button", { name: "Close", exact: true }).click();
  step("phone Close removes the artifact URL parameter", !new URL(mobile.url()).searchParams.has("artifact"));
  await phone.close();

  // No mock scenario streams reasoning, so save a reply whose reasoning drafts an HTML block the way the chat route saves one.
  const { id: draftedId } = await (await page.request.post(`${origin}/api/chats`)).json();
  const draftedParts = [
    { type: "step-start" },
    { type: "reasoning", text: "```html\n<h1>Reasoning draft</h1>\n```", state: "done" },
    { type: "text", text: "```html\n<h1>Reply artifact</h1>\n```", state: "done" },
  ];
  execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const { Redactor } = require(${JSON.stringify(path.resolve("src/lib/chat-errors.ts"))});
    const { finishChatReply, planChatWrite } = require(${JSON.stringify(path.resolve("src/lib/messages.ts"))});
    const [id, parts] = process.argv.slice(1);
    const redact = new Redactor(null);
    const plan = planChatWrite(id, [{ id: id + "-prompt", role: "user", parts: [{ type: "text", text: "Draft, then answer" }] }], redact);
    if ("error" in plan || !finishChatReply(plan, JSON.parse(parts), redact)) throw new Error("reasoning fixture was not saved");
  `, draftedId, JSON.stringify(draftedParts)], { cwd: path.resolve(".verify/sandbox"), env: { ...process.env, ORBIT_DATA_DIR: path.resolve(".verify/sandbox/data") }, stdio: "pipe" });
  await page.goto(`${origin}/c/${draftedId}`);
  const thought = reply.getByRole("button", { name: "Thought", exact: true });
  const draft = reply.locator("pre").filter({ hasText: "Reasoning draft" });
  async function previewShows() {
    await previews.last().click();
    if (!await iframe.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return "no preview frame";
    const heading = await frame.locator("h1").innerText({ timeout: 10_000 });
    await close();
    return heading;
  }
  await thought.click();
  await draft.waitFor();
  step("open Thought shows no Preview button for its HTML block", await previews.count() === 1, `${await previews.count()} Preview buttons`);
  await shot("reasoning-open");
  const whileOpen = await previewShows();
  step("reply Preview shows the reply's artifact while Thought is open", whileOpen === "Reply artifact", `shows ${whileOpen}`);
  await thought.click();
  await draft.waitFor({ state: "hidden" });
  const afterClose = await previewShows();
  step("reply Preview shows the reply's artifact after Thought opens and closes", afterClose === "Reply artifact", `shows ${afterClose}`);
}
