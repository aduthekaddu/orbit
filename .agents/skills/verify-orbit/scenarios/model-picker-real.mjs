import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODEL = "claude-opus-5-5";

// Field names only, never values: the names of a model entry and its nested capability objects.
function fieldNames(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...fieldNames(child, `${prefix}${key}.`)]);
}

export default async function modelPickerReal({ page, origin, step, shot }) {
  const apiKey = process.env.ORBIT_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("skip model-picker-real: ORBIT_ANTHROPIC_API_KEY is not set");
    return;
  }
  const baseUrl = (process.env.ORBIT_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  const listed = await fetch(`${baseUrl}/models?limit=1000`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
  const page1 = await listed.json();
  const entry = page1.data?.find((model) => model.id === MODEL) ?? page1.data?.[0];
  console.log(`models page fields: ${Object.keys(page1).sort().join(", ")}`);
  console.log(`model entry fields: ${fieldNames(entry).sort().join(", ")}`);
  step("the Models API lists claude-opus-5-5", listed.ok && page1.data?.some((model) => model.id === MODEL), `status ${listed.status}`);

  const created = await page.request.post(`${origin}/api/connections`, { data: { kind: "anthropic", label: "Anthropic", apiKey }, headers: { origin } });
  const createdText = await created.text();
  const connection = created.ok() ? JSON.parse(createdText) : null;
  step("anthropic connection saved", created.status() === 201 && !createdText.includes(apiKey), `POST /api/connections returned ${created.status()}`);
  if (!connection) return;
  try {
    const models = await (await page.request.get(`${origin}/api/connections/${connection.id}/models`)).json();
    step("Orbit lists the real models", models.models?.some((model) => model.id === MODEL), `${models.models?.length ?? 0} models`);
    await page.request.put(`${origin}/api/preferences/model`, { data: { connectionId: connection.id, model: MODEL, effort: "high" }, headers: { origin } });

    const { id } = await (await page.request.post(`${origin}/api/chats`)).json();
    await page.goto(`${origin}/c/${id}`);
    const chip = page.locator("[data-model-chip]").first();
    await chip.click();
    const picker = page.locator("[data-model-picker=popover]");
    await picker.locator(`[data-model-option='${MODEL}']`).waitFor({ timeout: 30_000 });
    await picker.locator(`[data-model-option='${MODEL}']`).click();
    await picker.getByRole("radio", { name: "High", exact: true }).click();
    await page.keyboard.press("Escape");
    step("chip reads claude-opus-5-5 · High", (await chip.innerText()) === `${MODEL} · High`, `chip reads ${await chip.innerText()}`);

    const composer = page.getByPlaceholder("Ask anything");
    // With adaptive thinking the model can skip thinking on an easy prompt, so this one needs a few steps.
    await composer.fill("A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. Then the bat and ball are each discounted 10 percent, and a 0.05 coupon applies to the ball only. What does the ball cost now? Reason carefully, then answer in one line.");
    await composer.press("Enter");
    const reply = page.locator('[data-message-role="assistant"]').last();
    const label = reply.locator("[data-reply-label]");
    await label.waitFor({ timeout: 180_000 });
    // The label shows when the stream starts; read the reply only once the Send button is back.
    await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 180_000 });
    const thought = await reply.getByRole("button", { name: /^Thought for / }).count();
    const labelText = (await label.innerText()).trim();
    await shot("reply");
    step("summarized thinking shows", thought > 0, "no Thought for button on the reply");
    step("the label names the model", labelText.startsWith(MODEL) && labelText.endsWith("· High"), `label reads ${labelText}`);
    const serverLog = path.join(repoRoot, ".verify", "server.log");
    const logged = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : null;
    step("no key in the server log", logged !== null && !logged.includes(apiKey), logged === null ? `no server log at ${serverLog}` : "the server log holds the key");
  } finally {
    await page.request.delete(`${origin}/api/connections/${connection.id}`, { headers: { origin } });
  }
}
