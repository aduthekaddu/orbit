import { eventually } from "../../../../src/lib/eventually.mjs";

export default async function providerReview({ page, origin, step, shot }) {
  async function api(method, pathname, data) {
    const response = await page.request.fetch(`${origin}${pathname}`, { method, data, headers: { origin } });
    if (!response.ok()) throw new Error(`${method} ${pathname} returned ${response.status()}`);
    return response.json();
  }

  const connection = await api("POST", "/api/connections", {
    kind: "anthropic", label: "Claude QA", apiKey: "provider-review-test-key",
  });
  const composer = page.getByPlaceholder("Ask anything");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const label = page.locator("[data-reply-label]").last();

  async function openChat(model, layout) {
    const { id } = await api("POST", "/api/chats");
    await page.goto(`${origin}/c/${id}`);
    await page.locator("[data-model-chip]").first().click();
    const picker = page.locator(`[data-model-picker=${layout}]`);
    await picker.locator(`[data-model-option='${model}']`).click();
    await picker.getByRole("radio", { name: "High", exact: true }).click();
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
    return id;
  }

  async function submit(text) {
    await composer.fill(text);
    await send.click();
  }

  async function stopReply(chatId, text, expectedLabel, name) {
    await page.getByText(text).waitFor();
    const whileRunning = await label.innerText();
    await stop.click();
    await send.waitFor();
    const afterStop = await label.innerText();
    await shot(name);
    await page.reload();
    await label.waitFor();
    const afterReload = await label.innerText();
    step(`${name} shows the final reply label live, after Stop, and after reload`,
      [whileRunning, afterStop, afterReload].every((actual) => actual === expectedLabel),
      `live=${whileRunning}, stopped=${afterStop}, reloaded=${afterReload} (/c/${chatId})`);
  }

  try {
    const chatId = await openChat("claude-opus-5-5", "popover");
    await submit("[qa:claude-think] Say hello.");
    await page.getByText("Hello from the mock Claude.", { exact: true }).waitFor();
    await send.waitFor();
    await submit("Thank you. One more reply, please.");
    const accepted = await eventually(async () => {
      const chat = await api("GET", `/api/chats/${chatId}`);
      return chat.messages.filter(({ message }) => message.role === "assistant").length === 2;
    }, Boolean, { timeoutMs: 4_000, what: "the second saved reply" }).catch(() => false);
    step("desktop accepts a follow-up after ordinary Claude thinking", accepted, "no second reply was saved");
    await shot("desktop-thinking-follow-up");

    const fallbackChat = await openChat("claude-opus-5-5", "popover");
    await submit("[qa:claude-fallback-stop] Share a short update.");
    await stopReply(fallbackChat, /The fallback model started its answer/, "claude-opus-5 · High", "desktop-stopped-fallback");

    await page.setViewportSize({ width: 390, height: 844 });
    const effortChat = await openChat("mock-reasoner", "sheet");
    await submit("[qa:slow-effort-reject] Count in words.");
    await stopReply(effortChat, /\bword3\b/, "mock-reasoner · High (ignored)", "mobile-stopped-effort");
  } finally {
    const response = await page.request.delete(`${origin}/api/connections/${connection.id}`, { headers: { origin } });
    if (!response.ok()) throw new Error(`Removing the QA connection returned ${response.status()}`);
  }
}
