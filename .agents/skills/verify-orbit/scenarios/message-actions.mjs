import { eventually } from "../../../../src/lib/eventually.mjs";

// With a mouse resting away from the thread, Tab must still reach the actions of earlier
// messages, and a focused action must be fully visible. Retry stays visible when the last reply
// fails, and a touch screen shows every action at rest.

const ACTIONS = ["Copy", "Edit", "Edit reply", "Regenerate", "Retry"];

// Each message's action buttons, with the opacity a user sees: the button's own times every ancestor's.
// Messages fade in with animate-rise, so finite animations finish before the measure.
async function actionsAtRest(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
    .map((animation) => animation.finished)));
  return page.evaluate((actions) => [...document.querySelectorAll("[data-message-id]")].map((message) =>
    [...message.querySelectorAll("button")]
      .map((button) => {
        let opacity = 1;
        for (let node = button; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        return { label: button.getAttribute("aria-label") ?? button.textContent.trim(), opacity };
      })
      .filter(({ label }) => actions.includes(label))), ACTIONS);
}

function focusedOpacity(page) {
  return page.evaluate(() => {
    let opacity = 1;
    for (let node = document.activeElement; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  });
}

// Tabs from the top of the page to the composer and records each stop inside a message.
async function tabStops(page, onStop = async () => {}) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const stops = [];
  for (let n = 0; n < 80; n += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (element?.getAttribute("placeholder") === "Ask anything") return { composer: true };
      const message = element?.closest("[data-message-id]");
      if (!message) return null;
      const index = [...document.querySelectorAll("[data-message-id]")].indexOf(message);
      return { message: index, label: element.getAttribute("aria-label") ?? element.textContent.trim() };
    });
    if (stop?.composer) return stops;
    if (!stop) continue;
    // Poll for 500 ms in case a fade is still running. A focused button must end fully visible.
    const opacity = await eventually(() => focusedOpacity(page), (value) => value === 1, {
      timeoutMs: 500,
      intervalMs: 50,
      what: `focused action ${stop.label} to become visible`,
    }).catch(() => focusedOpacity(page));
    stops.push({ ...stop, opacity });
    await onStop(stop);
  }
  return stops;
}

const has = (stops, message, label) => stops.some((stop) => stop.message === message && stop.label === label);
const describeStops = (stops) => stops.map(({ message, label, opacity }) => `${message}:${label}@${opacity}`).join(" ") || "none";
const describeRest = (rest) => rest.map((actions, index) => `${index}=[${actions.map(({ label, opacity }) => `${label}@${opacity}`).join(",")}]`).join(" ");

async function sendAndWait(page, prompt, done) {
  const composer = page.getByRole("textbox").first();
  await composer.fill(prompt);
  await composer.press("Enter");
  await done.waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 30_000 });
}

export default async function messageActions({ page, origin, step, shot }) {
  const replies = page.locator('[data-message-role="assistant"]');

  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  await sendAndWait(page, "[qa:plain] first prompt", replies.nth(0).getByText("pong", { exact: true }));
  await sendAndWait(page, "[qa:plain] second prompt", replies.nth(1).getByText("pong", { exact: true }));
  await page.goto(`${origin}/c/${id}`);
  await replies.nth(1).getByText("pong", { exact: true }).waitFor({ timeout: 15_000 });
  await page.mouse.move(5, 795);

  const pointer = await page.evaluate(() => `pointer:fine=${matchMedia("(pointer: fine)").matches}`);
  const rest = await eventually(
    () => actionsAtRest(page),
    (items) => items.length === 4 && items.slice(0, 3).every((actions) => actions.every(({ opacity }) => opacity === 0)),
    { timeoutMs: 1_000, intervalMs: 50, what: "earlier message actions to hide at rest" },
  ).catch(() => actionsAtRest(page));
  step("earlier message actions are hidden at rest", rest.length === 4 && rest.slice(0, 3).every((actions) => actions.every(({ opacity }) => opacity === 0)), `${pointer} ${describeRest(rest)}`);
  step("last reply actions show at rest", ["Copy", "Edit reply", "Regenerate"].every((label) => rest[3]?.some((action) => action.label === label && action.opacity === 1)), describeRest(rest));
  await shot("rest");

  let tooltip = false;
  const stops = await tabStops(page, async ({ message, label }) => {
    if (message !== 0 || label !== "Copy") return;
    tooltip = await page.getByRole("tooltip", { name: "Copy" }).waitFor({ timeout: 1_000 }).then(() => true, () => false);
    await shot("first-prompt-copy-focused");
  });
  step("Tab reaches Copy and Edit on the first prompt", has(stops, 0, "Copy") && has(stops, 0, "Edit"), describeStops(stops));
  step("Tab reaches Copy, Edit reply and Regenerate on the first reply", ["Copy", "Edit reply", "Regenerate"].every((label) => has(stops, 1, label)), describeStops(stops));
  step("Tab reaches Copy and Edit on the second prompt", has(stops, 2, "Copy") && has(stops, 2, "Edit"), describeStops(stops));
  step("every focused message action is fully visible", stops.length > 0 && stops.every(({ opacity }) => opacity === 1), describeStops(stops));
  step("focus on the first prompt's Copy opens its tooltip", tooltip);

  await page.locator("[data-message-id]").first().hover();
  const hovered = await eventually(
    async () => (await actionsAtRest(page))[0]?.some(({ label, opacity }) => label === "Copy" && opacity === 1) ?? false,
    Boolean,
    { timeoutMs: 1_000, intervalMs: 50, what: "hover to show the first prompt's actions" },
  ).then(() => true, () => false);
  step("hover shows the first prompt's actions", hovered);

  const failedChat = (await (await page.request.post(`${origin}/api/chats`)).json()).id;
  await page.goto(`${origin}/c/${failedChat}`);
  const firstReply = replies.first();
  const retry = firstReply.getByRole("button", { name: "Retry", exact: true });
  await sendAndWait(page, `[qa:fail-first] keyboard ${Date.now()}`, retry);
  const failedReplyId = await firstReply.getAttribute("data-message-id");
  await page.mouse.move(5, 795);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const failedRest = (await actionsAtRest(page)).flat();
  step("a failed reply shows Retry at rest", failedRest.some(({ label, opacity }) => label === "Retry" && opacity === 1), failedRest.map(({ label, opacity }) => `${label}@${opacity}`).join(","));
  const failedStops = await tabStops(page);
  step("Tab reaches a visible Retry on a failed reply", failedStops.some(({ label, opacity }) => label === "Retry" && opacity === 1), describeStops(failedStops));
  await shot("failed");

  await sendAndWait(page, "[qa:plain] after the failed reply", replies.nth(1).getByText("pong", { exact: true }));
  step("the failed reply stays before the follow-up reply", await firstReply.getAttribute("data-message-id") === failedReplyId);
  const earlierFailedStops = await tabStops(page);
  step("Tab reaches visible Regenerate on the earlier failed reply", earlierFailedStops.some(({ message, label, opacity }) => message === 1 && label === "Regenerate" && opacity === 1), describeStops(earlierFailedStops));

  const touch = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await touch.addCookies(await page.context().cookies());
    const phone = await touch.newPage();
    await phone.goto(`${origin}/c/${id}`);
    await phone.locator('[data-message-role="assistant"]').nth(1).getByText("pong", { exact: true }).waitFor({ timeout: 15_000 });
    const media = await phone.evaluate(() => `pointer:coarse=${matchMedia("(pointer: coarse)").matches}`);
    const touchRest = await actionsAtRest(phone);
    const shown = touchRest.length === 4 && touchRest.every((actions) => actions.length > 0 && actions.every(({ opacity }) => opacity === 1));
    step("touch shows every message's actions at rest", shown, `${media} ${describeRest(touchRest)}`);
    await shot("touch", phone);
  } finally {
    await touch.close();
  }
}
