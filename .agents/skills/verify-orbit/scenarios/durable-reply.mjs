import assert from "node:assert/strict";
import { startDropFront } from "../../../../scripts/qa/drop-front.mjs";
import { eventually } from "../../../../src/lib/eventually.mjs";

const word = (page, number) => page.getByText(new RegExp(`\\bword${number}\\b`));
const replies = (page) => page.locator('[data-message-role="assistant"]');
const thinking = (page) => page.getByRole("button", { name: /^Thinking ([2-9]|\d{2,})s$/ });
const thought = (page) => page.getByRole("button", { name: /^Thought for / });
const textWords = (text) => text.match(/\bword\d+\b/g) ?? [];
const allWords = Array.from({ length: 50 }, (_, index) => `word${index + 1}`);

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

async function readChat(page, origin, id) {
  const response = await page.request.get(`${origin}/api/chats/${id}`);
  assert.equal(response.status(), 200);
  return response.json();
}

function savedWords(snapshot) {
  return snapshot.messages
    .filter(({ message }) => message.role === "assistant")
    .flatMap(({ message }) => message.parts)
    .flatMap((part) => part.type === "text" ? textWords(part.text) : []);
}

async function waitForSavedWords(page, origin, id) {
  const words = await eventually(
    async () => savedWords(await readChat(page, origin, id)),
    (words) => words.includes("word50"),
    { timeoutMs: 15_000, what: "word50 in the saved chat" },
  );
  assert.deepEqual(words, allWords);
}

async function dropDuringText({ page, origin, front, step, shot, phone = false }) {
  const id = await openChat(page, origin, front.origin);
  await send(page, "[qa:slow] Answer while I lose the connection");
  await word(page, 8).waitFor({ timeout: 15_000 });
  const reconnectUrl = `**/api/chats/${id}/stream?**`;
  const reconnect = Promise.withResolvers();
  const hold = async (route) => {
    await reconnect.promise;
    await route.continue();
  };
  await page.route(reconnectUrl, hold);
  try {
    front.drop();
    await page.getByText("Reconnecting", { exact: true }).waitFor({ timeout: 10_000 });
    const online = await page.evaluate(() => navigator.onLine && document.visibilityState === "visible");
    const noError = await page.getByText(/network error/i).count() === 0;
    const noRetry = await page.getByRole("button", { name: "Retry", exact: true }).count() === 0;
    step(`${phone ? "phone" : "desktop"} shows Reconnecting on an online, visible tab`, online && noError && noRetry,
      `visible and online=${online} error visible=${!noError} Retry visible=${!noRetry}`);
    await shot(phone ? "phone" : "dropped");
  } finally {
    reconnect.resolve();
    await page.unroute(reconnectUrl, hold);
  }

  await word(page, 50).waitFor({ timeout: 15_000 });
  assert.deepEqual(textWords(await replies(page).last().textContent()), allWords);
  await waitForSavedWords(page, origin, id);
  if (!phone) await shot("finished");
  await page.reload();
  await word(page, 50).waitFor({ timeout: 15_000 });
  step(`${phone ? "phone" : "desktop"} renders all 50 words before reload and one complete reply after reload`,
    await replies(page).count() === 1 && JSON.stringify(textWords(await replies(page).last().textContent())) === JSON.stringify(allWords),
    "the saved reply is duplicated or incomplete");
}

export default async function durableReply({ page, origin, mockUrl, step, shot }) {
  assert.ok(mockUrl);
  const front = await startDropFront(origin);
  try {
    await dropDuringText({ page, origin, front, step, shot });

    const completedThought = await openChat(page, origin, front.origin);
    await send(page, "[qa:think-slow] Think while I lose the connection");
    await thinking(page).waitFor({ timeout: 15_000 });
    await shot("thinking");
    front.drop();
    await word(page, 10).waitFor({ timeout: 15_000 });
    const label = await thought(page).innerText();
    await eventually(
      async () => (await readChat(page, origin, completedThought)).messages.some(({ message }) =>
        message.role === "assistant" && message.parts.some((part) =>
          part.type === "reasoning" && part.providerMetadata?.orbitTiming?.thoughtMs > 0)),
      Boolean,
      { timeoutMs: 5_000, what: "the thinking duration saved in the chat" },
    );
    await page.reload();
    await thought(page).waitFor({ timeout: 15_000 });
    step("thinking finishes after a dropped connection and the saved duration survives reload",
      await thought(page).innerText() === label && await word(page, 10).isVisible(), `duration before reload was ${label}`);
    await shot("thought");

    await openChat(page, origin);
    await send(page, "[qa:think-slow] Think until I press Stop");
    await thinking(page).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const endMark = page.locator('[data-reply-end="stopped"]').filter({ hasText: /^Stopped$/ });
    await endMark.waitFor({ timeout: 10_000 });
    await page.reload();
    await endMark.waitFor({ timeout: 10_000 });
    await thought(page).click();
    step("Stop appears live and saves reasoning with its duration", await page.getByText(/\bthought1\b/).isVisible() && await word(page, 1).count() === 0,
      "reasoning is missing or answer text arrived after Stop");
    await shot("stopped");

    const switching = await openChat(page, origin);
    await send(page, "[qa:slow] Answer while I switch chats");
    await word(page, 5).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith("/c/") && url.pathname !== `/c/${switching}`);
    await waitForSavedWords(page, origin, switching);
    await page.goto(`${origin}/c/${switching}`);
    await word(page, 50).waitFor({ timeout: 15_000 });
    step("switching chats leaves the reply running", true);

    const branched = await openChat(page, origin);
    await send(page, "[qa:plain] Earlier branch");
    await page.getByText("pong", { exact: true }).waitFor({ timeout: 15_000 });
    const earlier = await eventually(
      async () => (await readChat(page, origin, branched)).messages.find(({ message }) => message.role === "assistant")?.message,
      Boolean,
      { timeoutMs: 5_000, what: "earlier branch saved in the chat" },
    );
    const earlierPrompt = page.locator("[data-turn-id]").first();
    await earlierPrompt.hover();
    await earlierPrompt.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit message" });
    await editor.fill("[qa:slow] Active branch");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await word(page, 5).waitFor({ timeout: 15_000 });

    const second = await page.context().newPage();
    try {
      await second.goto(`${origin}/c/${branched}`);
      await word(second, 5).waitFor({ timeout: 15_000 });
      const snapshot = await readChat(second, origin, branched);
      const prompt = snapshot.messages.find(({ message }) => message.id === snapshot.headId).message;
      const refusedId = crypto.randomUUID();
      const refused = await second.request.post(`${origin}/api/chat`, {
        data: {
          id: branched,
          trigger: "submit-message",
          messages: [prompt, { id: refusedId, role: "user", parts: [{ type: "text", text: "Refuse this overlapping send" }] }],
        },
      });
      step("the second tab cannot submit while the first reply runs", refused.status() === 409, `HTTP ${refused.status()}`);
      await page.goto(`${origin}/c/${branched}?m=${earlier.id}`);
      await page.getByText("pong", { exact: true }).waitFor({ timeout: 10_000 });
      await word(second, 50).waitFor({ timeout: 15_000 });
      const final = await readChat(second, origin, branched);
      step("the second tab renders all 50 words and the refused prompt stays out of the chat",
        JSON.stringify(textWords(await replies(second).last().textContent())) === JSON.stringify(allWords) &&
          !final.messages.some(({ message }) => message.id === refusedId),
        "the reply is incomplete or the refused prompt was saved");
      step("focusing the earlier branch keeps only that branch visible",
        await page.getByText("pong", { exact: true }).isVisible() &&
          await page.getByText("[qa:slow] Active branch", { exact: true }).count() === 0 &&
          textWords(await replies(page).last().textContent()).length === 0,
        "the active branch reached the focused page");
    } finally {
      await second.close();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await dropDuringText({ page, origin, front, step, shot, phone: true });
  } finally {
    await front.close();
  }
}
