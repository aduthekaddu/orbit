import assert from "node:assert/strict";
import { startDropFront } from "../../../../scripts/qa/drop-front.mjs";
import { eventually } from "../../../../src/lib/eventually.mjs";

const chatPost = (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/chat";
const button = (page, name) => page.getByRole("button", { name, exact: true });

async function openChat(page, origin, browserOrigin = origin) {
  const created = await page.request.post(`${origin}/api/chats`);
  assert.equal(created.status(), 201);
  const { id } = await created.json();
  await page.goto(`${browserOrigin}/c/${id}`);
  return id;
}

async function send(page, prompt) {
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill(prompt);
  await composer.press("Enter");
}

async function retryWhilePending({ page, origin, step, shot }) {
  const id = await openChat(page, origin);
  const retry = button(page, "Retry");
  await send(page, `[qa:fail-first] Retry after an interrupted reply ${Date.now()}`);
  await retry.waitFor({ timeout: 30_000 });
  await page.evaluate(({ id, replyId }) => sessionStorage.setItem(`orbit-stream:${id}`, replyId), { id, replyId: crypto.randomUUID() });
  await page.reload();
  const interrupted = page.getByRole("status").filter({ hasText: /^Interrupted$/ });
  await interrupted.waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('[data-message-role="assistant"]').count(), 0);

  const release = Promise.withResolvers();
  await page.exposeFunction("releaseRetryHeaders", () => release.promise);
  await page.evaluate(() => {
    const fetch = window.fetch;
    let firstPost = true;
    window.fetch = async (input, init) => {
      if (!firstPost || input !== "/api/chat" || init?.method !== "POST") return fetch(input, init);
      firstPost = false;
      const response = await fetch(input, init);
      await window.releaseRetryHeaders();
      return response;
    };
  });

  const posts = [];
  const record = (request) => { if (chatPost(request)) posts.push(request); };
  page.on("request", record);
  try {
    const primary = page.waitForResponse((response) => chatPost(response.request()), { timeout: 10_000 });
    await retry.click();
    assert.equal((await primary).status(), 200);
    await button(page, "Stop").waitFor({ timeout: 10_000 });

    const retryEnabled = await retry.isVisible() && await retry.isEnabled();
    const interruptedVisible = await interrupted.isVisible();
    await shot("retry-pending");
    let duplicate;
    if (retryEnabled) {
      const overlap = page.waitForResponse((response) => chatPost(response.request()), { timeout: 5_000 });
      await retry.click();
      duplicate = (await overlap).status();
    }

    step("pending Retry hides Interrupted and cannot send again",
      !interruptedVisible && !retryEnabled && posts.length === 1,
      `Interrupted visible=${interruptedVisible}, Retry enabled=${retryEnabled}, POSTs=${posts.length}, duplicate HTTP=${duplicate}`);
  } finally {
    release.resolve();
    page.off("request", record);
  }
  if (posts.length === 1) {
    await page.getByText(/\bword50\b/).waitFor({ timeout: 15_000 });
    step("the first Retry completes after its response headers arrive", true);
  }
}

async function editWhilePending({ page, origin, step, shot }) {
  const front = await startDropFront(origin);
  const replay = Promise.withResolvers();
  try {
    const id = await openChat(page, origin, front.origin);
    await send(page, "[qa:plain] Earlier prompt");
    await page.getByText("pong", { exact: true }).waitFor({ timeout: 15_000 });
    await button(page, "Send").waitFor({ timeout: 10_000 });

    await button(page, "Edit").click();
    const editor = page.getByRole("textbox", { name: "Edit message" });
    await editor.fill("An unsent change to the earlier prompt");
    const editSend = page.locator('form[data-aui-composer-type="edit"]').getByRole("button", { name: "Send", exact: true });
    assert.equal(await editSend.isEnabled(), true);
    const replayUrl = `**/api/chats/${id}/stream?**`;
    await page.route(replayUrl, async (route) => {
      await replay.promise;
      await route.continue();
    });
    await send(page, "[qa:slow] Active reply");
    await page.getByText(/\bword3\b/).waitFor({ timeout: 15_000 });
    const activeEdit = page.locator("[data-turn-id]").filter({ hasText: "[qa:slow] Active reply" })
      .getByRole("button", { name: "Edit", exact: true });
    const activeEditEnabled = await activeEdit.isEnabled();
    const editSendStreaming = await editSend.isEnabled();
    step("a streaming reply blocks opening and submitting a user edit",
      !activeEditEnabled && !editSendStreaming, `Edit enabled=${activeEditEnabled}, edit Send enabled=${editSendStreaming}`);
    await shot("edit-streaming");

    const checkpointKey = `orbit-stream:${id}`;
    const checkpoint = () => page.evaluate((key) => sessionStorage.getItem(key), checkpointKey);
    const replyId = await checkpoint();
    assert.ok(replyId);
    front.drop();
    await page.getByRole("status").filter({ hasText: /^Reconnecting$/ }).waitFor({ timeout: 10_000 });
    const stop = button(page, "Stop");
    const stopUrl = `**/api/chats/${id}/stop`;
    const releaseStop = Promise.withResolvers();
    const holdStop = async (route) => {
      await releaseStop.promise;
      await route.fulfill({ status: 500 });
    };
    await page.route(stopUrl, holdStop);
    try {
      await stop.click();
      await eventually(() => stop.isDisabled(), Boolean, { timeoutMs: 5_000, what: "Stop waiting for the server" });
      const stoppingSendDisabled = await editSend.isDisabled();
      step("a pending Stop keeps the edit Send button disabled",
        stoppingSendDisabled, `edit Send disabled=${stoppingSendDisabled}`);
      await shot("edit-stopping");
    } finally {
      releaseStop.resolve();
      await page.unroute(stopUrl, holdStop);
    }
    await page.getByRole("alert").filter({ hasText: "Could not stop" }).waitFor({ timeout: 5_000 });
    await page.getByRole("status").filter({ hasText: /^Reconnecting$/ }).waitFor({ timeout: 5_000 });
    const editorDisabled = await editor.isDisabled();
    const sendDisabled = await editSend.isDisabled();
    await shot("edit-reconnecting");

    let editStatus;
    if (!sendDisabled) {
      const overlap = page.waitForResponse((response) => chatPost(response.request()), { timeout: 5_000 });
      await editSend.click();
      editStatus = (await overlap).status();
      await eventually(checkpoint, (value) => value !== replyId, {
        timeoutMs: 2_000, what: "the checkpoint cleared by the overlapping edit",
      }).catch(() => {});
    }

    step("reconnecting blocks edit submission and keeps the active reply checkpoint",
      editorDisabled && sendDisabled && await checkpoint() === replyId,
      `input disabled=${editorDisabled}, Send disabled=${sendDisabled}, edit HTTP=${editStatus}, checkpoint retained=${await checkpoint() === replyId}`);

    replay.resolve();
    if (sendDisabled) {
      await page.getByText(/\bword50\b/).waitFor({ timeout: 15_000 });
      await eventually(() => editSend.isEnabled(), Boolean, {
        timeoutMs: 5_000, what: "the edit Send button enabled after the reply",
      });
      step("the unsent edit is available after the reply completes",
        (await editor.inputValue()) === "An unsent change to the earlier prompt");
    }
  } finally {
    replay.resolve();
    await front.close();
  }
}

export default async function replyActions(context) {
  await retryWhilePending(context);
  await editWhilePending(context);
}
