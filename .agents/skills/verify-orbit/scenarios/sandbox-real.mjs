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
  const text = await reply.innerText();
  console.log(`sha256sum orbit=${expected}`);
  console.log(`provider answer=${text}`);
  step("real provider runs code to compute the hash", await reply.locator('[data-tool-name="run_code"]').count() > 0, "no run_code call");
  step("real provider hash matches sha256sum", text.includes(expected), "the answer does not contain the correct hash");
  await shot("real-provider");
}
