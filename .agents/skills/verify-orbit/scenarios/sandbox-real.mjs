import { createHash } from "node:crypto";

export default async function sandboxReal({ page, origin, step, shot }) {
  const { ORBIT_API_KEY, ORBIT_BASE_URL, ORBIT_MODEL } = process.env;
  if (!ORBIT_API_KEY || !ORBIT_BASE_URL || !ORBIT_MODEL) throw new Error("ORBIT_API_KEY, ORBIT_BASE_URL, and ORBIT_MODEL are required");
  const settings = await page.request.put(`${origin}/api/settings`, { data: { baseUrl: ORBIT_BASE_URL, apiKey: ORBIT_API_KEY, model: ORBIT_MODEL, reasoningEffort: "low" } });
  if (!settings.ok()) throw new Error(`provider settings returned ${settings.status()}`);
  const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder("Ask anything");
  await composer.fill("What is the SHA-256 of the word orbit?");
  await composer.press("Enter");
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.getByRole("button", { name: "Regenerate", exact: true }).waitFor({ timeout: 180_000 });
  const expected = createHash("sha256").update("orbit").digest("hex");
  let parts = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const chat = await (await page.request.get(`${origin}/api/chats/${id}`)).json();
    parts = chat.messages.findLast(({ message }) => message.role === "assistant")?.message.parts ?? [];
    if (parts.some((part) => part.type === "text" && part.text.includes(expected))) break;
    await page.waitForTimeout(100);
  }
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const run = parts.find((part) => part.type === "tool-run_code" && part.state === "output-available");
  console.log(`sha256sum orbit=${expected}`);
  console.log(`provider answer=${text}`);
  step("real provider runs code to compute the hash", run?.output?.exitCode === 0 && run.output.stdout.includes(expected), "no completed hash calculation");
  step("real provider hash matches sha256sum", text.includes(expected), "the answer does not contain the correct hash");
  if (text.includes(expected)) {
    await page.waitForFunction((hash) => {
      const node = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)?.cloneNode(true);
      if (!node) return false;
      node.querySelectorAll("[data-tool-name]").forEach((card) => card.remove());
      return node.textContent.includes(hash);
    }, expected, { timeout: 15_000 });
    step("the full hash appears in the answer outside the code card", true);
  }
  await shot("real-provider");
}
