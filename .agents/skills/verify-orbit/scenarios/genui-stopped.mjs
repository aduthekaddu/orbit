import { eventually } from "../../../../src/lib/eventually.mjs";
export default async function genuiStopped({ page, origin, step, shot }) {
  const response = await page.request.post(`${origin}/api/chats`);
  if (!response.ok()) throw new Error(`could not create the test chat (${response.status()})`);
  const { id } = await response.json();
  await page.goto(`${origin}/c/${id}`);

  const composer = page.getByPlaceholder("Ask anything");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const card = page.locator('[data-tool-name="render_ui"]');
  const firstCard = card.first();
  const fallback = firstCard.locator("[data-genui-fallback]").first();

  async function expectStopped(label) {
    await fallback.waitFor({ timeout: 20_000 });
    const cardCount = await card.count();
    const snapshot = await firstCard.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      const mutedColor = getComputedStyle(probe).color;
      probe.remove();

      const fallbacks = [...node.querySelectorAll("[data-genui-fallback]")];
      const fallbackNode = fallbacks[0] ?? null;
      return {
        statusAttr: node.getAttribute("data-tool-status") ?? "",
        fallbackCount: fallbacks.length,
        fallbackTag: fallbackNode?.tagName.toLowerCase() ?? "",
        fallbackText: fallbackNode?.textContent?.trim() ?? "",
        fallbackMuted: fallbackNode ? getComputedStyle(fallbackNode).color === mutedColor : false,
        rawCount: node.querySelectorAll("pre, details").length,
        cardText: node.innerText.replace(/\s+/g, " ").trim(),
      };
    });
    const ok =
      cardCount === 1 &&
      snapshot.statusAttr === "cancelled" &&
      snapshot.fallbackCount === 1 &&
      snapshot.fallbackTag === "p" &&
      snapshot.fallbackText === "Stopped" &&
      snapshot.fallbackMuted &&
      snapshot.rawCount === 0 &&
      snapshot.cardText === "Stopped";
    step(
      label,
      ok,
      `cards=${cardCount} root data-tool-status=${JSON.stringify(snapshot.statusAttr)} fallbacks=${snapshot.fallbackCount} fallback=${snapshot.fallbackTag} ${JSON.stringify(snapshot.fallbackText)} fallbackMuted=${snapshot.fallbackMuted} raw=${snapshot.rawCount} text=${JSON.stringify(snapshot.cardText)}`,
    );
  }

  await composer.fill("[qa:truncated] Render a stream that stops.");
  await composer.press("Enter");
  await fallback.waitFor({ timeout: 25_000 });
  await stop.waitFor({ state: "hidden", timeout: 25_000 });
  await expectStopped("interrupted render_ui is cancelled and shows only one muted Stopped line");
  await shot("at-interruption");

  await composer.fill("[qa:recover] Try a plain reply after the truncated stream.");
  await composer.press("Enter");
  const recovered = page.getByText("Recovered after the failed stream.", { exact: true });
  await recovered.waitFor({ timeout: 25_000 });
  await stop.waitFor({ state: "hidden", timeout: 25_000 });
  await expectStopped("follow-up keeps the cancelled render_ui with only one muted Stopped line");
  await shot("after-follow-up");

  await eventually(async () => {
    const stored = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    return Array.isArray(stored.messages) ? stored.messages.filter(({ message }) => message?.role === "assistant").length : 0;
  }, (assistants) => assistants >= 2, { timeoutMs: 5_000, what: "both assistant replies saved in the chat" });

  await page.reload();
  await recovered.waitFor({ timeout: 20_000 });
  await expectStopped("reload keeps the cancelled render_ui with only one muted Stopped line");
  const assistants = await page.locator('[data-message-role="assistant"]').count();
  step("reload keeps both assistant turns", assistants === 2, `found ${assistants} assistant message(s)`);
  await shot("after-reload");
}
