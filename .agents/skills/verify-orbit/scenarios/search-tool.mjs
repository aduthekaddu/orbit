import { eventually } from "../../../../src/lib/eventually.mjs";
import { startMockSearxng, searchFixtures } from "../../../../scripts/qa/mock-searxng.mjs";
import { settingsSave } from "../../../../scripts/qa/settings-save.mjs";

export default async function searchTool({ page, origin, useProvider, step, shot }) {
  const mock = await startMockSearxng();
  try {
    await useProvider();
    await page.goto(`${origin}/settings`);
    const field = page.getByLabel("SearXNG URL", { exact: true });
    const present = await field.isVisible();
    if (!present) {
      await shot("before");
      step("Search settings expose the SearXNG URL", false, "SearXNG URL field is missing");
      return;
    }
    await field.fill(mock.url);
    await page.getByLabel("Tavily key", { exact: true }).fill("test-tavily-key-not-real");
    await settingsSave(page).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await shot("settings");
    const settings = await page.request.get(`${origin}/api/settings`);
    const publicText = await settings.text();
    const publicSettings = JSON.parse(publicText);
    step("Search settings save without exposing either key", publicSettings.searxngUrl === mock.url && publicSettings.tavilyKeySet === true && !("tavilyApiKey" in publicSettings) && !("apiKey" in publicSettings) && !publicText.includes("test-tavily-key-not-real") && !publicText.includes("test-key-not-real"));
    await page.getByLabel("Tavily key", { exact: true }).fill("");
    await settingsSave(page).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    const kept = await (await page.request.get(`${origin}/api/settings`)).json();
    step("a blank Tavily key keeps the stored key", kept.tavilyKeySet === true);

    const remove = page.getByRole("button", { name: "Remove Tavily key", exact: true });
    if (!step("a saved Tavily key has a Remove action", await remove.count() === 1, "Remove action is missing")) {
      await shot("remove-missing");
      return;
    }
    await remove.click();
    await settingsSave(page).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    const removed = await (await page.request.get(`${origin}/api/settings`)).json();
    step("Remove and Save clear the stored Tavily key", removed.tavilyKeySet === false);
    await page.reload();
    step("the removed Tavily key stays absent after reload", await page.getByLabel("Tavily key", { exact: true }).getAttribute("placeholder") === "" && await remove.count() === 0);
    await shot("key-removed");

    const created = await page.request.post(`${origin}/api/chats`);
    const { id } = await created.json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder("Ask anything");
    const send = async (query) => { await composer.fill(`[qa:search] ${query}`); await composer.press("Enter"); };
    const cards = page.locator('[data-tool-name="web_search"]');
    await send("orbit");
    await cards.last().locator('[data-tool-status="running"]').waitFor({ timeout: 10_000 });
    await shot("running");
    await cards.last().locator('[data-tool-status="succeeded"]').waitFor({ timeout: 20_000 });
    const done = cards.last();
    step("search card changes from running to succeeded", true);
    step("search card shows three source links", await done.getByRole("link").count() === 3);
    const answer = page.locator('[data-message-role="assistant"]').last().getByRole("link", { name: "Orbit guide", exact: true }).last();
    await answer.waitFor({ timeout: 10_000 });
    const answerHref = await answer.getAttribute("href");
    step("the model answers from the first result URL", answerHref === searchFixtures[0].url && mock.requests.includes("orbit"), `href ${answerHref}, searches ${JSON.stringify(mock.requests)}`);
    step("source links open safely", await done.getByRole("link").first().getAttribute("target") === "_blank" && await done.getByRole("link").first().getAttribute("rel") === "noopener noreferrer nofollow");
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    await shot("done");
    await page.reload();
    await cards.last().locator('[data-tool-status="succeeded"]').waitFor();
    step("the search card and three links survive reload", await cards.last().getByRole("link").count() === 3);
    await shot("reloaded");
    await page.setViewportSize({ width: 390, height: 844 });
    await cards.last().scrollIntoViewIfNeeded();
    await shot("mobile");
    step("the mobile card fits without page overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.setViewportSize({ width: 1440, height: 900 });

    await send("slow orbit");
    await cards.last().locator('[data-tool-status="running"]').waitFor();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await cards.last().locator('[data-tool-status="cancelled"]').waitFor();
    await shot("cancelled");
    await eventually(async () => {
      const chat = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
      return chat.messages.some(({ message }) => message.parts?.some((part) => part.type === "tool-web_search" && part.errorText === "Stopped"));
    }, Boolean, { timeoutMs: 3_000, intervalMs: 100, what: "the stopped search saved in the chat" });
    await page.reload();
    await cards.last().locator('[data-tool-status="cancelled"]').waitFor();
    step("a stopped search stays cancelled after reload", true);
    await shot("cancelled-reloaded");

    await send("fail orbit");
    await cards.last().locator('[data-tool-status="failed"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-message-role="assistant"]').last().getByText("Search is unavailable.", { exact: true }).waitFor({ timeout: 10_000 });
    step("a failed search shows its card and the model still answers", true);
    await shot("failed");

    const loopChat = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${loopChat.id}`);
    await composer.fill("[qa:search-loop] orbit");
    await composer.press("Enter");
    const loopReply = page.locator('[data-message-role="assistant"]').last();
    await loopReply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 20_000 });
    const savedLoop = await (await page.request.get(`${origin}/api/chats/${loopChat.id}`)).json();
    const parts = savedLoop.messages.flatMap(({ message }) => message.role === "assistant" ? message.parts : []);
    const searched = parts.filter((part) => part.type === "tool-web_search");
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    step("repeated searches leave the fifth model step for a cited answer", searched.length === 4 && parts.filter((part) => part.type === "step-start").length === 5 && text.includes(`[Orbit guide](${searchFixtures[0].url})`));
    await shot("final-answer");
  } finally {
    await mock.close();
  }
}
